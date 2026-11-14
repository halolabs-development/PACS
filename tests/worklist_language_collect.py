"""Collect the words the worklist and reading screens show, for the language glossary check.

Stdlib only. Reads worklist-v0/hpacs-lite/main.html, every script it loads (and the sources of
main-split.bundle.js), their CSS `content:` words, and the Korean exception messages of api/src.
Each collected piece is the text a reader sees, whitespace collapsed. The parts the code fills in
are written where the code builds the sentence (a template literal or a chain of `+`):
`{0}` data shown as is, `{t0}` words the code chose (a literal choice), `{e0}` an error message.
"""
from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGE_DIR = ROOT / "worklist-v0" / "hpacs-lite"
HANGUL = re.compile(r"[\uac00-\ud7a3]")
LATIN = re.compile(r"[A-Za-z]")
SLOT = re.compile(r"\{[te]?\d+\}")
# The glossary is data for the translator, not translated text.
OWN = {"worklist-language-terms.js", "main-split.bundle.js"}


@dataclass
class Piece:
    text: str
    file: str
    line: int
    kind: str  # html | js-ko | js-en | css | server


@dataclass
class Lit:
    value: str  # literal parts joined with \x00N\x00 markers for the filled-in parts
    line: int
    quote: str
    start: int = 0
    end: int = 0
    exprs: list = field(default_factory=list)
    before: str = ""


REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^") | {""}
REGEX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"}
ERROR_EXPR = re.compile(r"\b(?:e|err|error|ex|failure|cause)\??\.message\b")
WORDS_EXPR = re.compile(r"'[^'\n]*[A-Za-z\uac00-\ud7a3][^'\n]*'|\"[^\"\n]*[A-Za-z\uac00-\ud7a3][^\"\n]*\"|`[^`]*[A-Za-z\uac00-\ud7a3][^`]*`")


LITERAL = re.compile(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`[^`$]*`")


def slot_kind(expr: str) -> str:
    """`e` an error message, `t` when every value the part can take is a literal of the code (a choice between words),
    otherwise data (``)."""
    if ERROR_EXPR.search(expr): return "e"
    e = expr.strip()
    while e.startswith("(") and e.endswith(")"): e = e[1:-1].strip()
    if not WORDS_EXPR.search(e): return ""
    s = LITERAL.sub("L", e)
    if s == "L" or re.fullmatch(r"[^?]+\?\s*L\s*:\s*(?:[^?:]+\?\s*L\s*:\s*)*L", s) or re.fullmatch(r"[^&|?]+&&\s*L", s):
        return "t"
    return ""


def decode(raw: str) -> str:
    def rep(m):
        s = m.group(0)
        if s.startswith("\\u{"): return chr(int(s[3:-1], 16))
        if s.startswith("\\u"): return chr(int(s[2:], 16))
        if s.startswith("\\x"): return chr(int(s[2:], 16))
        return {"\\n": "\n", "\\t": "\t", "\\r": ""}.get(s, s[1:])
    return re.sub(r"\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\.", rep, raw)


def tokenize(src: str, base_line: int = 1) -> list[Lit]:
    """String and template literals of JavaScript source (comments and regex literals skipped), with
    `'words' + value + 'words'` chains joined into one literal whose filled-in parts are markers."""
    lits: list[Lit] = []
    nested: list[Lit] = []
    i, n, line = 0, len(src), base_line
    prev = ""

    def skip_string(j, q):
        j += 1
        while j < n and src[j] != q and src[j] != "\n":
            j += 2 if src[j] == "\\" else 1
        return min(j + 1, n)

    def read_template(j, line):
        parts, exprs, buf = [], [], []
        while j < n:
            c = src[j]
            if c == "\\":
                buf.append(src[j:j + 2]); j += 2; continue
            if c == "`":
                parts.append("".join(buf)); return j + 1, line, parts, exprs
            if c == "$" and j + 1 < n and src[j + 1] == "{":
                parts.append("".join(buf)); buf = []
                k, depth = j + 2, 1
                while k < n and depth:
                    ch = src[k]
                    if ch in "'\"": k = skip_string(k, ch); continue
                    if ch == "`":
                        k, _l, _p, _e = read_template(k + 1, line); continue
                    if ch == "{": depth += 1
                    elif ch == "}": depth -= 1
                    k += 1
                expr = src[j + 2:k - 1]
                exprs.append(expr)
                nested.extend(tokenize(expr, line))
                line += expr.count("\n")
                j = k; continue
            if c == "\n": line += 1
            buf.append(c); j += 1
        return j, line, parts + ["".join(buf)], exprs

    while i < n:
        c = src[i]
        if c == "\n": line += 1; i += 1; continue
        if c in " \t\r": i += 1; continue
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2); seg = src[i:(n if j < 0 else j + 2)]
            line += seg.count("\n"); i = n if j < 0 else j + 2; continue
        if c == "/" and (prev in REGEX_PREV or prev in REGEX_WORDS):
            j, cls = i + 1, False
            while j < n and src[j] != "\n":
                ch = src[j]
                if ch == "\\": j += 2; continue
                if ch == "[": cls = True
                elif ch == "]": cls = False
                elif ch == "/" and not cls: break
                j += 1
            j += 1
            while j < n and src[j].isalnum(): j += 1
            i = j; prev = "regex"; continue
        if c in "'\"":
            j = skip_string(i, c)
            lits.append(Lit(decode(src[i + 1:j - 1]), line, c, i, j, [], src[max(0, i - 60):i]))
            i = j; prev = "str"; continue
        if c == "`":
            j, line2, parts, exprs = read_template(i + 1, line)
            value = "".join(decode(p) + ("\x00%d\x00" % k if k < len(exprs) else "") for k, p in enumerate(parts))
            lits.append(Lit(value, line, "`", i, j, exprs, src[max(0, i - 60):i]))
            line = line2; i = j; prev = "str"; continue
        if c.isalnum() or c in "_$":
            j = i
            while j < n and (src[j].isalnum() or src[j] in "_$"): j += 1
            prev = src[i:j]; i = j; continue
        prev = c; i += 1
    return join_chains(src, lits) + nested


