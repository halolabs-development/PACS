"""D633/D634: fixture-only reset, process reuse, and secret-free diagnostics."""
import contextlib
import io
import json
import os
import traceback
import unittest
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from urllib.error import HTTPError
from urllib.parse import parse_qs
from urllib.request import HTTPHandler, HTTPSHandler, build_opener
from urllib.response import addinfourl
from unittest.mock import MagicMock, patch

import admin_otp
import live_admin_credential as credential


URL = "http://synthetic.invalid/auth/admin/realms/kin"


class Response:
    def __init__(self, body, status=200):
        self.body, self.status = body, status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.body).encode()


class Transport:
    def __init__(self):
        self.calls = []
        self.realm = {"realm": "kin", "displayName": "HALO PACS"}
        self.users = [{"id": "fixture-admin", "username": "jmryu"}]
        self.reset_error = None
        self.credentials = [{"id": "fixture-password", "type": "password"}]

    def open(self, request, **kwargs):
        self.calls.append(request)
        if request.full_url.endswith("/token"):
            return Response({"access_token": "stub-master-token"})
        if request.full_url == URL:
            return Response(self.realm)
        if request.full_url.endswith("/users?username=jmryu&exact=true"):
            return Response(self.users)
        if request.full_url.endswith("/users/fixture-admin/reset-password"):
            if self.reset_error:
                raise self.reset_error
            return Response(None, 204)
        if request.full_url.endswith("/users/fixture-admin/credentials") and request.method == "GET":
            return Response(self.credentials)
        if "/users/fixture-admin/credentials/" in request.full_url and request.method == "DELETE":
            return Response(None, 204)
        if request.full_url.endswith("/users/fixture-admin") and request.method == "PUT":
            return Response(None, 204)
        raise AssertionError("Unexpected transport operation")


