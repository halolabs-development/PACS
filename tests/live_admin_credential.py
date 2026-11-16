"""D633/D634: an in-memory credential for the imported synthetic realm fixture.

The driver must attest its isolated synthetic stack with KIN_SYNTHETIC_REALM=1.
The shipped display name/client names also occur in real realms, so they cannot
authorize a password reset. Never call this helper for a real account.
"""
import hashlib
import json
import os
import secrets
import threading
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import admin_otp


_credentials = {}
_lock = threading.Lock()


def _admin_call(request, method, url, body, token):
    """admin_otp.seed's (status, body) over this module's no-redirect request: GET answers 200, the writes 204."""
    expected = 200 if method == "GET" else 204
    return expected, request(method, url, body, token=token, expected=expected)


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Admin credentials must never follow a redirect to another endpoint.
        return None


def ensure_imported_admin_credential(kc_admin_url: str, kc_admin_password: str) -> str:
    """Reset synthetic kin/jmryu once per process/target; return without logging.

    kc_admin_url is the realm admin endpoint, ending in /auth/admin/realms/kin.
    Call after /api/health reports memberRights=ready and pass the return value
    only in memory as KIN_LIVE_IMPORTED_ADMIN_PASSWORD to supervised live runs.
    """
    if os.environ.get("KIN_SYNTHETIC_REALM") != "1":
        raise RuntimeError("Imported admin credential requires KIN_SYNTHETIC_REALM=1")
    endpoint = urlsplit(kc_admin_url)
    if (endpoint.scheme not in ("http", "https") or not endpoint.hostname
            or endpoint.username is not None or endpoint.password is not None
            or endpoint.query or endpoint.fragment
            or endpoint.path.rstrip("/") != "/auth/admin/realms/kin"):
        raise RuntimeError("Imported admin credential requires the synthetic kin realm endpoint")
    if not kc_admin_password:
        raise RuntimeError("Imported admin credential requires KC_ADMIN_PASSWORD")
    base = kc_admin_url.rstrip("/")
    key = (base, hashlib.sha256(kc_admin_password.encode("utf-8")).digest())
    with _lock:
        if key in _credentials:
            return _credentials[key]
        opener = build_opener(_NoRedirects())

        def request(method, url, body=None, token=None, form=False, expected=200):
            headers = {}
            data = None
            if body is not None:
                data = (urlencode(body) if form else json.dumps(body)).encode("utf-8")
                headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
            if token:
                headers["Authorization"] = "Bearer " + token
            try:
                with opener.open(Request(url, data=data, headers=headers, method=method), timeout=30) as response:
                    if response.status != expected:
                        raise ValueError("Unexpected status")
                    return json.loads(response.read()) if expected == 200 else None
            except Exception:
                # Response bodies, redirect URLs and exception text may echo credentials.
                raise RuntimeError("Synthetic imported admin credential request failed") from None

        master = base.removesuffix("/admin/realms/kin") + "/realms/master/protocol/openid-connect/token"
        granted = request("POST", master, {"client_id": "admin-cli", "grant_type": "password",
                          "username": "admin", "password": kc_admin_password}, form=True)
        token = granted.get("access_token") if isinstance(granted, dict) else None
        if not isinstance(token, str) or not token:
            raise RuntimeError("Synthetic imported admin authentication failed")
        realm = request("GET", base, token=token)
        if not isinstance(realm, dict) or realm.get("realm") != "kin":
            raise RuntimeError("Imported admin credential target is not the synthetic kin realm")
        users = request("GET", base + "/users?username=jmryu&exact=true", token=token)
        if (not isinstance(users, list) or len(users) != 1 or not isinstance(users[0], dict)
                or users[0].get("username") != "jmryu"
                or not isinstance(users[0].get("id"), str) or not users[0]["id"]):
            raise RuntimeError("Synthetic imported administrator must resolve exactly once")
        password = secrets.token_urlsafe(32)
        user = base + "/users/" + quote(users[0]["id"], safe="")
        request("PUT", user + "/reset-password",
                {"type": "password", "value": password, "temporary": False}, token=token, expected=204)
        # jmryu holds admin, and administrators sign in with OTP (keycloak/README.md): the synthetic one, answered by
        # admin_otp wherever the harness signs in.
        admin_otp.seed(lambda method, path, body: _admin_call(request, method, base + path, body, token), users[0]["id"])
        _credentials[key] = password
        return password
