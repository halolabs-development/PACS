"""Screen language (Korean / English) of the worklist and reading screens: the glossary and what it must cover.

Stdlib only (Node only to read the glossary as the page does). The glossary worklist-language-terms.js must hold every
word the screens show: the words of main.html, of every script it loads, the CSS `content:` words and the Korean
error messages of the server that reach these screens. A word it lacks is named with its file and line, so a new
feature that adds words turns this test red until its words are added (tests/worklist_language_collect.py).
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import worklist_language_collect as collect  # noqa: E402

ROOT = collect.ROOT
PAGE = collect.PAGE_DIR
TERMS = PAGE / "worklist-language-terms.js"
SLOT = re.compile(r"\{[ten]?\d+\}")
HANGUL = re.compile(r"[가-힣]")
NODE = "node"


def glossary():
    script = ("global.window={};require(process.argv[1]);process.stdout.write(JSON.stringify(window.KinLanguageTerms))")
    out = subprocess.run([NODE, "-e", script, str(TERMS)], capture_output=True, check=True)
    return json.loads(out.stdout.decode("utf-8"))


class Glossary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.terms = glossary() if TERMS.exists() else None

    def setUp(self):
        self.assertIsNotNone(self.terms, "worklist-language-terms.js is missing")

    def test_every_entry_has_two_languages_and_the_same_slots(self):
        problems, seen = [], set()
        for row in self.terms["terms"]:
            source, other, kind = row[0], row[1], row[2]
            same = row[3] if len(row) > 3 else None
            if source in seen: problems.append(("duplicate", source))
            seen.add(source)
            if not source.strip() or not other.strip(): problems.append(("empty", source))
            if not re.fullmatch(r"[lms]c?", kind): problems.append(("kind", source, kind))
            korean = bool(HANGUL.search(SLOT.sub("", source)))
            if korean and HANGUL.search(SLOT.sub("", other)) and not re.search(r"한국어", other): problems.append(("not English", source, other))
            if not korean and not HANGUL.search(other) and other != source: problems.append(("not Korean", source, other))
            # Only these slots are supplied with the English suffix '' / 's'. Other UI slots must survive.
            plural = {"Attach {n0} File{t1}": {"{t1}"}, "{0} · {n1} image{t2}": {"{t2}"},
                      "{n0} image{t1}": {"{t1}"}}.get(source, set())
            for text in [other] + ([same] if same else []):
                want = sorted(s for s in SLOT.findall(source) if not (text is other and s in plural))
                have = sorted(s for s in SLOT.findall(text) if not (text is other and s in plural))
                if want != have: problems.append(("slots", source, text))
                if text is other and plural & set(SLOT.findall(text)): problems.append(("plural kept", source, text))
        self.assertEqual([], problems)

    def test_skip_and_terms_do_not_overlap_and_css_is_whole(self):
        sources = {row[0] for row in self.terms["terms"]}
        self.assertEqual(set(), sources & set(self.terms["skip"]))
        for region, selector, en, ko in self.terms["css"]:
            self.assertIn(region, ("worklist", "reading"))
            self.assertRegex(selector, r"::(before|after)$")
            self.assertTrue(en.strip() and ko.strip() and HANGUL.search(ko))

    def test_no_word_of_the_screens_is_missing(self):
        """Missing words are named file:line (screen words in main.html and its scripts, CSS, server errors)."""
        known = {row[0] for row in self.terms["terms"]} | set(self.terms["skip"])
        css = {c[2].strip() for c in self.terms["css"]}
        missing = sorted({f"{p.file}:{p.line} [{p.kind}] {p.text}" for p in collect.collect()
                          if p.text not in known and not (p.kind == "css" and p.text in css)})
        self.assertEqual([], missing, f"{len(missing)} words without a glossary entry (add them to {TERMS.name})")

    def test_every_kind_of_path_is_collected(self):
        """The collector reaches each kind of place a word comes from (paths.md): static page words and attributes,
        script words and attributes inside HTML strings, sentences built with data, error messages, CSS, the server."""
        pieces = collect.collect()
        texts = {p.text for p in pieces}
        kinds = {p.kind for p in pieces}
        self.assertEqual({"html", "js-ko", "js-en", "css", "server"}, kinds)
        for word in ("Approve", "Reset to Unread", "Approve & Next", "↻ Refresh", "Findings", "Conclusion", "RS", "Unread",
                     "서버 저장 실패: {e0}", "Clinical Context", "계정 설정이 변경되었습니다. 불러온 뒤 다시 저장하세요"):
            self.assertIn(word, texts)

    def test_collector_follows_the_sentence_writer_for_text_and_attributes(self):
        source = "kinWrite(node, 'Approve'); window.KinLanguage.write(node, 'Unread', 'title');"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.js"
            path.write_text(source, encoding="utf-8")
            words = {piece["value"] for piece in collect.parse(path) if piece["ui"]}
        self.assertTrue({"Approve", "Unread"}.issubset(words))

    def test_collector_builds_templates_where_the_code_joins_words(self):
        """Read with the TypeScript parser: joined words become one template, each part with its kind."""
        src = ("toast('서버 저장 실패: ' + e.message, 'err');\n"
               "x.textContent = `불러온 목록 중 ${rows.length}건` + (b ? ' · 일부' : '');\n"
               "el.title = '승인: ' + (ok ? '가능' : '불가') + ' · ' + name;\n"
               "body.textContent = (item.text || '(메모 비움)') + ' 사유: ' + item.reason;\n"
               "status.textContent = '조회 실패: ' + (error?.message || '응답 없음');\n")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.js"
            path.write_text(src, encoding="utf-8")
            built = sorted(t for lit in collect.parse(path) for t in collect.pieces_of(lit["value"], lit["kinds"]))
        self.assertIn("서버 저장 실패: {e0}", built)
        self.assertIn("불러온 목록 중 {n0}건{t1}", built)
        self.assertIn("승인: {t0} · {1}", built)
        self.assertIn("{0} 사유: {1}", built, "a value that may be data stays data")
        self.assertIn("조회 실패: {e0}", built)


class Page(unittest.TestCase):
    def test_language_button_sits_left_of_the_mark_and_scripts_load_first(self):
        page = (PAGE / "main.html").read_text(encoding="utf-8")
        button = page.index('id="language-open"')
        mark = page.index('id="language-label"')
        self.assertLess(button, mark)
        self.assertEqual("", page[page.index(">", button) + 1:page.index("<", button)].replace("Language", ""))
        scripts = re.findall(r'<script src="([^"]+)"', page)
        self.assertLess(scripts.index("worklist-language-terms.js"), scripts.index("worklist-language.js"))
        self.assertLess(scripts.index("worklist-language.js"), scripts.index("reading-appearance.js"))

    def test_server_accepts_appearance_version_12_with_the_language(self):
        source = (ROOT / "api/src/pacs/preferences.ts").read_text(encoding="utf-8")
        self.assertIn("'colors,current,dock,fonts,language,list,markers,mpr,prior,toolbar,version,viewer'", source)
        self.assertIn("[null, 'en', 'ko'].includes(v.worklist)", source)


if __name__ == "__main__":
    unittest.main()
