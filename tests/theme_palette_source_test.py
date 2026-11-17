"""The five-colour theme as a rule for new work: a colour is a theme variable, not a value written into a file.

Requirement: the worklist, the report editor, the viewer and the pages beside them use the dark palette (background
#212121, panels and inputs #2D2D2D, text #E3E3E3, secondary text #B4B4B4, selection/accent #8AB4C8) through the theme
variables (--kin-bg, --kin-panel, --kin-text, --kin-muted, --kin-accent, ...); meaning colours (status, warning,
error) are kept where they are.

RISK: a new panel, dialog or message brings a colour of its own, so one screen no longer looks like the others.

The check: every colour value written in a stylesheet, a page's <style> or style attribute, or a string of a page or
viewer script (read with the TypeScript parser, so comments do not count) that is not one of the five is counted per
file. A file may not have more of them than tests/theme_palette_baseline.json records (the colours of today, mostly
meaning colours and the stock values the theme file covers). A new colour is written with a theme variable instead;
a new meaning colour is added to the baseline in the same change, where a reviewer sees it.
Run: python3 -B tests/theme_palette_source_test.py   (--write-baseline only when a change removes colours or adds a
meaning colour on purpose).
"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import worklist_language_collect as collect  # noqa: E402

ROOT = collect.ROOT
PAGE = collect.PAGE_DIR
BASELINE = Path(__file__).resolve().parent / "theme_palette_baseline.json"
PALETTE = {"212121", "2d2d2d", "e3e3e3", "b4b4b4", "8ab4c8"}
# A colour: #rgb, #rgba, #rrggbb or #rrggbbaa ending where CSS ends a value; or rgb()/rgba() with three numbers.
HEX = re.compile(r"#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?=[\s;,)'\"!}`]|$)")
RGB = re.compile(r"rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})")
GENERATED = {"main-split.bundle.js", "worklist-language-terms.js"}


def colours(text):
    found = []
    for m in HEX.finditer(text):
        h = m.group(1).lower()
        found.append(("".join(c * 2 for c in h[:3]) if len(h) <= 4 else h[:6]))
    for m in RGB.finditer(text):
        found.append("%02x%02x%02x" % tuple(min(255, int(x)) for x in m.groups()))
    return [c for c in found if c not in PALETTE]


def files():
    out = sorted(p for p in PAGE.glob("*.css")) + sorted(p for p in PAGE.glob("*.html"))
    out += sorted(p for p in PAGE.glob("*.js") if p.name not in GENERATED) + sorted((ROOT / "config" / "ohif").glob("*.js"))
    return out


def count():
    """file (repository path) -> the colours outside the palette, in order."""
    result = {}
    rel = lambda p: p.relative_to(ROOT).as_posix()
    with tempfile.TemporaryDirectory() as tmp:
        # Each directory read on its own: a script is named by its file name, and the two directories share some.
        groups = {PAGE: [p for p in files() if p.suffix == ".js" and p.parent == PAGE],
                  ROOT / "config" / "ohif": [p for p in files() if p.suffix == ".js" and p.parent != PAGE]}
        for page in (p for p in files() if p.suffix == ".html"):
            text = page.read_text(encoding="utf-8")
            styles = re.findall(r"<style[^>]*>([\s\S]*?)</style>", text) + re.findall(r'\sstyle="([^"]*)"', text)
            result[rel(page)] = colours("\n".join(styles))
            inline = collect.inline_scripts(page.name, tmp)  # the page's own scripts count as the page
            for lit in collect.parse(inline):
                result[rel(page)] += colours(re.sub(r"\x00\d+\x00", " ", lit["value"]))
        for css in (p for p in files() if p.suffix == ".css"):
            result[rel(css)] = colours(css.read_text(encoding="utf-8"))
        for directory, scripts in groups.items():
            for lit in collect.parse(*scripts):
                result.setdefault(rel(directory / lit["file"]), []).extend(colours(re.sub(r"\x00\d+\x00", " ", lit["value"])))
    return {k: v for k, v in result.items() if v}


class ThemePalette(unittest.TestCase):
    def test_no_file_adds_a_colour_outside_the_theme(self):
        baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
        grown = {f"{name}: {len(found)} > {baseline.get(name, 0)} ({', '.join('#' + c for c in sorted(set(found)))})"
                 for name, found in count().items() if len(found) > baseline.get(name, 0)}
        self.assertEqual(set(), grown, "colours written into files instead of the theme variables (workspace-theme.css, "
                                       "viewer-ux-theme.css: var(--kin-bg) / --kin-panel / --kin-text / --kin-muted / --kin-accent)")

    def test_the_check_sees_each_kind_of_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            js = Path(tmp) / "sample.js"
            js.write_text("// #123456 in a comment is not a colour\nel.style.color = '#4f8ef7'; x.querySelector('#rows');"
                          " const ok = 'var(--kin-accent)'; const bg = `rgba(1, 2, 3, .5)`;\n", encoding="utf-8")
            found = [c for lit in collect.parse(js) for c in colours(lit["value"])]
        self.assertEqual(["4f8ef7", "010203"], found)
        # The five are the theme at any alpha.
        self.assertEqual([], colours("color: #E3E3E3; background: #2d2d2d80; border: 1px solid rgba(138, 180, 200, .2)"))


if __name__ == "__main__":
    if "--write-baseline" in sys.argv:
        BASELINE.write_text(json.dumps({k: len(v) for k, v in sorted(count().items())}, indent=1) + "\n", encoding="utf-8")
        print("baseline written", BASELINE)
    else:
        unittest.main()
