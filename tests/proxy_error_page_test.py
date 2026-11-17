# coding: utf-8
"""When an address a person opens in a browser fails, the proxy answers with one product error page.

Before, the proxy and the services behind it drew their own failures: an unknown address answered `404 not exposed`
with no type (a browser downloaded it as a file named after the path), a missing screen file showed the image
server's JSON, the closed sign-in account and admin addresses and an unauthenticated image address showed nginx's
default page with its version, and a service that was down showed nginx's default 502/503 page.

Now every failure nginx itself produces (a closed or unknown address, a refused sign-in check, an upload over the
limit, a service that does not answer) and every failure of the two screen folders (/worklist/, /ohif/) is the same
static page from the proxy image: one line saying what failed, the status number, links back to the worklist and to
the sign-in screen, no server name or version, nothing from the request. It keeps the security headers every page
has, is never cached, and works with only the proxy alive.

What programs read keeps its shape: the API's and the sign-in server's own answers (JSON, status) pass untouched, the
viewer's decoder worker keeps its own policy, and an image request refused by the sign-in check keeps its status and
X-KIN-Auth-Code (the screens decide "session ended" from exactly those two).

Real nginx over the repository's own configuration, rendered as proxy_grant_log_test.py renders it, in both
deployment modes. nginx and sh come from PATH or KIN_PROXY_NGINX / KIN_PROXY_SH (never a skip).
"""
import http.client
import http.server
import json
import re
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proxy_grant_log_test import ARCHIVE, PRODUCTION_HOST, Proxy, free_ports, marker  # noqa: E402

MARK = "SYNPATHMARK7f3a"  # put into request paths: the page must not echo the address
WORKLIST = "/worklist/hpacs-lite/main.html"
SIGN_IN = "/worklist/hpacs-lite/index.html"
WORKER = "/ohif/1927.bundle.497fe7ce9f85fada0cc8.js"
LINES = {
    401: "로그인이 필요합니다. 다시 로그인하세요.",
    403: "이 화면이나 자료를 열 권한이 없습니다.",
    404: "찾는 화면이 없습니다. 주소가 바뀌었거나 잘못 입력되었을 수 있습니다.",
    413: "보낸 파일이 너무 큽니다.",
    500: "서버가 지금 응답하지 않습니다. 잠시 뒤 다시 시도하세요.",
    502: "서버가 지금 응답하지 않습니다. 잠시 뒤 다시 시도하세요.",
    503: "서버가 지금 응답하지 않습니다. 잠시 뒤 다시 시도하세요.",
    504: "서버의 응답이 늦어 요청을 마치지 못했습니다. 잠시 뒤 다시 시도하세요.",
}
ORTHANC_404 = json.dumps({"HttpError": "Not Found", "HttpStatus": 404, "Message": "Unknown resource",
                          "OrthancError": "Inexistent file", "OrthancStatus": 7})


