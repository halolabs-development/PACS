"""Data shown as written on a translated screen: the probe the screen-language page tests share.

Requirement: a reader who chose a screen language sees the page's own words in it, and data (patient and study fields,
report text, names, institutions, roles, free text) exactly as written - even when a value equals a glossary word or a
sentence the glossary knows.

RISK: a value the page writes without marking it as data (translate="no") is translated when it equals a glossary entry;
reading the code for those places finds only the ones read.

The probe: a harness's valid synthetic answers go through Planter, which replaces the displayed text values (not ids,
dates, codes, states or other values a screen needs to reach) with glossary words, whole glossary sentences and
glossary templates filled with a marker - each original value its own planted value, so a swap is seen too. The same
screens are drawn from the plain answers and from the planted ones; snapshot() reads every text, every title-like
attribute, field values, the document title and the browser dialogs. A planted value whose translation shows more often
in the planted screens than in the plain ones was translated where it is shown (check()). Which fields are displayed is
not decided here: the comparison finds it. This is no proof that every data path exists in the fixtures - only the
paths the harness answers are probed.
"""
import copy
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TERMS = ROOT / "worklist-v0" / "hpacs-lite" / "worklist-language-terms.js"
HANGUL = re.compile(r"[가-힣]")
SLOT = re.compile(r"\{(?:[ten]?\d+|[A-Za-z]\w*)\}")
MARK = "SYN-Q"


def glossary():
    rows, inside = [], False
    for line in TERMS.read_text(encoding="utf-8").splitlines():
        if re.match(r"^\s*terms:\s*\[", line):
            inside = True
            continue
        if inside and re.match(r"^\s*\],?\s*$", line):
            break
        if inside and line.strip().startswith("["):
            rows.append(json.loads(line.strip().rstrip(",")))
    return rows


def pools():
    """Korean data (words, sentences, filled templates) for an English screen; English data for a Korean screen."""
    words, sentences, filled, english = [], [], [], []
    seen = set()
    for row in glossary():
        source, other, kind = row[0], row[1], row[2] if len(row) > 2 else ""
        if source in seen:
            continue
        seen.add(source)
        korean = HANGUL.search(SLOT.sub("", source))
        slots = SLOT.findall(source)
        if korean and not slots and "l" in kind and 1 <= len(source) <= 6 and len(re.sub(r"[^A-Za-z]", "", other)) >= 4:
            words.append(source)
        elif korean and not slots and "m" in kind and 12 <= len(source) <= 60 and "\n" not in source:
            sentences.append(source)
        elif korean and slots == ["{0}"] and len(SLOT.sub("", source).strip()) >= 3 and "\n" not in source:
            filled.append(source.replace("{0}", MARK))
        elif not korean and not slots and "l" in kind and re.fullmatch(r"[A-Z][A-Za-z ]{3,20}", source) and HANGUL.search(other):
            english.append(source)
    words.sort(key=lambda w: (not re.fullmatch(r"[가-힣]+", w), len(w)))
    mixed = []
    for i in range(max(len(words), len(sentences), len(filled))):
        for part in (words, filled, sentences):
            if i < len(part):
                mixed.append(part[i])
    return mixed, english


# Values a screen needs as they are to reach the place where data shows: ids, dates, codes, states, addresses.
SKIP_KEY = re.compile(r"(^|[a-z_])(id|Id|ID|uid|Uid|UID|sub|at|At|date|Date|time|Time|state|State|status|Status|kind|Kind|"
                      r"code|Code|version|Version|action|Action|type|Type|method|format|mode|view|owner|token|csrf|session|"
                      r"Session|href|url|Url|path|Path|hash|sha256|etag|cursor|Cursor|next|rs|modality|Modality|sex|role|"
                      r"pin|Pin|region|language|filters?|layout|sizes|query|sort|order|key|Key|color|font|unit|scope|Scope|ss|Act|rule|"
                      # the server's own wording (translated by design) and status words the page names
                      r"message|error|statusText)$")
