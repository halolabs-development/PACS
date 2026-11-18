# coding: utf-8
"""The viewer's application files are kept by the browser only when their name changes with their content.

Every new viewer window and every reload asked the server for the whole viewer application again (about 24 MB of
JavaScript and WebAssembly): the embedded viewer's answers carry no Cache-Control and no validator, so a browser has
no ground to reuse them. The pinned viewer build names almost all of those bytes after their content
(`app.bundle.<20 hex>.js`, `<id>.bundle.<20 hex>.js`, `<20 hex>.wasm`): such a name never serves other bytes, so the
proxy lets the browser keep it for a year without asking. Every other file under /ohif/ keeps a fixed name across
releases (the viewer page, app-config.js, `<id>.css`, polyfills, icons), so the browser must ask again before each
use ("no-cache"). That is what makes a new release visible at once: the page and the configuration are asked for
again, and the new page names new bundles.

Images, metadata, reports and every other route keep the cache policy their service answers with (images are
no-store by design: each display is recorded).

Real nginx over the repository's own proxy configuration, rendered as proxy_grant_log_test.py renders it, in both
deployment modes; one local recorder stands in for every upstream and answers with the status and Cache-Control a
case asks for. Error answers under /ohif/ are no-store, so a bundle missing during a release is asked for again.
nginx and sh come from PATH or KIN_PROXY_NGINX / KIN_PROXY_SH (never a skip).
"""
import http.client
import http.server
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proxy_grant_log_test import PRODUCTION_HOST, Proxy  # noqa: E402

KEEP = "public, max-age=31536000, immutable"
CHECK = "no-cache"
WORKER = "/ohif/1927.bundle.497fe7ce9f85fada0cc8.js"
# Names as the pinned viewer build writes them (the image's /ohif/ listing).
HASHED = (
    "/ohif/app.bundle.6656ed549d35896854f2.js",
    "/ohif/4571.bundle.3b1691730b3c57bf4d35.js",
    "/ohif/8295.bundle.4ecb27f9e58526f12bcb.js",
    WORKER,
    "/ohif/17dd54813d5acc10bf8f.wasm",
    "/ohif/dicom-microscopy-viewer/c22b37c3488e1d6c3aa4.wasm",
)
FIXED = (
    "/ohif/", "/ohif/viewer", "/ohif/viewer?StudyInstanceUIDs=2.25.1", "/ohif/index.html", "/ohif/app-config.js",
    "/ohif/init-service-worker.js", "/ohif/app.bundle.css", "/ohif/1266.css", "/ohif/8228.css",
    "/ohif/es6-shim.min.js", "/ohif/polyfill.min.js", "/ohif/oidc-client.min.js", "/ohif/google.js",
    "/ohif/silent-refresh.html", "/ohif/serve.json", "/ohif/assets/favicon-32x32.png",
    "/ohif/assets/images/tool-length.svg", "/ohif/dicom-microscopy-viewer/dicomMicroscopyViewer.min.js",
    "/ohif/dicom-microscopy-viewer/index.worker.min.worker.js",
    # Near a content name, but not one: a source map of a hashed bundle, a short or upper-case "hash", a hash that is
    # a folder, and a content name under another prefix.
    "/ohif/app.bundle.6656ed549d35896854f2.js.map", "/ohif/4571.bundle.3b1691730b3c57bf4d3.js",
    "/ohif/4571.bundle.3B1691730B3C57BF4D35.js", "/ohif/3b1691730b3c57bf4d35.js/x.js",
    "/ohif/app.bundle.6656ed549d35896854f2.css",
)
# (target, what the upstream answers with): routes that are not viewer application files keep the upstream's policy.
OTHER = (
    ("/worklist/hpacs-lite/main.html", "no-cache, no-store, must-revalidate"),
    ("/worklist/hpacs-lite/viewer-preload.js", "no-cache, no-store, must-revalidate"),
    ("/worklist/hpacs-lite/app.bundle.6656ed549d35896854f2.js", "no-cache, no-store, must-revalidate"),
    ("/dicom-web/studies/2.25.1/series/2.25.2/metadata", "no-store"),
    ("/dicom-web/studies/2.25.1/series/2.25.2/instances/2.25.3/frames/1", "no-store"),
    ("/dicom-web/studies/2.25.1/series", "no-store"),
    ("/instances/0f0f0f0f-0f0f0f0f-0f0f0f0f-0f0f0f0f-0f0f0f0f/preview", "no-store"),
    ("/api/worklist", "no-store"),
    ("/api/ohif/app.bundle.6656ed549d35896854f2.js", "no-store"),
    ("/auth/realms/kin/protocol/openid-connect/certs", None),
)


class Upstream(http.server.BaseHTTPRequestHandler):
    """Every proxied service: the status and Cache-Control a case names (X-Probe-*), and the path it was given."""
    protocol_version = "HTTP/1.1"
    seen = []

    def answer(self):
        Upstream.seen.append(self.path)
        if self.path.startswith("/api/authz/"):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = b"" if self.command == "HEAD" else b"BODY"
        self.send_response(int(self.headers.get("X-Probe-Status", "200")))
        self.send_header("Content-Type", "application/javascript")
        self.send_header("Content-Length", "4")
        if self.headers.get("X-Probe-Cache"):
            self.send_header("Cache-Control", self.headers["X-Probe-Cache"])
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_HEAD = answer

    def log_message(self, *args):
        pass