class Upstream(http.server.BaseHTTPRequestHandler):
    """Every proxied service. A case names the answer: X-Probe-Status / X-Probe-Body / X-Probe-Type, and for the
    sign-in check (/api/authz/...) X-Probe-Authz / X-Probe-Authz-Code."""
    protocol_version = "HTTP/1.1"

    def answer(self):
        if self.path.startswith("/api/authz/"):
            self.send_response(int(self.headers.get("X-Probe-Authz", "204")))
            if self.headers.get("X-Probe-Authz-Code"):
                self.send_header("X-KIN-Auth-Code", self.headers["X-Probe-Authz-Code"])
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        body = self.headers.get("X-Probe-Body", "UPSTREAM-BODY").encode()
        self.send_response(int(self.headers.get("X-Probe-Status", "200")))
        self.send_header("Content-Type", self.headers.get("X-Probe-Type", "text/html"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = do_HEAD = do_POST = answer

    def log_message(self, *args):
        pass


class ErrorPageTests(unittest.TestCase):
    mode = "development"
    host = "localhost"

    @classmethod
    def setUpClass(cls):
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.proxy = Proxy(cls.mode, cls.upstream.server_port)
        # The same configuration with nothing behind it: only the proxy is alive.
        cls.alone = Proxy(cls.mode, free_ports(1)[0])

    @classmethod
    def tearDownClass(cls):
        cls.proxy.stop()
        cls.alone.stop()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def request(self, target, method="GET", headers=None, body=None, proxy=None):
        sent = {"Host": self.host}
        sent.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", (proxy or self.proxy).p443, timeout=20)
        try:
            connection.request(method, target, body=body, headers=sent)
            response = connection.getresponse()
            return response.status, response.headers, response.read().decode("utf-8", errors="replace")
        finally:
            connection.close()

    def page_security(self):
        status, headers, _ = self.request("/ohif/viewer")
        self.assertEqual(200, status)
        return {name: headers.get_all(name) for name in ("Content-Security-Policy", "Strict-Transport-Security",
                                                          "X-Content-Type-Options", "Referrer-Policy")}

    def assertErrorPage(self, label, status, headers, body, expected, method="GET"):
        self.assertEqual(expected, status, label)
        self.assertEqual("text/html; charset=utf-8", headers.get("Content-Type"), label)
        self.assertEqual(["no-store"], headers.get_all("Cache-Control"), f"{label}: an error page is never kept")
        for name, values in self.security.items():
            self.assertEqual(values, headers.get_all(name), f"{label}: {name} as on every page")
        self.assertNotRegex(headers.get("Server", ""), r"[0-9]", f"{label}: no server version in the header")
        # The same isolation as the screens, so a worklist or viewer window that shows it keeps its window handles.
        self.assertEqual(["same-origin"], headers.get_all("Cross-Origin-Opener-Policy"), label)
        self.assertEqual(["require-corp"], headers.get_all("Cross-Origin-Embedder-Policy"), label)
        if method == "HEAD":
            self.assertEqual("", body, label)
            return
        self.assertIn("HALO PACS", body, label)
        self.assertIn(LINES[expected], body, f"{label}: the line says what failed")
        self.assertIn(f">{expected}</span>", body, f"{label}: the status number")
        self.assertRegex(body, f"href=['\"]{WORKLIST}['\"]", f"{label}: a way back to the worklist")
        self.assertRegex(body, f"href=['\"]{SIGN_IN}['\"]", f"{label}: a way back to the sign-in screen")
        for word in ("nginx", "Orthanc", "OrthancError", "not exposed", "UPSTREAM-BODY", MARK, "KIN_ERROR_"):
            self.assertNotIn(word, body, f"{label}: {word!r} on the page")
        self.assertNotIn("<script", body.lower(), f"{label}: the page reads without script")

    def setUp(self):
        self.security = self.page_security()

    def test_unknown_and_closed_addresses_show_the_error_page(self):
        targets = ("/" + MARK, "/favicon.ico", f"/{MARK}/x.html?q={MARK}", "/auth/realms/kin/account",
                   "/auth/realms/kin/account/" + MARK, "/auth/admin/", "/auth/admin", "/auth/realms/master/",
                   f"/kin-brand/{MARK}.svg")
        for target in targets:
            for method in ("GET", "HEAD"):
                with self.subTest(target=target, method=method):
                    status, headers, body = self.request(target, method)
                    self.assertErrorPage(target, status, headers, body, 404, method)

    def test_missing_screen_files_show_the_error_page_not_the_image_server_json(self):
        for target in (f"/worklist/hpacs-lite/{MARK}.html", f"/worklist/{MARK}", f"/ohif/{MARK}",
                       "/ohif/app.bundle.6656ed549d35896854f2.js"):
            with self.subTest(target=target):
                status, headers, body = self.request(target, headers={
                    "X-Probe-Status": "404", "X-Probe-Body": ORTHANC_404, "X-Probe-Type": "application/json"})
                self.assertErrorPage(target, status, headers, body, 404)

    def test_screen_folders_failing_behind_the_proxy_show_the_error_page(self):
        for target in (WORKLIST, "/ohif/viewer?StudyInstanceUIDs=2.25.1"):
            for code in (500, 502, 503, 504):
                with self.subTest(target=target, status=code):
                    status, headers, body = self.request(target, headers={"X-Probe-Status": str(code)})
                    self.assertErrorPage(target, status, headers, body, code)

    def test_with_only_the_proxy_alive_every_screen_address_shows_the_error_page(self):
        for target in (WORKLIST, SIGN_IN, "/ohif/viewer", "/auth/realms/kin/protocol/openid-connect/auth",
                       "/api/worklist", "/dicom-web/studies", "/dicom-web/studies/2.25.1", WORKER,
                       "/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/1"):
            with self.subTest(target=target):
                status, headers, body = self.request(target, proxy=self.alone)
                # The sign-in check of an image address cannot be asked either: nginx answers 500 for it.
                self.assertErrorPage(target, status, headers, body, 500 if target == "/dicom-web/studies" else 502)

    def test_an_image_address_opened_without_sign_in_shows_the_page_and_keeps_what_the_screens_read(self):
        cases = ((401, "AUTH_SESSION_ENDED"), (401, None), (403, "AUTH_SESSION_MISMATCH"), (403, None))
        for target in ("/dicom-web/studies", "/dicom-web/studies/2.25.1/series", "/statistics", "/system"):
            for code, auth_code in cases:
                with self.subTest(target=target, status=code, code=auth_code):
                    probe = {"X-Probe-Authz": str(code)}
                    if auth_code:
                        probe["X-Probe-Authz-Code"] = auth_code
                    status, headers, body = self.request(target, headers=probe)
                    self.assertErrorPage(target, status, headers, body, code)
                    self.assertEqual([auth_code] if auth_code else None, headers.get_all("X-KIN-Auth-Code"),
                                     "the screens tell an ended session from this header")

    def test_an_upload_over_the_limit_shows_the_error_page(self):
        status, headers, body = self.request("/api/reports", "POST", body=b"x" * (2 * 1024 * 1024 + 1),
                                             headers={"Content-Type": "application/json"})
        self.assertErrorPage("POST /api/reports over 2m", status, headers, body, 413)

    def test_a_failing_write_keeps_its_status_whatever_the_method(self):
        # The page must not turn a refused or failed write into another status (a static file answers POST with 405).
        status, headers, body = self.request("/instances/0f0f0f0f-0f0f0f0f-0f0f0f0f-0f0f0f0f-0f0f0f0f", "DELETE")
        self.assertErrorPage("DELETE an image", status, headers, body, 403)
        status, headers, body = self.request("/dicom-web/studies/2.25.1/series", "POST", body=b"x")
        self.assertErrorPage("POST to a read-only image address", status, headers, body, 403)
        for method in ("POST", "PUT", "DELETE"):
            with self.subTest(method=method):
                status, headers, body = self.request("/" + MARK, method, body=b"x")
                self.assertErrorPage(method + " unknown address", status, headers, body, 404)
                status, headers, body = self.request("/api/reports", method, body=b"{}", proxy=self.alone)
                self.assertErrorPage(method + " /api/ with the API down", status, headers, body, 502)

    def test_what_programs_read_passes_untouched(self):
        cases = (
            ("/api/worklist", 401, '{"statusCode":401,"code":"AUTH_SESSION_ENDED"}', "application/json"),
            ("/api/" + MARK, 404, '{"statusCode":404,"message":"Cannot GET"}', "application/json"),
            ("/api/worklist", 503, '{"statusCode":503}', "application/json"),
            ("/auth/realms/kin/protocol/openid-connect/token", 400, '{"error":"invalid_grant"}', "application/json"),
            ("/auth/realms/kin/login-actions/authenticate", 400, "<html>sign-in server page</html>", "text/html"),
            ("/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/1", 404, '{"m":"x"}', "application/json"),
            ("/instances/0f0f0f0f-0f0f0f0f-0f0f0f0f-0f0f0f0f-0f0f0f0f/preview", 503, '{"m":"x"}', "application/json"),
            (WORKER, 404, ORTHANC_404, "application/json"),
            (WORKLIST, 200, "<html>worklist</html>", "text/html"),
        )
        for target, code, payload, kind in cases:
            with self.subTest(target=target, status=code):
                status, headers, body = self.request(target, method="POST" if target.endswith("/token") else "GET",
                                                     headers={"X-Probe-Status": str(code), "X-Probe-Body": payload,
                                                              "X-Probe-Type": kind})
                self.assertEqual(code, status)
                self.assertEqual(payload, body, "the service's own answer")
                self.assertEqual(kind, headers.get("Content-Type"))
        _, headers, _ = self.request(WORKER, headers={"X-Probe-Status": "404"})
        self.assertIn("'unsafe-eval'", headers.get("Content-Security-Policy"), "the decoder worker keeps its policy")

    def test_a_failed_download_shows_the_page_and_logs_neither_the_grant_nor_another_address(self):
        value = marker(64)
        before, _ = self.alone.logs()
        status, headers, body = self.request(ARCHIVE + "?grant=" + value, proxy=self.alone)
        self.assertErrorPage("archive with the API down", status, headers, body, 502)
        self.assertNotIn(value, body)
        for _ in range(40):
            access, error = self.alone.logs()
            if len(access) > len(before):
                break
            time.sleep(0.025)
        lines = access[len(before):]
        self.assertIn(f'"GET {ARCHIVE}" 502 ', lines, "logged in the archive format under its own address")
        self.assertNotIn(value, lines)
        self.assertNotIn(value, error)

    def test_answers_that_are_not_the_error_page_get_no_isolation_headers_from_it(self):
        for target, expected in (("/api/worklist", None), ("/ohif/viewer", None), (WORKLIST, ["same-origin"])):
            with self.subTest(target=target):
                _, headers, _ = self.request(target)
                self.assertEqual(expected, headers.get_all("Cross-Origin-Opener-Policy"))

    def test_no_server_version_anywhere(self):
        for target in ("/", WORKLIST, "/" + MARK, "/api/worklist"):
            with self.subTest(target=target):
                _, headers, body = self.request(target)
                self.assertNotRegex(headers.get("Server", ""), r"[0-9]")
                self.assertNotRegex(body, r"nginx/[0-9]")


class ProductionErrorPageTests(ErrorPageTests):
    """Production adds HSTS on every answer and default servers; the error page carries HSTS too."""
    mode = "production"
    host = PRODUCTION_HOST

    def test_strict_transport_security_is_on_the_error_page(self):
        _, headers, _ = self.request("/" + MARK)
        self.assertEqual(1, len(headers.get_all("Strict-Transport-Security") or []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