SKIP_VALUE = re.compile(r"^$|^[\d.:/\- TZ+]+$|^[A-Z0-9_\-./:]+$|^[a-z][a-z0-9_\-.:]*$|@|^https?:|^/|^\{|^\[|^#")


class Planter:
    """Plants pool values into JSON answers; the same original value always gets the same planted value."""

    def __init__(self, pool, roles=True, codes=False):
        """codes: synthetic values written like codes (SYN-SITE, SYN-RECORD) are planted too, unless the key marks an id -
        for a page whose logic does not compare them."""
        self.pool, self.map, self.roles, self.codes = list(pool), {}, roles, codes

    def value(self, original):
        if original not in self.map:
            self.map[original] = self.pool[len(self.map) % len(self.pool)]
        return self.map[original]

    def plant(self, data, key=""):
        if isinstance(data, dict):
            return {k: self.plant(v, k) for k, v in data.items()}
        if isinstance(data, list):
            out = [self.plant(v, key) for v in data]
            # Role names are data too (a site may name its own roles): one more beside the ones the page acts on.
            if self.roles and key == "roles" and out and all(isinstance(v, str) for v in out):
                out.append(self.value("role:" + "|".join(out)))
            return out
        if isinstance(data, str) and not SKIP_KEY.search(key) and (not SKIP_VALUE.search(data) or self.codes and data.startswith("SYN")):
            return self.value(data)
        return data

    def wrap(self, route):
        return Planted(route, self)

    def planted(self):
        return sorted(set(self.map.values()))


class Planted:
    """A route whose JSON answer carries planted values."""

    def __init__(self, route, planter):
        self._route, self._planter = route, planter

    def __getattr__(self, name):
        return getattr(self._route, name)

    def fulfill(self, **kwargs):
        if "json" in kwargs:
            kwargs["json"] = self._planter.plant(copy.deepcopy(kwargs["json"]))
        return self._route.fulfill(**kwargs)


SNAPSHOT = r"""() => { const out = [document.title];
  const walk = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement; if (!p || p.closest('script,style')) continue; if (n.nodeValue.trim()) out.push(n.nodeValue); }
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) if (/^(title|alt|placeholder|aria-.+)$/.test(a.name) && a.value.trim()) out.push(a.value);
    if ((el.localName === 'input' || el.localName === 'textarea') && el.value) out.push(el.value); }
  return out; }"""


def snapshot(page, dialogs=()):
    """Every word a reader can meet on the page now, and the browser dialogs it showed."""
    return page.evaluate(SNAPSHOT) + list(dialogs)


def translations(page, values, lang):
    return page.evaluate("([vs, l]) => vs.map(v => window.KinLanguage ? KinLanguage.tr(v, l) : v)", [list(values), lang])


def check(plain, planted, values, shown, planter=None):
    """Planted values whose translation shows more often than on the plain screens; shown = translations of values.
    With the planter, each is named with the answer value it replaced (the field to look for)."""
    a, b = "\n".join(plain), "\n".join(planted)
    origin = {p: o for o, p in (planter.map.items() if planter else [])}
    found = [f"{origin.get(v, "?")!r} -> {v!r} shown as {t!r} ({b.count(t)} > {a.count(t)})" for v, t in zip(values, shown)
             if t != v and b.count(t) > a.count(t)]
    reached = [v for v in values if v in b]
    return found, reached


ENGLISH = {"version": 1, "worklist": "en", "reading": "en"}


def compare(draw, lang="en", codes=False):
    """draw(planter) -> (words met, the page still open): drawn from plain answers, then from planted ones."""
    plain, _ = draw(None)
    planter = Planter(pools()[0 if lang == "en" else 1], codes=codes)
    planted, page = draw(planter)
    values = planter.planted()
    return check(plain, planted, values, translations(page, values, lang), planter)