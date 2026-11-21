"""The image store stops while the API and its database answer, then comes back (main.html, the real page).

- The study list is also the image store's list: when only it fails, two failed polls (or a failed Refresh) ask the
  server whether it answers at all (GET study-access reads the member's access policy from the database only). It does:
  the top status stays DB Connected, the banner says the list could not be refreshed and the last list is shown, the
  report stays editable. A Save or Approve the server refuses because it could not confirm the study's original says so
  and keeps the text; once the list reads again the warning goes, and Save and Approve made again are stored.
- When the server itself does not answer, the page goes offline as before.
- A reconnect does not wait on the study list: when the full bootstrap (it reads the store's identities) is not answered,
  the bootstrap without states reconnects.
- A viewer window this list opened that came back as the product's error page (the proxy's page for a 504 while the store
  was stopped) is read again when the study is opened from the list once more - that window only, the same study or
  another one. A window holding a viewer document is kept as before.

Synthetic data only (SYN- names, the harness of report_text_boundaries_dom_test.py).
"""
import re
import unittest
from pathlib import Path

import auth_logout_dom_test as h
import report_text_boundaries_dom_test as rtb
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
STORE_DOWN = (503, {"message": "Orthanc에 연결할 수 없습니다: fetch failed"})
SOURCE_UNAVAILABLE = (503, {"code": "STUDY_SOURCE_UNAVAILABLE", "message": "검사 원본을 확인하지 못했습니다. 잠시 후 다시 시도하세요"})


def proxy_error_page(status):
    """The product's error page as the proxy sends it (proxy/nginx.conf.template, location @kin_error_page)."""
    template = (ROOT / "proxy/nginx.conf.template").read_text(encoding="utf-8")
    body = re.search(r"location @kin_error_page \{.*?return 200 \"(.*?)\";\n    \}", template, re.S).group(1)
    line = re.search(r"^\s*%d\s+\"([^\"]+)\";" % status, template, re.M).group(1)
    return body.replace("$kin_error_line", line).replace("$status", str(status))


class StoreSite(rtb.MultiStudySite):
    def __init__(self):
        super().__init__()
        self.viewer_error = None        # the status the proxy's error page answers the viewer document with, while set

    def handle(self, route, request):
        url = h.urlparse(request.url)
        if (request.method == "GET" and url.path == "/ohif/viewer" and self.viewer_error
                and f"{url.scheme}://{url.netloc}" == h.ORIGIN):
            self.viewer_opens.append(url.query)
            return route.fulfill(status=self.viewer_error, content_type="text/html; charset=utf-8",
                                 body=proxy_error_page(self.viewer_error))
        return super().handle(route, request)


