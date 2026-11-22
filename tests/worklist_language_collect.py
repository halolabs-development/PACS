"""Collect the words the worklist and reading screens show, for the language glossary check.

The page markup is read with the standard HTML parser; the scripts main.html loads (and the sources of
main-split.bundle.js) and the server exceptions are read with the TypeScript parser installed for the API
(tests/worklist_language_collect.cjs, node and api/node_modules/typescript). Each collected piece is the
text a reader sees, whitespace collapsed. The parts the code fills in are written where the code builds the
sentence (a template literal or a chain of `+`): `{0}` data shown as is, `{n0}` a number, `{t0}` words the
code chose (every value a literal), `{e0}` an error message.
"""
from __future__ import annotations

import collections
import html
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE_DIR = ROOT / "worklist-v0" / "hpacs-lite"
HANGUL = re.compile(r"[가-힣]")
LATIN = re.compile(r"[A-Za-z]")
SLOT = re.compile(r"\{[ten]?\d+\}")
# The glossary is data for the translator, not translated text.
OWN = {"worklist-language-terms.js", "main-split.bundle.js"}
NODE = os.environ.get("KIN_NODE") or shutil.which("node") or "node"


@dataclass
class Piece:
    text: str
    file: str
    line: int
    kind: str  # html | js-ko | js-en | css | server
    through: bool = True  # (scripts) reaches the screen through the screen-language write path
    reads: bool = False   # (scripts) words the code reads back (compared, matched, a key, a log line), not writes


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


TAG = re.compile(r"<\s*/?\s*[a-zA-Z][^<>]*>")
ATTR = re.compile(r"""\b(title|aria-label|placeholder|alt|aria-description|aria-valuetext)\s*=\s*("([^"]*)"|'([^']*)')""")


def pieces_of(value: str, kinds: list) -> list[str]:
    """The visible pieces of one literal: text between tags and the words of title-like attributes, its filled-in
    parts renumbered from 0 in each piece and marked with their kind."""
    chunks = []
    if TAG.search(value):
        for m in TAG.finditer(value):
            for a in ATTR.finditer(m.group(0)):
                chunks.append(a.group(3) if a.group(3) is not None else a.group(4))
        chunks.extend(TAG.split(value))
    else:
        chunks.append(value)
    result = []
    for chunk in chunks:
        chunk = re.sub(r"\x00(\d+)\x00", lambda m: "\x01%s\x01" % m.group(1), chunk)
        text = normalize(chunk)
        order = []

        def renum(m):
            k = int(m.group(1))
            if k not in order: order.append(k)
            return "{%s%d}" % (kinds[k] if k < len(kinds) else "", order.index(k))
        text = re.sub(r"\x01(\d+)\x01", renum, text)
        if text: result.append(text)
    return result


def meaningful(text: str) -> bool:
    bare = SLOT.sub("", text)
    return bool(HANGUL.search(bare) or len(LATIN.findall(bare)) >= 2)


EN_WORDS = re.compile(r"^[A-Z0-9⌂⚙⇄✎▸▾◀▶↻←→↑↓☆★•·(\[“\"'{][^\n]*[A-Za-z]")
NOT_TEXT = re.compile(r"^\[[\w-]+(?:[~|^$*]?=[^\]]*)?\]$|\?\w+=|^[\w.-]+$|[;{}]|=>|^\.|^#|^[a-z]+(-[a-z]+)+$|^https?:|\.(js|css|svg|png|json|html)$|^[A-Z_]{2,}$|^[a-z][a-zA-Z0-9]*$|^\w+:\w|^(GET|PUT|POST|DELETE|PATCH)$")


def english_label(text: str, ui: bool, has_tags: bool) -> bool:
    """English words that reach the screen: through a place that shows text, or as text between tags."""
    bare = SLOT.sub("", text)
    if HANGUL.search(bare) or not EN_WORDS.search(text) or not (ui or has_tags):
        return False
    # A template the parser saw reach the screen keeps its fixed words even when they are one lowercase word
    # ({0}{n1} image{t2}): they are what the reader reads around the values.
    if ui and SLOT.search(text) and re.search(r"(^|\s)[A-Za-z]{2,}", bare):
        # Code keys built from a value ({0}.kind, {0}-title, HTTP_{0}, {n0}px) are not words of the screen.
        glued = re.search(r"\}[A-Za-z_.\-]|[_.\-/]\{", text)
        return not glued and not re.search(r"[;=]|\.(js|css|svg|png|json|html)\b", bare)
    if NOT_TEXT.search(bare.strip()) and " " not in bare.strip():
        return bool(re.match(r"^[A-Z][a-z]+(?: ?[A-Z&][a-z]*)*[.…]?$|^[A-Z]{2,4}$", bare.strip()))
    return True