STOP = set(",;)]}?:+\n")


def join_chains(src: str, lits: list[Lit]) -> list[Lit]:
    at = {l.start: l for l in lits}
    used, out = set(), []

    def expr_end(p):
        depth = 0
        while p < len(src):
            ch = src[p]
            if ch in "'\"`" and p in at: p = at[p].end; continue
            if ch in "([{": depth += 1
            elif ch in ")]}":
                if depth == 0: return p
                depth -= 1
            elif depth == 0 and (ch in STOP or src.startswith("&&", p) or src.startswith("||", p) or src.startswith("??", p) or src.startswith("==", p) or src.startswith("!=", p)):
                return p
            p += 1
        return p

    for lit in lits:
        if lit.start in used: continue
        parts = [lit]
        pos = lit.end
        while True:
            m = re.match(r"[ \t]*\+[ \t\r\n]*", src[pos:])
            if not m or src[pos:].lstrip().startswith("+="): break
            p = pos + m.end()
            if p in at:
                parts.append(at[p]); used.add(p); pos = at[p].end; continue
            e = expr_end(p)
            if e == p: break
            parts.append(src[p:e].strip()); pos = e
        back = re.search(r"([\w$][\w$.?]*(?:\([^()\n]*\))?)\s*\+\s*$", src[max(0, lit.start - 80):lit.start])
        if back and not re.search(r"\+\s*$", src[max(0, lit.start - 80):lit.start - len(back.group(0))]) and back.group(1) not in REGEX_WORDS:
            parts.insert(0, back.group(1))
        if len(parts) == 1:
            out.append(lit); continue
        value, exprs = "", []
        for part in parts:
            if isinstance(part, Lit):
                k0 = len(exprs)
                value += re.sub(r"\x00(\d+)\x00", lambda m: "\x00%d\x00" % (int(m.group(1)) + k0), part.value)
                exprs.extend(part.exprs)
            else:
                value += "\x00%d\x00" % len(exprs); exprs.append(part)
        out.append(Lit(value, lit.line, "+", lit.start, pos, exprs, lit.before))
    return out


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


TAG = re.compile(r"<\s*/?\s*[a-zA-Z][^<>]*>")
ATTR = re.compile(r"""\b(title|aria-label|placeholder|alt|aria-description|aria-valuetext)\s*=\s*("([^"]*)"|'([^']*)')""")


def pieces_of(value: str, exprs: list) -> list[str]:
    """The visible pieces of one literal: text between tags and the words of title-like attributes."""
    kinds = [slot_kind(e) for e in exprs]
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


# Places in JavaScript whose English literal reaches the screen.
EN_SINK = re.compile(
    r"(textContent|innerText|innerHTML|title|placeholder|label|ariaLabel|value)\s*[+]?=\s*[^=;]*$"
    r"|(toast|alert|confirm|prompt|note|status|say|setStatus|announce|tell|show|setCustomValidity)\s*\([^()]*$"
    r"|setAttribute\(\s*['\"](title|aria-label|placeholder|alt|aria-valuetext)['\"]\s*,\s*[^()]*$"
    r"|new Option\(\s*$"
    r"|\b(element|el|make|node|button|btn|chip|h|tag|create|item|add|option|plain|primary|text|line|row|cell|heading|labelled|control|link|field|section|group|note|say)"
    r"\s*\(\s*(?:['\"][\w-]*['\"]|[\w$.]+)\s*,\s*(?:(?:\{[^{}]*\}|null|undefined|['\"][\w -]*['\"])\s*,\s*)?$"
    r"|\b(t|label|title|text|name|help|hint|summary|caption|legend|word|words|placeholder|tip|why|empty|none|message|msg)\s*:\s*$"
    r"|\?\s*$|:\s*$|\|\|\s*$|\?\?\s*$"
)
EN_WORDS = re.compile(r"^[A-Z0-9⌂⚙⇄✎▸▾◀▶↻←→↑↓☆★•·(\[“\"'{][^\n]*[A-Za-z]")
NOT_TEXT = re.compile(r"^[\w.-]+$|[;{}]|=>|^\.|^#|^[a-z]+(-[a-z]+)+$|^https?:|\.(js|css|svg|png|json|html)$|^[A-Z_]{2,}$|^[a-z][a-zA-Z0-9]*$|^\w+:\w|^(GET|PUT|POST|DELETE|PATCH)$")


