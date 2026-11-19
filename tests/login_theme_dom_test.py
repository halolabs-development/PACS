# coding: utf-8
"""kin-login theme: the forgot-password link on the Keycloak login page (A3 C-R01-114#5, C-R03-143#12).

The page is the markup Keycloak 26.7.3's base template.ftl + login.ftl render with the keycloak theme's classes
(html.login-pf, header, language button, page title, username, password, hidden password toggle, settings row with the
forgot-password link, Login button, registration link), styled by the shipped login.css and running the scripts
theme.properties lists, as template.ftl loads them in <head>. Texts are the theme's messages_ko.properties. Keycloak's
stylesCommon (PatternFly from the server jar) is not in this repository and is not loaded; login.css sets the link's
size, line height and colour itself.

  01  the link is drawn as its own text: a box with height, Playwright-visible, one accessible name equal to the
      message, no generated duplicate; a click opens the reset page.
  02  keyboard: Tab follows the screen (password -> Login -> forgot-password -> registration); Enter on the link
      opens the reset page.
  03  the link stays where it was drawn: under the Login button, left of the TLS note, above the registration line.
  04  the administrator's OTP code page (keycloak/README.md 관리자 OTP 필수) shows its button's own "로그인"; only the
      password form draws the label beside a transparent button.
  05  a phone-sized window (375x667) keeps the card, its button and the notice links inside the window, on the login,
      OTP code and OTP set-up pages.
  07  the Halo Labs design of the company's other products: charcoal ground, top bar with the HALO LABS logo and the
      product name, product line and picture left of the sign-in column, the HALO mark, accent button with dark text;
      every picture is a file of this theme and no old name is drawn.

Synthetic data only; no server, no credentials.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys
import unittest
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
THEME = ROOT / "keycloak" / "themes" / "kin-login" / "login"
ORIGIN = "https://login.test"
RESOURCES = "/auth/resources/kin-login/"
RESET = "/auth/realms/kin/login-actions/reset-credentials"
KINDS = {".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
         ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg"}


def properties(path):
    """Keycloak .properties (UTF-8 in this theme): key=value lines."""
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            rows[key.strip()] = value.strip()
    return rows


THEME_PROPERTIES = properties(THEME / "theme.properties")
MSG = properties(THEME / "messages" / "messages_ko.properties")
FORGOT = MSG["doForgotPassword"]
HEAD = "".join(f'<link href="{RESOURCES}{style}" rel="stylesheet">' for style in THEME_PROPERTIES["styles"].split()) + \
    "".join(f'<script src="{RESOURCES}{script}" type="text/javascript"></script>' for script in THEME_PROPERTIES["scripts"].split())
LOGIN = f"""<!doctype html><html class="login-pf" lang="ko" dir="ltr"><head><meta charset="utf-8">
<title>{MSG["loginTitle"]}</title>{HEAD}</head>
<body class="" data-page-id="login-login">
<div class="login-pf-page">
 <div id="kc-header" class="login-pf-page-header"><div id="kc-header-wrapper" class="">KIN</div></div>
 <div class="card-pf">
  <header class="login-pf-header">
   <div class="pf-c-dropdown" id="kc-locale"><div id="kc-locale-wrapper" class="">
    <div id="kc-locale-dropdown" class="menu-button-links ">
     <button tabindex="1" id="kc-current-locale-link" aria-label="languages" aria-haspopup="true" aria-expanded="false" aria-controls="language-switch1">한국어</button>
     <ul role="menu" tabindex="-1" aria-labelledby="kc-current-locale-link" aria-activedescendant="" id="language-switch1" class="pf-c-dropdown__menu pf-m-align-right">
      <li class="" role="none"><a role="menuitem" id="language-1" class="pf-c-dropdown__menu-item" href="?kc_locale=en">English</a></li>
      <li class="" role="none"><a role="menuitem" id="language-2" class="pf-c-dropdown__menu-item" href="?kc_locale=ko">한국어</a></li>
     </ul></div></div></div>
   <h1 id="kc-page-title">{MSG["loginAccountTitle"]}</h1>
  </header>
  <div id="kc-content"><div id="kc-content-wrapper">
   <div id="kc-form"><div id="kc-form-wrapper">
    <form id="kc-form-login" onsubmit="login.disabled = true; return true;" action="/auth/realms/kin/login-actions/authenticate" method="post">
     <div class="form-group"><label for="username" class="pf-c-form__label pf-c-form__label-text">{MSG["usernameOrEmail"]}</label>
      <input tabindex="2" id="username" class="pf-c-form-control" name="username" value="" type="text" autofocus autocomplete="username" aria-invalid="" dir="ltr"></div>
     <div class="form-group"><label for="password" class="pf-c-form__label pf-c-form__label-text">{MSG["password"]}</label>
      <div class="pf-c-input-group" dir="ltr">
       <input tabindex="3" id="password" class="pf-c-form-control" name="password" type="password" autocomplete="current-password" aria-invalid="">
       <button class="pf-c-button pf-m-control" type="button" aria-label="Show password" aria-controls="password" data-password-toggle tabindex="4"><i class="fa fa-eye" aria-hidden="true"></i></button>
      </div></div>
     <div class="form-group login-pf-settings">
      <div id="kc-form-options"></div>
      <div class="">
       <span><a tabindex="6" href="{RESET}">{FORGOT}</a></span>
      </div>
     </div>
     <div id="kc-form-buttons" class="form-group"><input type="hidden" id="id-hidden-input" name="credentialId">
      <input tabindex="7" class="pf-c-button pf-m-primary pf-m-block btn-lg" name="login" id="kc-login" type="submit" value="{MSG["doLogIn"]}"></div>
    </form></div></div>
   <div id="kc-info" class="login-pf-signup"><div id="kc-info-wrapper" class=""><div id="kc-registration-container"><div id="kc-registration">
    <span>{MSG["noAccount"]} <a tabindex="8" href="/auth/realms/kin/login-actions/registration">{MSG["doRegister"]}</a></span>
   </div></div></div></div>
  </div></div>
 </div>
