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
import re
import sys
import time
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
BACK_EN = "Back to HALO PACS"
CONTINUE = "HALO PACS로 계속"
HANGUL = re.compile(r"[가-힣]")
# Names a Korean login-server page keeps in Latin letters (the product's name, OTP, the connection note's TLS).
NAMES = {"HALO", "PACS", "OTP", "QR", "TLS"}
# Keycloak's own messages for each entry (26.7.3, Korean screen; the theme overrides invalidParameterMessage).
SAID = {
    "dead-reset-link": "자격 증명 재설정이 허용되지 않습니다",
    "unknown-client": "클라이언트를 찾을 수 없습니다.",
    "wrong-return-address": "잘못된 매개변수입니다: redirect_uri",
    "client-with-base-url": "잘못된 매개변수입니다: redirect_uri",
    "lost-login-cookie": "쿠키를 찾을 수 없습니다. 브라우저에서 쿠키가 활성화되어 있는지 확인하세요. \"HALO PACS로 돌아가기\"를 눌러 다시 로그인하세요.",
    "unknown-client-en": "Client not found.",
    # Keycloak's English sentence, with the button it names as the theme draws it.
    "lost-login-cookie-en": 'If cookies are disabled then enable them. Click "Back to HALO PACS" to login again.',
}
# A locked account (the theme's accountTemporarilyDisabledMessage), and Keycloak's own wrong-password sentence that an
# unknown username and an unlocked wrong password keep.
LOCKED = "로그인에 여러 번 실패해 이 계정이 잠시 잠겼습니다."
LOCKED_EN = "Too many failed sign-in attempts: this account is locked for a while"
WRONG = "잘못된 사용자 이름 또는 비밀번호입니다."
# The product landing's answers for a suspended member (index.html ARRIVAL_NOTICES).
SUSPENDED = "이 계정은 사용이 정지되어 로그인할 수 없습니다. 소속 기관의 HALO PACS 관리자 또는 HALO PACS 운영 담당자에게 문의해 주세요."
SUSPENDED_UNAPPROVED = ("이 계정은 현재 승인이 없고 사용이 정지되어 로그인할 수 없습니다. 다시 쓰려면 승인이 필요합니다 — "
                        "소속 기관의 HALO PACS 관리자 또는 HALO PACS 운영 담당자에게 문의해 주세요.")


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
        label = BACK_EN if entry.endswith("-en") else BACK
        expect(back, entry).to_be_visible()
        expect(back, entry).to_have_text(label)
        self.assertEqual(back.get_attribute("href"), HOME, entry)
        expect(page.get_by_role("link", name=label, exact=True), entry).to_have_count(1)
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
        # The login card that follows stays inside the phone window: no letters cut off on the left, no sideways page.
        place = page.evaluate("""() => { const card = document.querySelector('.card-pf').getBoundingClientRect();
          return {left: card.left, right: card.right, width: innerWidth, scroll: document.documentElement.scrollWidth}; }""")
        page.screenshot(path=str(ARTIFACTS / "LOGIN-ERROR-PAGE-login-narrow.png"), full_page=True)
        self.assertGreaterEqual(place["left"], 0, place)
        self.assertLessEqual(place["right"], place["width"], place)
        self.assertLessEqual(place["scroll"], place["width"], place)

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

    def submit(self, page, username, password):
        """One try on the real login form; the page that answers is the form again (refused) or somewhere else."""
        page.locator("#username").fill(username)
        page.locator("#password").fill(password)
        page.locator("#kc-login").click()
        page.wait_for_load_state()

    def test_login_error_page_06_a_locked_account_is_told_it_is_locked(self):
        """Five wrong passwords lock the account for a while (realm brute-force protection). While it is locked the
        right password and a wrong one both say it is locked and how long to wait, in Korean and in English. A username
        that does not exist keeps the wrong-password sentence however often it is tried: nothing new about who exists."""
        self.stack.create_test_identity("locked", [], "")
        name, right = self.stack.username("locked"), self.stack.passwords["locked"]
        page = self.fresh_page()
        page.goto(self.stack.proxy + HOME)
        expect(page.locator("#kc-form-login")).to_be_visible()
        # Before the lock, a wrong password on this account and any password for a username nobody has draw the very
        # same sentence: the page says nothing about who exists.
        self.submit(page, name, "syn-wrong-password")
        expect(page.locator("#input-error")).to_have_text(WRONG)
        nobody = self.fresh_page()
        nobody.goto(self.stack.proxy + HOME)
        self.submit(nobody, "syn-nobody-has-this-name", "syn-wrong-password")
        expect(nobody.locator("#input-error")).to_have_text(WRONG)
        self.assertEqual(page.locator("#input-error").inner_text().strip(), nobody.locator("#input-error").inner_text().strip())
        for _ in range(4):
            self.submit(page, name, "syn-wrong-password")
            expect(page.locator("#kc-form-login")).to_be_visible()
        ARTIFACTS.mkdir(exist_ok=True)
        for label, password in (("right", right), ("wrong", "syn-wrong-password")):
            self.submit(page, name, password)
            content = page.locator("#kc-content")
            expect(content, label).to_contain_text(LOCKED)
            expect(content, label).not_to_contain_text(WRONG)
            page.screenshot(path=str(ARTIFACTS / f"LOGIN-ERROR-PAGE-locked-{label}-password.png"), full_page=True)
        # The English screen says the same.
        english = self.fresh_page(locale="en-US")
        english.goto(self.stack.proxy + HOME)
        expect(english.locator("html")).to_have_attribute("lang", "en")
        self.submit(english, name, right)
        expect(english.locator("#kc-content")).to_contain_text(LOCKED_EN)
        english.screenshot(path=str(ARTIFACTS / "LOGIN-ERROR-PAGE-locked-en.png"), full_page=True)
        # The username nobody has, five more tries (six in all): the same wrong-password sentence every time, never the lock.
        for _ in range(5):
            self.submit(nobody, "syn-nobody-has-this-name", "syn-wrong-password")
            expect(nobody.locator("#input-error")).to_have_text(WRONG)
            expect(nobody.locator("#kc-content")).not_to_contain_text(LOCKED)

    def test_login_error_page_07_a_suspended_member_is_told_why(self):
        """A member an administrator suspended, and one whose approval was revoked, sign in with the right password: the
        product's landing says why and whom to ask (not the general failure), and nothing opens."""
        for logical, change, said in (("suspended", {"enabled": False}, SUSPENDED),
                                      ("revoked", {"approvalState": "PENDING"}, SUSPENDED_UNAPPROVED)):
            with self.subTest(member=logical):
                member = self.stack.create_test_identity(logical, ["radiologist"], "hallym")
                self.stack.set_member_rights(member, **change)
                time.sleep(1.05)  # the fixture's whole-second allowance after a rights change (set_member_rights)
                page = self.fresh_page()
                page.goto(self.stack.proxy + HOME)
                self.submit(page, self.stack.username(logical), self.stack.passwords[logical])
                page.wait_for_url(re.compile(r".*/worklist/hpacs-lite/index\.html(\?.*)?$"), timeout=30000)
                expect(page.locator("#why")).to_have_text(said)
                ARTIFACTS.mkdir(exist_ok=True)
                page.screenshot(path=str(ARTIFACTS / f"LOGIN-ERROR-PAGE-blocked-{logical}.png"), full_page=True)
                expect(page.locator("#signin")).to_be_visible()


    def page_words(self, page, language, shot):
        """The words a reader sees or hears on a login-server page in the language Keycloak chose: the title, the page
        text, the lines the style sheet draws, the submit buttons' labels (inputs), the names given to links, buttons and
        pictures for a screen reader - without the language menu's language names (each written in its own language)
        and the account name the page repeats (data, not words)."""
        ARTIFACTS.mkdir(exist_ok=True)
        page.screenshot(path=str(ARTIFACTS / f"LOGIN-ERROR-PAGE-language-{shot}.png"), full_page=True)
        expect(page.locator("html")).to_have_attribute("lang", language)
        expect(page.locator("#kin-legal-links")).to_be_attached()
        return page.evaluate("""() => {
          const set = ['kc-locale', 'kc-attempted-username'].map(id => document.getElementById(id)).filter(Boolean);
          const was = set.map(node => node.style.display);
          set.forEach(node => { node.style.display = 'none'; });
          const buttons = [...document.querySelectorAll('input[type=submit], input[type=button]')]
            .filter(input => input.offsetParent).map(input => input.value);
          const shown = [...document.body.querySelectorAll('*')].filter(e => !set.some(node => node.contains(e)));
          const drawn = shown.flatMap(e => ['::before', '::after'].map(p => getComputedStyle(e, p).content))
            .filter(c => c.startsWith('"'));
          const named = shown.flatMap(e => [e.getAttribute('aria-label'), e.tagName === 'IMG' ? e.getAttribute('alt') : null])
            .filter(Boolean);
          const menu = document.getElementById('kc-current-locale-link');
          const seen = [document.title, document.body.innerText, ...buttons, ...drawn, ...named,
                        menu ? menu.getAttribute('aria-label') : ''].join('\\n');
          set.forEach((node, i) => { node.style.display = was[i]; });
          return seen; }""")

    def assert_one_language(self, page, language, shot, names=()):
        # A drawn line's CSS escapes (the line break "\\a ") are not words.
        seen = re.sub(r"\\[0-9a-fA-F]{1,6} ?", " ", self.page_words(page, language, shot))
        if language == "en":
            self.assertIsNone(HANGUL.search(seen), f"{shot}: {seen}")
        else:
            self.assertIsNotNone(HANGUL.search(seen), f"{shot}: {seen}")
            self.assertEqual(set(re.findall(r"[A-Za-z]+", seen)) - NAMES - set(names), set(), f"{shot}: {seen}")

    def test_login_error_page_08_each_page_in_one_language(self):
        """A Korean and an English browser: the login form, the reset request and its answer, a dead reset link, the
        new-password form, the first OTP set-up and the one-time code form each show one language only - the product's
        words and Keycloak's alike - with the same way back in each."""
        for logical in ("relang-password", "relang-otp", "relang-code"):
            self.stack.create_test_identity(logical, [], "")
        coded = self.stack.user_ids["relang-code"]
        admin_otp.seed(lambda method, path, body: (lambda r: (r.status, r.body))(self.stack.kc_admin(method, path, body)), coded)
        for browser, language in (("ko-KR", "ko"), ("en-US", "en")):
            with self.subTest(language=language):
                page = self.fresh_page(locale=browser)
                page.goto(self.stack.proxy + HOME)
                expect(page.locator("#kc-form-login")).to_be_visible()
                self.assert_one_language(page, language, f"{language}-login")
                page.locator("#kc-form-login .login-pf-settings a").click()
                expect(page.locator("#kc-reset-password-form")).to_be_visible()
                self.assert_one_language(page, language, f"{language}-reset-request")
                # A username nobody has: the answer is the same as for a real account, and no mail is sent.
                page.locator("#username").fill("syn-nobody-has-this-name")
                page.locator("#kc-reset-password-form [type=submit]").click()
                page.wait_for_load_state()
                self.assert_one_language(page, language, f"{language}-reset-sent")
                page.goto(self.stack.proxy + self.entries()["dead-reset-link"])
                expect(page.locator("#kc-error-message")).to_be_visible()
                self.assert_one_language(page, language, f"{language}-dead-reset-link")
                for logical, action, form, names in (
                        ("relang-password", "UPDATE_PASSWORD", "#kc-passwd-update-form", ()),
                        # Keycloak lists the authenticator apps by their names.
                        ("relang-otp", "CONFIGURE_TOTP", "#kc-totp-settings-form", ("FreeOTP", "Google", "Microsoft", "Authenticator"))):
                    user = self.stack.user_ids[logical]
                    changed = self.stack.kc_admin("PUT", f"/users/{user}", {"requiredActions": [action]})
                    self.assertEqual(changed.status, 204, changed.text)
                    signer = self.fresh_page(locale=browser)
                    signer.goto(self.stack.proxy + HOME)
                    self.submit(signer, self.stack.username(logical), self.stack.passwords[logical])
                    expect(signer.locator(form)).to_be_visible()
                    self.assert_one_language(signer, language, f"{language}-{action.lower()}", names)
                # An account with an OTP: after the password, the one-time code form.
                coder = self.fresh_page(locale=browser)
                coder.goto(self.stack.proxy + HOME)
                self.submit(coder, self.stack.username("relang-code"), self.stack.passwords["relang-code"])
                expect(coder.locator("#kc-otp-login-form")).to_be_visible()
                self.assert_one_language(coder, language, f"{language}-otp-code")

def load_tests(loader, tests, pattern):
    # Only the cases declared here: the worklist cases this class inherits are not part of this profile.
    return unittest.TestSuite(LoginErrorPageE2E(name) for name in sorted(vars(LoginErrorPageE2E)) if name.startswith("test_"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
