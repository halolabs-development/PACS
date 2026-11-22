"""The HALO icon on the Admin, Clinician Home and Audit pages, the same as on the work page.

What "the same" means is read from the work page itself (main.html), not written down here: its browser tab icon links
(rel, type, sizes, href, in order) and the picture at the start of its header brand. The shipped files are served by a
local HTTP server (/kin-brand/ is proxy/branding/, as the proxy serves it) with a synthetic session, and opened in full
Chromium (the headless shell never asks for a tab icon, so it cannot see a missing one). Each of the three pages must have
  - exactly the work page's tab icon links, each answered 200 with a picture that decodes, and on a fresh origin no
    request for /favicon.ico in the server's log (before, Admin and Audit asked for it and got 404);
  - at 1366, 1024 and 380 px, as the first thing in its header brand a decorative image (alt="") of the work page's
    header icon file (same bytes), drawn at the work page's size, with the brand's words and every header control's
    name, order and target unchanged, and every visible header control reachable: scrolled into view it is inside the
    header, apart from the others and the icon, and the point at its centre is the control itself (or its child).
On Audit the icon is part of the brand link (pressing it goes to the work page), and when the server says the account
is not a designated auditor the header goes away with the icon.
"""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "worklist-v0/hpacs-lite"
BRANDING = ROOT / "proxy/branding"
PAGES = {  # page -> (role of the synthetic session, header selector, brand selector)
    "admin.html": ("admin", "body > header", "body > header > .brand"),
    "clinician.html": ("clinician", "body > header", "body > header > .brand"),
    "audit.html": ("radiologist", "#audit-workspace > header", "#audit-workspace > header > a[href='main.html']"),
}
WIDTHS = (1366, 1024, 380)
USER = "Synthetic Member With A Long Display Name"
# The header controls as they were before the icon, in order (name, target); the session's name button is left out.
HEADER_CONTROLS = {
    "admin.html": [("A", "Worklist", "main.html"), ("BUTTON", "Product Information", None), ("BUTTON", "Log out", None)],
    "clinician.html": [("BUTTON", "Physician ▾", None), ("BUTTON", "Product Information", None), ("BUTTON", "Log out", None)],
    "audit.html": [("A", "HALO PACS", "main.html"), ("BUTTON", "Log out", None)],
}
TYPES = {"svg": "image/svg+xml", "png": "image/png", "js": "text/javascript", "css": "text/css",
         "html": "text/html; charset=utf-8", "json": "application/json"}


class WorkPage(HTMLParser):
    """The work page's tab icon links and the image inside its header brand, from the shipped main.html."""

    def __init__(self):
        super().__init__()
        self.icons, self.brand_img, self._brand = [], None, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "link" and "icon" in (a.get("rel") or "").split():
            self.icons.append((a.get("rel"), a.get("type"), a.get("sizes"), a.get("href")))
        if tag == "div" and "brand" in (a.get("class") or "").split():
            self._brand = True
        elif tag == "img" and self._brand and self.brand_img is None:
            self.brand_img = a.get("src")


def local_file(path):
    for prefix, folder in (("/worklist/hpacs-lite/", ASSETS), ("/kin-brand/", BRANDING)):
        if path.startswith(prefix) and "/" not in path[len(prefix):]:
            file = folder / path[len(prefix):]
            return file if file.is_file() else None
    return None


