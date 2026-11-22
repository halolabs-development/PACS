"""Synthetic OTP for test identities that have one (keycloak/README.md, OTP는 스스로 등록한 계정만).

No account is required to have OTP: Keycloak's built-in flows ask it only of an account that has one. A case about such an
account gives its test identity this synthetic credential (Admin REST, `seed`), and the harness answers Keycloak's OTP form
with its code wherever it signs in (`answer_http` for urllib openers, `answer_page` for Playwright pages). An account without
OTP never sees the form and these helpers return at once; an OTP set-up page that appears unasked fails the sign-in.

SECRET is a synthetic test value. Never seed it for a real account.
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import re
import struct
import threading
import time
from urllib.parse import urlencode, urlparse
from urllib.request import Request

SECRET = "kin-synthetic-admin-otp-not-a-real-credential"
LABEL = "kin synthetic test OTP"
PERIOD = 30
# Keycloak's default TOTP policy (kin-realm.json keeps it): HmacSHA1, 6 digits, 30 s, look-around 1, codes not reusable.
_used: dict[str, int] = {}
_lock = threading.Lock()


def credential() -> dict:
    return {"type": "otp", "userLabel": LABEL, "secretData": json.dumps({"value": SECRET}),
            "credentialData": json.dumps({"subType": "totp", "digits": 6, "counter": 0, "period": PERIOD,
                                          "algorithm": "HmacSHA1"})}


def seed(call, user_id: str) -> None:
    """Give the account exactly the synthetic OTP. `call(method, path, body)` is a realm Admin REST call returning
    (status, body); paths are relative to /admin/realms/kin."""
    path = "/users/" + user_id
    status, rows = call("GET", path + "/credentials", None)
    if status != 200 or not isinstance(rows, list):
        raise RuntimeError(f"Cannot read the test identity's credentials: {status}")
    otp = [row for row in rows if isinstance(row, dict) and row.get("type") == "otp"]
    if len(otp) == 1 and otp[0].get("userLabel") == LABEL:
        return
    for row in otp:
        deleted = call("DELETE", path + "/credentials/" + str(row["id"]), None)[0]
        if deleted != 204:
            raise RuntimeError(f"Cannot replace the test identity's OTP: {deleted}")
    added = call("PUT", path, {"credentials": [credential()]})[0]
    if added != 204:
        raise RuntimeError(f"Cannot give the test identity its synthetic OTP: {added}")


def code_at(counter: int, secret: bytes | None = None) -> str:
    """The TOTP code of one time step (HmacSHA1, 6 digits) for `secret`: the synthetic one (read now), or an enrolled one."""
    key = SECRET.encode("utf-8") if secret is None else secret
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % 1_000_000).zfill(6)


def code(username: str) -> str:
    """A code this process has not used for the account yet (Keycloak refuses a reused code): the current step, else the
    next one (look-around 1), else wait for the step after. A refused code (another process used it) is not reused either:
    the retry takes the next step."""
    with _lock:
        now = int(time.time() // PERIOD)
        counter = max(now, _used.get(username, now - 1) + 1)
        if counter > now + 1:
            time.sleep(max(0.0, (counter - 1) * PERIOD - time.time()) + 0.05)
        _used[username] = counter
        return code_at(counter)


OTP_FORM = 'id="kc-otp-login-form"'
FORM_HEADERS = {"Content-Type": "application/x-www-form-urlencoded"}


def answer(submit, page: str, username: str):
    """The one OTP loop of every HTTP sign-in. `page`: the HTML Keycloak answered the password form with. While it is the
    OTP form, `submit(action, body)` posts the next code and returns (the page Keycloak answered, or "" for a redirect;
    whatever the caller needs back). Returns the last such value, or None when no OTP form was shown."""
    result = None
    for attempt in range(4):
        if OTP_FORM not in page:
            return result
        if attempt == 3:
            break
        action = re.search(r'<form[^>]+id="kc-otp-login-form"[^>]*action="([^"]+)"|<form[^>]+action="([^"]+)"[^>]*id="kc-otp-login-form"', page)
        if not action:
            raise RuntimeError("Keycloak OTP form has no action")
        page, result = submit(html.unescape(action.group(1) or action.group(2)), urlencode({"otp": code(username)}).encode("ascii"))
    raise RuntimeError(f"Keycloak refused the synthetic OTP of {username}")


def answer_http(opener, page: str, url: str, username: str, *, timeout: float = 30) -> tuple[str, str]:
    """`answer` for a urllib opener: returns the last page and its URL; a redirect the opener refuses to follow raises
    (urllib's HTTPError) as it did for the password form."""
    def submit(action, body):
        with opener.open(Request(action, data=body, method="POST", headers=FORM_HEADERS), timeout=timeout) as response:
            last = response.read().decode("utf-8", "replace"), response.geturl()
        return last[0], last
    return answer(submit, page, username) or (page, url)


def answer_call(browser, answered: tuple, username: str) -> tuple:
    """`answer` for a non-redirecting client whose `call(method, url, data, headers)` returns (status, headers, text):
    `answered` is that triple for the password form; returns the triple of the last post."""
    status, _, page = answered
    last = answer(lambda action, body: (lambda r: (r[2] if r[0] == 200 else "", r))(browser.call("POST", action, body, FORM_HEADERS)),
                  page if status == 200 else "", username)
    return last or answered


# One read of the current document. A document the browser has committed but not parsed yet ("loading") is empty, so it
# says nothing about which page Keycloak answered; only a parsed one is judged.
_PAGE_STATE = """() => ({parsed: document.readyState !== 'loading',
  otp: !!document.querySelector('#kc-otp-login-form'), enrol: !!document.querySelector('#kc-totp-settings'),
  password: !!document.querySelector('#kc-form-login'),
  refused: !!document.querySelector('#input-error, .alert-error, #kc-error-message')})"""


def answer_page(page, username: str, *, timeout: float = 30) -> None:
    """Call right after the password form is submitted. Waits until the browser is on the OTP form (an account that has
    OTP) or anywhere else (the product, or a Keycloak page the caller expects), answering the OTP form. While the
    submitted password form itself is still the parsed document, it keeps waiting. The OTP set-up page fails: no sign-in
    is made to enrol OTP."""
    deadline = time.monotonic() + timeout
    tries = 0
    while True:
        try:
            if "/realms/" not in urlparse(page.url).path:
                return  # left Keycloak: the product
            state = page.evaluate(_PAGE_STATE)
        except Exception:
            state = None  # the document changed under the read (navigation); look again
        if state and state["parsed"]:
            if state["otp"]:
                if tries == 3:
                    raise RuntimeError(f"Keycloak refused the synthetic OTP of {username}")
                tries += 1
                page.locator("#otp").fill(code(username))
                with page.expect_navigation(timeout=timeout * 1000):
                    page.locator("#kc-login").click()
                continue
            if state["enrol"]:
                raise RuntimeError(f"Keycloak made {username} set up OTP: no account is required to have OTP")
            if not state["password"] or state["refused"]:
                return  # another Keycloak page the caller expects, or a refused password
        if time.monotonic() > deadline:
            raise TimeoutError(f"Sign-in of {username} did not leave the password form")
        page.wait_for_timeout(100)
