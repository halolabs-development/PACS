"""The login server's error page on the real stack: every way a person lands on it has one way back into HALO PACS.

Keycloak 26.7.3 draws its error page (error.ftl) for a reset link that no longer works, a login whose cookie is gone, a
login request naming a client that does not exist, and a login request with a wrong return address. Its base page drew a
link only when the request named a client with a base URL - the product's own login client has none - so the page was a
dead end. The kin-login theme now draws "HALO PACS로 돌아가기" on every error page: the product's login start
(/api/auth/login, the address the registration success page's "HALO PACS로 계속" already uses), nothing attached.

Each entry is opened through the real proxy in a fresh browser (no session): the page is Keycloak's error page with its
own message, and the one link in it is the way back. Following it from a dead reset link starts a real login through the
BFF and ends on the worklist. A built-in client that has its own base URL (account-console) does not get Keycloak's
"back to application" link to a page users are not served; the English locale and a phone-sized window draw the same.

Run in CI: `python tests/measurement_ci.py --profile login-error-page` (Focused integration, dispatch only); on a
development stack: `python tests/e2e/test_login_error_page.py`.
"""
from __future__ import annotations

from pathlib import Path
import sys
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

from playwright.sync_api import expect

import test_worklist as base
import admin_otp

THEME = base.ROOT / "keycloak" / "themes" / "kin-login" / "login"
ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
HOME = "/api/auth/login"
REALM = "/auth/realms/kin"


def properties(path):
    rows = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            rows[key.strip()] = value.strip()
    return rows


MSG = {"ko": properties(THEME / "messages" / "messages_ko.properties"),
       "en": properties(THEME / "messages" / "messages_en.properties")}


def auth_request(client_id, redirect, **extra):
    query = {"client_id": client_id, "response_type": "code", "scope": "openid", "redirect_uri": redirect, **extra}
    return REALM + "/protocol/openid-connect/auth?" + urlencode(query)


