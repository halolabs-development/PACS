# coding: utf-8
"""REQ-D-WORKSPACE-WINDOWS / RISK-D-WORKSPACE-IDENTITY/UNSAVED/STALE / TEST-VIEWER-WINDOW-MANAGER-DOM."""
from page_source import read_page_bytes
from pathlib import Path
import hashlib
import os
import re
import sys
import unittest

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "worklist-v0" / "hpacs-lite" / "main.html"
WINDOWS = ROOT / "worklist-v0" / "hpacs-lite" / "viewer-windows.js"


def extract_function(source, name):
    start = source.index(f"    function {name}(")
    brace = source.index("{", start)
    depth = 0
    quote = None
    escaped = False
    line_comment = False
    block_comment = False
    for index in range(brace, len(source)):
        char = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if char in "\r\n":
                line_comment = False
            continue
        if block_comment:
            if char == "*" and following == "/":
                block_comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char == "/" and following == "/":
            line_comment = True
            continue
        if char == "/" and following == "*":
            block_comment = True
            continue
        if char in "'\"`":
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated function {name}")


def page_functions_called_by(source, root, provided):
    """`root` and the page-level functions of main.html it calls, directly or through each other (a call is the name
    followed by `(`), leaving out every name `provided` mentions. Order: root first, then as found."""
    defined = set(re.findall(r"^    function ([A-Za-z_$][\w$]*)\(", source, re.M))
    mentioned = set(re.findall(r"[A-Za-z_$][\w$]*", provided))
    found, queue = [root], [extract_function(source, root)]
    while queue:
        body = queue.pop(0)
        for name in sorted(defined - mentioned - set(found)):
            if re.search(r"(?<![\w$.])" + re.escape(name) + r"\s*\(", body):
                found.append(name)
                queue.append(extract_function(source, name))
    return found


# S7-U5: the sliced page code passes its writes through the page's work-context gate and registers its end with the
# page's session-end coordination. The shipped gate is loaded as it is, following a session that is at work for the whole
# case; onSessionEnd() is main.html's two-line registry (the end coordination itself is tests/auth_logout_dom_test.py's).
WORK_CONTEXT = ((Path(__file__).resolve().parents[1] / "worklist-v0/hpacs-lite/work-context.js").read_text(encoding="utf-8")
                + "\nconst work=KinWorkContext;work.follow({onLifecycle(listener){listener({state:'active',session:'SYN-SESSION'})}});"
                + "const sessionEndHooks=[];function onSessionEnd(end){sessionEndHooks.push(end)}\n")