class ViewerAppCacheTests(unittest.TestCase):
    mode = "development"
    host = "localhost"

    @classmethod
    def setUpClass(cls):
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.proxy = Proxy(cls.mode, cls.upstream.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.proxy.stop()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def request(self, target, method="GET", status=200, cache=None):
        headers = {"Host": self.host, "X-Probe-Status": str(status)}
        if cache:
            headers["X-Probe-Cache"] = cache
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.p443, timeout=10)
        try:
            connection.request(method, target, headers=headers)
            response = connection.getresponse()
            response.read()
            return response.status, response.headers
        finally:
            connection.close()

    def page_security(self):
        status, headers = self.request("/ohif/viewer?StudyInstanceUIDs=2.25.1")
        self.assertEqual(status, 200)
        return {name: headers.get_all(name) for name in ("Content-Security-Policy", "Strict-Transport-Security",
                                                          "X-Content-Type-Options", "Referrer-Policy")}

    def assertSecurityKept(self, target, headers, page):
        # A cache header must not cost a response its security headers (a location's add_header drops inherited ones).
        for name, values in page.items():
            got = headers.get_all(name)
            if name == "Content-Security-Policy" and target.split("?")[0] == WORKER:
                self.assertEqual(1, len(got or []), target)
                self.assertIn("'unsafe-eval'", got[0], target)
                continue
            self.assertEqual(values, got, (target, name))

    def test_content_named_viewer_files_are_kept_without_asking(self):
        page = self.page_security()
        for target in HASHED + tuple(t + "?v=1" for t in HASHED):
            for method in ("GET", "HEAD"):
                # An upstream that one day answers with its own policy must not leave a second, contradicting header.
                for upstream in (None, "no-store"):
                    with self.subTest(target=target, method=method, upstream=upstream):
                        status, headers = self.request(target, method, cache=upstream)
                        self.assertEqual(200, status)
                        self.assertEqual([KEEP], headers.get_all("Cache-Control"))
                        self.assertSecurityKept(target, headers, page)
                        self.assertEqual(target, Upstream.seen[-1], "the file still comes from the viewer server")

    def test_fixed_name_viewer_files_are_asked_for_again_before_each_use(self):
        page = self.page_security()
        for target in FIXED:
            for method in ("GET", "HEAD"):
                with self.subTest(target=target, method=method):
                    status, headers = self.request(target, method)
                    self.assertEqual(200, status)
                    self.assertEqual([CHECK], headers.get_all("Cache-Control"))
                    self.assertSecurityKept(target, headers, page)

    def test_failed_answers_for_viewer_files_are_not_kept(self):
        # During a release a browser can ask for a bundle the server does not have (yet); that answer must not stick,
        # whatever the viewer server says about it.
        page = self.page_security()
        for target in HASHED + FIXED[:5]:
            for status in (404, 500, 503):
                for upstream in (None, "max-age=600"):
                    with self.subTest(target=target, status=status, upstream=upstream):
                        got, headers = self.request(target, status=status, cache=upstream)
                        self.assertEqual(status, got)
                        self.assertEqual(["no-store"], headers.get_all("Cache-Control"))
                        self.assertSecurityKept(target, headers, page)

    def test_failed_answers_elsewhere_keep_their_own_policy(self):
        for target, upstream in OTHER:
            for status in (404, 503):
                with self.subTest(target=target, status=status):
                    got, headers = self.request(target, status=status, cache=upstream)
                    self.assertEqual(status, got)
                    # A failed screen file is the proxy's error page (proxy_error_page_test.py), which is never kept.
                    expected = ["no-store"] if target.startswith("/worklist/") else [upstream] if upstream else None
                    self.assertEqual(expected, headers.get_all("Cache-Control"))

    def test_images_records_and_other_routes_keep_their_own_policy(self):
        for target, upstream in OTHER:
            with self.subTest(target=target):
                status, headers = self.request(target, cache=upstream)
                self.assertEqual(200, status)
                self.assertEqual([upstream] if upstream else None, headers.get_all("Cache-Control"))
        status, headers = self.request("/ops-status.json")
        self.assertEqual(["no-store"], headers.get_all("Cache-Control"))


class ProductionViewerAppCacheTests(ViewerAppCacheTests):
    """Production adds HSTS on every answer; the cache header must keep it on the viewer files too."""
    mode = "production"
    host = PRODUCTION_HOST

    def test_strict_transport_security_is_on_viewer_files(self):
        for target in (HASHED[0], WORKER, "/ohif/app-config.js"):
            with self.subTest(target=target):
                _, headers = self.request(target)
                self.assertEqual(1, len(headers.get_all("Strict-Transport-Security") or []))


if __name__ == "__main__":
    unittest.main(verbosity=2)