class LoginErrorPageE2E(base.WorklistE2E):
    def fresh_page(self, width=1600, height=1050):
        # Korean browser by default (the realm's default); the English case asks for English in the address.
        context = self.browser.new_context(ignore_https_errors=True, locale="ko-KR",
                                           viewport={"width": width, "height": height})
        self.contexts.append(context)
        page = context.new_page()
        page.set_default_timeout(20000)
        return page

    def entries(self):
        callback = self.stack.proxy + "/api/auth/callback"
        elsewhere = self.stack.proxy + "/not-a-registered-return"
        return {
            # A reset link from the mail that no longer works (used, expired or cut short): the action-token address
            # with a key the server cannot accept. Keycloak answers it with its error page, as for a used link.
            "dead-reset-link": REALM + "/login-actions/action-token?" + urlencode(
                {"key": "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJyZXNldC1jcmVkZW50aWFscyJ9.c3lu", "client_id": "kin-bff"}),
            # A login request naming no client the realm has: the error page has no client at all.
            "unknown-client": auth_request("kin-not-a-client", callback),
            # The product's own login client with a return address it does not allow: a client with no base URL.
            "wrong-return-address": auth_request("kin-bff", elsewhere),
            # A built-in client with its own base URL: Keycloak's base page linked there; users are not served it.
            "client-with-base-url": auth_request("account-console", elsewhere),
        }

    def assert_way_back(self, page, entry, lang="ko"):
        """Keycloak's error page with its own message, and exactly one link in it: the way back, nothing attached."""
        message = page.locator("#kc-error-message")
        expect(message, entry).to_be_visible()
        # The picture first, so a page without the way back is on record too.
        ARTIFACTS.mkdir(exist_ok=True)
        page.screenshot(path=str(ARTIFACTS / f"LOGIN-ERROR-PAGE-{entry}.png"), full_page=True)
        expect(message.locator("p.instruction").first, entry).not_to_be_empty()
        links = message.locator("a")
        expect(links, entry).to_have_count(1)
        back = page.locator("#kin-back")
        expect(back, entry).to_be_visible()
        expect(back, entry).to_have_text(MSG[lang]["backToKin"])
        self.assertEqual(back.get_attribute("href"), HOME, entry)
        expect(page.get_by_role("link", name=MSG[lang]["backToKin"], exact=True), entry).to_have_count(1)
        # No other way out was drawn: not Keycloak's "back to application" link, on the page or elsewhere.
        expect(page.locator("#backToApplication"), entry).to_have_count(0)
        return back

    def test_login_error_page_01_every_entry_has_one_way_back(self):
        said = {}
        for entry, path in self.entries().items():
            with self.subTest(entry=entry):
                page = self.fresh_page()
                page.goto(self.stack.proxy + path)
                self.assert_way_back(page, entry)
                said[entry] = page.locator("#kc-error-message p.instruction").first.inner_text()
        # The built-in client exists (its error is about the return address, not a missing client), so the case really
        # is a client with a base URL.
        self.assertNotEqual(said.get("client-with-base-url"), said.get("unknown-client"))
        # The English screen draws the same link from the English message file.
        page = self.fresh_page()
        page.goto(self.stack.proxy + auth_request("kin-not-a-client", self.stack.proxy + "/api/auth/callback", kc_locale="en"))
        expect(page.locator("html")).to_have_attribute("lang", "en")
        self.assert_way_back(page, "unknown-client-en", "en")

    def test_login_error_page_02_lost_login_cookie_has_one_way_back(self):
        """A login form left open until its cookie is gone: the next submit lands on the error page, which has the way
        back. No account is named: the server refuses before it reads the form."""
        page = self.fresh_page()
        page.goto(self.stack.proxy + HOME)
        expect(page.locator("#kc-form-login")).to_be_visible()
        page.context.clear_cookies()
        page.locator("#username").fill("syn-no-such-person")
        page.locator("#password").fill("syn-not-a-password")
        page.locator("#kc-login").click()
        self.assert_way_back(page, "lost-login-cookie")

    def test_login_error_page_03_the_way_back_starts_a_real_login(self):
        """From a dead reset link, the way back opens the product's login through the BFF; signing in ends on the
        worklist."""
        page = self.fresh_page()
        page.goto(self.stack.proxy + self.entries()["dead-reset-link"])
        self.assert_way_back(page, "dead-reset-link").click()
        expect(page.locator("#kc-form-login")).to_be_visible()
        target = urlsplit(page.url)
        self.assertEqual((target.netloc, target.path), (urlsplit(self.stack.proxy).netloc, REALM + "/protocol/openid-connect/auth"))
        self.assertEqual(parse_qs(target.query).get("client_id"), ["kin-bff"])
        page.locator("#username").fill(self.stack.username("doctor"))
        page.locator("#password").fill(self.stack.passwords["doctor"])
        page.locator("#kc-login").click()
        admin_otp.answer_page(page, self.stack.username("doctor"))
        page.wait_for_url("**/worklist/hpacs-lite/main.html", timeout=30000)
        expect(page.locator("#dbstat")).to_contain_text("DB Connected")

    def test_login_error_page_04_phone_sized_window(self):
        """A phone-sized window: the way back is on screen, inside the window's width, as a full button."""
        page = self.fresh_page(375, 667)
        page.goto(self.stack.proxy + self.entries()["unknown-client"])
        back = self.assert_way_back(page, "unknown-client-narrow")
        back.scroll_into_view_if_needed()
        box = back.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box["x"], 0)
        self.assertLessEqual(box["x"] + box["width"], 375)
        self.assertGreaterEqual(box["height"], 40)


def load_tests(loader, tests, pattern):
    # Only this class: the base module's own cases are not part of this profile.
    return loader.loadTestsFromTestCase(LoginErrorPageE2E)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