class Site:
    """One origin: the shipped files and a synthetic session; every request is logged with its status."""

    def __init__(self, role, auditor=True):
        self.role, self.auditor, self.log = role, auditor, []
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                site.answer(self, "GET")

            def do_POST(self):
                site.answer(self, "POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def answer(self, handler, method):
        path = urlsplit(handler.path).path
        file = local_file(path) if method == "GET" else None
        if file is not None:
            status, kind, body = 200, TYPES.get(file.suffix[1:], "application/octet-stream"), file.read_bytes()
        else:
            status, data = 404, {}
            if path == "/api/me":
                status, data = 200, {"sub": "syn-member", "user": USER, "displayName": USER, "institution": "SYN-SITE",
                                     "kind": "member", "sessionId": "S1", "roles": [self.role]}
            elif path == "/api/emr-audit/intake-context":
                status, data = (200, {"institutionId": "SYN-SITE", "verifier": {"id": "syn", "issuer": "syn", "subject": "syn"}}) \
                    if self.auditor else (403, {"code": "AuditorNotDesignated"})
            kind, body = "application/json", json.dumps(data).encode()
        self.log.append((path, status))
        handler.send_response(status)
        handler.send_header("Content-Type", kind)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class HaloIconPages(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        work = WorkPage()
        work.feed((ASSETS / "main.html").read_text(encoding="utf-8"))
        assert work.icons and work.brand_img, "main.html has tab icons and a header icon"
        cls.work = work
        cls.work_icon = (ASSETS / work.brand_img).read_bytes()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(channel="chromium", headless=True)
        # The size the work page draws its header icon at (its menu bar brand), measured on the shipped main.html.
        site = Site("radiologist")
        try:
            context = cls.browser.new_context(viewport={"width": 1366, "height": 800}, java_script_enabled=False)
            page = context.new_page()
            page.goto(f"{site.origin}/worklist/hpacs-lite/main.html")
            cls.work_size = page.locator(".menubar .brand img").first.evaluate(
                "e => [getComputedStyle(e).width, getComputedStyle(e).height]")
            context.close()
        finally:
            site.close()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def site(self, name, **kwargs):
        site = Site(PAGES[name][0], **kwargs)
        self.addCleanup(site.close)
        return site

    def open(self, browser, site, name, width, shown=True):
        context = browser.new_context(viewport={"width": width, "height": 800})
        self.addCleanup(context.close)
        page = context.new_page()
        page.goto(f"{site.origin}/worklist/hpacs-lite/{name}")
        page.wait_for_load_state("load")
        if not shown:
            return page
        page.wait_for_selector(PAGES[name][1], state="visible")
        if name == "clinician.html":  # the session's name button is filled in after the session is read
            expect(page.locator("#session-who")).to_be_visible()
        return page

    def test_tab_icons_are_the_work_pages_and_no_favicon_ico_is_asked_for(self):
        for name in PAGES:
            with self.subTest(page=name):
                site = self.site(name)
                browser = self.pw.chromium.launch(channel="chromium", headless=True)  # nothing cached for this origin
                self.addCleanup(browser.close)
                page = self.open(browser, site, name, 1366)
                page.wait_for_timeout(1500)  # the browser asks for the tab icon after the page has loaded
                asked = [entry for entry in site.log if entry[0] == "/favicon.ico" or entry[0].startswith("/kin-brand/")]
                self.assertNotIn("/favicon.ico", [path for path, _ in asked])
                self.assertTrue(asked and all(status == 200 for _, status in asked), f"the browser's tab icon: {asked}")
                links = page.evaluate("""() => [...document.querySelectorAll('head link')]
                    .filter(l => l.relList.contains('icon'))
                    .map(l => [l.getAttribute('rel'), l.getAttribute('type'), l.getAttribute('sizes'), l.getAttribute('href')])""")
                self.assertEqual([tuple(link) for link in links], self.work.icons)
                for _rel, _type, sizes, href in self.work.icons:
                    drawn = page.evaluate("""href => new Promise(done => { const i = new Image();
                        i.onload = () => done([i.naturalWidth, i.naturalHeight]); i.onerror = () => done(null); i.src = href; })""", href)
                    self.assertIsNotNone(drawn, href)
                    if sizes:
                        self.assertEqual("x".join(map(str, drawn)), sizes, href)
                    self.assertIn((href, 200), site.log)

    def test_header_icon_is_the_work_pages_and_the_header_keeps_its_controls(self):
        for name, (_role, header, brand) in PAGES.items():
            site = self.site(name)
            for width in WIDTHS:
                with self.subTest(page=name, width=width):
                    page = self.open(self.browser, site, name, width)
                    head = page.locator(header)
                    icon = page.locator(f"{brand} > img:first-child")
                    self.assertEqual(icon.count(), 1, "one image at the start of the header brand")
                    self.assertEqual(icon.get_attribute("alt"), "")
                    icon.scroll_into_view_if_needed()
                    page.wait_for_function("img => img.complete && img.naturalWidth > 0", arg=icon.element_handle())
                    src = icon.evaluate("img => img.src")
                    self.assertEqual(urljoin(f"{site.origin}/worklist/hpacs-lite/main.html", self.work.brand_img), src)
                    self.assertEqual(local_file(urlsplit(src).path).read_bytes(), self.work_icon)
                    self.assertEqual(icon.evaluate("e => [getComputedStyle(e).width, getComputedStyle(e).height]"), self.work_size)
                    self.assertEqual(page.locator(brand).inner_text().strip(), "HALO PACS")
                    controls = head.evaluate("""h => [...h.querySelectorAll('a, button')]
                        .filter(e => e.getClientRects().length)
                        .map(e => [e.tagName, e.textContent.trim().replace(/\\s+/g, ' '), e.getAttribute('href')])""")
                    self.assertEqual([tuple(c) for c in controls if c[1] != USER], HEADER_CONTROLS[name])
                    boxes = head.evaluate("""h => {
                        const items = [...h.querySelectorAll('a, button, .brand > img, a > img')].filter(e => e.getClientRects().length);
                        return items.map(e => {
                            e.scrollIntoView({block: 'nearest', inline: 'nearest'});
                            const r = e.getBoundingClientRect(), hr = h.getBoundingClientRect();
                            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                            return {name: e.tagName + ':' + (e.textContent.trim() || e.getAttribute('src')), img: e.tagName === 'IMG',
                                    left: r.left - hr.left, right: r.right - hr.left, top: r.top - hr.top, bottom: r.bottom - hr.top,
                                    width: hr.width, inLink: Boolean(e.parentElement.closest('a')),
                                    hit: Boolean(top && (top === e || e.contains(top)))};
                        });
                    }""")
                    for item in boxes:
                        self.assertTrue(item["hit"], f"{item['name']} is covered")
                        self.assertGreaterEqual(item["left"], -0.5, item["name"])
                        self.assertLessEqual(item["right"], item["width"] + 0.5, f"{item['name']} is pushed out of the header")
                    for i, a in enumerate(boxes):
                        for b in boxes[i + 1:]:
                            if (a["img"] and a["inLink"]) or (b["img"] and b["inLink"]):
                                continue  # the Audit icon is inside its brand link
                            apart = (a["right"] <= b["left"] + 0.5 or b["right"] <= a["left"] + 0.5
                                     or a["bottom"] <= b["top"] + 0.5 or b["bottom"] <= a["top"] + 0.5)
                            self.assertTrue(apart, f"{a['name']} overlaps {b['name']}")

    def test_audit_icon_is_the_brand_link_and_goes_with_the_header(self):
        site = self.site("audit.html")
        page = self.open(self.browser, site, "audit.html", 1366)
        page.locator(f"{PAGES['audit.html'][2]} > img").click()
        page.wait_for_url(f"{site.origin}/worklist/hpacs-lite/main.html")
        denied = self.site("audit.html", auditor=False)
        page = self.open(self.browser, denied, "audit.html", 1366, shown=False)
        for _ in range(100):  # until the server has refused the auditor
            if ("/api/emr-audit/intake-context", 403) in denied.log:
                break
            page.wait_for_timeout(50)
        self.assertIn(("/api/emr-audit/intake-context", 403), denied.log)
        expect(page.locator(PAGES["audit.html"][1])).to_be_hidden()
        expect(page.locator(f"{PAGES['audit.html'][2]} > img")).to_be_hidden()


if __name__ == "__main__":
    unittest.main()