HARNESS = r"""
<button id="viewer-windows-open" disabled></button>
<script>
const $ = value => document.querySelector(value);
let viewerWindows = null, viewerWindowCursor = null;
const studies = [
  {uid:'1.2.1',name:'Current',date:'2026-09-10',desc:'CT'},
  {uid:'1.2.2',name:'Compared',date:'2026-09-11',desc:'CT'}
];
const imageOpening = {snapshot:()=>({maxWindows:2})};
let openingPreference = {maxWindows:2,reuseClean:true};
imageOpening.snapshot=()=>({...openingPreference});
let sessionOwner = '["institution","doctor"]';
const KinViewerOpening = {PREFIX:'kin:',key:()=>sessionOwner ? 'kin:' + sessionOwner : null};
const KinAuth = {session:()=>({state:'approved'})};
const ohifPopupSlots = new WeakMap(), ohifPopupSequences = new WeakMap(), ohifPlacementWrites = new WeakMap();
const display={id:'display-1',left:0,top:0,width:1280,height:900,primary:true};
const KinViewerDisplayLayout = {span:()=>null,screens:details=>details.screens||[],identity:screen=>screen.id,
  fit:()=>({left:10,top:10,width:800,height:600})};
const initMonitorPermission = async()=>{}, cacheMonitorScreens=details=>{monitorDetails=details}, popupRect=()=>null;
const readOhifSpanScreens=()=>null;const OHIF_SPAN_SCREENS_KEY='kin.ohif.span.screens';
const monitorPermissionGranted = ()=>true, rememberOhifRect=()=>true, watchOhifRect=()=>{}, rememberReportedOhifRect=()=>{};
let monitorQueryUnsupported=false, monitorSessionGranted=false, monitorDetails=null;const screensCache=[display];
let demoMode=false,ohifOpenSeq=0,viewerOpenSeq=0,monitorHintShown=false;
let monitorPermission={state:'denied'};
const screen={isExtended:false};
const readStoredOhifRect=()=>null,ohifPlacement=()=>({left:10,top:10,width:800,height:600});
const toast=(message,kind,duration)=>__toasts.push({message,kind,duration});
window.__toasts=[];window.__opened=[];window.__openCalls=[];window.__blockNextOpen=false;window.__nextOpenPopup=null;
window.__blankPopup=()=>{
  const documentToken={querySelector:()=>null,visibilityState:'visible'};
  return {kind:'blank',location:{href:'about:blank'},document:documentToken,opener:{},closed:false,
    focusCalls:0,closeCalls:0,resizeCalls:0,moveCalls:0,focus(){this.focusCalls++},
    close(){this.closeCalls++;this.closed=true},resizeTo(){this.resizeCalls++},moveTo(){this.moveCalls++}};
};
// A browser answers window.open(anything, name) with the live window of that name instead of opening one (no popup
// blocker either); those lookups are recorded apart so a case can still count the windows it asked to open.
window.__lookups=[];
window.open=(...args)=>{const named=args[1]&&[...(window.__popups||[]),...__opened].find(p=>!p.closed&&p.name===args[1]);
  if(named){__lookups.push({url:args[0],name:args[1],features:args[2],active:navigator.userActivation.isActive});
    return args[2]==='noopener'?null:named}
  __openCalls.push(args);if(__blockNextOpen){__blockNextOpen=false;return null}
  const popup=__nextOpenPopup||__blankPopup();__nextOpenPopup=null;popup.openArgs=args;__opened.push(popup);return popup};
window.getScreenDetails = undefined;
window.BroadcastChannel = undefined;
window.__enableDisplay=async()=>{
  window.getScreenDetails=async()=>({screens:[display]});
  document.querySelector('#viewer-windows-displays').click();
  while(document.querySelector('#viewer-windows-displays').disabled)await new Promise(resolve=>setTimeout(resolve,0));
};
window.__holdDisplayMove=()=>{
  let resolve;window.getScreenDetails=()=>new Promise(done=>{resolve=done});
  window.__resolveDisplayMove=()=>resolve({screens:[display]});
};
function ohifPopupState(popup) {
  try {
    const href=popup.location.href;
    if (href === 'about:blank') return {kind:'blank',busy:false,dirty:false};
    if (popup.kind !== 'viewer') return {kind:popup.kind||'unknown',href,ready:false,busy:true,dirty:true};
    if (!sessionOwner || popup.owner !== sessionOwner) return {kind:'viewer',href,ready:false,busy:true,dirty:false};
    return {kind:'viewer',href,ready:popup.ready,busy:popup.busy,dirty:popup.dirty};
  } catch (_) { return {kind:'unknown',ready:false,busy:true,dirty:true}; }
}
window.__popups=[];
window.__makePopup = ({href='https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1', pending=null,
  kind='viewer',ready=true,busy=false,dirty=false,owner=sessionOwner,coverage=true,sequence=1}={}) => {
  const documentToken={querySelector:()=>null,visibilityState:'visible'};
  const popup={kind,location:{href,reload(){popup.reloadCalls++}},history:{state:null,replaceState(state,title,url){popup.location.href=new URL(url,location.origin).href}},document:documentToken,ready,busy,dirty,owner,reloadCalls:0,
    coverageCalls:0,focusCalls:0,closeCalls:0,closed:false,
    focus(){this.focusCalls++},close(){this.closeCalls++;this.closed=true},
    kinViewerFrameCoverageConfirm(callback){this.coverageCalls++;return typeof coverage==='function'?coverage(this,callback):coverage}
  };
  const target=pending||href,choice=viewerWindows.choose(target,2);
  viewerWindows.attach(choice,popup);ohifPopupSlots.set(popup,choice.index);
  if(sequence!==null)ohifPopupSequences.set(popup,sequence);
  if(pending)viewerWindows.navigating(choice,pending,documentToken);
  window.__popups.push(popup);return {popup,index:choice.index};
};
</script>
""".replace("<script>\nconst $ = value", "<script>\n" + WORK_CONTEXT + "const $ = value", 1)


class ViewerWindowManagerDOMTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)
        main_fixture = os.environ.get("KIN_VIEWER_MAIN_FIXTURE")
        cls.main_path = Path(main_fixture).resolve() if main_fixture else MAIN.resolve()
        main_bytes = cls.main_path.read_bytes()
        main_lf = main_bytes.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
        print(f"MAIN_SOURCE path={cls.main_path} raw_sha256={hashlib.sha256(main_bytes).hexdigest()} "
              f"lf_sha256={hashlib.sha256(main_lf).hexdigest()}")
        cls.main_source = read_page_bytes(cls.main_path).decode("utf-8-sig")
        cls.manager_source = extract_function(cls.main_source, "mountViewerWindows")
        cls.windows_source = WINDOWS.read_text(encoding="utf-8")
        # openOhifWindow runs with the page functions it calls, found from its body rather than named here: a helper of
        # the open path that is renamed, split or inlined changes nothing for these cases (AGENTS 1-B). What the harness
        # stands in for (any name it mentions) is not taken from the page.
        cls.open_source = "\n".join(extract_function(cls.main_source, name) for name in page_functions_called_by(
            cls.main_source, "openOhifWindow", HARNESS + cls.windows_source))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.open_harness()

    def open_harness(self):
        self.page = self.browser.new_page()
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=HARNESS)
                        if route.request.url == "https://example.test/harness" else route.abort())
        self.page.goto("https://example.test/harness")
        self.page.add_script_tag(path=str(WINDOWS.with_name('exam-scope.js')))
        self.page.add_script_tag(content=self.windows_source)
        self.page.add_script_tag(content=self.open_source + "\n" + self.manager_source + "\nmountViewerWindows();")

    def reset_harness(self):
        self.assertEqual(self.page_errors, [])
        self.page.close()
        self.open_harness()

    def tearDown(self):
        self.assertEqual(self.page_errors, [])
        self.page.close()

    def close_button(self, index=0):
        return self.page.locator(f'[data-window-index="{index}"][data-window-action="close"]')

    def focus_button(self, index=0):
        return self.page.locator(f'[data-window-index="{index}"][data-window-action="focus"]')

    def enable_display(self):
        self.page.evaluate("__enableDisplay()")
        self.page.wait_for_function("document.querySelector('[data-window-action=\"display-0\"]') !== null")

    def test_pending_refuses_before_coverage_focuses_and_closes_after_replacement(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1',
            pending:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2'});
          document.querySelector('#viewer-windows-open').click();return made.index;
        }""")
        self.close_button(result).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 0)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
        self.assertIn("닫지 않았습니다", self.page.locator("#viewer-windows-status").inner_text())

        self.page.locator(f'[data-window-index="{result}"][data-window-action="focus"]').click()
        self.assertEqual(self.page.evaluate("__popups[0].focusCalls"), 2)
        self.assertFalse(self.page.locator("#viewer-windows-dialog").evaluate("dialog=>dialog.open"))
        self.page.evaluate("""() => {
          const popup=__popups[0];popup.document={querySelector:()=>null,visibilityState:'visible'};
          popup.location.href='https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2';viewerWindows.rows();
          document.querySelector('#viewer-windows-open').click();
        }""")
        self.close_button(result).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_authenticated_clean_document_closes(self):
        index = self.page.evaluate("() => {const made=__makePopup();document.querySelector('#viewer-windows-open').click();return made.index}")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_reconnected_clean_window_without_sequence_still_closes(self):
        index = self.page.evaluate("""() => {
          const made=__makePopup({sequence:null});
          viewerWindows.end();
          viewerWindows=KinViewerWindows.create({storage:sessionStorage,owner:()=>sessionOwner,
            newId:()=>crypto.randomUUID(),origin:location.origin,describe:ohifPopupState,changed:()=>{}});
          window.__reconnectCalls=[];
          window.open=(...args)=>{__reconnectCalls.push(args);return made.popup};
          document.querySelector('#viewer-windows-open').click();return made.index;
        }""")
        self.assertTrue(self.page.evaluate("viewerWindows.rows()[0].popup === null"))
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__reconnectCalls.length"), 1)
        self.assertEqual(self.page.evaluate("__reconnectCalls[0][1]"), "kin-ohif-current")
        self.assertTrue(self.page.evaluate("ohifPopupSequences.get(__popups[0]) === undefined"))
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_confirmation_navigation_owner_and_document_changes_refuse_close(self):
        mutations = {
            "coverage_cancel": "p=>false",
            "dirty_during_confirmation": "p=>{p.dirty=true;return true}",
            "busy_during_confirmation": "p=>{p.busy=true;return true}",
            "navigation": "p=>{ohifPopupSequences.set(p,2);viewerWindows.navigating(viewerWindows.rows()[0],p.location.href,p.document);return true}",
            "pending_without_sequence_change": "p=>{viewerWindows.navigating(viewerWindows.rows()[0],'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2',p.document);return true}",
            "placement_pending": "p=>{ohifPlacementWrites.set(p,{pending:true});return true}",
            "owner": "p=>{sessionOwner='[\\\"institution\\\",\\\"other\\\"]';return true}",
            "document": "p=>{p.document={querySelector:()=>null,visibilityState:'visible'};return true}",
            "document_aba": "p=>{const old=p.document;p.document={querySelector:()=>null};ohifPopupSequences.set(p,2);viewerWindows.navigating(viewerWindows.rows()[0],p.location.href,old);viewerWindows.rows();p.document=old;return true}",
            "registry_end": "p=>{viewerWindows.end();return true}",
            "session_end": "p=>{sessionOwner=null;return true}",
            "slot_popup_replacement": "p=>{__makePopup();return true}",
        }
        for name, mutation in mutations.items():
            with self.subTest(name=name):
                self.reset_harness()
                index = self.page.evaluate(f"() => {{const made=__makePopup({{coverage:{mutation}}});document.querySelector('#viewer-windows-open').click();return made.index}}")
                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
                self.assertIn("닫지 않았습니다", self.page.locator("#viewer-windows-status").inner_text())

    def test_moving_and_pending_placement_refuse_before_coverage_then_focus_and_recover(self):
        for boundary in ("moving", "placement"):
            with self.subTest(boundary=boundary):
                self.reset_harness()
                index = self.page.evaluate("() => {const made=__makePopup();document.querySelector('#viewer-windows-open').click();return made.index}")
                if boundary == "moving":
                    self.enable_display()
                    self.page.evaluate("__holdDisplayMove()")
                    self.page.locator(f'[data-window-index="{index}"][data-window-action="display-0"]').click()
                    self.page.wait_for_function("document.querySelector('.viewer-window-row p').textContent.includes('Moving')")
                else:
                    self.page.evaluate("ohifPlacementWrites.set(__popups[0],{pending:true})")

                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 0)
                self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
                self.assertGreaterEqual(self.page.evaluate("__popups[0].focusCalls"), 1)
                self.assertIn("닫지 않았습니다", self.page.locator("#viewer-windows-status").inner_text())

                self.focus_button(index).click()
                self.assertFalse(self.page.locator("#viewer-windows-dialog").evaluate("dialog=>dialog.open"))
                if boundary == "moving":
                    self.page.evaluate("__resolveDisplayMove()")
                    self.page.wait_for_function("!document.querySelector('.viewer-window-row p').textContent.includes('Moving')")
                else:
                    self.page.evaluate("ohifPlacementWrites.delete(__popups[0])")
                self.page.locator("#viewer-windows-open").click()
                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
                self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_movement_started_during_confirmation_refuses_then_focuses_and_closes_cleanly(self):
        index = self.page.evaluate("""() => {const made=__makePopup({coverage:p=>{
          document.querySelector('[data-window-index="0"][data-window-action="display-0"]').click();return true}});
          document.querySelector('#viewer-windows-open').click();return made.index}""")
        self.enable_display()
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
        self.page.wait_for_function("!document.querySelector('.viewer-window-row p').textContent.includes('Moving')")
        self.focus_button(index).click()
        self.assertGreaterEqual(self.page.evaluate("__popups[0].focusCalls"), 1)
        self.page.locator("#viewer-windows-open").click()
        self.page.evaluate("__popups[0].kinViewerFrameCoverageConfirm=()=>true")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_registry_error_during_confirmation_fails_closed_and_actual_model_recovers(self):
        mutation = "p=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw Error('synthetic storage failure')};try{viewerWindows.choose('https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2',2)}finally{Storage.prototype.setItem=original}return true}"
        index = self.page.evaluate(f"() => {{const made=__makePopup({{coverage:{mutation}}});document.querySelector('#viewer-windows-open').click();return made.index}}")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 1)
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 0)
        self.assertFalse(self.page.evaluate("viewerWindows.available()"))
        self.page.evaluate("viewerWindows.blocked({fresh:true,index:1})")
        self.assertTrue(self.page.evaluate("viewerWindows.available()"))
        self.focus_button(index).click()
        self.assertGreaterEqual(self.page.evaluate("__popups[0].focusCalls"), 1)
        self.page.locator("#viewer-windows-open").click()
        self.page.evaluate("__popups[0].kinViewerFrameCoverageConfirm=()=>true")
        self.close_button(index).click()
        self.assertEqual(self.page.evaluate("__popups[0].closeCalls"), 1)

    def test_dirty_busy_unknown_are_protected_and_focus_remains_available(self):
        for state in ({"dirty": True}, {"busy": True}, {"kind": "unknown"}):
            with self.subTest(state=state):
                self.reset_harness()
                index = self.page.evaluate("state=>{const made=__makePopup(state);document.querySelector('#viewer-windows-open').click();return made.index}", state)
                self.close_button(index).click()
                self.assertEqual(self.page.evaluate("__popups[0].coverageCalls"), 0)
                self.page.locator(f'[data-window-index="{index}"][data-window-action="focus"]').click()
                self.assertEqual(self.page.evaluate("__popups[0].focusCalls"), 2)

    # A viewer window is detached from its opener, and Chrome ignores popup.focus() from a page that is not the opener: the
    # reused window changed its study behind the list. The list now looks the window up by a name only that window carries
    # for the call (noopener), inside the click - which is what raises an existing window (measured on Chrome 157 with real
    # input and the OS foreground window; this harness can only see the call).
    def click_to_run(self, body):
        """Run `body` from a real click, so it has the browser's user activation as a row double-click would."""
        self.page.evaluate("""body => {const b=document.createElement('button');b.id='syn-trigger';b.textContent='Trigger';
          b.onclick=new Function(body);document.body.append(b);}""", body)
        self.page.locator('#syn-trigger').click()

    def named_popup(self, **state):
        return self.page.evaluate("""state => {const made=__makePopup(state);made.popup.opener=null;
          made.popup.name=viewerWindows.rows().find(r=>r.index===made.index).name;return made.popup.name}""", state)

    def assert_one_raise(self, lookups):
        self.assertEqual(1, len(lookups), lookups)
        self.assertEqual(("", "noopener", True), (lookups[0]["url"], lookups[0]["features"], lookups[0]["active"]))
        self.assertTrue(lookups[0]["name"].startswith("kin-raise:"), lookups[0]["name"])

    def test_reused_window_comes_to_front_inside_the_click(self):
        name = self.named_popup()
        self.click_to_run("window.__result=openOhifWindow('1.2.2')")
        result = self.page.evaluate("""() => ({status:__result.status,lookups:__lookups,openCalls:__openCalls.length,
          opened:__opened.length,href:__popups[0].location.href,name:__popups[0].name,opener:__popups[0].opener,
          focusCalls:__popups[0].focusCalls})""")
        self.assertEqual("accepted", result["status"])
        self.assertIn("StudyInstanceUIDs=1.2.2", result["href"])
        self.assert_one_raise(result["lookups"])
        # The session hand-over name the next document reads is back in place after the lookup.
        self.assertEqual("kin-viewer-entry:", result["name"][:17])
        self.assertIn(name, result["name"])
        self.assertEqual((0, 0), (result["openCalls"], result["opened"]))
        self.assertIsNone(result["opener"])
        self.assertGreaterEqual(result["focusCalls"], 1)

    def test_kept_loading_and_same_study_windows_come_to_front_too(self):
        cases = {
            "unsaved": ({"dirty": True}, "'1.2.2'", "저장하지 않은"),
            "busy": ({"busy": True}, "'1.2.2'", "저장·복원"),
            "loading": ({"pending": "https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2"}, "'1.2.2'", "불러오는 중"),
            "same_study": ({}, "'1.2.1'", None),
            "coverage_refused": ({"coverage": False}, "'1.2.2'", "Frame Coverage"),
        }
        for label, (state, uid, notice) in cases.items():
            with self.subTest(case=label):
                self.reset_harness()
                name = self.named_popup(**state)
                href = self.page.evaluate("__popups[0].location.href")
                self.click_to_run(f"window.__result=openOhifWindow({uid})")
                result = self.page.evaluate("""() => ({lookups:__lookups,openCalls:__openCalls.length,opened:__opened.length,
                  href:__popups[0].location.href,name:__popups[0].name,toasts:__toasts.map(t=>t.message)})""")
                self.assert_one_raise(result["lookups"])
                self.assertEqual((0, 0, href.split("#")[0], name),
                                 (result["openCalls"], result["opened"], result["href"].split("#")[0], result["name"]))
                if notice:
                    self.assertTrue(any(notice in message for message in result["toasts"]), result["toasts"])

    def test_viewer_windows_focus_and_next_bring_the_window_to_front(self):
        name = self.named_popup()
        for action in ("focus", "next"):
            with self.subTest(action=action):
                self.page.evaluate("__lookups.length=0")
                self.page.locator("#viewer-windows-open").click()
                if action == "focus":
                    self.focus_button(0).click()
                else:
                    self.page.locator("#viewer-windows-next").click()
                self.assert_one_raise(self.page.evaluate("__lookups"))
                self.assertEqual(name, self.page.evaluate("__popups[0].name"))
                self.assertFalse(self.page.locator("#viewer-windows-dialog").evaluate("dialog=>dialog.open"))
                self.assertEqual(0, self.page.evaluate("__openCalls.length"))

    def test_without_user_activation_only_focus_is_tried(self):
        self.named_popup()
        self.page.evaluate("Object.defineProperty(navigator,'userActivation',{configurable:true,value:{isActive:false}})")
        self.click_to_run("window.__result=openOhifWindow('1.2.2')")
        result = self.page.evaluate("({lookups:__lookups,openCalls:__openCalls.length,focusCalls:__popups[0].focusCalls})")
        self.assertEqual([], result["lookups"])
        self.assertEqual(0, result["openCalls"])
        self.assertGreaterEqual(result["focusCalls"], 1)

    def test_viewer_window_focus_sites_go_through_the_shared_rule(self):
        # The pages that hold a viewer window (list launcher, Image Findings' Go to Image / Open Saved View, clinician
        # viewer button) raise it through KinExamScope.raiseWindow; a bare popup.focus() there leaves it behind the list.
        hpacs = ROOT / "worklist-v0" / "hpacs-lite"
        for name, minimum in (("viewer-launch.js", 12), ("reading-findings.js", 1), ("clinician.js", 1)):
            with self.subTest(file=name):
                source = (hpacs / name).read_text(encoding="utf-8")
                self.assertGreaterEqual(source.count("KinExamScope.raiseWindow(popup)"), minimum)
                bare = [line.strip() for line in source.splitlines()
                        if re.search(r"\bpopup\.focus\(\)", line) and "raiseWindow(popup) : popup.focus()" not in line]
                self.assertEqual([], bare)

    def test_raise_rule_looks_up_only_that_window_and_restores_its_name(self):
        result = self.page.evaluate("""() => {
          const out={};
          const make=(extra={})=>({name:'kin-ohif-current',closed:false,opener:null,focusCalls:0,focus(){this.focusCalls++},...extra});
          const from=(p,active=true)=>{const f={calls:[],navigator:{userActivation:{isActive:active}},crypto};
            f.open=(url,name,features)=>{f.calls.push([url,name,features,p?.name]);return null};return f};
          let p=make(),f=from(p);out.same=[KinExamScope.raiseWindow(p,f),f.calls,p.name,p.focusCalls,p.opener];
          p=make();f=from(p,false);out.inactive=[KinExamScope.raiseWindow(p,f),f.calls.length,p.focusCalls];
          p=make();f=from(p);f.navigator={};out.noActivationApi=[KinExamScope.raiseWindow(p,f),f.calls.length];
          p=make({name:''});f=from(p);out.unnamed=[KinExamScope.raiseWindow(p,f),f.calls.length,p.name];
          p=make({name:undefined});f=from(p);out.nameless=[KinExamScope.raiseWindow(p,f),f.calls.length];
          p=make({closed:true});f=from(p);out.closed=[KinExamScope.raiseWindow(p,f),f.calls.length];
          p=make();Object.defineProperty(p,'name',{get(){throw Error('cross-origin')}});f=from(null);out.crossOrigin=[KinExamScope.raiseWindow(p,f),f.calls.length];
          let held='kin-ohif-current';p=make();Object.defineProperty(p,'name',{get(){return held},set(){throw Error('denied')}});f=from(null);
          out.renameRefused=[KinExamScope.raiseWindow(p,f),f.calls.length];
          p=make({focus(){throw Error('focus failed')}});f=from(p);out.focusThrows=KinExamScope.raiseWindow(p,f);
          p=make();f=from(p);f.open=()=>{throw Error('blocked')};out.openThrows=[KinExamScope.raiseWindow(p,f),p.name];
          return out;}""")
        same = result["same"]
        self.assertTrue(same[0])
        self.assertEqual(1, len(same[1]))
        url, probe, features, name_at_call = same[1][0]
        self.assertEqual(("", "noopener"), (url, features))
        self.assertTrue(probe.startswith("kin-raise:") and len(probe) > 20, probe)
        self.assertEqual(probe, name_at_call)
        self.assertEqual(["kin-ohif-current", 1, None], same[2:])
        self.assertEqual([False, 0, 1], result["inactive"])
        self.assertEqual([False, 0], result["noActivationApi"])
        self.assertEqual([True, 1, ""], result["unnamed"])
        self.assertEqual([False, 0], result["nameless"])
        self.assertEqual([False, 0], result["closed"])
        self.assertEqual([False, 0], result["crossOrigin"])
        self.assertEqual([False, 0], result["renameRefused"])
        self.assertTrue(result["focusThrows"])
        self.assertEqual([False, "kin-ohif-current"], result["openThrows"])

    def test_second_study_is_neutral_comparison_with_date_and_uid(self):
        self.page.evaluate("""() => {__makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1,1.2.2'});
          document.querySelector('#viewer-windows-open').click()}""")
        text = self.page.locator(".viewer-window-row p").inner_text()
        self.assertIn("Comparison: 2026-09-11 · 1.2.2", text)
        self.assertNotIn("Prior:", text)

    def test_window_list_keeps_study_values_when_language_changes(self):
        for name in ("worklist-language-terms.js", "worklist-language.js"):
            self.page.add_script_tag(path=str(WINDOWS.with_name(name)))
        self.page.evaluate("""() => {
          Object.assign(studies[0], {name:'승인',desc:'Unread'});
          __makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1'});
          document.querySelector('#viewer-windows-open').click();
        }""")
        for lang in ("en", "ko"):
            self.page.evaluate("l => KinLanguage.restore({version:1,worklist:l,reading:l})", lang)
            label = self.page.locator(".viewer-window-row p").inner_text()
            self.assertIn("승인", label)
            self.assertIn("Unread", label)

    def test_latest_images_refusal_reads_in_the_screen_language(self):
        for name in ("worklist-language-terms.js", "worklist-language.js"):
            self.page.add_script_tag(path=str(WINDOWS.with_name(name)))
        self.page.evaluate("""() => {
          KinLanguage.restore({version:1,worklist:'en',reading:'en'});
          __makePopup({dirty:true});
          document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
        }""")
        text = self.page.locator('#viewer-windows-status').inner_text()
        self.assertTrue(text.strip())
        self.assertNotRegex(text, "[가-힣]")

    def test_latest_images_refuses_reload_and_preserves_dirty_source(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup({dirty:true});
          const original={href:made.popup.location.href,document:made.popup.document,dirty:made.popup.dirty};
          document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
          return {original,index:made.index,rows:viewerWindows.rows().map(r=>({index:r.index,pending:r.pending})),
            old:{href:made.popup.location.href,sameDocument:made.popup.document===original.document,
              dirty:made.popup.dirty,closeCalls:made.popup.closeCalls},
            fresh:__opened.map(p=>({args:p.openArgs,href:p.location.href,opener:p.opener,focusCalls:p.focusCalls}))};
        }""")
        self.assertEqual(result["index"], 0)
        self.assertEqual(result["old"], {"href": result["original"]["href"], "sameDocument": True,
                                          "dirty": True, "closeCalls": 0})
        self.assertEqual(result["rows"], [{"index": 0, "pending": False}])
        self.assertEqual(result["fresh"], [])
        self.assertIn('저장하지 않은', self.page.locator('#viewer-windows-status').inner_text())

    def test_latest_images_full_limit_never_reuses_a_clean_document(self):
        result = self.page.evaluate("""() => {
          openingPreference={maxWindows:2,reuseClean:true};
          const dirty=__makePopup({dirty:true});
          const clean=__makePopup({href:'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2'});
          const before=[dirty.popup.location.href,clean.popup.location.href];
          document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
          return {before,after:[dirty.popup.location.href,clean.popup.location.href],opened:__opened.length,
            closes:[dirty.popup.closeCalls,clean.popup.closeCalls],toasts:__toasts.map(x=>x.message),rows:viewerWindows.rows().length};
        }""")
        self.assertEqual(result["after"], result["before"])
        self.assertEqual(result["opened"], 0)
        self.assertEqual(result["closes"], [0, 0])
        self.assertEqual(result["rows"], 2)
        self.assertTrue(any("저장하지 않은" in message for message in result["toasts"]))

    def test_latest_images_clean_reload_reuses_even_when_popups_are_blocked(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup();document.querySelector('#viewer-windows-open').click();__blockNextOpen=true;
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
          return {rows:viewerWindows.rows().length,opened:__opened.length,openCalls:__openCalls.length,
            reloads:made.popup.reloadCalls,coverage:made.popup.coverageCalls,closed:made.popup.closeCalls,
            href:made.popup.location.href,opener:made.popup.opener};
        }""")
        self.assertEqual(result['rows'], 1)
        self.assertEqual(result['opened'], 0)
        self.assertEqual(result['openCalls'], 0)
        self.assertEqual(result['reloads'], 1)
        self.assertEqual(result['coverage'], 1)
        self.assertEqual(result['closed'], 0)
        self.assertIn('StudyInstanceUIDs=1.2.1', result['href'])
        self.assertIsNone(result['opener'])
        self.assertEqual('', self.page.locator('#viewer-windows-status').text_content())

    def test_latest_detached_button_revalidates_owner_pending_unknown_and_current_scope(self):
        for boundary in ("owner", "pending", "unknown"):
            with self.subTest(boundary=boundary):
                self.reset_harness()
                opened = self.page.evaluate("""boundary => {
                  const made=__makePopup();document.querySelector('#viewer-windows-open').click();
                  const old=document.querySelector('[data-window-index="0"][data-window-action="latest"]');
                  if(boundary==='owner')sessionOwner='["institution","other"]';
                  if(boundary==='pending')viewerWindows.navigating(viewerWindows.rows()[0],
                    'https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2',made.popup.document);
                  if(boundary==='unknown')made.popup.kind='unknown';
                  old.onclick();return __opened.length;
                }""", boundary)
                self.assertEqual(opened, 0)

        self.reset_harness()
        current = self.page.evaluate("""() => {
          const made=__makePopup();document.querySelector('#viewer-windows-open').click();
          const old=document.querySelector('[data-window-index="0"][data-window-action="latest"]');
          made.popup.location.href='https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.2';
          old.onclick();return {oldClose:made.popup.closeCalls,href:made.popup.location.href};
        }""")
        self.assertEqual(current["oldClose"], 0)
        self.assertIn("StudyInstanceUIDs=1.2.2", current["href"])
        self.assertNotIn("StudyInstanceUIDs=1.2.1", current["href"])

    def test_latest_dirty_source_never_requests_another_named_window(self):
        result = self.page.evaluate("""() => {
          const made=__makePopup({dirty:true});
          const original={href:made.popup.location.href,document:made.popup.document};
          document.querySelector('#viewer-windows-open').click();
          __nextOpenPopup=made.popup;
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
          return {rows:viewerWindows.rows().map(r=>({index:r.index,pending:r.pending,popup:r.popup===made.popup})),
            href:made.popup.location.href,sameDocument:made.popup.document===original.document,
            dirty:made.popup.dirty,closeCalls:made.popup.closeCalls,openCalls:__openCalls.length,
            status:document.querySelector('#viewer-windows-status').textContent};
        }""")
        self.assertEqual(result["rows"], [{"index": 0, "pending": False, "popup": True}])
        self.assertEqual(result["href"], "https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1")
        self.assertTrue(result["sameDocument"])
        self.assertTrue(result["dirty"])
        self.assertEqual(result["closeCalls"], 0)
        self.assertEqual(result["openCalls"], 0)
        self.assertIn("저장하지 않은", result["status"])

    def test_latest_collision_focus_failure_keeps_visible_notice_and_no_exception(self):
        self.page.evaluate("""()=>{const made=__makePopup({dirty:true});
          document.querySelector('#viewer-windows-open').click();
          made.popup.focus=()=>{throw Error('native focus failed')};__nextOpenPopup=made.popup;}""")
        self.page.locator('[data-window-index="0"][data-window-action="latest"]').evaluate('button=>button.onclick()')
        self.assertIn('저장하지 않은', self.page.locator('#viewer-windows-status').text_content())
        self.assertEqual([], self.page_errors)
        self.assertEqual(1, self.page.evaluate('viewerWindows.rows().length'))

    def test_latest_preserves_comparison_series_and_reading_return_scope(self):
        reading_return = "12345678-1234-4123-8123-123456789abc"
        href = ("https://example.test/ohif/viewer?StudyInstanceUIDs=1.2.1,1.2.2"
                "&hangingProtocolId=@ohif/hpCompare&initialSeriesInstanceUID=1.2.3"
                f"#kin-reading-return={reading_return}")
        opened = self.page.evaluate("""href => {
          __makePopup({href});document.querySelector('#viewer-windows-open').click();
          document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
          return __popups[0].location.href;
        }""", href)
        target = self.page.evaluate("href => {const u=new URL(href,location.origin);return {studies:u.searchParams.get('StudyInstanceUIDs'),"
                                    "hp:u.searchParams.get('hangingProtocolId'),series:u.searchParams.get('initialSeriesInstanceUID'),"
                                    "reading:new URLSearchParams(u.hash.slice(1)).get('kin-reading-return')}}", opened)
        self.assertEqual(target, {"studies": "1.2.1,1.2.2", "hp": "@ohif/hpCompare",
                                  "series": "1.2.3", "reading": reading_return})

    def test_latest_failures_are_announced_inside_the_open_dialog(self):
        scenarios = {
            "dirty": "__makePopup({dirty:true});",
            "busy": "__makePopup({busy:true});",
            "coverage": "__makePopup({coverage:false});",
        }
        for name, setup in scenarios.items():
            with self.subTest(name=name):
                self.reset_harness()
                result = self.page.evaluate(f"""() => {{
                  {setup}
                  document.querySelector('#viewer-windows-open').click();
                  document.querySelector('[data-window-index="0"][data-window-action="latest"]').onclick();
                  const dialog=document.querySelector('#viewer-windows-dialog');
                  return {{open:dialog.open,status:dialog.querySelector('#viewer-windows-status').textContent,
                    rows:viewerWindows.rows().length}};
                }}""")
                self.assertTrue(result["open"])
                self.assertTrue(result["status"].strip())
                expected = {"dirty": "저장하지 않은", "busy": "검사와 계정을 확인", "coverage": "Frame Coverage"}
                self.assertIn(expected[name], result["status"])
                self.assertEqual(result["rows"], 1)