def english_label(lit: Lit, text: str) -> bool:
    bare = SLOT.sub("", text)
    if HANGUL.search(bare) or not EN_WORDS.search(text):
        return False
    if NOT_TEXT.search(bare) and " " not in bare:
        if not re.match(r"^[A-Z][a-z]+(?: ?[A-Z&][a-z]*)*[.…]?$|^[A-Z]{2,4}$", bare):
            return False
    return bool(EN_SINK.search(lit.before)) or lit.quote in "`+" and TAG.search(lit.value) is not None


def page_scripts():
    page = (PAGE_DIR / "main.html").read_text(encoding="utf-8")
    names = re.findall(r'<script[^>]*\ssrc="([^"]+)"', page)
    manifest = json.loads((ROOT / "scripts" / "main-split-order.json").read_text(encoding="utf-8"))
    names += [s["file"] for s in manifest["sources"]]
    seen, files = set(), []
    for name in names:
        if name in OWN or name in seen or not name.endswith(".js"): continue
        if (PAGE_DIR / name).exists():
            seen.add(name); files.append(name)
    return files


def collect_js(name: str) -> list[Piece]:
    src = (PAGE_DIR / name).read_text(encoding="utf-8")
    found = []
    for lit in tokenize(src):
        for text in pieces_of(lit.value, lit.exprs):
            if not meaningful(text): continue
            if HANGUL.search(SLOT.sub("", text)):
                found.append(Piece(text, name, lit.line, "js-ko"))
            elif english_label(lit, text):
                found.append(Piece(text, name, lit.line, "js-en"))
    return found


VOID = {"br", "img", "input", "meta", "link", "hr", "source", "col", "area", "wbr", "param", "embed", "track"}


def collect_html() -> list[Piece]:
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
                    found.append(Piece(normalize(v), "main.html", self.getpos()[0], "html"))
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
                found.append(Piece(t, "main.html", self.getpos()[0], "html"))
    P().feed((PAGE_DIR / "main.html").read_text(encoding="utf-8"))
    return found


CSS_CONTENT = re.compile(r"""content:\s*(["'])((?:(?!\1).)*[A-Za-z\uac00-\ud7a3](?:(?!\1).)*)\1""")


def collect_css() -> list[Piece]:
    found = []
    page = (PAGE_DIR / "main.html").read_text(encoding="utf-8")
    sources = [("main.html", page)]
    for css in re.findall(r'<link[^>]*href="([^"]+\.css)"', page):
        p = PAGE_DIR / css
        if p.exists(): sources.append((css, p.read_text(encoding="utf-8")))
    for name, text in sources:
        for m in CSS_CONTENT.finditer(text):
            t = normalize(m.group(2))
            if meaningful(t):
                found.append(Piece(t, name, text.count("\n", 0, m.start()) + 1, "css"))
    return found


SERVER_EXC = re.compile(r"Exception\(\s*(?:\{[^()]*?message:\s*)?(['\"`])((?:(?!\1)(?:\\.|.))*)\1", re.S)


def collect_server() -> list[Piece]:
    found = []
    for path in sorted((ROOT / "api" / "src").rglob("*.ts")):
        text = path.read_text(encoding="utf-8")
        for m in SERVER_EXC.finditer(text):
            raw = m.group(2)
            if not HANGUL.search(raw): continue
            exprs = re.findall(r"\$\{((?:[^{}]|\{[^{}]*\})*)\}", raw) if m.group(1) == "`" else []
            k = iter(range(len(exprs)))
            value = re.sub(r"\$\{(?:[^{}]|\{[^{}]*\})*\}", lambda _m: "\x00%d\x00" % next(k), raw) if exprs else raw
            for t in pieces_of(decode(value), exprs):
                if meaningful(t):
                    found.append(Piece(t, str(path.relative_to(ROOT)).replace("\\", "/"), text.count("\n", 0, m.start()) + 1, "server"))
    return found


def collect() -> list[Piece]:
    pieces = collect_html()
    for name in page_scripts():
        pieces += collect_js(name)
    pieces += collect_css()
    pieces += collect_server()
    return pieces


if __name__ == "__main__":
    import collections, sys
    sys.stdout.reconfigure(encoding="utf-8")
    ps = collect()
    by = collections.Counter(p.kind for p in ps)
    distinct = {}
    for p in ps: distinct.setdefault(p.text, p)
    print(len(ps), "pieces", len(distinct), "distinct", dict(by))
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps([{"text": t, "file": p.file, "line": p.line, "kind": p.kind} for t, p in distinct.items()], ensure_ascii=False, indent=0), encoding="utf-8")