def page_scripts(page_name="main.html"):
    page = (PAGE_DIR / page_name).read_text(encoding="utf-8")
    names = re.findall(r'<script[^>]*\ssrc="([^"]+)"', page)
    if page_name == "main.html":
        manifest = json.loads((ROOT / "scripts" / "main-split-order.json").read_text(encoding="utf-8"))
        names += [s["file"] for s in manifest["sources"]]
    seen, files = set(), []
    for name in names:
        if name in OWN or name in seen or not name.endswith(".js"): continue
        if (PAGE_DIR / name).exists():
            seen.add(name); files.append(name)
    return files


def inline_scripts(page_name, tmp):
    """The page's inline <script> blocks as one file named like the page, each block at its own line, so a piece is
    named page:line."""
    text = (PAGE_DIR / page_name).read_text(encoding="utf-8")
    out = [""] * (text.count("\n") + 1)
    for m in re.finditer(r"<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)</script>", text):
        start = text.count("\n", 0, m.start(1))
        for k, line in enumerate(m.group(1).split("\n")):
            out[start + k] = line
    path = Path(tmp) / page_name
    path.write_text("\n".join(out), encoding="utf-8")
    return path


def parse(*args) -> list[dict]:
    out = subprocess.run([NODE, str(ROOT / "tests" / "worklist_language_collect.cjs"), *map(str, args)], capture_output=True, check=True)
    return json.loads(out.stdout.decode("utf-8"))


# A stylesheet a script writes (rules with a selector and declarations): code, not words (its comments are the author's).
STYLESHEET = re.compile(r"[^{};]+\{\s*[\w-]+\s*:[^{}]*\}")


def collect_js(names=None) -> list[Piece]:
    found = []
    for lit in parse(*[n if isinstance(n, Path) else PAGE_DIR / n for n in (names or page_scripts())]):
        if STYLESHEET.search(lit["value"]): continue
        has_tags = bool(TAG.search(lit["value"]))
        for text in pieces_of(lit["value"], lit["kinds"]):
            if not meaningful(text): continue
            if HANGUL.search(SLOT.sub("", text)):
                found.append(Piece(text, lit["file"], lit["line"], "js-ko", lit.get("through", True), lit.get("reads", False)))
            elif english_label(text, lit["ui"], has_tags):
                found.append(Piece(text, lit["file"], lit["line"], "js-en", lit.get("through", True), lit.get("reads", False)))
    return found


VOID = {"br", "img", "input", "meta", "link", "hr", "source", "col", "area", "wbr", "param", "embed", "track"}


