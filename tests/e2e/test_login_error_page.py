"""The login server's error page on the real stack: every way a person lands on it has one way back into HALO PACS.

Keycloak 26.7.3 draws its error page (error.ftl) for a reset link that no longer works, a login whose cookie is gone, a
login request naming a client that does not exist, and a login request with a wrong return address. Its base page drew a
link only when the request named a client with a base URL - the product's own login client has none - so the page was a
dead end. The kin-login theme now draws "HALO PACS로 돌아가기" on every error page: the product's login start
(/api/auth/login, the address the theme's "HALO PACS로 계속" already uses), nothing attached.

Each entry is opened through the real proxy in a fresh browser (no session): the page is Keycloak's error page with the
message that entry causes, and the one link in it is the way back. Following it from a dead reset link starts a real
login through the BFF and ends on the worklist; a person who is already signed in goes back to the product without a
login form. A built-in client that has its own base URL (account-console) does not get Keycloak's "back to application"
link to a page users are not served. The English screen and a phone-sized window draw the same way back. The logged-out
page (info.ftl, drawn through the same theme macro) keeps its "HALO PACS로 계속".

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

ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
HOME = "/api/auth/login"
REALM = "/auth/realms/kin"
# The screen's words, written out here (not read from the theme) so a wrong label in the theme fails.
BACK = "HALO PACS로 돌아가기"
CONTINUE = "HALO PACS로 계속"
# Keycloak's own messages for each entry (26.7.3, Korean screen; the theme overrides invalidParameterMessage).
SAID = {
    "dead-reset-link": "자격 증명 재설정이 허용되지 않습니다",
    "unknown-client": "클라이언트를 찾을 수 없습니다.",
    "wrong-return-address": "잘못된 매개변수입니다: redirect_uri",
    "client-with-base-url": "잘못된 매개변수입니다: redirect_uri",
    "lost-login-cookie": "쿠키를 찾을 수 없습니다. 브라우저에서 쿠키가 활성화되어 있는지 확인하세요.",
    "unknown-client-en": "Client not found.",
    # Keycloak's English sentence, with the button it names as the theme draws it.
    "lost-login-cookie-en": 'If cookies are disabled then enable them. Click "HALO PACS로 돌아가기" to login again.',
}


def auth_request(client_id, redirect, **extra):
    query = {"client_id": client_id, "response_type": "code", "scope": "openid", "redirect_uri": redirect, **extra}
    return REALM + "/protocol/openid-connect/auth?" + urlencode(query)


class LoginErrorPageE2E(base.WorklistE2E):
    def fresh_page(self, width=1600, height=1050, locale="ko-KR"):
        # Korean browser by default (the realm's default); the English cases ask for English.
        context = self.browser.new_context(ignore_https_errors=True, locale=locale,
                                           viewport={"width": width, "height": height})
        self.contexts.append(context)
        page = context.new_page()
        page.set_default_timeout(20000)
        return page

    def entries(self):
        callback = self.stack.proxy + "/api/auth/callback"
        elsewhere = self.stack.proxy + "/not-a-registered-return"
        return {
            # A reset link from the mail that no longer works: the action-token address with a key the server will not
            # accept. Keycloak answers it with its error page, as for a used or expired link.
            "dead-reset-link": REALM + "/login-actions/action-token?" + urlencode(
                {"key": "eyJhbGciOiJIUzUxMiJ9.eyJ0eXAiOiJyZXNldC1jcmVkZW50aWFscyJ9.c3lu", "client_id": "kin-bff"}),
            # A login request naming no client the realm has: the error page has no client at all.
            "unknown-client": auth_request("kin-not-a-client", callback),
            # The product's own login client with a return address it does not allow: a client with no base URL.
            "wrong-return-address": auth_request("kin-bff", elsewhere),
            # A built-in client with its own base URL: Keycloak's base page linked there; users are not served it.
            "client-with-base-url": auth_request("account-console", elsewhere),
        }

    def assert_way_back(self, page, entry, shot=None):
        """Keycloak's error page with this entry's message, and exactly one link in it: the way back, nothing attached."""
        message = page.locator("#kc-error-message")
        expect(message, entry).to_be_visible()
        # The picture first, so a page without the way back is on record too.
        ARTIFACTS.mkdir(exist_ok=True)
        page.screenshot(path=str(ARTIFACTS / f"LOGIN-ERROR-PAGE-{shot or entry}.png"), full_page=True)
        expect(message.locator("p.instruction").first, entry).to_contain_text(SAID[entry])
        expect(message.locator("a"), entry).to_have_count(1)
        back = page.locator("#kin-back")
        expect(back, entry).to_be_visible()
        expect(back, entry).to_have_text(BACK)
        self.assertEqual(back.get_attribute("href"), HOME, entry)
        expect(page.get_by_role("link", name=BACK, exact=True), entry).to_have_count(1)
        # No other way out was drawn: not Keycloak's "back to application" link.
        expect(page.locator("#backToApplication"), entry).to_have_count(0)
        return back

    def lose_login_cookie(self, page):
        """A login form left open until its cookie is gone, then submitted. No account is named: the server refuses
        before it reads the form."""
        page.goto(self.stack.proxy + HOME)
        expect(page.locator("#kc-form-login")).to_be_visible()
        page.context.clear_cookies()
        page.locator("#username").fill("syn-no-such-person")
        page.locator("#password").fill("syn-not-a-password")
        page.locator("#kc-login").click()

    def test_login_error_page_01_every_entry_has_one_way_back(self):
        # The built-in client really has a base URL (Keycloak's base page would link there).
        clients = self.stack.kc_admin("GET", "/clients?clientId=account-console")
        self.assertEqual(clients.status, 200, clients.text)
        self.assertTrue([row.get("baseUrl") for row in clients.body if row.get("baseUrl")], "account-console base URL")
        for entry, path in self.entries().items():
            with self.subTest(entry=entry):
                page = self.fresh_page()
                page.goto(self.stack.proxy + path)
                self.assert_way_back(page, entry)
        # The English screen (an English browser) draws the same way back.
        page = self.fresh_page(locale="en-US")
        page.goto(self.stack.proxy + self.entries()["unknown-client"])
        expect(page.locator("html")).to_have_attribute("lang", "en")
        self.assert_way_back(page, "unknown-client-en")

    def test_login_error_page_02_lost_login_cookie_has_one_way_back(self):
        """Korean and English screens; the English sentence names the button that is there."""
        page = self.fresh_page()
        self.lose_login_cookie(page)
        self.assert_way_back(page, "lost-login-cookie")
        page = self.fresh_page(locale="en-US")
        self.lose_login_cookie(page)
        expect(page.locator("html")).to_have_attribute("lang", "en")
        self.assert_way_back(page, "lost-login-cookie-en")
        expect(page.locator("#kc-error-message")).not_to_contain_text("Back to Application")

    def test_login_error_page_03_the_way_back_starts_a_real_login(self):
        """From a dead reset link, the way back opens the product's login through the BFF; signing in ends on the
        worklist. Signed in, the same way back returns to the product without a login form."""
        page = self.fresh_page()
        page.goto(self.stack.proxy + self.entries()["dead-reset-link"])
        self.assert_way_back(page, "dead-reset-link", "dead-reset-link-then-login").click()
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
        page.goto(self.stack.proxy + self.entries()["unknown-client"])
        self.assert_way_back(page, "unknown-client", "signed-in-unknown-client").click()
        page.wait_for_url("**/worklist/hpacs-lite/**", timeout=30000)
        expect(page.locator("#kc-form-login")).to_have_count(0)

    def test_login_error_page_04_phone_sized_window(self):
        """A phone-sized window: the way back is drawn as the same button and still starts the login."""
        page = self.fresh_page(375, 667)
        page.goto(self.stack.proxy + self.entries()["unknown-client"])
        back = self.assert_way_back(page, "unknown-client", "unknown-client-narrow")
        box = back.bounding_box()
        self.assertIsNotNone(box)
        self.assertGreaterEqual(box["height"], 40)
        back.click()
        expect(page.locator("#kc-form-login")).to_be_visible()

    def test_login_error_page_05_logged_out_page_keeps_its_continue_button(self):
        """The logged-out page (info.ftl) draws its "HALO PACS로 계속" through the same macro as the error page."""
        page = self.fresh_page()
        page.goto(self.stack.proxy + REALM + "/protocol/openid-connect/logout")
        page.locator("#kc-logout").click()
        go_on = page.locator("#kin-continue")
        expect(go_on).to_be_visible()
        ARTIFACTS.mkdir(exist_ok=True)
        page.screenshot(path=str(ARTIFACTS / "LOGIN-ERROR-PAGE-logged-out.png"), full_page=True)
        expect(go_on).to_have_text(CONTINUE)
        self.assertEqual(go_on.get_attribute("href"), HOME)
        go_on.click()
        expect(page.locator("#kc-form-login")).to_be_visible()


def load_tests(loader, tests, pattern):
    # Only this class: the base module's own cases are not part of this profile.
    return loader.loadTestsFromTestCase(LoginErrorPageE2E)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
