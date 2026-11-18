"""Derive PR regression inputs from recorder declarations, pages and test imports.

The selector stays stdlib-only on a fresh runner. Its checked-in path manifest is
verified against this derivation using the existing Python/TypeScript AST audit.
"""
from html.parser import HTMLParser
import json
import posixpath
from pathlib import PurePosixPath
import re
import shlex
from urllib.parse import urlsplit


def local_script(importer, src):
    url = urlsplit(src)
    if url.scheme or url.netloc:
        return None
    if url.path.startswith('/worklist/'):
        return 'worklist-v0/' + url.path.removeprefix('/worklist/')
    if url.path.startswith('/'):
        return None
    return posixpath.normpath(str(PurePosixPath(importer).parent / url.path))


def page_scripts(root, page):
    scripts = set()

    class Scripts(HTMLParser):
        def handle_starttag(self, tag, attrs):
            src = dict(attrs).get('src') if tag == 'script' else None
            if not src:
                return
            path = local_script(page, src)
            if path:
                scripts.add(path)

    Scripts().feed((root / page).read_text(encoding='utf-8'))
    manifest_path = 'scripts/main-split-order.json'
    manifest = json.loads((root / manifest_path).read_text(encoding='utf-8'))
    if manifest['artifact'] in scripts:
        scripts.update((manifest_path, 'scripts/build-main-split-bundle.py'))
        scripts.update((PurePosixPath(page).parent / row['file']).as_posix() for row in manifest['sources'])
    return scripts


def expand_scripts(root, scripts, graph):
    from ci_workflow_consumers_test import javascript_scan

    required, pending = set(scripts), set(scripts)
    while pending:
        rows = [{'filename': name, 'source': (root / name).read_text(encoding='utf-8')}
                for name in sorted(pending) if name.endswith(('.js', '.cjs', '.mjs'))
                and name not in graph and (root / name).is_file()]
        for row, scanned in zip(rows, javascript_scan(rows) if rows else []):
            graph[row['filename']] = {path for src in scanned['scriptPaths']
                                      if (path := local_script(row['filename'], src)) and (root / path).is_file()}
        following = set().union(*(graph.get(name, set()) for name in pending)) - required
        required.update(following)
        pending = following
    return required


class InputClosure:
    """Follow test imports and served-page scripts from a job's direct inputs."""

    def __init__(self, root):
        from ci_workflow_consumers_test import consumers

        self.root = root
        self.graph = {}
        consumers(root, audit=self.graph)
        self.config = json.loads((root / 'scripts/ci-paths.json').read_text(encoding='utf-8'))
        self.script_graph = {}
        self.pages = {page.relative_to(root).as_posix(): expand_scripts(root, page_scripts(root, page.relative_to(root).as_posix()), self.script_graph)
                      for page in (root / 'worklist-v0/hpacs-lite').glob('*.html')}

    def __call__(self, owner, required):
        required = set(required)
        pending = list(required)
        while pending:
            for dependency in self.graph['edges'].get(pending.pop(), []):
                if dependency not in required:
                    required.add(dependency)
                    pending.append(dependency)
        for page, scripts in self.pages.items():
            if page in required or page in self.config['jobs'][owner]:
                required.update(scripts)
        return required


def regression_inputs(root, catalog, suites, closure=None):
    closure = closure or InputClosure(root)
    result = {}
    for owner, commands in suites.items():
        required = set(commands)
        for step in catalog.job(owner)['steps']:
            words = shlex.split(re.sub(r'\$\{\{[^}]+\}\}', 'EXPRESSION', step.get('run', '')), comments=True)
            required.update(words[i + 1] for i, word in enumerate(words[:-1]) if word == '--file'
                            and '$' not in words[i + 1] and 'node_modules/' not in words[i + 1])
        result[owner] = closure(owner, required)
    return result


# Both path-selected workflows gate a job, or a single step inside the always-on
# runtime job, on one key of the select output.
SELECTING_WORKFLOWS = ('.github/workflows/validate.yml', '.github/workflows/pr-regressions.yml')
SELECTION = re.compile(r"fromJSON\((?:needs\.select|steps\.paths)\.outputs\.jobs\)\['([a-z0-9-]+)'\]")


def selected_steps(catalog):
    """Every step whose execution follows a selection key, keyed by that key.

    A job that waits on another selected job (consume after produce) inherits its key.
    """
    rows = {}
    for workflow in SELECTING_WORKFLOWS:
        jobs = catalog.documents[workflow]['jobs']
        for job_id, job in jobs.items():
            owner = SELECTION.search(str(job.get('if', '')))
            needs = job.get('needs')
            if not owner and isinstance(needs, str) and needs in jobs:
                owner = SELECTION.search(str(jobs[needs].get('if', '')))
            for step in job.get('steps', []):
                key = owner or SELECTION.search(str(step.get('if', '')))
                if key:
                    rows.setdefault(key[1], []).append(step)
    return rows


def command_inputs(root, run, profiles):
    """Repository files a step's shell text names: recorder --file/--tree, run test files,
    discover patterns and measurement profiles. Trees yield a synthetic new file."""
    files, trees = set(), set()
    text = re.sub(r'\$\{\{[^}]+\}\}', 'EXPRESSION', str(run)).replace('\\\n', ' ')
    for line in text.splitlines():
        try:
            words = shlex.split(line, comments=True)
        except ValueError:
            words = line.split()  # an inline program; its literal paths still count
        words = [re.sub(r'^(?:\./|\$PWD/|"\$PWD"/)', '', word) for word in words]
        for index, word in enumerate(words):
            following = words[index + 1] if index + 1 < len(words) else ''
            if word == '--tree' and following and '$' not in following:
                trees.add(following.rstrip('/'))
            elif word == '-p' and 'discover' in words:
                files.update(path.relative_to(root).as_posix() for path in (root / 'tests').glob(following))
            elif word == '--profile' and following in profiles:
                files.update('tests/' + row[0] for row in profiles[following]['suites'])
            elif word == '-m' and following and (root / (following.replace('.', '/') + '.py')).is_file():
                files.add(following.replace('.', '/') + '.py')
            elif ('$' not in word and 'node_modules/' not in word and not word.startswith(('/', '-', 'tmp/'))
                  and '/' in word and (root / word).is_file()):
                files.add(word)
    return files, trees


def workflow_inputs(root, catalog, profiles, closure=None):
    """For every selection key: the files its steps run or read, with their imports and pages."""
    closure = closure or InputClosure(root)
    result = {}
    for owner, steps in selected_steps(catalog).items():
        files, trees = set(), set()
        for step in steps:
            found, folders = command_inputs(root, step.get('run', ''), profiles)
            files |= found
            trees |= folders
        # A test tree's own files are run; follow what they import from outside the tree.
        for tree in trees:
            if tree.startswith('tests/') and (root / tree).is_dir():
                files.update(path.relative_to(root).as_posix() for path in (root / tree).rglob('*')
                             if path.is_file() and path.suffix in ('.py', '.cjs', '.js', '.mjs'))
        result[owner] = (closure(owner, files), trees)
    return result