REAL_LIST = r"""<!doctype html><meta charset="utf-8"><title>SYN LIST</title>
<button id="open">Open</button><button id="again">Again</button><button id="move">Move</button>
<script src="/exam-scope.js"></script>
<script>
let popup=null;window.results=[];
document.querySelector('#open').onclick=()=>{popup=window.open('/viewer?s=A','kin-ohif-current','popup=yes,width=400,height=300');popup.opener=null;};
document.querySelector('#again').onclick=()=>{const marker=popup.marker;
  results.push({raised:KinExamScope.raiseWindow(popup),same:popup.marker===marker,opener:popup.opener,name:popup.name});};
document.querySelector('#move').onclick=()=>{popup.name='kin-viewer-entry:'+JSON.stringify({session:'SYN',name:'kin-ohif-current'});
  popup.location.href='/viewer?s=B';results.push({raised:KinExamScope.raiseWindow(popup),opener:popup.opener});};
</script>"""
REAL_VIEWER = r"""<!doctype html><meta charset="utf-8"><title>SYN VIEWER</title><script>
window.marker=Math.random();
if(window.name.startsWith('kin-viewer-entry:'))window.name=JSON.parse(window.name.slice(17)).name;
document.title='SYN VIEWER '+new URLSearchParams(location.search).get('s');
</script>"""