</div></body></html>"""
# keycloak/README.md 관리자 OTP 필수: the administrator's one-time code page (26.7.3 login-otp.ftl as served with this theme).
OTP_PATH = "/auth/realms/kin/login-actions/authenticate"
OTP = f"""<!doctype html><html class="login-pf" lang="ko" dir="ltr"><head><meta charset="utf-8">
<title>{MSG["loginTitle"]}</title>{HEAD}</head>
<body class="" data-page-id="login-login-otp">
<div class="login-pf-page">
 <div id="kc-header" class="login-pf-page-header"><div id="kc-header-wrapper" class="">KIN</div></div>
 <div class="card-pf"><header class="login-pf-header"><h1 id="kc-page-title">{MSG["loginAccountTitle"]}</h1></header>
  <div id="kc-content"><div id="kc-content-wrapper">
   <form id="kc-otp-login-form" class="form-horizontal" onsubmit="login.disabled = true; return true;" action="{OTP_PATH}" method="post">
    <div class="form-group"><div class="col-xs-12 col-sm-12 col-md-12 col-lg-12">
     <label for="otp" class="pf-c-form__label pf-c-form__label-text">일회용 코드</label></div>
     <div class="col-xs-12 col-sm-12 col-md-12 col-lg-12">
      <input id="otp" name="otp" autocomplete="one-time-code" type="text" class="pf-c-form-control" autofocus="" aria-invalid="" dir="ltr"></div></div>
    <div class="form-group"><div id="kc-form-options" class="col-xs-12 col-sm-12 col-md-12 col-lg-12"><div class=""></div></div>
     <div id="kc-form-buttons" class="col-xs-12 col-sm-12 col-md-12 col-lg-12">
      <input class="pf-c-button pf-m-primary pf-m-block btn-lg" name="login" id="kc-login" type="submit" value="{MSG["doLogIn"]}"></div></div>
   </form></div></div>
 </div>
