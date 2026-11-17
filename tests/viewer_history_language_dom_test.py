"""The viewer's saved marks list (config/ohif/history.js) on an English screen: the marks' own words stay as written.

Requirement: a reader who chose English sees the viewer's own words in English and data - a mark's title, text, key image
title and description, a spine level, held changes, the author - exactly as written, even when it equals a glossary word,
sentence or filled template.

RISK: the list draws a mark's text with the same helper as its own labels; unmarked, a mark whose text equals a glossary
entry is shown translated.

The shipped drawing code is run as it is: row() and the helpers it draws with are read out of config/ohif/history.js with
the API's TypeScript parser; what they read from the rest of the viewer (session, saving, navigation) is a stand-in. The
real glossary and screen-language module translate the page. The list is drawn from plain and from planted marks
(language_data_probe) and compared.
"""
import json
import subprocess
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

import language_data_probe as probe

ROOT = Path(__file__).resolve().parents[1]
HISTORY = ROOT / "config" / "ohif" / "history.js"
HPACS = ROOT / "worklist-v0" / "hpacs-lite"
SHIPPED = ["ORTHO", "names", "lineMark", "valueMark", "measureMark", "manual", "text", "data", "button", "input", "hasWork", "row"]


def shipped(names):
    """The declarations of names anywhere in history.js, in the order asked."""
    script = r"""const fs=require('fs'), ts=require('./api/node_modules/typescript');
      const file=process.argv[1], names=JSON.parse(process.argv[2]), found=new Map();
      const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
      (function walk(n){
        if(ts.isFunctionDeclaration(n)&&n.name&&names.includes(n.name.text)&&!found.has(n.name.text))found.set(n.name.text,n.getText(source));
        if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&names.includes(n.name.text)&&!found.has(n.name.text))
          found.set(n.name.text,'const '+n.getText(source)+';');
        ts.forEachChild(n,walk);
      })(source);
      const missing=names.filter(n=>!found.has(n)); if(missing.length)throw Error('missing '+missing);
      process.stdout.write(names.map(n=>found.get(n)).join('\n'));"""
    return subprocess.check_output(["node", "-e", script, str(HISTORY), json.dumps(names)], cwd=ROOT).decode("utf-8")


STAND_IN = """
const list = document.querySelector('#list');
let generation = 0; const scope = 'SYN-STUDY', entries = new Map();
const readOnly = () => false, writer = () => true, writable = () => true, valid = () => true;
const navigate = () => {}, load = () => {}, updateAnnotation = () => {}, valueNode = () => {};
"""


def marks(words):
    """A memo, a key image and a spine label, each saved; the memo with held changes. words: the 8 texts they carry."""
    memo_title, memo_text, key_title, key_text, spine, held_text, held_note, author = words
    head = lambda rid: {"id": rid, "revision": 2, "authorActor": author, "hidden": False, "item": {}, "referenceStatus": "verified"}
    return [
        {"id": "m1", "draft": {"kind": "memo", "title": memo_title, "label": memo_text, "frame": 3}, "head": head("h1"),
         "heldDraft": {"label": held_text, "description": held_note, "frame": 3}},
        {"id": "m2", "draft": {"kind": "key", "title": key_title, "description": key_text, "frame": 4}, "head": head("h2")},
        {"id": "m3", "draft": {"kind": "spine", "label": spine, "frame": 5}, "head": head("h3")},
    ]


class ViewerHistoryLanguage(unittest.TestCase):
    def test_english_list_shows_the_marks_words_as_written(self):
        code = STAND_IN + shipped(SHIPPED)
        planted = probe.pools()[0][:8]
        plain = [f"SYN mark text {i}" for i in range(8)]

        def draw(words):
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                page = browser.new_page()
                page.add_init_script("localStorage.setItem('kin-language:v1', JSON.stringify(%s))" % json.dumps(probe.ENGLISH))
                page.route("https://history.test/", lambda route: route.fulfill(
                    body='<!doctype html><html data-kin-language-source="browser" data-kin-lang-region="reading"><body><div id="list"></div></body></html>',
                    content_type="text/html"))
                page.goto("https://history.test/")
                for name in ("worklist-language-terms.js", "worklist-language.js"):
                    page.add_script_tag(path=str(HPACS / name))
                page.evaluate("([code, entries]) => { new Function('entries_', code + '\\nfor (const e of entries_) row(e);')(entries); }",
                              [code, marks(words)])
                page.wait_for_timeout(300)
                self.assertEqual("en", page.evaluate("document.documentElement.getAttribute('data-kin-lang-reading')"))
                seen = probe.snapshot(page)
                shown = probe.translations(page, words, "en")
                browser.close()
                return seen, shown

        before, _ = draw(plain)
        after, shown = draw(planted)
        found, reached = probe.check(before, after, planted, shown)
        self.assertEqual([], found)
        self.assertEqual(sorted(planted), sorted(reached), "every planted text is on the list")
        self.assertIn("Held Changes", "\n".join(after))


if __name__ == "__main__":
    unittest.main()