class ViewerWindowRaiseRealPopupTest(unittest.TestCase):
    """The raise rule on real browser windows: the name lookup finds the open viewer window itself - no new window, no
    reload, the detachment kept - also while the window carries the session hand-over name and is navigating."""

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def test_lookup_by_own_name_keeps_the_window_its_document_and_navigation(self):
        context = self.browser.new_context()
        scope = WINDOWS.with_name("exam-scope.js").read_text(encoding="utf-8")
        def serve(route):
            path = urlparse_path(route.request.url)
            body = {"/list": REAL_LIST, "/viewer": REAL_VIEWER, "/exam-scope.js": scope}.get(path)
            if body is None:
                route.abort()
            else:
                route.fulfill(status=200, body=body,
                              content_type="text/javascript" if path.endswith(".js") else "text/html")
        context.route("**/*", serve)
        try:
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto("https://example.test/list")
            with context.expect_page() as opened:
                page.locator("#open").click()
            viewer = opened.value
            viewer.wait_for_load_state()
            self.assertEqual("SYN VIEWER A", viewer.title())
            page.locator("#again").click()
            self.assertEqual([{"raised": True, "same": True, "opener": None, "name": "kin-ohif-current"}],
                             page.evaluate("results"))
            self.assertEqual(2, len(context.pages))
            page.locator("#move").click()
            viewer.wait_for_function("document.title === 'SYN VIEWER B'")
            self.assertEqual({"raised": True, "opener": None}, page.evaluate("results[1]"))
            self.assertEqual("kin-ohif-current", viewer.evaluate("window.name"))
            self.assertIsNone(viewer.evaluate("window.opener"))
            self.assertEqual(2, len(context.pages))
            self.assertEqual([], errors)
        finally:
            context.close()


def urlparse_path(url):
    from urllib.parse import urlparse
    return urlparse(url).path


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    unittest.main(verbosity=2)