</div></body></html>"""
# The administrator's first OTP set-up page (26.7.3 login-config-totp.ftl's shape as served with this theme): the widest card.
TOTP_SETUP_PATH = "/auth/realms/kin/login-actions/required-action"
TOTP_SETUP = f"""<!doctype html><html class="login-pf" lang="ko" dir="ltr"><head><meta charset="utf-8">
<title>{MSG["loginTitle"]}</title>{HEAD}</head>
<body class="" data-page-id="login-login-config-totp">
<div class="login-pf-page">
 <div id="kc-header" class="login-pf-page-header"><div id="kc-header-wrapper" class="">KIN</div></div>
 <div class="card-pf"><header class="login-pf-header"><h1 id="kc-page-title">{MSG["loginTotpTitle"]}</h1></header>
  <div id="kc-content"><div id="kc-content-wrapper">
   <ol id="kc-totp-settings">
    <li><p>{MSG["loginTotpStep1"]}</p><ul id="kc-totp-supported-apps"><li>SYN Authenticator</li></ul></li>
    <li><p>{MSG["loginTotpStep2"]}</p><img id="kc-totp-secret-qr-code" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" alt="Figure: Barcode"></li>
    <li><p>{MSG["loginTotpStep3"]}</p><p>{MSG["loginTotpStep3DeviceName"]}</p></li>
   </ol>
   <form action="{TOTP_SETUP_PATH}" class="form-horizontal" id="kc-totp-settings-form" method="post">
    <div class="form-group"><label for="totp" class="control-label">{MSG["authenticatorCode"]}</label>
     <input type="text" id="totp" name="totp" autocomplete="off" class="pf-c-form-control"></div>
    <div class="form-group"><label for="userLabel" class="control-label">{MSG["loginTotpDeviceName"]}</label>
     <input type="text" class="pf-c-form-control" id="userLabel" name="userLabel" autocomplete="off"></div>
    <input type="submit" class="pf-c-button pf-m-primary pf-m-block btn-lg" id="saveTOTPBtn" value="{MSG["doSubmit"]}">
   </form></div></div>
 </div>