class ImageStoreDown(h.LogoutDOMTest):
    def setUp(self):
        super().setUp()
        self.site = StoreSite()

    collect_notices = rtb.ReportTextBoundaries.collect_notices

    def status(self):
        return self.page.locator("#dbstat")

    def switch(self, patient):
        self.page.locator("#rows tr", has_text=patient).first.click()

    def open_images(self, known):
        if known is None:
            with self.context.expect_page() as opened:
                self.page.locator("#m-filmbox").click()
            viewer = self.watch(opened.value)
            viewer.wait_for_url("**/ohif/viewer?**", wait_until="load")
            return viewer
        self.page.locator("#m-filmbox").click()
        return known

    def test_only_the_store_stopped_keeps_the_connection_and_saves_after_it_is_back(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.list_answers = [STORE_DOWN] * 2
        checks = self.site.count("GET", "/api/study-access")
        self.page.clock.run_for(61000)
        self.wait_until(lambda: self.site.count("GET", "/api/study-access") > checks, "the connection check")
        self.page.wait_for_timeout(200)
        expect(self.status()).to_contain_text("DB Connected")
        expect(self.page.locator("#err")).to_contain_text("검사 목록을 갱신하지 못했습니다. 마지막 목록을 표시합니다")
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        self.assertEqual(h.FIELDS, self.editor())
        expect(self.page.locator("#b-save")).to_be_enabled()
        # Save while the store is down: the server could not confirm the study's original and stored nothing.
        notices = self.collect_notices()
        self.site.commit_answers = [SOURCE_UNAVAILABLE]
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 1, "the refused Save")
        self.wait_until(lambda: any("검사 원본을 확인하지 못했습니다" in text for text, _ in notices), "the refusal is said")
        self.assertEqual(h.FIELDS, self.editor(), "the text stays in the editor")
        self.assertEqual(0, self.site.report["version"], "nothing was stored")
        expect(self.status()).to_contain_text("DB Connected")
        expect(self.page.locator("#b-save")).to_be_enabled()
        # The store is back: the next poll reads the list and the warning goes.
        self.page.clock.run_for(31000)
        expect(self.page.locator("#err")).to_have_text("")
        # Save again: one version with the kept text, In Progress (T).
        self.page.locator("#b-save").click()
        self.wait_until(lambda: len(self.site.commits) == 2 and self.site.report["version"] == 1, "the Save made again")
        self.assertEqual(("T", h.FIELDS["findings"]), (self.site.report["rs"], self.site.report["findings"]))
        self.page.locator("#b-approve").click()
        self.wait_until(lambda: self.site.report["rs"] == "A", "the Approve")
        self.assertEqual(2, self.site.report["version"])

    def test_a_list_read_the_store_holds_without_an_answer_is_not_a_lost_connection(self):
        """The store is paused: list reads wait on it until their limit; the connection check is answered."""
        self.page.clock.install()
        self.open_main()
        self.site.held_gets["/api/studies"] = []
        self.refresh()
        self.wait_until(lambda: self.site.held_gets["/api/studies"], "the held list read")
        checks = self.site.count("GET", "/api/study-access")
        self.page.clock.run_for(60000)
        self.wait_until(lambda: self.site.count("GET", "/api/study-access") > checks, "the connection check")
        self.page.clock.run_for(60000)
        self.page.wait_for_timeout(200)
        expect(self.status()).to_contain_text("DB Connected")
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)

    def test_a_server_that_does_not_answer_still_goes_offline(self):
        self.page.clock.install()
        self.open_main()
        self.select_and_type()
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.site.gets["/api/study-access"] = (502, {"message": "SYN bad gateway"})
        self.page.clock.run_for(61000)
        expect(self.status()).to_contain_text("서버 연결 끊김")
        self.assertEqual(h.FIELDS, self.editor())

    def test_a_reconnect_while_the_store_is_still_down_does_not_wait_on_the_list(self):
        self.page.clock.install()
        self.open_main()
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.site.gets["/api/study-access"] = (502, {"message": "SYN bad gateway"})
        self.page.clock.run_for(61000)
        expect(self.status()).to_contain_text("서버 연결 끊김")
        # The API is back, the store not: every bootstrap and the list fail (a restricted account's order check reads
        # the store even without states), the database answers the connection check.
        del self.site.gets["/api/study-access"]
        original_api = self.site.api

        def api(route, request, method, path, query):
            if method == "GET" and path == "/api/bootstrap":
                return self.site.answer(route, *STORE_DOWN)
            return original_api(route, request, method, path, query)

        self.site.api = api
        self.site.list_answers = [STORE_DOWN] * 4
        self.site.gets["/api/study-access"] = (200, {"restricted": True, "revision": 1})
        checks = self.site.count("GET", "/api/study-access")
        self.status().click()
        expect(self.status()).to_contain_text("DB Connected")
        self.assertGreater(self.site.count("GET", "/api/study-access"), checks, "the connection check decided")
        expect(self.page.locator("#rows")).to_contain_text(h.PATIENT)
        # The automatic reconnect decides the same way.
        self.site.gets["/api/study-access"] = (502, {"message": "SYN bad gateway"})
        self.site.list_answers = [(500, {"code": "SYN_OUTAGE"})] * 2
        self.page.clock.run_for(61000)
        expect(self.status()).to_contain_text("서버 연결 끊김")
        self.site.gets["/api/study-access"] = (200, {"restricted": True, "revision": 1})
        self.site.list_answers = [STORE_DOWN] * 4
        self.page.clock.run_for(16000)
        expect(self.status()).to_contain_text("DB Connected")

    def test_a_failed_refresh_notice_goes_with_the_next_list_a_poll_reads(self):
        self.page.clock.install()
        self.open_main()
        self.site.list_answers = [STORE_DOWN]
        self.refresh()
        expect(self.page.locator("#err")).to_contain_text("검사 목록을 불러오지 못했습니다")
        expect(self.status()).to_contain_text("DB Connected")
        self.page.clock.run_for(31000)
        expect(self.page.locator("#err")).to_have_text("")

    def test_the_error_page_window_is_read_again_from_the_list(self):
        self.open_main()
        self.switch(h.PATIENT)
        # The store is stopped: the viewer document comes back as the proxy's error page.
        self.site.viewer_error = 504
        viewer = self.open_images(None)
        expect(viewer.locator("p.code")).to_contain_text("504")
        self.assertEqual(1, len(self.site.viewer_opens))
        # The store is back. The same study opened again reads that window again, in place.
        self.site.viewer_error = None
        self.open_images(viewer)
        self.wait_until(lambda: len(self.site.viewer_opens) == 2, "the error window is read again", page=viewer)
        viewer.wait_for_function("() => window.__synEntry && window.__synEntry.session")
        self.assertEqual(self.site.cookie, viewer.evaluate("() => window.__synEntry.session"))
        self.assertEqual(1, len([page for page in self.context.pages if "/ohif/viewer" in page.url]), "no second window")
        # A viewer document is only focused when the same study is opened again (as before).
        self.open_images(viewer)
        self.page.wait_for_timeout(400)
        self.assertEqual(2, len(self.site.viewer_opens))
        self.assertEqual([], self.dialogs)

    def test_the_error_page_window_opens_another_study(self):
        self.open_main()
        self.switch(h.PATIENT)
        self.site.viewer_error = 504
        viewer = self.open_images(None)
        expect(viewer.locator("p.code")).to_contain_text("504")
        self.site.viewer_error = None
        self.switch(h.PATIENT_B)
        self.open_images(viewer)
        self.wait_until(lambda: len(self.site.viewer_opens) == 2, "the error window opens the other study", page=viewer)
        self.assertNotEqual(self.site.viewer_opens[0], self.site.viewer_opens[1])
        viewer.wait_for_function("() => window.__synEntry && window.__synEntry.session")
        self.assertEqual(1, len([page for page in self.context.pages if "/ohif/viewer" in page.url]), "no second window")

    def test_an_error_page_window_this_list_did_not_open_is_kept(self):
        """The list read again holds no record of having navigated that window: the usual protection stands."""
        self.open_main()
        self.switch(h.PATIENT)
        self.site.viewer_error = 504
        viewer = self.open_images(None)
        expect(viewer.locator("p.code")).to_contain_text("504")
        self.site.viewer_error = None
        self.open_main()
        self.switch(h.PATIENT)
        self.page.locator("#m-filmbox").click()
        self.page.wait_for_timeout(500)
        # Whatever the reloaded list opens, it does not read that window again.
        expect(viewer.locator("p.code")).to_contain_text("504")
        self.assertIn("/ohif/viewer", viewer.url)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(ImageStoreDown(name) for name in ImageStoreDown.__dict__ if name.startswith('test_'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