def collect_html(page_name="main.html") -> list[Piece]:
    from html.parser import HTMLParser
    found: list[Piece] = []

    class P(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.skip = 0
            self.no = []

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if tag in ("script", "style"): self.skip += 1
            if tag not in VOID: self.no.append(a.get("translate") == "no")
            if any(self.no) or self.skip or tag in VOID and a.get("translate") == "no": return
            for k in ("title", "aria-label", "placeholder", "alt", "aria-description", "aria-valuetext"):
                v = a.get(k)
                if v and meaningful(normalize(v)):
                    found.append(Piece(normalize(v), page_name, self.getpos()[0], "html"))

        def handle_startendtag(self, tag, attrs):
            self.handle_starttag(tag, attrs)
            if tag not in VOID and self.no: self.no.pop()

        def handle_endtag(self, tag):
            if tag in ("script", "style"): self.skip -= 1
            if tag not in VOID and self.no: self.no.pop()

        def handle_data(self, data):
            if self.skip or any(self.no): return
            t = normalize(data)
            if t and meaningful(t):
                found.append(Piece(t, page_name, self.getpos()[0], "html"))
    P().feed((PAGE_DIR / page_name).read_text(encoding="utf-8"))
    return found


CSS_CONTENT = re.compile(r"""content:\s*(["'])((?:(?!\1).)*[A-Za-z가-힣](?:(?!\1).)*)\1""")


def collect_css(page_name="main.html") -> list[Piece]:
    found = []
    page = (PAGE_DIR / page_name).read_text(encoding="utf-8")
    sources = [(page_name, page)]
    for css in re.findall(r'<link[^>]*href="([^"]+\.css)"', page):
        p = PAGE_DIR / css
        if p.exists(): sources.append((css, p.read_text(encoding="utf-8")))
    for name, text in sources:
        for m in CSS_CONTENT.finditer(text):
            t = normalize(m.group(2))
            if meaningful(t):
                found.append(Piece(t, name, text.count("\n", 0, m.start()) + 1, "css"))
    return found


def collect_server() -> list[Piece]:
    found = []
    for lit in parse("--server", *sorted((ROOT / "api" / "src").rglob("*.ts"))):
        if not HANGUL.search(lit["value"]): continue
        for t in pieces_of(lit["value"], lit["kinds"]):
            if meaningful(t):
                found.append(Piece(t, lit["file"], lit["line"], "server"))
    return found


def collect() -> list[Piece]:
    return collect_html() + collect_js() + collect_css() + collect_server()


# The other documents: the pages and the viewer (config/ohif and the page scripts it loads). Their screens are English
# only (a reader who chose Korean keeps them as they are), so only their Korean words need a glossary entry.
PAGES = ("clinician.html", "admin.html", "audit.html", "index.html")


# The screen language itself (glossary, translator, the viewer mark) is shared into config/ohif.js but holds no viewer words.
LANGUAGE = {"viewer-language.js", "worklist-language-terms.js", "worklist-language.js"}


def viewer_scripts() -> list[Path]:
    """config/ohif's sources and shared files, and every page script the viewer loads, followed through the scripts that
    load further ones (a quoted file name of worklist-v0/hpacs-lite in viewer code)."""
    order = json.loads((ROOT / "config/ohif/source-order.json").read_text(encoding="utf-8"))
    files = [ROOT / "config/ohif" / name for name in order["sources"]]
    files += [ROOT / name for name in order.get("shared", []) if Path(name).name not in LANGUAGE]
    seen = {p.name for p in files if p.parent == PAGE_DIR}
    queue = list(files)
    loaded = []
    while queue:
        text = queue.pop(0).read_text(encoding="utf-8")
        for name in sorted(set(re.findall(r"""['"`/]([\w.-]+\.js)['"`]""", text))):
            if name in seen or name in LANGUAGE or not (PAGE_DIR / name).exists(): continue
            seen.add(name)
            loaded.append(PAGE_DIR / name)
            queue.append(PAGE_DIR / name)
    return files + sorted(loaded)


def collect_document(name: str, tmp) -> list[Piece]:
    if name == "viewer":
        return collect_js(viewer_scripts())
    return (collect_html(name) + collect_js([PAGE_DIR / n for n in page_scripts(name)] + [inline_scripts(name, tmp)])
            + collect_css(name))


def missing_by_document(known: set, css: set) -> dict:
    """Per document: its distinct product words, and those without a glossary entry (main.html: every word; the other
    documents: their Korean words). tests/worklist_language_source_test.py reads the glossary the same way."""
    import tempfile
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name in ("main.html",) + PAGES + ("viewer",):
            pieces = collect() if name == "main.html" else collect_document(name, tmp)
            distinct = {}
            for p in pieces: distinct.setdefault(p.text, p)
            needs = {t: p for t, p in distinct.items()
                     if name == "main.html" or p.kind != "server" and HANGUL.search(SLOT.sub("", t))}
            out[name] = {"words": len(distinct), "need": len(needs),
                         "missing": sorted(f"{p.file}:{p.line} [{p.kind}] {t}" for t, p in needs.items()
                                           if t not in known and not (p.kind == "css" and t in css))}
            if name == "viewer":
                # The viewer has no page markup of ours: a Korean word reaches the screen only through the write path
                # (kinText / kinHtml / kinError, kinSay / kinWrite). Per file, the Korean writes that do not go through it.
                unwritten = collections.Counter(p.file for p in pieces
                                                if p.kind == "js-ko" and not p.through and not p.reads)
                out[name]["unwritten"] = dict(sorted(unwritten.items(), key=lambda kv: (-kv[1], kv[0])))
    return out


if __name__ == "__main__":
    import collections, sys
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:2] == ["--missing"]:
        # Rerun the glossary check on every document: python tests/worklist_language_collect.py --missing
        script = "global.window={};require(process.argv[1]);process.stdout.write(JSON.stringify(window.KinLanguageTerms))"
        terms = json.loads(subprocess.run([NODE, "-e", script, str(PAGE_DIR / "worklist-language-terms.js")],
                                          capture_output=True, check=True).stdout.decode("utf-8"))
        result = missing_by_document({row[0] for row in terms["terms"]} | set(terms["skip"]), {c[2].strip() for c in terms["css"]})
        for name, row in result.items():
            print(f"{name}: {row['words']} words, {row['need']} need an entry, {len(row['missing'])} without one")
            for line in row["missing"]: print("  " + line)
            if "unwritten" in row:
                print(f"{name}: {sum(row['unwritten'].values())} Korean writes outside the write path, in {len(row['unwritten'])} files")
                for file, count in row["unwritten"].items(): print(f"  {file}: {count}")
        sys.exit(1 if any(row["missing"] or row.get("unwritten") for row in result.values()) else 0)
    ps = collect()
    by = collections.Counter(p.kind for p in ps)
    distinct = {}
    for p in ps: distinct.setdefault(p.text, p)
    print(len(ps), "pieces", len(distinct), "distinct", dict(by))
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps([{"text": t, "file": p.file, "line": p.line, "kind": p.kind} for t, p in distinct.items()], ensure_ascii=False, indent=0), encoding="utf-8")