</div></body></html>"""
# Which element has focus, by the name a person would use.
FOCUSED = """() => { const e = document.activeElement;
  return e.id === 'kc-login' ? 'Login' : e.id || e.textContent.trim(); }"""


class LoginThemeDomTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.unexpected, self.errors, self.served, self.missing = [], [], [], []
        self.context = self.browser.new_context(viewport={"width": 1600, "height": 1050})
        self.context.route("**/*", self.route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(ORIGIN + "/auth/realms/kin/protocol/openid-connect/auth")
        expect(self.page.locator("#kc-login")).to_be_visible()
        self.link = self.page.locator("#kc-form-login .login-pf-settings a")

    def tearDown(self):
        self.context.close()
        self.assertEqual([], self.errors, "page errors")
        self.assertEqual([], self.unexpected, "requests the harness does not answer")
        self.assertEqual([], self.missing, "theme files the page asks for that the theme does not have")

    def route(self, route):
        url = urlparse(route.request.url)
        if f"{url.scheme}://{url.netloc}" != ORIGIN:
            self.unexpected.append(route.request.url)
            return route.abort()
        if url.path == "/auth/realms/kin/protocol/openid-connect/auth":
            return route.fulfill(body=LOGIN, content_type="text/html; charset=utf-8")
        if url.path == TOTP_SETUP_PATH:
            return route.fulfill(body=TOTP_SETUP, content_type="text/html; charset=utf-8")
        if url.path == OTP_PATH:
            return route.fulfill(body=OTP, content_type="text/html; charset=utf-8")
        if url.path == RESET:
            return route.fulfill(body="<!doctype html><title>SYN 비밀번호 재설정</title>", content_type="text/html; charset=utf-8")
        if url.path.startswith(RESOURCES):
            local = THEME / "resources" / url.path[len(RESOURCES):]
            if local.is_file():
                self.served.append(url.path[len(RESOURCES):])
                return route.fulfill(path=str(local), content_type=KINDS.get(local.suffix, "application/octet-stream"))
            self.missing.append(url.path)
        if url.path.startswith(("/kin-brand/", "/worklist/legal/")) or url.path.endswith((".png", ".jpg", ".svg", ".woff2")):
            return route.fulfill(status=404, body="")
        self.unexpected.append(f"{route.request.method} {url.path}")
        return route.abort()

    def test_04_the_otp_code_page_button_shows_its_own_label(self):
        """The password form draws "로그인" beside a transparent button; the OTP page reuses #kc-login with no drawn label,
        so its button must show its own text (it was blank)."""
        drawn = "(e) => [getComputedStyle(e).color, getComputedStyle(e.parentElement, '::after').content]"
        color, label = self.page.locator("#kc-login").evaluate(drawn)
        self.assertEqual((color, label), ("rgba(0, 0, 0, 0)", '"로그인"'), "the password form: one drawn label")
        self.page.goto(ORIGIN + OTP_PATH)
        button = self.page.locator("#kc-otp-login-form #kc-login")
        expect(button).to_be_visible()
        color, label = button.evaluate(drawn)
        self.assertNotEqual(color, "rgba(0, 0, 0, 0)", "the OTP button's own text is drawn")
        self.assertEqual(label, "none", "and nothing is drawn beside it")
        expect(self.page.get_by_role("button", name=MSG["doLogIn"], exact=True)).to_be_visible()

    def test_01_link_is_drawn_as_its_own_text_and_opens_reset(self):
        box = self.link.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreater(box["width"], 0)
        self.assertGreater(box["height"], 0)
        expect(self.link).to_be_visible()
        expect(self.link).to_have_text(FORGOT)
        # One link with that accessible name, named once.
        expect(self.page.get_by_role("link", name=FORGOT, exact=True)).to_have_count(1)
        self.page.get_by_role("link", name=FORGOT, exact=True).click()
        expect(self.page).to_have_title("SYN 비밀번호 재설정")

    def test_02_tab_follows_the_screen_and_enter_opens_reset(self):
        self.page.locator("#password").focus()
        order = []
        for _ in range(3):
            self.page.keyboard.press("Tab")
            order.append(self.page.evaluate(FOCUSED))
        self.assertEqual(["Login", FORGOT, "가입 신청"], order)
        self.page.locator("#kc-login").focus()
        self.page.keyboard.press("Tab")
        self.assertEqual(FORGOT, self.page.evaluate(FOCUSED))
        self.page.keyboard.press("Enter")
        expect(self.page).to_have_title("SYN 비밀번호 재설정")

    def test_03_link_stays_under_the_login_button(self):
        place = self.page.evaluate("""() => {
          const r = s => document.querySelector(s).getBoundingClientRect();
          const settings = document.querySelector('#kc-form-login .login-pf-settings');
          return {login: r('#kc-login').bottom, link: r('#kc-form-login .login-pf-settings a'),
                  register: r('#kc-registration a').top, settings: settings.getBoundingClientRect(),
                  note: getComputedStyle(settings, '::after').content}; }""")
        self.assertGreater(place["link"]["top"], place["login"])
        self.assertLess(place["link"]["bottom"], place["register"])
        self.assertLess(place["link"]["left"] - place["settings"]["left"], place["settings"]["width"] / 2)
        self.assertIn("TLS", place["note"])

    def test_05_a_phone_sized_window_keeps_the_card_inside(self):
        """375x667: the card (and its first letters) stays inside the window, the page does not scroll sideways, and the
        notice links sit under the card, not beside it. The OTP code page and the wider OTP set-up page keep the same shape."""
        measure = """() => { const r = s => document.querySelector(s).getBoundingClientRect();
          return {card: r('.card-pf'), links: r('#kin-legal-links'), width: innerWidth,
                  scroll: document.documentElement.scrollWidth}; }"""
        self.page.set_viewport_size({"width": 375, "height": 667})
        for path in ("/auth/realms/kin/protocol/openid-connect/auth", OTP_PATH, TOTP_SETUP_PATH):
            with self.subTest(path=path):
                self.page.goto(ORIGIN + path)
                expect(self.page.locator("#kin-legal-links")).to_be_attached()
                place = self.page.evaluate(measure)
                self.assertGreaterEqual(place["card"]["left"], 0, "card starts inside the window")
                self.assertLessEqual(place["card"]["right"], place["width"], "card ends inside the window")
                self.assertLessEqual(place["scroll"], place["width"], "no sideways scrolling")
                self.assertGreaterEqual(place["links"]["top"], place["card"]["bottom"], "notice links under the card")
                button = self.page.locator("#kc-login, #saveTOTPBtn").first
                button.scroll_into_view_if_needed()
                edge = button.bounding_box()
                self.assertGreaterEqual(edge["x"], 0, "the button's left edge is inside the window")
                self.assertLessEqual(edge["x"] + edge["width"], place["width"], "the button's right edge is inside the window")
                if path == TOTP_SETUP_PATH:
                    self.assertGreater(self.page.locator("#kc-totp-secret-qr-code").evaluate("(i) => i.naturalWidth"), 0)

    def test_07_the_page_wears_the_halo_labs_design(self):
        """Like the other Halo Labs products' first screen: charcoal ground, a top bar with the HALO LABS logo and the product
        name, the product line and picture left of the sign-in column, the HALO mark over the title, the one accent on the
        sign-in button with dark text. Every picture the page draws is a file of this theme, and no old name is drawn."""
        look = self.page.evaluate("""() => {
          const css = (s, pseudo, prop) => getComputedStyle(document.querySelector(s), pseudo || null)[prop];
          const box = s => document.querySelector(s).getBoundingClientRect();
          return {
            ground: css('body', null, 'backgroundColor'),
            bar: css('body', '::before', 'backgroundImage'), barTop: css('body', '::before', 'top'),
            name: css('body', '::after', 'content'),
            mark: css('.login-pf-header', null, 'backgroundImage'),
            art: css('#kc-header', '::after', 'backgroundImage'),
            eyebrow: css('#kc-header', '::before', 'content'),
            line: css('#kc-header-wrapper', '::before', 'content') + css('#kc-header-wrapper', '::after', 'content'),
            foot: css('.login-pf-page', '::after', 'content'),
            button: css('#kc-login', null, 'backgroundColor'), label: css('#kc-form-buttons', '::after', 'color'),
            title: document.querySelector('#kc-page-title').textContent.trim(), titleSize: css('#kc-page-title', null, 'fontSize'),
            realmName: (() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#kc-header-wrapper'));
              return Array.from(r.getClientRects()).reduce((a, b) => a + b.width * b.height, 0); })(),
            story: box('#kc-header'), card: box('.card-pf'), links: box('#kin-legal-links'),
            favicons: Array.from(document.querySelectorAll('link[rel~=icon]')).map(l => l.getAttribute('href')),
          }; }""")
        self.assertEqual(look["ground"], "rgb(33, 33, 33)")
        self.assertIn("halo-labs-light-text.svg", look["bar"])
        self.assertEqual(look["barTop"], "0px")
        self.assertEqual(look["name"], '"HALO PACS"')
        self.assertIn("halo-icon.svg", look["mark"])
        self.assertIn("halo-pacs-art.svg", look["art"])
        self.assertEqual(look["eyebrow"], '"HALO PACS"')
        self.assertEqual((look["button"], look["label"]), ("rgb(138, 180, 200)", "rgb(33, 33, 33)"), "accent with dark text")
        self.assertEqual(look["title"], MSG["loginAccountTitle"], "the page title is drawn as its own text")
        self.assertNotEqual(look["titleSize"], "0px")
        self.assertIn("주식회사 헤일로랩스", look["foot"])
        self.assertEqual(look["realmName"], 0, "the realm's own name (the old name on the server) takes no space on the page")
        for drawn in (look["name"], look["eyebrow"], look["line"], look["foot"], MSG["loginTitle"]):
            self.assertNotRegex(drawn.upper(), r"KOREA|IMAGING NETWORK|\bKIN\b", drawn)
        # Product line on the left, sign-in column on the right, notices under the sign-in column.
        self.assertLess(look["story"]["right"], look["card"]["left"])
        self.assertGreaterEqual(look["links"]["top"], look["card"]["bottom"] - 1)
        self.assertGreaterEqual(look["links"]["left"], look["card"]["left"] - 1)
        # Every picture the page and theme.properties name is served from this theme.
        self.page.wait_for_load_state("networkidle")
        self.assertTrue({"img/halo-labs-light-text.svg", "img/halo-icon.svg", "img/halo-pacs-art.svg"} <= set(self.served),
                        self.served)
        # theme.properties may add a version query (?v=…) so browsers drop a cached old look; the file is the part before it.
        css = "".join((THEME / "resources" / style.split("?")[0]).read_text(encoding="utf-8")
                      for style in THEME_PROPERTIES["styles"].split())
        icons = {THEME_PROPERTIES.get(k + ".type") for k in THEME_PROPERTIES if re.fullmatch(r"favicons\.\d+", k)}
        self.assertEqual(icons, {"image/svg+xml", "image/png"}, "the tab has the HALO mark and a PNG fallback")
        named = set(re.findall(r'url\("\.\./(img/[^"]+)"\)', css))
        named |= {v.split("?")[0] for k, v in THEME_PROPERTIES.items() if re.fullmatch(r"favicons\.\d+", k)}
        for name in sorted(named):
            with self.subTest(file=name):
                self.assertTrue((THEME / "resources" / name).is_file(), name)
                self.assertFalse(Path(name).name.startswith("kin-"), "pictures carry the product's name, not the old one")
        self.assertFalse(list((THEME / "resources" / "img").glob("kin-*")), "no old picture left in the theme")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