class ImportedAdminCredentialTests(unittest.TestCase):
    def setUp(self):
        credential._credentials.clear()
        self.addCleanup(credential._credentials.clear)
        self.transport = Transport()
        self.master_password = "stub-master-password"
        env = patch.dict(os.environ, {"KIN_SYNTHETIC_REALM": "1"}, clear=True)
        env.start(); self.addCleanup(env.stop)
        transport = patch.object(credential, "build_opener", return_value=self.transport)
        transport.start(); self.addCleanup(transport.stop)

    def ensure(self):
        return credential.ensure_imported_admin_credential(URL, self.master_password)

    def test_exact_fixture_password_reset_and_process_reuse_without_output(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            first = self.ensure()
            second = self.ensure()
        self.assertEqual(first, second)
        self.assertGreaterEqual(len(first), 32)
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
        calls = self.transport.calls
        self.assertEqual([r.method for r in calls], ["POST", "GET", "GET", "PUT"])
        self.assertEqual(calls[0].full_url,
                         "http://synthetic.invalid/auth/realms/master/protocol/openid-connect/token")
        self.assertEqual(parse_qs(calls[0].data.decode()), {
            "client_id": ["admin-cli"], "grant_type": ["password"],
            "username": ["admin"], "password": ["stub-master-password"]})
        self.assertEqual(calls[2].full_url, URL + "/users?username=jmryu&exact=true")
        self.assertEqual(json.loads(calls[3].data), {"type": "password", "value": first, "temporary": False})
        # No account is required to have OTP: jmryu gets its password only, no OTP credential.
        self.assertTrue(all(r.get_header("Authorization") == "Bearer stub-master-token" for r in calls[1:]))

    def test_missing_or_false_synthetic_attestation_refuses_before_transport(self):
        for flag in (None, "0", "true"):
            with self.subTest(flag=flag):
                os.environ.pop("KIN_SYNTHETIC_REALM", None)
                if flag is not None:
                    os.environ["KIN_SYNTHETIC_REALM"] = flag
                with self.assertRaisesRegex(RuntimeError, "KIN_SYNTHETIC_REALM=1"):
                    self.ensure()
        self.assertEqual(self.transport.calls, [])

    def test_cached_credential_does_not_bypass_synthetic_attestation(self):
        self.ensure()
        os.environ.pop("KIN_SYNTHETIC_REALM")
        with self.assertRaises(RuntimeError):
            self.ensure()
        self.assertEqual(len(self.transport.calls), 4)

    def test_other_realm_or_ambiguous_endpoint_refuses_before_transport(self):
        for url in (URL.replace("/kin", "/production"), URL + "?realm=other", URL + "#other",
                    URL.replace("http://", "http://user:password@")):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                credential.ensure_imported_admin_credential(url, "stub-master-password")
        self.assertEqual(self.transport.calls, [])

    def test_non_synthetic_realm_response_cannot_reset_a_user(self):
        self.transport.realm = {"realm": "production"}
        with self.assertRaisesRegex(RuntimeError, "not the synthetic kin realm"):
            self.ensure()
        self.assertFalse(any(r.method == "PUT" for r in self.transport.calls))

    def test_missing_ambiguous_or_inexact_user_refuses_reset(self):
        for users in ([], [{"id": "x", "username": "jmryu-other"}], self.transport.users * 2,
                      [{"username": "jmryu"}], {"error": "unexpected"}):
            with self.subTest(users=users):
                self.transport.users = users
                with self.assertRaisesRegex(RuntimeError, "resolve exactly once"):
                    self.ensure()
        self.assertFalse(any(r.method == "PUT" for r in self.transport.calls))

    def test_failed_reset_does_not_cache_or_expose_response_or_exception_secrets(self):
        sentinel = "stub-reset-secret-must-not-be-printed"
        self.transport.reset_error = HTTPError(URL, 503, sentinel, {}, io.BytesIO(sentinel.encode()))
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(credential.secrets, "token_urlsafe", return_value=sentinel), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                self.ensure()
            except RuntimeError:
                traceback.print_exc()
            else:
                self.fail("Reset failure was admitted")
        diagnostic = stdout.getvalue() + stderr.getvalue()
        for secret in (sentinel, "stub-master-password", "stub-master-token"):
            self.assertNotIn(secret, diagnostic)
        self.transport.reset_error = None
        password = self.ensure()
        self.assertNotEqual(password, sentinel)
        self.assertEqual(sum(r.full_url.endswith("/reset-password") for r in self.transport.calls), 2)

    def test_concurrent_callers_share_one_reset(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(lambda _: self.ensure(), range(8)))
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(sum(r.full_url.endswith("/reset-password") for r in self.transport.calls), 1)

    def test_redirects_cannot_forward_admin_credentials(self):
        headers = Message()
        headers['Location'] = 'http://other.invalid/collect'
        response = addinfourl(io.BytesIO(b''), headers, URL, code=302)
        response.msg = 'Found'
        with patch.object(credential, 'build_opener', side_effect=lambda *handlers:
                          build_opener(HTTPSHandler(context=MagicMock()), *handlers)), \
                patch.object(HTTPHandler, 'http_open', return_value=response) as transport:
            with self.assertRaisesRegex(RuntimeError, 'request failed'):
                self.ensure()
        self.assertEqual(transport.call_count, 1)
        self.assertEqual(transport.call_args.args[0].full_url,
                         'http://synthetic.invalid/auth/realms/master/protocol/openid-connect/token')


class AdminOtpHelperTests(unittest.TestCase):
    """tests/admin_otp.py: RFC 6238 codes, no code reused for one account, and the one OTP-form loop."""

    def setUp(self):
        admin_otp._used.clear()
        self.addCleanup(admin_otp._used.clear)

    def test_codes_are_rfc6238_totp(self):
        with patch.object(admin_otp, "SECRET", "12345678901234567890"):
            self.assertEqual(admin_otp.code_at(59 // 30), "287082")
            self.assertEqual(admin_otp.code_at(1111111109 // 30), "081804")

    def test_an_account_never_gets_the_same_code_twice(self):
        clock = [1000 * 30 + 5.0]
        slept = []
        with patch.object(admin_otp.time, "time", side_effect=lambda: clock[0]), \
                patch.object(admin_otp.time, "sleep", side_effect=lambda s: (slept.append(s), clock.__setitem__(0, clock[0] + s))):
            codes = [admin_otp.code("syn-admin") for _ in range(3)]
            other = admin_otp.code("syn-other")
        self.assertEqual(codes[:2], [admin_otp.code_at(1000), admin_otp.code_at(1001)])
        self.assertEqual(codes[2], admin_otp.code_at(1002))
        self.assertEqual(len(slept), 1, "the third waits for the next step, inside Keycloak's look-around window")
        self.assertEqual(other, admin_otp.code_at(int(clock[0] // 30)))

    def test_the_loop_answers_the_otp_form_and_retries_a_refused_code(self):
        clock = [2000 * 30 + 1.0]
        for name, fake in (("time", lambda: clock[0]), ("sleep", lambda s: clock.__setitem__(0, clock[0] + s))):
            patcher = patch.object(admin_otp.time, name, side_effect=fake)
            patcher.start(); self.addCleanup(patcher.stop)
        form = '<form id="kc-otp-login-form" class="x" action="https://kc.invalid/login-actions/authenticate?a=1&amp;b=2">'
        posts, answers = [], [(form, "refused"), ("", "callback")]
        result = admin_otp.answer(lambda action, body: (posts.append((action, parse_qs(body.decode())["otp"][0])), answers.pop(0))[1],
                                  form, "syn-admin")
        self.assertEqual(result, "callback")
        self.assertEqual([action for action, _ in posts], ["https://kc.invalid/login-actions/authenticate?a=1&b=2"] * 2)
        self.assertNotEqual(posts[0][1], posts[1][1])
        self.assertIsNone(admin_otp.answer(lambda *a: self.fail("no OTP form, no post"), "<form id=\"kc-form-login\">", "syn-doctor"))
        with self.assertRaisesRegex(RuntimeError, "refused the synthetic OTP"):
            admin_otp.answer(lambda action, body: (form, None), form, "syn-admin")


if __name__ == "__main__":
    unittest.main(verbosity=2)
