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
            # Scripts and the stylesheets (and other local links) the page loads.
            src = dict(attrs).get({'script': 'src', 'link': 'href'}.get(tag, ''))
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


STRING = re.compile(r'''(['"`])([^'"`\n\\$]{1,200})\1''')


def literal_files(root, name, source):
    """Repository files a test names in a string literal, conservatively.

    A test reads fixtures, opens sources as data or loads scripts into a browser
    by path, not only by import. Each literal, and consecutive literals of one
    line joined by '/', is tried from the root, the test's folder and tests/.
    """
    found = set()
    folder = posixpath.dirname(name)
    for line in source.splitlines():
        words = [match[2].strip() for match in STRING.finditer(line)]
        candidates = set(words)
        for size in (2, 3, 4):
            candidates.update('/'.join(words[i:i + size]) for i in range(len(words) - size + 1))
        for candidate in candidates:
            candidate = re.sub(r'^/worklist/', 'worklist-v0/', candidate).removeprefix('./')
            last = candidate.rsplit('/', 1)[-1]
            if (not candidate or candidate.startswith(('/', '.git')) or ':' in candidate or '*' in candidate
                    or '.' not in last.strip('.')):
                continue
            for base in ('', folder, 'tests'):
                path = posixpath.normpath(posixpath.join(base, candidate))
                if (not path.startswith('..') and 'node_modules/' not in path and path != name
                        and (root / path).is_file()):
                    found.add(path)
                    break
    return found


class InputClosure:
    """Follow test imports, files tests name, and served-page scripts from a job's direct inputs."""

    def __init__(self, root):
        from ci_workflow_consumers_test import consumers

        self.root = root
        self.graph = {}
        consumers(root, audit=self.graph)
        self.config = json.loads((root / 'scripts/ci-paths.json').read_text(encoding='utf-8'))
        self.script_graph = {}
        self.pages = {page.relative_to(root).as_posix(): expand_scripts(root, page_scripts(root, page.relative_to(root).as_posix()), self.script_graph)
                      for page in (root / 'worklist-v0/hpacs-lite').glob('*.html')}
        self.named = {}
        import importlib.util
        spec = importlib.util.spec_from_file_location('input_closure_selector', root / 'scripts/ci_select.py')
        selector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(selector)
        # A shared runner already selects every job; the files it names (its registries) are not each job's inputs.
        self.common = lambda name: any(selector.matches(name, pattern) for pattern in self.config['common'])

    def named_files(self, name):
        if not (name.startswith('tests/') and name.endswith(('.py', '.cjs', '.js', '.mjs'))) or self.common(name):
            return set()
        if name not in self.named:
            path = self.root / name
            self.named[name] = (literal_files(self.root, name, path.read_text(encoding='utf-8-sig', errors='replace'))
                                if path.is_file() else set())
        return self.named[name]

    def follow(self, required, step):
        pending = list(required)
        while pending:
            for dependency in step(pending.pop()):
                if dependency not in required:
                    required.add(dependency)
                    pending.append(dependency)

    def __call__(self, owner, required):
        required = set(required)
        self.follow(required, lambda name: self.graph['edges'].get(name, []))
        # Pages a job serves bring the scripts and stylesheets they load: a page its command names, or a page in
        # its own map entry when it uses the page-serving helper (the recorder's served-page rule).
        serving = bool(required & {'tests/page_source.py', 'tests/page_source.cjs'})
        for page, scripts in self.pages.items():
            if page in required or (serving and page in self.config['jobs'][owner]):
                required.update(scripts)
        # Then files a test names as data, with their imports; a page named here is read, not served.
        self.follow(required, lambda name: set(self.graph['edges'].get(name, [])) | self.named_files(name))
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
    """(step, env) for every step whose execution follows a selection key, keyed by that key.

    A job that waits on another selected job (consume after produce) inherits its key. The env
    merges the workflow, job and step env, as the step sees it.
    """
    rows = {}
    for workflow in SELECTING_WORKFLOWS:
        document = catalog.documents[workflow]
        jobs = document['jobs']
        for job_id, job in jobs.items():
            owner = SELECTION.search(str(job.get('if', '')))
            needs = job.get('needs')
            if not owner and isinstance(needs, str) and needs in jobs:
                owner = SELECTION.search(str(jobs[needs].get('if', '')))
            for step in job.get('steps', []):
                key = owner or SELECTION.search(str(step.get('if', '')))
                if key:
                    env = {**(document.get('env') or {}), **(job.get('env') or {}), **(step.get('env') or {})}
                    rows.setdefault(key[1], []).append((step, env))
    return rows


def _expand(value, env):
    return re.sub(r'\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}', lambda m: str(env.get(m[1], m[0])), str(value))


def command_inputs(root, step, profiles, env=None):
    """Repository files a step names: recorder --file/--tree, run test files (also through a
    working directory or a docker bind mount), discover patterns, measurement profiles and env
    values. Returns the files and synthetic new files that must select the step's job: one in
    each recorded tree and one matching each discover pattern."""
    env = env or {}
    files, synthetic, trees = set(), set(), set()

    def repository_file(word, prefixes):
        for prefix in prefixes:
            name = posixpath.normpath(posixpath.join(prefix, word)) if prefix else word
            if not name.startswith('..') and (root / name).is_file():
                return name
        return None

    for value in env.values():
        value = str(value)
        if '/' in value and '$' not in value and (root / value).is_file():
            files.add(value)
    directory = _expand(step.get('working-directory', ''), env)
    text = re.sub(r'\$\{\{[^}]+\}\}', 'EXPRESSION', _expand(step.get('run', ''), env)).replace('\\\n', ' ')
    for line in text.splitlines():
        try:
            words = shlex.split(line, comments=True)
        except ValueError:
            words = line.split()  # an inline program; its literal paths still count
        mounts = {}
        for index, word in enumerate(words[:-1]):
            if word in ('-v', '--volume') and words[index + 1].startswith('$PWD'):
                source, _, target = words[index + 1][len('$PWD'):].lstrip('/').partition(':')
                mounts[target.split(':')[0].rstrip('/')] = source.rstrip('/')
        words = [re.sub(r'^(?:\./|\$PWD/|"\$PWD"/)', '', word) for word in words]
        prefixes = [''] + ([directory] if directory and '$' not in directory else [])
        for index, word in enumerate(words[:-1]):
            following = words[index + 1]
            if word in ('--cwd', 'cd') and '$' not in following and following != '.':
                prefixes.append(following.rstrip('/'))
        for index, word in enumerate(words):
            following = words[index + 1] if index + 1 < len(words) else ''
            if word == '--tree' and following and '$' not in following:
                trees.add(following.rstrip('/'))
                synthetic.add(following.rstrip('/') + '/new-input.py')
            elif word == '-p' and 'discover' in words:
                start = words[words.index('-s') + 1].rstrip('/') if '-s' in words[:-1] else 'tests'
                files.update(path.relative_to(root).as_posix() for path in (root / start).glob(following))
                synthetic.add(start + '/' + following.replace('*', 'new'))
            elif word == '--profile' and following in profiles:
                files.update('tests/' + row[0] for row in profiles[following]['suites'])
            elif word == '-m' and following and (root / (following.replace('.', '/') + '.py')).is_file():
                files.add(following.replace('.', '/') + '.py')
            elif '$' in word or 'node_modules/' in word or word.startswith(('-', 'tmp/')):
                continue
            elif word.startswith('/'):
                for target, source in mounts.items():
                    if word.startswith(target + '/') and (root / source / word[len(target) + 1:]).is_file():
                        files.add(posixpath.join(source, word[len(target) + 1:]) if source else word[len(target) + 1:])
            elif (name := repository_file(word, prefixes)):
                files.add(name)
    return files, synthetic, trees


def workflow_inputs(root, catalog, profiles, closure=None):
    """For every selection key: the files its steps run or read, with their imports and pages,
    and the synthetic new files (in a recorded tree, matching a discover pattern) it must catch."""
    closure = closure or InputClosure(root)
    result = {}
    for owner, steps in selected_steps(catalog).items():
        files, synthetic, trees = set(), set(), set()
        for step, env in steps:
            found, new, folders = command_inputs(root, step, profiles, env)
            files |= found
            synthetic |= new
            trees |= folders
        # A test tree's own files are run; follow what they import from outside the tree.
        for tree in trees:
            if tree.startswith('tests/') and (root / tree).is_dir():
                files.update(path.relative_to(root).as_posix() for path in (root / tree).rglob('*')
                             if path.is_file() and path.suffix in ('.py', '.cjs', '.js', '.mjs'))
        result[owner] = (closure(owner, files), synthetic)
    return result
