"""Clinician viewer behaviour on the shipped session boundary.

U5S-REQ-04/08/12 -> U5S-RISK-SESSION/WRITE -> TEST-CLINICIAN-VIEWER.
Only OHIF rendering services and server responses are synthetic. The gate, transport,
viewer authority and clinician window.name handoff are shipped assets.
Negative controls are served copies in clinician_viewer_mutants.py; this baseline serves the shipped assets.
"""
from collections import Counter

import copy
import json

from pathlib import Path

import re

import time

import unicodedata

import unittest

from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]

HPACS = ROOT / "worklist-v0" / "hpacs-lite"

def lf_text(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")

ORIGIN = "https://clinician.test"

BASE = "/worklist/hpacs-lite/"

SHIPPED = {name: lf_text(HPACS / name) for name in ("clinician.html", "clinician.js", "unread-badges.js", "report-preview.js", "report-citation.js", "physician-name.js", "worklist-folder-tree.js", "work-mode.js", "product-info-data.js", "product-info.js", "auth.js", "work-context.js", "exam-scope.js", "session-transport.js", "viewer-resources.js", "viewer-preload.js", "viewer-session.js", "viewer-exam-scope.js", "critical-result-inbox.js", "clinical-signature.js")}

CONFIG = lf_text(ROOT / "config" / "ohif.js")

EMBLEM = (HPACS / "kin-emblem-j1.svg").read_bytes()

INST_A, INST_B = "SYN-INST-A", "SYN-INST-B"

KEYCLOAK_DEFAULTS = ["default-roles-kin", "offline_access", "uma_authorization"]

def me(roles, sub="SYN-CLIN-SUB", user="syn-clinician", name="SYN Clinician"):
    return {"sub": sub, "actor": user, "roles": roles, "institution": INST_A, "kind": "member", "user": user,
            "displayName": name}

CLINICIAN = me(["clinician", *KEYCLOAK_DEFAULTS])

RADIOLOGIST = me(["radiologist", *KEYCLOAK_DEFAULTS], sub="SYN-RAD-SUB", user="syn-radiologist", name="SYN Radiologist")

MIXED = me(["clinician", "radiologist"], sub="SYN-MIX-SUB", user="syn-mixed", name="SYN Mixed")

MIXED_NOW_CLINICIAN = me(["clinician", *KEYCLOAK_DEFAULTS], sub="SYN-MIX-SUB", user="syn-mixed", name="SYN Mixed")

CLINICIAN_NOW_MIXED = me(["clinician", "radiologist"])

PREFIX = "1.2.826.0.1.3680043.10.5432"

def uid(n):
    return f"{PREFIX}.{n}"

def patient(inst, pid):
    return f"{inst}|{pid}"

HOSTILE = '<img src=x onerror="document.body.dataset.pwned=1">'

FINAL = {"final": True, "rs": "A", "action": "approve", "version": 4, "repDoc": "syn-rad", "confirm": "2026-09-20"}

OPEN = {"final": False, "rs": "W"}

A, P1, P2, N, O, T, K, B = (uid(n) for n in range(11, 19))

BAD = f"{PREFIX}.19x"

def study(u, name, pid, key, date, report, **extra):
    row = {"uid": u, "id": pid, "name": name, "birth": "19800517", "sex": "M", "date": date, "acc": f"SYN-ACC-{u[-2:]}",
           "desc": f"SYN DESC {u[-2:]}", "modality": "CT", "count": 10, "series": 1, "sourcePatientKey": key,
           "institutionName": "SYN Hospital A", "tele": False, "report": report}
    row.update(extra)
    return row

ROWS = [
    study(A, "SYN KIM", "SYN-P-100", patient(INST_A, "SYN-P-100"), "20260320", FINAL),
    study(P1, "SYN KIM", "SYN-P-100", patient(INST_A, "SYN-P-100"), "20250101", OPEN, desc=HOSTILE),
    # The same server key; a technician's overlay changed what is displayed.
    study(P2, "SYN KIM (EDITED)", "SYN-P-100-EDIT", patient(INST_A, "SYN-P-100"), "20240101", OPEN, modality="MR"),
    # Same name, another patient.
    study(N, "SYN KIM", "SYN-P-200", patient(INST_A, "SYN-P-200"), "20260101", OPEN),
    # Another patient whose displayed ID an overlay made equal to A's.
    study(O, "SYN LEE", "SYN-P-100", patient(INST_A, "SYN-P-300"), "20251201", OPEN),
    # Tele study from another institution with the same original PatientID.
    study(T, "SYN KIM", "SYN-P-100", patient(INST_B, "SYN-P-100"), "20251115", OPEN, tele=True,
          institutionName="SYN Hospital B"),
    study(K, "SYN NOKEY", "", None, "20250601", OPEN),
    study(B, "SYN PARK", "SYN-P-400", patient(INST_A, "SYN-P-400"), "20250301", OPEN),
    study(BAD, "SYN BADUID", "SYN-P-500", patient(INST_A, "SYN-P-500"), "20250201", OPEN),
]

def exam_scope(target, report=None):
    return {"reportUid": target, "groupId": None, "kind": "single", "part": None, "active": True, "generation": "source-1",
            "sources": [{"studyUid": target, "series": {"mode": "all", "uids": []}}]}

def scope_reference(scope):
    return {key:scope[key] for key in ('reportUid','groupId','part')}

def viewer_query(current, prior=None):
    value={'StudyInstanceUIDs': [current + (',' + prior if prior else '')]}
    if prior: value['hangingProtocolId']=['@ohif/hpCompare']
    return value

def report_of(row):
    if row["report"]["final"]:
        return {"uid": row["uid"], "scope": row.get("reportScope", exam_scope(row["uid"])), "report": {**row["report"], "findings": "SYN findings", "conclusion": "SYN conclusion",
                                              "recommendation": ""}, "keys": []}
    return {"uid": row["uid"], "report": {"final": False, "rs": "W"}, "keys": None}

VIEWER = "영상은 새 창의 뷰어에서 읽기 전용으로 엽니다. 측정·키 이미지를 만들거나 저장하지 않으며 서버도 쓰기를 거절합니다."

VIEWER_ASKED = "뷰어 창에 이 검사를 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요."

COMPARE_ASKED = "뷰어 창에 이 검사와 고른 비교 검사를 나란히 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요."

BLOCKED = "브라우저가 새 창을 막아 뷰어를 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 누르세요."

BAD_UID = "검사 UID 형식을 확인할 수 없어 뷰어를 열지 않았습니다."

GONE = "비교할 검사를 지금 목록에서 같은 환자로 확인할 수 없어 열지 않았습니다. 목록을 새로고침하세요."

NONE = "같은 환자 키의 다른 검사가 목록에 없어 나란히 비교할 검사가 없습니다."

NO_KEY = "이 검사에는 서버 환자 키가 없어 비교할 검사를 찾지 않습니다."

VIEWER_WINDOW = "kin-clinician-viewer"

AVOIDED = re.compile(r"진단|검출|판정|우선순위|diagnos|detect|priorit|\bAI\b", re.IGNORECASE)

STAND_IN = '<!doctype html><html><head><meta charset="utf-8"><title>SYN viewer stand-in</title></head><body></body></html>'

COMPARE_VIEW = """() => { const s = document.querySelector('#compare');
  return {note: document.querySelector('#viewer-note').textContent, section: s ? s.dataset.uid : null,
    candidates: s ? [...s.querySelectorAll('#compare-list li')].map(li => li.dataset.uid) : [],
    enabled: !document.querySelector('#open-viewer').disabled}; }"""

VA, VP, VW, VE, VX, VY, VZ, VO, VQ = (uid(n) for n in range(21, 30))

VIEWER_URL = f"{ORIGIN}/ohif/viewer?StudyInstanceUIDs={VA},{VP}&hangingProtocolId=@ohif/hpCompare"

SERIES, SOP = uid(900), uid("900.1")

def item_id(n):
    return f"a0000000-0000-4000-8000-{n:012d}"

def key_item(n, title, description="", frame=1):
    return {"id": item_id(n), "revision": 1, "createdAt": "2026-09-20T00:00:00.000Z",
            "updatedAt": "2026-09-20T00:00:00.000Z",
            "item": {"schemaVersion": 1, "kind": "key", "seriesUid": SERIES, "sopUid": SOP, "frame": frame,
                     "title": title, "description": description}}

def mark_item(n, kind, label, status="verified", frame=1, revision=1):
    points = {"length": [[0, 0, 0], [1, 1, 0]], "angle": [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
              "arrow": [[0, 0, 0], [1, 1, 0]]}[kind]
    item = {"schemaVersion": 1, "kind": kind, "seriesUid": SERIES, "sopUid": SOP, "frame": frame,
            "frameOfReferenceUid": "SYN-FOR", "label": label, "points": points}
    if kind != "arrow":
        item.update(viewPlaneNormal=[0, 0, -1], viewUp=[0, -1, 0],
                    baseline={"calculator": "kin-native-manual-v1", "values": [12.3]})
    row = {"id": item_id(n), "revision": revision, "createdAt": "2026-09-20T00:00:00.000Z",
           "updatedAt": "2026-09-20T00:00:00.000Z", "item": item}
    if kind != "arrow":
        row["referenceStatus"] = status
    return row

A_PAGES = [[key_item(1, "SYN-A key", "SYN-A key note"), mark_item(2, "length", "SYN-A length", revision=2)],
           [mark_item(3, "angle", "SYN-A angle", status="unverified"), mark_item(4, "arrow", "SYN-A arrow", frame=2)]]

NOT_FOUND = (404, {"statusCode": 404, "message": "검사를 찾을 수 없습니다", "error": "Not Found"})

CHANGED = (409, {"code": "VIEWER_REPORT_CHANGED", "message": "판독 상태가 바뀌었습니다. 새로고침하세요."})

DENIED = (403, {"statusCode": 403, "message": "열람 권한이 없습니다", "error": "Forbidden"})

HIDDEN_REFUSED = (400, {"statusCode": 400, "message": "숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다",
                        "error": "Bad Request"})

# The server answers every reader of viewer-items in one shape, {items, nextCursor} (api/src/viewer.service.ts list; the
# physician reads the same current items as the radiologist, tests/clinician_read_live.py), whatever the report's state.
ITEMS = {
    VA: {"pages": A_PAGES},
    VP: {"pages": [[key_item(11, "SYN-P key")]]},
    VW: {"pages": [[key_item(91, "SYN-W unsigned report key")]]},
    VE: {"pages": [[]]},
    VX: NOT_FOUND,
    VY: HIDDEN_REFUSED,
    VZ: DENIED,
    VO: (200, {"items": "SYN-not-a-list", "nextCursor": None}),
    VQ: {"pages": [[key_item(31, "SYN-Q key one")], [key_item(32, "SYN-Q key two")]]},
}

WRITER_HEAD = {"id": item_id(41), "revision": 1, "hidden": False, "authorSub": None, "authorActor": "SYN Radiologist",
               "referenceStatus": "verified",
               "item": {"schemaVersion": 1, "kind": "key", "seriesUid": SERIES, "sopUid": SOP, "frame": 1,
                        "title": "SYN writer key", "description": "", "hidden": False}}

WRITER_HEAD_2 = {**WRITER_HEAD, "id": item_id(42), "item": {**WRITER_HEAD["item"], "title": "SYN writer key two"}}

WRITER_CURSOR = "SYN-W-CURSOR_1"

def author_page(*items, cursor=None):
    # A writer (author) list answer as viewer.service lists heads, for the MIXED account's own items.
    heads = []
    for item in items:
        head = copy.deepcopy(item)
        head.update(hidden=False, authorSub=MIXED["sub"], authorActor="SYN Mixed")
        head["item"]["hidden"] = False
        heads.append(head)
    return {"items": heads, "nextCursor": cursor}

SHOWN_MARK, SHOWN_KEY = mark_item(81, "length", "SYN WRITER SHOWN LENGTH"), key_item(82, "SYN WRITER SHOWN KEY")

LATE_MARK, LATE_KEY = mark_item(83, "length", "SYN LATE WRITER LENGTH"), key_item(84, "SYN LATE WRITER KEY")

LATE_WRITE = key_item(85, "SYN LATE WRITTEN KEY")

HELD_TITLE = "SYN HELD WRITER KEY"

RO_NOTE = ("읽기 전용 · 이 검사에 저장된 측정·키 이미지를 표시합니다. 이 화면에서는 측정·키 이미지를 만들거나 저장하지 않으며 "
           "서버도 쓰기를 거절합니다.")

RO_EMPTY = "이 검사에 저장된 측정·키 이미지가 없습니다 · 읽기 전용"

RO_TOOL = "읽기 전용 화면입니다. 측정을 만들지 않습니다."

RO_EDIT = "읽기 전용 화면입니다. 측정·표식을 편집하지 않습니다."

RO_SR = "읽기 전용 화면에서는 SR을 만들거나 저장하지 않습니다."

RO_DENIED = "이 검사의 저장 항목을 읽을 수 없습니다(HTTP 403). 서버가 거절했습니다."

RO_UNMATCHED = ("현재 화면에서 원본 프레임을 확인할 수 없어 이 목록을 표시 영상과 맞추지 않았습니다. 마지막으로 확인한 검사 기준이며 "
                "저장 항목은 계속 다시 확인합니다.")

UNCONFIRMED_TOOL = "계정이 확인되기 전에는 영상 조작만 할 수 있습니다. 측정·표식을 만들지 않습니다."

UNCONFIRMED_EDIT = "계정이 확인되기 전에는 측정·표식을 편집하지 않습니다."

UNCONFIRMED_SR = "계정이 확인되기 전에는 SR을 만들거나 저장하지 않습니다."

WRITER_SR = "직접 작성한 측정을1~16개 선택하세요."

ENDED = "로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요."

LOADING = "저장 항목 확인 중…"

UNVERIFIED = "재확인 필요: 원본 영상의 동일성을 확인할 수 없습니다."

WRITER_CONTROLS = {"Download SR", "Store SR", "Length", "Angle", "Ellipse ROI", "Add Key Image", "Edit", "Save", "Hide",
                   "Restore", "History", "Recheck Source", "Retry Request", "Use Latest & Keep Changes",
                   "Discard Held Changes", "Resume Held Work", "Discard Held Work"}

MODULES = {"findings", "jobs", "tech-note", "hanging-protocol"}

WRITE_MODULES = {"findings", "jobs", "tech-note"}

LATER = ["kin.viewer-findings", "kin.viewer-layout", "kin.viewer-jobs", "kin.viewer-tech-note"]

PRIMARY_SECTION = ["MeasurementTools", "Zoom", "Pan", "TrackballRotate", "WindowLevel", "Capture", "Layout", "Crosshairs",
                   "MoreTools"]

VIEW_SECTION = [x for x in PRIMARY_SECTION if x not in ("MeasurementTools", "Capture")]

ENDED_WRITER_SECTION = [x for x in PRIMARY_SECTION if x != "MeasurementTools"]

MORE_TOOLS = ["Reset", "rotate-right", "flipHorizontal", "ImageSliceSync", "ReferenceLines", "ImageOverlayViewer",
              "StackScroll", "invert", "Probe", "Cine", "Angle", "CobbAngle", "Magnify", "CalibrationLine", "TagBrowser",
              "AdvancedMagnify", "UltrasoundDirectionalTool", "WindowLevelRegion"]

VIEW_MORE = ["Reset", "rotate-right", "flipHorizontal", "ImageSliceSync", "ReferenceLines", "ImageOverlayViewer",
             "StackScroll", "invert", "Cine", "Magnify", "TagBrowser"]

VIEWING = {"WindowLevel", "Pan", "Zoom", "StackScroll", "TrackballRotate", "Crosshairs", "Magnify"}

AUTHORING = ["ArrowAnnotate", "Length", "Angle", "Bidirectional", "RectangleROI", "EllipticalROI", "CircleROI", "Probe",
             "DragProbe", "CobbAngle", "CalibrationLine", "PlanarFreehandROI", "SplineROI", "LivewireContour",
             "UltrasoundDirectionalTool", "WindowLevelRegion", "PlanarFreehandContourSegmentation", "AdvancedMagnify"]

ALL_GROUPS = ["default", "mpr", "SRToolGroup", "volume3d"]

STATES = ("unconfirmed", "refused", "read-only", "writer", "read-only+held", "refused+late-writer", "refused+layout-account",
          "ended+reenter", "read-only+ended")

WRITER_ONLY = (False, False, False, True, False, False, False, False, False)

CAPTURE_OFFERED = (False, False, False, True, False, False, True, True, False)

VIEWER_STATE_MATRIX = {
    # The list on screen: its verified saved length drawn locked (the writer list here holds key images only), and Go to Image
    # of the shown source frame through the navigation API (unconfirmed: busy; refused: ended).
    "list_mark": (False, False, True, False, True, False, False, False, False),
    "go_to_image": (False, False, True, True, True, False, False, False, False),
    # Write and mark entry points: True = works in that state, False = not offered or refused (nothing drawn, sent or mounted).
    "toolbar_offer": WRITER_ONLY,        # the Measurements split button and the authoring items of More Tools
    "capture": CAPTURE_OFFERED,          # Capture offered in the primary section and its press reaching showDownloadViewportModal
    "toolbar_press": WRITER_ONLY,        # a press on the rendered toolbar (Bidirectional), then a primary drag
    "toolbar_command": WRITER_ONLY,      # setToolActiveToolbar over every tool group (ArrowAnnotate), then a drag
    "hotkey": WRITER_ONLY,               # the setToolActive command a hotkey runs (RectangleROI), then a drag
    "tool_group": WRITER_ONLY,           # the tool group's own setToolActive (CircleROI), then a drag
    "around_guard": WRITER_ONLY,         # an activation around the guard (the class method) stays Active
    "later_group": WRITER_ONLY,          # a tool group created later keeps its authoring tool Passive
    "tool_modes": WRITER_ONLY,           # any authoring tool Active/Passive in the mode's tool groups
    "programmatic_add": WRITER_ONLY,     # addNewAnnotation called on the tool instance (SplineROI)
    "context_menu": WRITER_ONLY,         # showCornerstoneContextMenu
    "annotation_commands": WRITER_ONLY,  # deleteMeasurement, setMeasurementLabel, updateMeasurement
    "arrow_text": WRITER_ONLY,           # a new arrow's text prompt answered with the typed text
    "measurement_panel": WRITER_ONLY,    # the measurement panel's rename (update ..., true) and lock toggle
    "sr_commands": WRITER_ONLY,          # storeMeasurements / downloadReport reach the writer's SR flow
    "panel_controls": WRITER_ONLY,       # Download SR, Store SR, Length, Angle, Ellipse ROI, Add Key Image
    "row_controls": WRITER_ONLY,         # Edit, Save, Hide, Restore, History, Recheck Source
    "findings": WRITER_ONLY,             # the Findings section (finding create and saved-item link) mounted
    "jobs": WRITER_ONLY,                 # the Job panel mounted
    "tech_note": WRITER_ONLY,            # the Tech Note bridge connected
    "layout_account": WRITER_ONLY,       # Recent Layout buttons enabled / the Hanging Protocol editor mounted
    "marks_present": WRITER_ONLY,        # any native mark left after all of the attempts above
    "stray_mark_kept": WRITER_ONLY,      # a mark made outside every guard survives the next observation tick
    "viewing": (True, True, True, True, True, True, True, True, True),  # Zoom from the toolbar, then a drag: image viewing in every state
    # Recheck paths, as the viewer-items requests the panel makes: read = the read-only list (limit=100; its periodic and focus
    # checks read it whole again), read-all = the writer list (includeHidden=true), check = limit=1 (the writer's access probe), cursor = the next
    # page asked with the handed-out cursor verbatim, none = no list request (unconfirmed: /me is asked again on focus and
    # every 15 s, and nothing is read until an answer; refused: the panel has ended).
    "initial_read": ("none", "none", "read", "read-all", "read", "none", "none", "none", "none"),
    "page_continuation": ("none", "none", "cursor", "cursor", "cursor", "none", "none", "none", "none"),
    "focus": ("none", "none", "read", "check", "read", "none", "none", "none", "none"),
    "me_on_focus": (True, False, True, True, True, False, False, False, False),    # the same focus asks /me (the retry, the check, the probe)
    "periodic": ("none", "none", "read", "check", "read", "none", "none", "none", "none"),  # the clock moved past 15 s since the last /me
    "frame_lost": ("none", "none", "none", "none", "none", "none", "none", "none", "none"),  # the active viewport stops showing a source frame
    "frame_return": ("none", "none", "read", "none", "read", "none", "none", "none", "none"),  # the source frame comes back (clinician: checked at once)
    "frameless_focus": ("none", "none", "read", "none", "read", "none", "none", "none", "none"),  # focus with no source frame (writer probe stays frame-bound)
    "study_change": ("none", "none", "read", "read-all", "read", "none", "none", "none", "none"),  # the frame of another study
}

SESSION_CHANGES = ("unconfirmed->writer", "writer->read-only", "read-only->writer")

SESSION_CHANGE_MATRIX = {
    "state_after": ("writer", "read-only", "read-only"),   # read-only is never left: a later writer /me is noted, nothing changes
    "shown_at_change": ("kept", "taken down", "kept"),     # the rows and marks on screen when the state changes
    "reads_by_other_me": ("none", "me+read", "none"),      # what the change by another extension's /me starts
    "reads_by_own_me": ("read-all", "read", "read"),       # the panel's own /me made (or met) it: that answer is the read's /me
    "read_awaiting_me": ("read-all", "read", "read"),      # the panel's read waiting for its /me when another /me changed it
    "author_first_page": ("none", "dropped", "none"),      # the author list's first page asked before, answered after
    "author_next_page": ("none", "dropped", "none"),       # a later author page (the handed-out cursor) asked before
    "author_refresh": ("none", "dropped", "none"),         # a Refresh of the shown author list asked before
    "final_page": ("none", "none", "shown"),               # a final-list page asked before, answered after
    "write_awaiting_me": ("none", "not sent", "none"),     # a Save waiting for the /me whose answer makes the change
    "write_sent": ("none", "dropped", "none"),             # a Save already sent (the server decides the write itself)
}

MODULE_STUBS = {
    "finding-link-model.js": "window.kinFindingLinkModel = { SCHEMA: 2 };",
    "viewer-findings.js": "window.kinViewerFindings = (services, model, session) => window.synModule('findings', ['New Finding', 'Link Saved Items'], '#kin-viewer-history', session);",
    "viewer-volume-job.js": "/* SYN: no volume job module */",
    "viewer-stack-restore.js": "/* SYN: no stack restore in the role-only fixture */",
    "viewer-jobs.js": "window.kinViewerJobs = (services, model, session) => window.synModule('jobs', ['Save New Job'], null, session);",
    "tech-note.css": "",
}

REAL_MODULES = {"jobs": ("viewer-stack-restore.js", "viewer-jobs.js"), "findings": ("finding-link-model.js", "viewer-findings.js"),
                "tech-note": ("viewer-tech-note.js",)}

# The read-only viewer's two panels docked off the image cells: the panels with their production styles (history.js and
# layout.js float them over the viewer) docked by the shipped viewer-workspace-dock.js in an OHIF-like document.
DOCK_SOURCE = HPACS / "viewer-workspace-dock.js"
WORK_CONTEXT = HPACS / "work-context.js"
def production_style(source, panel_id):
    text = (ROOT / "config" / "ohif" / source).read_text(encoding="utf-8")
    found = re.search(r"panel\.id = '" + panel_id + r"';.*?panel\.style\.cssText = '([^']+)'", text, re.S)
    assert found, (source, panel_id)
    return found.group(1)
DOCK_PANEL_STYLES = {"kin-viewer-history": production_style("history.js", "kin-viewer-history"),
                     "kin-viewer-layout": production_style("layout.js", "kin-viewer-layout")}
DOCK_PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}
#root > div { height: 100vh; display: flex; flex-direction: column; } #root header { height: 52px; flex: none; }
#root > div > .flex { display: flex; height: calc(100vh - 52px); } .cell { flex: 1; background: #000; }</style></head><body>
<div id="root"><div><header>SYN toolbar</header><div class="flex"><div class="cell"></div><div class="cell"></div></div></div></div>
</body></html>"""
DOCK_OVERLAP = """() => {
  const cells = [...document.querySelectorAll('.cell')].map(c => c.getBoundingClientRect());
  const panels = ['kin-viewer-history', 'kin-viewer-layout', 'kin-workspace-dock'].map(id => document.getElementById(id))
    .filter(p => p && !p.hidden && getComputedStyle(p).display !== 'none').map(p => p.getBoundingClientRect())
    .filter(r => r.width > 0 && r.height > 0);
  let area = 0;
  for (const p of panels) for (const c of cells)
    area += Math.max(0, Math.min(p.right, c.right) - Math.max(p.left, c.left)) * Math.max(0, Math.min(p.bottom, c.bottom) - Math.max(p.top, c.top));
  return { area: Math.round(area), cells: cells.map(c => Math.round(c.height)), panels: panels.length };
}"""

VIEWER_HARNESS = r"""<!doctype html><html><head><meta charset="utf-8"><title>SYN viewer harness</title></head><body>
<script>
window.synMounted = []; window.synStopped = []; window.synEnded = []; window.synNative = []; window.synNotices = []; window.synStudy = null;
// synFrameless: the active viewport shows no identifiable source frame (an MPR/volume view, an image that failed to load).
window.synFrameless = false;
// The clock the panel reads; synAdvance moves it so the 15 s periodic check falls due without waiting.
const realNow = Date.now.bind(Date); let skew = 0; Date.now = () => realNow() + skew; window.synAdvance = ms => { skew += ms; };
// The observation tick: config/ohif.js runs the Measurements panel's scan() on a 250 ms interval (the real Findings section's sync
// too). synTick(n) runs every live 250 ms interval callback n times now, as its next n ticks would, so a case sees what those ticks
// do without waiting for them; the intervals keep running on their own as well.
const realSetInterval = window.setInterval.bind(window), realClearInterval = window.clearInterval.bind(window), ticking = new Map();
window.setInterval = (fn, ms, ...args) => { const id = realSetInterval(fn, ms, ...args);
  if (ms === 250 && typeof fn === 'function') ticking.set(id, () => fn(...args)); return id; };
window.clearInterval = id => { ticking.delete(id); realClearInterval(id); };
window.synTick = (n = 1) => { for (let i = 0; i < n; i++) for (const tick of [...ticking.values()]) tick(); };
const SERIES = '%SERIES%', SOP = '%SOP%';
window.synImage = () => `wadors:${location.origin}/dicom-web/studies/${window.synStudy}/series/${SERIES}/instances/${SOP}/frames/1`;
const element = document.createElement('div'); document.body.append(element);
const viewport = { id: 'syn-vp', renderingEngineId: 'syn-engine', type: 'stack', element,
  getCurrentImageId: () => window.synFrameless ? undefined : window.synImage(), getImageIds: () => [window.synImage()], setImageIdIndex: async () => {},
  getCamera: () => ({ viewPlaneNormal: [0, 0, -1], viewUp: [0, -1, 0] }), render() {} };
const annotations = new Map(), locks = new Map();
window.synEdits = [];
window.cornerstone = { Enums: { Events: { STACK_NEW_IMAGE: 'syn-stack-new-image' } },
  metaData: { get: (type) => type === 'imagePlaneModule' ? { frameOfReferenceUID: 'SYN-FOR' } : undefined },
  cache: { getImage: () => null }, getEnabledElement: () => ({ viewport }), getEnabledElements: () => [] };
// A tool's own mouse-down creation: a new unlocked mark in the annotation state (the harness counts these as syn-native-*).
let drawn = 0;
const tool = name => ({ configuration: name === 'EllipticalROI'
    ? { statsCalculator: { statsCallback() {}, getStatistics: () => ({ array: [] }) }, getTextLines: () => [] } : { getTextLines: () => [] },
  addNewAnnotation() {
    window.synNative.push('add ' + name);
    const uid = 'syn-native-' + (++drawn);
    annotations.set(uid, { annotationUID: uid, metadata: { toolName: name, referencedImageId: window.synImage() }, data: { handles: { points: [] }, text: '' } });
    return { annotationUID: uid }; } });
window.synTools = { EllipticalROI: tool('EllipticalROI') };
// A mark made by a path outside every guard (a script writing the annotation state); synHas says whether it is still there.
window.synRawMark = name => { const uid = 'syn-native-' + (++drawn);
  annotations.set(uid, { annotationUID: uid, metadata: { toolName: name, referencedImageId: window.synImage() }, data: { handles: { points: [] }, text: '' } });
  return uid; };
window.synHas = uid => annotations.has(uid);

// ── The pinned OHIF around config/ohif.js: cornerstone3D tool groups (modes, primary binding, setToolPassive keeping a
// tool with another binding Active), extension-cornerstone ToolGroupService (TOOLGROUP_CREATED before tools and modes,
// TOOL_ACTIVATED), core ToolbarService (add only if absent, remove, sections) and the setToolActive / setToolActiveToolbar
// actions, and the longitudinal mode's initToolGroups + toolbarButtons + moreTools, built after the extensions' onModeEnter.
const PRIMARY = 1, SECONDARY = 2, AUXILIARY = 4, WHEEL = 524288;
const bus = () => { const handlers = new Map(); return {
  subscribe: (event, fn) => { const set = handlers.get(event) || new Set(); set.add(fn); handlers.set(event, set); return { unsubscribe: () => set.delete(fn) }; },
  emit: (event, detail) => { for (const fn of [...(handlers.get(event) || [])]) fn(detail); } }; };
const groupBus = bus(), barBus = bus(), groups = new Map();
class SynGroup {
  constructor(id) { this.id = id; this.toolOptions = {}; this.instances = {}; }
  hasTool(name) { return Object.hasOwn(this.instances, name); }
  addTool(name) { if (!this.hasTool(name)) { this.instances[name] = window.synTools[name] ||= tool(name); this.toolOptions[name] = { mode: 'Disabled', bindings: [] }; } }
  getToolInstance(name) { return this.instances[name]; }
  getToolOptions(name) { return this.toolOptions[name]; }
  setToolActive(name, options = {}) {
    if (!this.hasTool(name)) return;
    this.toolOptions[name] = { mode: 'Active', bindings: [...(options.bindings || [])] };
    groupBus.emit('syn-tool-activated', { toolGroupId: this.id, toolName: name, toolBindingsOptions: options });
  }
  setToolPassive(name) {
    if (!this.hasTool(name)) return;
    const bindings = (this.toolOptions[name].bindings || []).filter(b => b.mouseButton !== PRIMARY || b.modifierKey);
    this.toolOptions[name] = { mode: bindings.length ? 'Active' : 'Passive', bindings };
  }
  setToolEnabled(name) { if (this.hasTool(name)) this.toolOptions[name] = { mode: 'Enabled', bindings: [] }; }
  setToolDisabled(name) { if (this.hasTool(name)) this.toolOptions[name] = { mode: 'Disabled', bindings: [] }; }
  getActivePrimaryMouseButtonTool() {
    return Object.keys(this.toolOptions).find(name => this.toolOptions[name].mode === 'Active' &&
      this.toolOptions[name].bindings.some(b => b.mouseButton === PRIMARY && !b.modifierKey));
  }
}
window.SynGroup = SynGroup;
const toolGroupService = {
  EVENTS: { TOOLGROUP_CREATED: 'syn-toolgroup-created', TOOL_ACTIVATED: 'syn-tool-activated' }, subscribe: groupBus.subscribe,
  getToolGroup: id => groups.get(id || 'default'), getToolGroupIds: () => [...groups.keys()],
  createToolGroupAndAddTools(id, tools) {
    const group = new SynGroup(id); groups.set(id, group); groupBus.emit('syn-toolgroup-created', { toolGroupId: id });
    for (const mode of ['active', 'passive', 'enabled', 'disabled']) for (const t of tools[mode] || []) group.addTool(t.toolName);
    for (const t of tools.active || []) group.setToolActive(t.toolName, { bindings: t.bindings });
    for (const t of tools.passive || []) group.setToolPassive(t.toolName);
    for (const t of tools.enabled || []) group.setToolEnabled(t.toolName);
    for (const t of tools.disabled || []) group.setToolDisabled(t.toolName);
    return group;
  },
  destroy() { groups.clear(); },
};
const bar = { buttons: {}, buttonSections: {} }, barChanged = () => barBus.emit('syn-toolbar-modified');
const toolbarService = {
  EVENTS: { TOOL_BAR_MODIFIED: 'syn-toolbar-modified' }, state: bar, subscribe: barBus.subscribe,
  reset() { bar.buttons = {}; bar.buttonSections = {}; },
  addButtons(buttons) { for (const b of buttons) if (!bar.buttons[b.id]) bar.buttons[b.id] = b; barChanged(); },
  removeButton(id) { delete bar.buttons[id]; barChanged(); },
  createButtonSection(key, ids) { if (bar.buttonSections[key]) bar.buttonSections[key].push(...ids); else bar.buttonSections[key] = ids; barChanged(); },
  clearButtonSection(key) { bar.buttonSections[key] = []; barChanged(); },
  getButtons: () => bar.buttons, getButton: id => bar.buttons[id], refreshToolbarState() { barChanged(); },
};
const activeTools = { toolGroupIds: ['default', 'mpr', 'SRToolGroup', 'volume3d'] };
const toolbarCommand = { commandName: 'setToolActiveToolbar', commandOptions: activeTools };
const item = (id, commands = toolbarCommand) => ({ id, label: id, commands });
const toolbarButtons = () => [
  { id: 'MeasurementTools', uiType: 'ohif.splitButton', props: { groupId: 'MeasurementTools', primary: item('Length'),
    items: ['Length', 'Bidirectional', 'ArrowAnnotate', 'EllipticalROI', 'RectangleROI', 'CircleROI', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour'].map(id => item(id)) } },
  ...['Zoom', 'WindowLevel', 'Pan', 'TrackballRotate'].map(id => ({ id, uiType: 'ohif.radioGroup', props: { commands: toolbarCommand } })),
  { id: 'Capture', uiType: 'ohif.radioGroup', props: { commands: 'showDownloadViewportModal' } },
  { id: 'Layout', uiType: 'ohif.layoutSelector', props: { rows: 3, columns: 4 } },
  { id: 'Crosshairs', uiType: 'ohif.radioGroup', props: { commands: { commandName: 'setToolActiveToolbar', commandOptions: { toolGroupIds: ['mpr'] } } } },
  { id: 'MoreTools', uiType: 'ohif.splitButton', props: { groupId: 'MoreTools', primary: item('Reset', 'resetViewport'), items: [
    item('Reset', 'resetViewport'), item('rotate-right', 'rotateViewportCW'), item('flipHorizontal', 'flipViewportHorizontal'),
    item('ImageSliceSync', { commandName: 'toggleSynchronizer', commandOptions: { type: 'imageSlice' } }),
    item('ReferenceLines', 'toggleEnabledDisabledToolbar'), item('ImageOverlayViewer', 'toggleEnabledDisabledToolbar'), item('StackScroll'),
    item('invert', 'invertViewport'), item('Probe'), item('Cine', 'toggleCine'), item('Angle'), item('CobbAngle'), item('Magnify'),
    item('CalibrationLine'), item('TagBrowser', 'openDICOMTagViewer'), item('AdvancedMagnify', 'toggleActiveDisabledToolbar'),
    item('UltrasoundDirectionalTool'), item('WindowLevelRegion')] } }];
const names = list => list.map(toolName => ({ toolName }));
const viewing = [{ toolName: 'WindowLevel', bindings: [{ mouseButton: PRIMARY }] }, { toolName: 'Pan', bindings: [{ mouseButton: AUXILIARY }] },
  { toolName: 'Zoom', bindings: [{ mouseButton: SECONDARY }] }, { toolName: 'StackScroll', bindings: [{ mouseButton: WHEEL }] }];
window.synMode = () => {
  toolbarService.reset();
  toolGroupService.createToolGroupAndAddTools('default', { active: viewing, passive: names(['Length', 'ArrowAnnotate', 'Bidirectional',
    'DragProbe', 'Probe', 'EllipticalROI', 'CircleROI', 'RectangleROI', 'StackScroll', 'Angle', 'CobbAngle', 'Magnify', 'CalibrationLine',
    'PlanarFreehandContourSegmentation', 'UltrasoundDirectionalTool', 'PlanarFreehandROI', 'SplineROI', 'LivewireContour', 'WindowLevelRegion']),
    enabled: names(['ImageOverlayViewer', 'ReferenceLines', 'SRSCOORD3DPoint']), disabled: names(['AdvancedMagnify']) });
  toolGroupService.createToolGroupAndAddTools('SRToolGroup', { active: viewing, passive: names(['SRLength', 'SRArrowAnnotate', 'SRBidirectional',
    'SREllipticalROI', 'SRCircleROI', 'SRPlanarFreehandROI', 'SRRectangleROI', 'WindowLevelRegion']), enabled: names(['DICOMSRDisplay']) });
  toolGroupService.createToolGroupAndAddTools('mpr', { active: viewing, passive: names(['Length', 'ArrowAnnotate', 'Bidirectional', 'DragProbe',
    'Probe', 'EllipticalROI', 'CircleROI', 'RectangleROI', 'StackScroll', 'Angle', 'CobbAngle', 'PlanarFreehandROI', 'WindowLevelRegion',
    'PlanarFreehandContourSegmentation']), disabled: names(['Crosshairs', 'AdvancedMagnify', 'ReferenceLines']) });
  toolGroupService.createToolGroupAndAddTools('volume3d', { active: [{ toolName: 'TrackballRotate', bindings: [{ mouseButton: PRIMARY }] },
    { toolName: 'Zoom', bindings: [{ mouseButton: SECONDARY }] }, { toolName: 'Pan', bindings: [{ mouseButton: AUXILIARY }] }] });
  toolbarService.addButtons(toolbarButtons());
  toolbarService.createButtonSection('primary', ['MeasurementTools', 'Zoom', 'Pan', 'TrackballRotate', 'WindowLevel', 'Capture', 'Layout', 'Crosshairs', 'MoreTools']);
};
window.cornerstoneTools = {
  annotation: {
    locking: { setAnnotationLocked: (uid, value) => { locks.set(uid, value); }, isAnnotationLocked: uid => locks.get(uid) === true },
    state: { getAnnotation: uid => annotations.get(uid), getAllAnnotations: () => [...annotations.values()],
      removeAnnotation: uid => { annotations.delete(uid); }, addAnnotation: a => { annotations.set(a.annotationUID, a); } },
    selection: { setAnnotationSelected() {} } },
  ToolGroupManager: { getToolGroupForViewport: () => groups.get('default'), getToolGroup: id => groups.get(id), getAllToolGroups: () => [...groups.values()] },
  Enums: { MouseBindings: { Primary: PRIMARY } } };
window.synDrawn = () => [...annotations.values()].filter(a => !String(a.annotationUID).startsWith('syn-native-'))
  .map(a => [a.metadata.toolName, a.data.label, locks.get(a.annotationUID) === true]);
window.synMarks = () => [...annotations.values()].filter(a => String(a.annotationUID).startsWith('syn-native-')).map(a => a.metadata.toolName);
window.synClearMarks = () => { for (const uid of [...annotations.keys()]) if (uid.startsWith('syn-native-')) annotations.delete(uid); };
window.synGroup = id => groups.get(id);
window.synModes = id => Object.fromEntries(Object.entries(groups.get(id)?.toolOptions || {}).map(([name, o]) => [name, o.mode]));
window.synToolbar = () => ({ primary: [...(bar.buttonSections.primary || [])], buttons: Object.keys(bar.buttons).sort(),
  more: bar.buttons.MoreTools ? bar.buttons.MoreTools.props.items.map(i => i.id) : null, morePrimary: bar.buttons.MoreTools?.props.primary?.id ?? null });
// A press on the rendered primary section, as ToolbarService.recordInteraction runs it; 'missing' when the section offers no such control.
window.synClick = id => {
  const offered = (bar.buttonSections.primary || []).flatMap(key => { const b = bar.buttons[key]; if (!b) return [];
    return Array.isArray(b.props.items) ? [b.props.primary, ...b.props.items].filter(Boolean) : [{ id: key, ...b.props }]; });
  const found = offered.find(x => x.id === id);
  if (!found) return 'missing';
  commandsManager.run(found.commands, { ...found, itemId: found.id }); return 'ran';
};
// A primary-button drag on the viewport: the active primary tool of that group handles it.
window.synDraw = (id = 'default') => {
  const group = groups.get(id), name = group && group.getActivePrimaryMouseButtonTool();
  if (!name) return 'none';
  if (['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'TrackballRotate', 'Crosshairs', 'Magnify'].includes(name)) return 'view ' + name;
  // A refusal hands back an empty stand-in (no annotationUID), so the pinned press handler has nothing to raise on.
  return group.getToolInstance(name).addNewAnnotation({ detail: { element } })?.annotationUID ? 'mark ' + name : 'refused ' + name;
};
const services = {
  cornerstoneViewportService: { getCornerstoneViewport: () => viewport },
  viewportGridService: { EVENTS: { ACTIVE_VIEWPORT_ID_CHANGED: 'syn-active' }, getActiveViewportId: () => 'syn-vp',
    getState: () => ({ activeViewportId: 'syn-vp', layout: { numRows: 1, numCols: 1, layoutType: 'grid' },
      viewports: new Map([['syn-vp', { viewportId: 'syn-vp', x: 0, y: 0, width: 1, height: 1, displaySetInstanceUIDs: [] }]]) }),
    subscribe: () => ({ unsubscribe() {} }), setDisplaySetsForViewport() {}, setActiveViewportId() {} },
  displaySetService: { getActiveDisplaySets: () => [], getDisplaySetByUID: () => undefined },
  measurementService: { getMeasurements: () => [], getMeasurement: () => undefined, remove() {}, getSourceMappings: () => [],
    update: (uid, measurement, notYetUpdatedAtSource) => { window.synEdits.push(['update', uid, notYetUpdatedAtSource === true]); },
    toggleLockMeasurement: uid => { window.synEdits.push(['lock', uid]); } },
  uiNotificationService: { show: notice => { window.synNotices.push(notice.message); } },
  toolGroupService, toolbarService,
};
window.synServices = services;
const commands = new Map(['downloadReport', 'storeMeasurements'].map(name => [name, { commandFn: () => { window.synNative.push('sr ' + name); } }]));
// The CORNERSTONE context: the tool activation actions as the pinned extension runs them, the viewing actions, and the
// annotation menu / label / measurement / arrow-text commands (recorded so a refusal is visible as their absence).
const cornerstoneCommands = new Map(), native = (name, fn) => cornerstoneCommands.set(name, { commandFn: fn });
const setToolActive = ({ toolName, toolGroupId = null }) => {
  const group = toolGroupService.getToolGroup(toolGroupId);
  if (!group || !group.hasTool(toolName)) return;
  const current = group.getActivePrimaryMouseButtonTool();
  if (current) group.setToolPassive(current);
  group.setToolActive(toolName, { bindings: [{ mouseButton: PRIMARY }] });
};
native('setToolActive', setToolActive);
native('setToolActiveToolbar', ({ value, itemId, toolName, toolGroupIds = [] }) => {
  toolName = toolName || itemId || value;
  (toolGroupIds.length ? toolGroupIds : toolGroupService.getToolGroupIds()).forEach(toolGroupId => setToolActive({ toolName, toolGroupId }));
});
native('toggleActiveDisabledToolbar', ({ value, itemId, toolGroupId }) => {
  const toolName = itemId || value, group = toolGroupService.getToolGroup(toolGroupId);
  if (!group || !group.hasTool(toolName)) return;
  if (['Active', 'Passive', 'Enabled'].includes(group.getToolOptions(toolName).mode)) group.setToolDisabled(toolName); else setToolActive({ toolName, toolGroupId });
});
for (const name of ['resetViewport', 'rotateViewportCW', 'flipViewportHorizontal', 'toggleSynchronizer', 'toggleEnabledDisabledToolbar',
  'invertViewport', 'toggleCine', 'openDICOMTagViewer', 'showDownloadViewportModal']) native(name, () => { window.synNative.push('view ' + name); });
native('showCornerstoneContextMenu', () => { window.synNative.push('menu'); });
native('deleteMeasurement', ({ uid }) => { window.synNative.push('delete ' + uid); });
native('setMeasurementLabel', ({ uid }) => { window.synNative.push('label ' + uid); });
native('updateMeasurement', ({ uid }) => { window.synNative.push('update ' + uid); });
native('arrowTextCallback', ({ callback }) => { window.synNative.push('arrow-text'); callback('SYN typed'); });
const commandsManager = {
  getCommand: (name, context) => context === 'CORNERSTONE_STRUCTURED_REPORT' ? commands.get(name)
    : context === 'CORNERSTONE' || context === undefined ? cornerstoneCommands.get(name) : undefined,
  registerCommand: (context, name, command) => {
    if (context === 'CORNERSTONE_STRUCTURED_REPORT') commands.set(name, command); else if (context === 'CORNERSTONE') cornerstoneCommands.set(name, command); },
  runCommand: (name, options = {}, context) => { const command = commandsManager.getCommand(name, context); return command?.commandFn({ ...(command.options || {}), ...options }); },
  run: (toRun, options = {}) => { for (const c of [toRun].flat().filter(Boolean))
    typeof c === 'string' ? commandsManager.runCommand(c, options) : commandsManager.runCommand(c.commandName, { ...(c.commandOptions || {}), ...options }, c.context); },
};
window.synRun = (name, options) => commandsManager.runCommand(name, options);
// A writer's SR command is the async manual SR flow: its refusal is a rejected promise, awaited here.
window.synSR = name => { try { const result = commands.get(name).commandFn({ measurementData: [] });
  return typeof result?.then === 'function' ? result.then(() => 'ran', error => 'refused: ' + error.message) : 'ran'; }
  catch (error) { return 'refused: ' + error.message; } };
// The same with the measurements chosen for the SR (as the measurement list hands them over).
window.synSRWith = (name, measurementData) => { try { const result = commands.get(name).commandFn({ measurementData });
  return typeof result?.then === 'function' ? result.then(() => 'ran', error => 'refused: ' + error.message) : 'ran'; }
  catch (error) { return 'refused: ' + error.message; } };
window.synAddLength = () => String(window.synTools.Length.addNewAnnotation({ detail: { element } })?.annotationUID);
// addNewAnnotation called on a tool instance directly (no mode, no toolbar): 'true' when a mark was made (an annotationUID came back).
window.synAdd = name => window.synTools[name] ? String(Boolean(window.synTools[name].addNewAnnotation({ detail: { element } })?.annotationUID)) : 'missing';
// The Tech Note bridge's dependencies as if loaded; the bridge itself and the Hanging Protocol editor record a mount.
for (const name of ['KinVolumeOrientation', 'KinVolumeDisplay', 'KinVolumeMarks', 'KinVolumePreferences', 'KinVolumeCrosshair',
  'KinVolumeBatch', 'KinVolumeBatchScout', 'KinVolumeCurved', 'KinVolumePath', 'KinWorkspaceShortcuts', 'KinViewerWindows',
  'KinViewerIdentity', 'KinHangingProtocolModel']) window[name] = {};
for (const name of ['kinCreateVolumeOrientation', 'kinCreateVolumeDisplay', 'kinCreateVolumeSync', 'kinCreateVolumeProgressive',
  'kinCreateVolumeMarks', 'kinCreateVolumePreferences', 'kinCreateVolumeCrosshair', 'kinRenderVolumeScout', 'kinCreateVolumeBatch',
  'kinCreateVolumeCurved', 'kinCreateVolumePath', 'KinTechNote', 'KinViewerWorkspaceDock']) window[name] = () => {};
// A write module's stub: a stop takes its controls away, as the real modules' stop removes their panel; the document's end (the
// session's onEnd, Astra S5-U2b-X5-R-001 F01) ends it in place, as the real modules do: its controls stay, disabled.
window.synModule = (name, labels, host, session) => { let box = null, off = () => {}; return { mount() {
  window.synMounted.push(name);
  box = document.createElement('section'); box.dataset.synModule = name;
  for (const label of labels) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; box.append(b); }
  ((host && document.querySelector(host)) || document.body).append(box);
  off = session?.onEnd?.(() => { window.synEnded.push(name); for (const b of box.querySelectorAll('button')) b.disabled = true; }) || (() => {});
  return true; }, stop() { off(); window.synStopped.push(name); box?.remove(); } }; };
window.kinViewerTechNote = (services, session) => window.synModule('tech-note', ['Tech Note'], null, session);
// Its end() disables its control, as the real editor's end() does (viewer-hanging-protocol.js refresh() with ended). synHpAccess
// is the access check the layout panel hands it (its /me and study read), as the real editor runs it before an apply or a save.
window.KinViewerHangingProtocol = { mount: options => { window.synMounted.push('hanging-protocol'); window.synHpAccess = options.access;
  const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Save to Account'; options.host.append(b);
  return { end() { b.disabled = true; } }; } };
const IDS = ['kin.viewer-history', 'kin.viewer-findings', 'kin.viewer-layout', 'kin.viewer-jobs', 'kin.viewer-tech-note'];
let extensions = [];
// As the viewer route does: extension onModeEnter first, then the mode builds its tool groups and toolbar. `enter` lets a
// case enter the other extensions later (synEnter) in the same mode.
window.synBoot = (study, enter = IDS) => {
  window.synStudy = study;
  extensions = IDS.map(id => window.config.extensions.find(e => e.id === id));
  for (const e of extensions) e.preRegistration({ servicesManager: { services }, commandsManager, extensionManager: {} });
  window.synEnter(enter);
  window.synMode();
};
window.synEnter = ids => { for (const e of extensions) if (ids.includes(e.id)) e.onModeEnter(); };
// Mode exit and re-entry in the same document: extensions leave, the mode destroys its tool groups, and all of it is built again.
window.synReenter = () => {
  for (const e of extensions) e.onModeExit();
  toolGroupService.destroy();
  window.synEnter(IDS); window.synMode();
};
// test_23: the same two halves with the case acting in between (every extension down, the document still open).
window.synLeave = () => { for (const e of extensions) e.onModeExit(); toolGroupService.destroy(); };
window.synComeBack = () => { window.synEnter(IDS); window.synMode(); };
// The write-module controls on the page that still work (a stub's, or a real module's own buttons).
window.synWriteControls = () => [...document.querySelectorAll('[data-syn-module] button, #kin-viewer-jobs button, #kin-viewer-findings button, #kin-viewer-tech-note button')]
  .filter(b => !b.disabled && !b.hidden).map(b => b.textContent);
window.synSwitch = study => { window.synStudy = study; document.dispatchEvent(new Event('syn-stack-new-image')); };
window.synFocus = () => { window.dispatchEvent(new Event('focus')); };
</script>
<script src="/harness/ohif.js"></script>
</body></html>""".replace("%SERIES%", SERIES).replace("%SOP%", SOP)

PANEL = """() => { const p = document.querySelector('#kin-viewer-history');
  return {state: p.dataset.readOnly ?? null, uid: p.dataset.studyUid ?? null, frame: p.dataset.frame ?? null,
    status: p.querySelector('[role=status]').textContent,
    buttons: [...p.querySelectorAll('button')].filter(b => !b.closest('[data-syn-module], #kin-viewer-findings')).map(b => b.textContent),
    links: [...p.querySelectorAll('a')].map(a => a.textContent), inputs: p.querySelectorAll('input, textarea').length,
    notes: [...p.querySelectorAll(':scope > div > p')].map(e => e.textContent),
    rows: [...p.querySelectorAll('section[data-item-id]')].map(s => [...s.children].map(c => c.textContent))}; }"""

EDIT_ATTEMPTS = """() => { const answers = [];
  synRun('showCornerstoneContextMenu', { requireNearbyToolData: true, menuId: 'measurementsContextMenu' });
  synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' });
  synRun('updateMeasurement', { uid: 'syn-uid', textLabel: 'SYN' });
  synRun('arrowTextCallback', { callback: text => answers.push(['new', text ?? null]) });
  synRun('arrowTextCallback', { data: { uid: 'syn-uid' }, callback: text => answers.push(['edit', text ?? null]) });
  const m = synServices.measurementService;
  m.update('syn-uid', { label: 'SYN renamed' }, true); m.update('syn-uid', { label: 'synced' }, false); m.toggleLockMeasurement('syn-uid');
  return answers; }"""

PROBE_WRITES = """async authoring => {
  const ALL = ['default', 'mpr', 'SRToolGroup', 'volume3d'], PRIMARY = [{ mouseButton: 1 }];
  const marked = () => [synDraw('default'), synDraw('mpr')].some(x => x.startsWith('mark '));
  const back = () => synRun('setToolActiveToolbar', { itemId: 'WindowLevel', toolGroupIds: ALL });
  const seen = {}, bar = synToolbar(), g = synGroup('default');
  seen.toolbar_offer = bar.primary.includes('MeasurementTools') || (bar.more || []).some(id => authoring.includes(id));
  seen.tool_modes = ALL.some(id => Object.entries(synModes(id)).some(([n, m]) => authoring.includes(n) && ['Active', 'Passive'].includes(m)));
  seen.viewing = synClick('Zoom') === 'ran' && synDraw('default') === 'view Zoom'; back();
  seen.toolbar_press = synClick('Bidirectional') === 'ran' && marked(); back();
  synRun('setToolActiveToolbar', { itemId: 'ArrowAnnotate', toolGroupIds: ALL }); seen.toolbar_command = marked(); back();
  synRun('setToolActive', { toolName: 'RectangleROI' }); seen.hotkey = marked(); back();
  const previous = g.getActivePrimaryMouseButtonTool(); if (previous) g.setToolPassive(previous);
  g.setToolActive('CircleROI', { bindings: PRIMARY }); seen.tool_group = marked(); back();
  SynGroup.prototype.setToolActive.call(g, 'CobbAngle', { bindings: PRIMARY });
  seen.around_guard = synModes('default').CobbAngle === 'Active'; g.setToolPassive('CobbAngle'); back();
  synServices.toolGroupService.createToolGroupAndAddTools('syn-late', { active: [{ toolName: 'WindowLevel', bindings: PRIMARY }],
    passive: [{ toolName: 'DragProbe' }] });
  seen.later_group = ['Active', 'Passive'].includes(synModes('syn-late').DragProbe);
  seen.programmatic_add = synAdd('SplineROI') === 'true';
  let from = synNative.length; synRun('showCornerstoneContextMenu', {}); seen.context_menu = synNative.slice(from).includes('menu');
  from = synNative.length;
  synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' }); synRun('updateMeasurement', { uid: 'syn-uid' });
  seen.annotation_commands = ['delete syn-uid', 'label syn-uid', 'update syn-uid'].every(x => synNative.slice(from).includes(x));
  let typed = null; synRun('arrowTextCallback', { callback: text => { typed = text ?? null; } }); seen.arrow_text = typed === 'SYN typed';
  from = synEdits.length; const m = synServices.measurementService;
  m.update('syn-uid', {}, true); m.toggleLockMeasurement('syn-uid');
  seen.measurement_panel = JSON.stringify(synEdits.slice(from)) === JSON.stringify([['update', 'syn-uid', true], ['lock', 'syn-uid']]);
  from = synNative.length;
  seen.capture = bar.primary.includes('Capture') && synClick('Capture') === 'ran' && synNative.slice(from).includes('view showDownloadViewportModal');
  seen.sr = [await synSR('storeMeasurements'), await synSR('downloadReport')];
  return seen; }"""

LAYOUT = """() => { const p = document.querySelector('#kin-viewer-layout');
  return {summary: p.querySelector('summary').textContent, buttons: [...p.querySelectorAll('button')].map(b => b.textContent),
    note: p.querySelector(':scope > p').textContent}; }"""

NAVIGABLE = """([series, sop]) => { const v = synServices.cornerstoneViewportService.getCornerstoneViewport('syn-vp');
  window.synIndexed = []; v.setImageIdIndex = async index => { window.synIndexed.push(index); };
  synServices.displaySetService.getActiveDisplaySets = () => [{ StudyInstanceUID: window.synStudy, SeriesInstanceUID: series,
    displaySetInstanceUID: 'syn-ds', images: [{ SOPInstanceUID: sop }] }]; }"""

NAVIGATE = """([study, series, sop, item]) => window.kinViewerHistoryNavigate({ studyUid: study, seriesUid: series, sopUid: sop,
  frame: 1, ...(item ? { itemId: item } : {}) })"""

def has_hangul(text):
    return any(unicodedata.name(ch, "").startswith("HANGUL") for ch in text)

HISTORY = "kin.viewer-history"

OTHER = ["kin.viewer-layout"]

GATES = ["kin.viewer-findings", "kin.viewer-jobs", "kin.viewer-tech-note"]

LAYOUT_ID = "kin.viewer-layout"

LAYOUT_ENDED = "세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요."

OTHER_WRITER = me(["radiologist", *KEYCLOAK_DEFAULTS], sub="SYN-RAD2-SUB", user="syn-radiologist-2", name="SYN Radiologist Two")

SLOW_ME_BODIES = """() => { const real = window.fetch.bind(window); window.synBodies = [];
  window.fetch = async (url, options) => { const response = await real(url, options);
    if (url !== '/api/me') return response;
    let release; const released = new Promise(resolve => { release = resolve; }); window.synBodies.push(release);
    return { status: response.status, ok: response.ok, json: () => released.then(() => response.json()) }; }; }"""

EXTRA_BUTTONS = """() => { const bar = synServices.toolbarService;
  bar.addButtons([{ id: 'SYN-Download', uiType: 'ohif.radioGroup', props: { commands: [{ commandName: 'showDownloadViewportModal' }] } },
                  { id: 'SYN-Reset', uiType: 'ohif.radioGroup', props: { commands: [{ commandName: 'resetViewport' }] } }]);
  bar.createButtonSection('primary', ['SYN-Download', 'SYN-Reset']); }"""

EXTRA_PRESSED = """() => { const from = synNative.length, offered = synToolbar().primary.filter(id => id.startsWith('SYN-'));
  return [offered, synClick('SYN-Download'), synClick('SYN-Reset'), synNative.slice(from)]; }"""

OTHER_CLINICIAN = me(["clinician", *KEYCLOAK_DEFAULTS], sub="SYN-CLIN2-SUB", user="syn-clinician-2", name="SYN Clinician Two")

LOGOUT = "() => window.dispatchEvent(new StorageEvent('storage', { key: 'kin-session-ended' }))"

QUIET = 0.15

LAYOUT_CHECKING = "계정과 검사 접근 확인 중…"

ACCOUNT_CHANGED = "계정이 변경되어 배치를 적용하지 않았습니다."

LAYOUT_BUTTONS = ["Save Recent Layout", "Restore Recent Layout", "Delete Recent Layout"]

LAYOUT_PREFIX = "kin-viewer-layout-v1:"

MODULE_NOTICE = {"jobs": ("#kin-viewer-jobs-status", "세션이 변경되었습니다. 다시 로그인한 뒤 뷰어를 여세요."),
                 "findings": ("#kin-viewer-findings-status", "로그인이 종료되었습니다. 다시 로그인한 뒤 뷰어를 여세요."),
                 "tech-note": ("#kin-viewer-note-status", "세션이나 영상창이 변경되었습니다. 뷰어를 새로 여세요.")}

MODULE_READY = {"jobs": ("#kin-viewer-jobs-status", "현재 판독 대상의 저장 작업 목록입니다."),
                "findings": ("#kin-viewer-findings-status", "0개 소견"),
                "tech-note": ("#kin-viewer-note-status", "선택한 영상 칸의 검사 메모")}

MODULE_CONTROL = {"jobs": "Save New Job", "findings": "New Finding", "tech-note": "Tech Note"}

MODULE_ME_HEADER = {"jobs": "x-kin-subject", "findings": "x-kin-finding-schema", "tech-note": "x-kin-institution"}

REAL_NOTE_DEPS = """() => { delete window.kinViewerTechNote;
  window.KinViewerWindows = { connect: () => ({ dispose() {} }) }; window.KinViewerIdentity = { mount: () => ({ dispose() {} }) };
  window.KinViewerWorkspaceDock = () => null;
  window.KinWorkspaceShortcuts = { read: () => ({ image: 'Control+Alt+2', report: 'Control+Alt+4', note: 'Control+Alt+6',
    tools: 'Control+Alt+7', nativeTools: 'Control+Alt+9' }), display: value => String(value), action: () => null };
  window.KinTechNote = options => { window.synNoteApi = options.api; return { open() {}, dispose() {} }; }; }"""

MODULE_RECHECK = {
    "jobs": "() => synAdvance(16000)",
    "findings": "() => [...document.querySelectorAll('#kin-viewer-findings button')].find(b => b.textContent === 'Reload Findings').click()",
    "tech-note": """() => { window.synNoteOutcome = null;
      synNoteApi('GET', '/syn-note').then(() => 'sent', error => error.message).then(outcome => { window.synNoteOutcome = outcome; }); }""",
}

BROADCAST_LOGOUT = "() => { const c = new BroadcastChannel('kin-session'); c.postMessage({ type: 'session-ended' }); c.close(); }"

END_REASONS = "() => { window.synEndReasons = []; kinViewerSession.onEnded(reason => { window.synEndReasons.push(reason); }); }"

CT_SYNC_TEXT = {
    "ended": "세션이 변경되었거나 종료되어 위치 동기를 중지했습니다. 다시 로그인한 뒤 뷰어를 여세요",
    "confirmed": "검사 접근 정보를 확인했습니다. 위치 동기를 사용할 수 있습니다",
    "failed": "검사 접근 정보를 확인하지 못해 위치 동기를 멈췄습니다. 연결 상태를 확인한 뒤 다시 확인하세요",
    "denied": "이 계정으로 검사 접근 정보를 확인할 수 없어 위치 동기를 멈췄습니다. 권한을 확인한 뒤 다시 확인하세요",
    "synced": "같은 좌표계의 CT 위치 동기",
}

CT_SYNC_HOLD_IMAGES = """() => { window.synCtImages = [];
  cornerstone.imageLoader.loadAndCacheImage = () => new Promise(resolve => window.synCtImages.push(resolve)); }"""

CT_SYNC_RELEASE_IMAGES = """() => { cornerstone.imageLoader.loadAndCacheImage = async () => ({});
  window.synCtImages.splice(0).forEach(resolve => resolve({})); }"""

CT_SYNC_BOOT = """([current, prior]) => {
  const CT = '1.2.840.10008.5.1.4.1.1.2', ENGINE = 'syn-ct-engine', planes = new Map(), viewports = new Map(), grid = new Map(), sets = new Map();
  const stack = (vp, study, series, zs) => {
    const ids = zs.map((z, i) => `wadors:${location.origin}/dicom-web/studies/${study}/series/${series}/instances/${series}.${i}/frames/1`);
    ids.forEach((id, i) => planes.set(id, { frameOfReferenceUID: 'SYN-FOR-1', imagePositionPatient: [0, 0, zs[i]], rowCosines: [1, 0, 0], columnCosines: [0, 1, 0] }));
    sets.set('syn-ds-' + vp, { StudyInstanceUID: study, SeriesInstanceUID: series, Modality: 'CT', SOPClassUID: CT, images: ids.map(() => ({ SOPClassUID: CT })) });
    grid.set(vp, { viewportId: vp, displaySetInstanceUIDs: ['syn-ds-' + vp] });
    viewports.set(vp, { id: vp, type: 'stack', index: 0, ids, getRenderingEngine: () => ({ id: ENGINE }), getImageIds() { return this.ids; },
      getCurrentImageIdIndex() { return this.index; }, getCurrentImageId() { return this.ids[this.index]; } });
  };
  stack('syn-ct-a', current, current + '.1', Array.from({ length: 16 }, (_, i) => i * 2));
  stack('syn-ct-b', prior, prior + '.1', Array.from({ length: 8 }, (_, i) => i * 4));
  const z = id => planes.get(id)?.imagePositionPatient[2];
  window.cornerstone.imageLoader = { loadAndCacheImage: async () => ({}) };
  window.cornerstone.metaData = { get: (type, id) => type === 'imagePlaneModule' ? planes.get(id) : undefined };
  window.cornerstone.utilities = { spatialRegistrationMetadataProvider: { add() {} } };
  class NativeSync {
    constructor() { this.targets = []; this.options = {}; this.enabled = true; }
    add(info) { this.targets.push(info); }
    getTargetViewports() { return this.targets.map(t => ({ ...t })); }
    hasTargetViewport(engine, id) { return this.targets.some(t => t.renderingEngineId === engine && t.viewportId === id); }
    isDisabled() { return !this.enabled; }
    setEnabled(value) { this.enabled = value; }
    getOptions(id) { return this.options[id]; }
    setOptions(id, value) { this.options[id] = value; }
    destroy() { this.targets = []; }
    async fireEvent(info) {
      const sz = z(viewports.get(info.viewportId).getCurrentImageId());
      for (const t of this.targets) {
        if (t.viewportId === info.viewportId || this.options[t.viewportId]?.disabled) continue;
        const target = viewports.get(t.viewportId), zs = target.ids.map(z);
        target.index = zs.reduce((best, value, i) => Math.abs(value - sz) < Math.abs(zs[best] - sz) ? i : best, 0);
      }
    }
  }
  const creators = new Map(['imageSlice', 'stackimage'].map(type => [type, () => new NativeSync()]));
  const services = {
    syncGroupService: { getSyncCreatorForType: type => creators.get(type), addSynchronizerType: (type, fn) => { creators.set(type, fn); } },
    cornerstoneViewportService: { getCornerstoneViewport: id => viewports.get(id) },
    viewportGridService: { getState: () => ({ viewports: grid }) },
    displaySetService: { getDisplaySetByUID: uid => sets.get(uid) } };
  const extension = window.config.extensions.find(e => e && e.id === 'kin.ct-sync');
  extension.preRegistration({ servicesManager: { services } });
  let sync = null;
  window.synCt = {
    enter() { extension.onModeEnter(); sync = creators.get('imageSlice')('IMAGE_SLICE_SYNC', {});
      for (const viewportId of viewports.keys()) sync.add({ viewportId, renderingEngineId: ENGINE }); },
    exit() { extension.onModeExit(); },
    scroll(vp, index) { viewports.get(vp).index = index; sync.fireEvent({ viewportId: vp, renderingEngineId: ENGINE }, {}); },
    z: vp => z(viewports.get(vp).getCurrentImageId()),
    notice() { const n = document.querySelector('#kin-ct-sync-status'), b = document.querySelector('#kin-ct-sync-recheck');
      return n ? { visible: !n.hidden, text: n.hidden ? '' : n.querySelector('span').textContent, recheck: !!b && !n.hidden && !b.hidden } : null; },
  };
  window.synCt.enter();
}"""

CT_SYNC_BESIDE_PANELS = ("([current, prior]) => { const panels = window.cornerstone.metaData.get;\n  (" + CT_SYNC_BOOT + ")([current, prior]);\n"
                         "  const ct = window.cornerstone.metaData.get;\n"
                         "  window.cornerstone.metaData.get = (type, id) => ct(type, id) ?? panels(type, id); }")

CT_SYNC_HIT = """() => { const n = document.querySelector('#kin-ct-sync-status'), b = document.querySelector('#kin-ct-sync-recheck');
  const at = r => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2), rb = b.getBoundingClientRect();
  return { button: at(rb) === b, words_pass: !n.contains(at(n.querySelector('span').getBoundingClientRect())), height: rb.height,
    font: parseFloat(getComputedStyle(b).fontSize) }; }"""

def all_studies(page):
    """B14: Clinician Home opens on My Studies. These synthetic rows name no requesting physician, so the cases read All
    Studies, chosen through the page without moving the keyboard focus."""
    page.wait_for_function("() => ['ready', 'empty'].includes(document.querySelector('#list-state')?.dataset.state)")
    page.evaluate("() => [...document.querySelectorAll('#folder-tree button')].find(b => b.textContent.startsWith('All Studies'))?.click()")


class ClinicianViewerDOMTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.me = CLINICIAN
        self.bootstrap = False
        self.entry_reads = []
        self.held_navigation = []
        self.me_status = None
        self.hold_me = False
        self.held_me = []
        self.writer_paged = False
        self.rows = copy.deepcopy(ROWS)
        self.extra_reports = {}
        self.citations, self.finding_revisions, self.finding_reads = {}, {}, []
        self.hold_findings, self.held_findings = False, []
        self.scope_reads = []
        self.exam_scopes, self.scope_queries = {}, []
        self.files = dict(SHIPPED)
        self.config = CONFIG
        self.viewer_page = False
        self.items = copy.deepcopy(ITEMS)
        self.cursors = {}
        self.hold_items = set()
        self.held_items = []
        self.hold_probes = set()
        self.held_probes = []
        self.hold_writer = set()
        self.held_writer = []
        self.hold_next = set()
        self.held_next = []
        self.list_me = None
        self.accept_writes = False
        self.held_writes = []
        self.writes = []
        self.item_requests = []
        self.viewer_opens = []
        self.me_requests = 0
        self.inbox_reads = []
        self.real_api = False
        self.module_requests = []
        self.module_status = {}
        self.last_request = 0.0
        self.unexpected, self.errors, self.dialogs, self.finished = ([], [], [], [])
        self.context = self.browser.new_context(viewport={'width': 1400, 'height': 900})
        self.context.route('**/*', self.route)
        self.page = self.watched_page()

    def watched_page(self):
        page = self.context.new_page()
        page.on('pageerror', lambda error: self.errors.append(str(error)))
        page.on('dialog', self.on_dialog)
        page.on('requestfinished', lambda request: self.finished.append(request))
        return page

    def release_routes(self):
        routes=list(self.held_navigation)+list(self.held_me)+list(self.held_writes)
        routes += [row[-1] for row in self.held_items+self.held_writer]
        for route in routes:
            try:route.abort()
            except Exception:pass
        self.page.wait_for_timeout(20)

    def fresh_page(self):
        self.release_routes()
        if getattr(self, 'observer', None) and not self.observer.is_closed():
            self.observer.evaluate("localStorage.removeItem('kin-session-end')")
            self.observer.close()
        self.held_me=[];self.held_writer=[];self.held_items=[];self.held_writes=[];self.held_navigation=[]
        self.page.close()
        self.page = self.watched_page()

    def tearDown(self):
        self.release_routes()
        self.context.close()
        self.assertEqual([], self.errors, 'page errors')
        self.assertEqual([], self.unexpected, 'requests the harness does not answer')
        self.assertEqual([], self.dialogs, 'browser dialogs')

    def on_dialog(self, dialog):
        self.dialogs.append(f'{dialog.type}: {dialog.message}')
        dialog.dismiss()

    def route(self, route):
        request = route.request
        self.last_request = time.monotonic()
        url = urlparse(request.url)
        method, path = (request.method, url.path)
        if f'{url.scheme}://{url.netloc}' != ORIGIN:
            self.unexpected.append(f'{method} {request.url}')
            route.abort()
            return
        if path == '/harness/observer':
            return route.fulfill(body='<html><body>Observer</body></html>', content_type='text/html')
        if path == BASE + 'index.html':
            self.held_navigation.append(route)
            return
        if method == 'GET' and path.startswith(BASE):
            name = path[len(BASE):]
            if name in self.files:
                kind = 'text/html' if name.endswith('.html') else 'application/javascript'
                route.fulfill(body=self.files[name], content_type=f'{kind}; charset=utf-8')
                return
            if name in MODULE_STUBS:
                kind = 'text/css' if name.endswith('.css') else 'application/javascript'
                route.fulfill(body=MODULE_STUBS[name], content_type=f'{kind}; charset=utf-8')
                return
        if method == 'GET' and path == '/worklist/hpacs-lite/kin-emblem-j1.svg':  # the header's HALO icon
            route.fulfill(path=HPACS / 'kin-emblem-j1.svg')
            return
        if path.startswith('/kin-brand/') or path == '/favicon.ico':
            route.fulfill(status=404, body='')
            return
        if method == 'GET' and path == '/ohif/viewer':
            if self.viewer_page:
                # B14: the hand-off names the screen that opened the window (mode) when a case sets viewer_mode; with
                # viewer_handoff False the page loads as a reload of the tab does (no hand-off at all).
                entry = {'session': 'SYN-SESSION-' + self.me['sub'], 'name': VIEWER_WINDOW,
                         **({'mode': self.viewer_mode} if getattr(self, 'viewer_mode', None) else {}),
                         **({'target': self.viewer_target} if getattr(self, 'viewer_target', None) else {})}
                handoff = '' if getattr(self, 'viewer_handoff', True) is False else '<script>window.name=' + json.dumps('kin-viewer-entry:' + json.dumps(entry)) + ';</script>'
                route.fulfill(body=VIEWER_HARNESS.replace('<script>', handoff + '<script>', 1), content_type='text/html; charset=utf-8')
            else:
                self.viewer_opens.append(parse_qs(url.query, keep_blank_values=True))
                route.fulfill(body=STAND_IN.replace('</body>', '<script src="/harness/ohif.js"></script><script>kinCreateSessionBoundary().preRegistration().then(()=>window.verified=true)</script></body>'), content_type='text/html; charset=utf-8')
            return
        if method == 'GET' and path == '/harness/ohif.js':
            route.fulfill(body=self.config, content_type='application/javascript; charset=utf-8')
            return
        if method == 'GET' and path == '/api/me':
            if self.bootstrap or not self.viewer_page and request.frame.page is not self.page:
                self.entry_reads.append(request.headers.get('x-kin-session'))
                route.fulfill(json={**self.me,'sessionId':'SYN-SESSION-'+self.me['sub']})
                return
            self.me_requests += 1
            if self.hold_me:
                self.held_me.append(route)
            elif self.me_status == 'abort':
                route.abort()
            elif self.me_status == 'bad-json':
                route.fulfill(status=200, body='<html>SYN not JSON</html>', content_type='text/html; charset=utf-8')
            elif self.me_status:
                route.fulfill(status=self.me_status, json={'statusCode': self.me_status, 'message': 'SYN unavailable'})
            else:
                route.fulfill(json={**self.me, 'sessionId': 'SYN-SESSION-' + str(self.me.get('sub'))})
            return
        # In-app unread (unread-badges.js): the page reads its unread views with the list; answered with nothing unread
        # for this session (tests/in_app_unread_dom_test.py has the marks) and logged apart.
        if method == "GET" and path == "/api/unread":
            account = self.me if isinstance(self.me, dict) else {}
            self.unread_reads = [*getattr(self, "unread_reads", []), request.url]
            route.fulfill(json={"owner": [account.get("institution"), account.get("sub")],
                                "view": parse_qs(url.query).get("view", [None])[0], "available": True, "count": 0, "items": [],
                                "nextCursor": None})
            return
        if method == 'GET' and path == '/api/clinician/studies':
            query = parse_qs(url.query, keep_blank_values=True)
            if query != {'limit': ['100']}:
                self.unexpected.append(f'{method} {request.url}')
                route.abort()
                return
            rows = sorted(self.rows, key=lambda row: row['uid'])
            route.fulfill(json={'studies': copy.deepcopy(rows), 'serverTime': '2026-09-26T00:00:00.000Z', 'pagination': {'next': None, 'total': len(rows), 'offset': 0, 'limit': 100}})
            return
        scope_target = re.fullmatch('/api/studies/([^/]+)/exam-scope', path)
        if method == 'GET' and scope_target:
            target = unquote(scope_target.group(1))
            self.scope_reads.append(target)
            self.scope_queries.append((target, parse_qs(url.query)))
            row = next((row for row in self.rows if row['uid'] == target), None)
            route.fulfill(json=self.exam_scopes[target] if target in self.exam_scopes else self.extra_reports[target]['scope'] if target in self.extra_reports else row.get('reportScope', exam_scope(target)) if row else exam_scope(target))
            return
        cited = re.fullmatch(r"/api/studies/([^/]+)/report/citations", path)
        if method == "GET" and cited:
            # the head version's citations Clinician Home reads after a report it shows (none unless a case sets them).
            route.fulfill(json=getattr(self, "citations", {}).get(unquote(cited.group(1)), {"version": 0, "head": [], "draft": []}))
            return
        found = re.fullmatch('/api/clinician/studies/([^/]+)/report', path)
        if method == 'GET' and found and (not url.query or set(parse_qs(url.query)) == {'version'}):
            target = unquote(found.group(1))
            if target in self.extra_reports:
                route.fulfill(json=self.extra_reports[target])
                return
            row = next((row for row in self.rows if row['uid'] == target), None)
            if row is None:
                self.unexpected.append(f'{method} {request.url}')
                route.abort()
                return
            route.fulfill(json=report_of(row))
            return
        found = re.fullmatch('/api/studies/([^/]+)/viewer-items', path)
        if method == 'GET' and found:
            self.viewer_items(route, unquote(found.group(1)), parse_qs(url.query, keep_blank_values=True))
            return
        found = re.fullmatch('/api/studies/([^/]+)/findings/([^/]+)/revisions', path)
        if method == 'GET' and found and not self.real_api:
            # the finding revisions a cited line was cited from (its sources name the saved item and its study).
            key = (unquote(found.group(1)), unquote(found.group(2)))
            self.finding_reads.append((key, parse_qs(url.query, keep_blank_values=True)))
            answer = getattr(self, 'finding_revisions', {}).get(key)
            if request.headers.get('x-kin-finding-schema') != '3':
                # api/src/finding.service.ts: a reader naming no record version reads version 1 only; these rows are 3.
                route.fulfill(status=409, json={'statusCode': 409, 'code': 'FINDING_SCHEMA_OUTDATED', 'message': 'SYN client outdated'})
            elif getattr(self, 'hold_findings', False):
                self.held_findings.append((route, answer))
            elif answer is None:
                route.fulfill(status=NOT_FOUND[0], json=NOT_FOUND[1])
            else:
                route.fulfill(json=answer)
            return
        found = re.fullmatch('/api/studies/([^/]+)/(viewer-jobs|findings)', path)
        if method == 'GET' and found and self.real_api:
            kind = found.group(2)
            self.module_requests.append((kind, unquote(found.group(1)), parse_qs(url.query, keep_blank_values=True)))
            status = self.module_status.get(kind)
            if status:
                route.fulfill(status=status, json={'statusCode': status, 'message': 'SYN refused'})
            elif kind == 'viewer-jobs':
                route.fulfill(json={'jobs': []})
            else:
                route.fulfill(status=200, headers={'content-type': 'application/json', 'X-KIN-Finding-Schema': '4'}, body='{"items":[],"nextCursor":null}')
            return
        if method == 'GET' and path == '/api/syn-note' and self.real_api:
            self.module_requests.append(('note', None, {}))
            route.fulfill(json={'ok': True})
            return
        found = re.fullmatch('/api/studies/([^/]+)/viewer-items(/[^?]*)?', path)
        if method == 'POST' and found and self.accept_writes:
            self.writes.append((unquote(found.group(1)), found.group(2) or ''))
            self.held_writes.append(route)
            return
        if method == 'GET' and path == '/api/critical-results' and (parse_qs(url.query, keep_blank_values=True) == {'view': ['received'], 'state': ['pending']}):
            account = self.me if isinstance(self.me, dict) else {}
            self.inbox_reads.append(request.url)
            route.fulfill(json={'owner': [account.get('institution'), account.get('sub')], 'view': 'received', 'items': [], 'nextCursor': None, 'pending': 0})
            return
        self.unexpected.append(f'{method} {request.url}')
        route.abort()

    def clinician_session(self, account=None):
        app = [role for role in (account or self.me)['roles'] if role in ('radiologist', 'technician', 'admin', 'clinician')]
        return bool(app) and all((role == 'clinician' for role in app))

    def viewer_items(self, route, target, query):
        self.item_requests.append((target, query))
        if set(query) - {'limit', 'cursor', 'includeHidden', 'recheck'}:
            self.unexpected.append(f'viewer-items query {query}')
            route.abort()
            return
        account = self.list_me or self.me
        if not self.clinician_session(account):
            if query == {'limit': ['1']} or set(query) == {'limit', 'cursor'} and query['limit'] == ['100'] and query['cursor'][0].startswith('eyJ2IjoxLCJTWU4i') and getattr(self, 'viewer_mode', None) != 'physician':
                # The writer's access probe; or a later page of a read-only check still on its way when the harness changed the account.
                route.fulfill(json={'items': [], 'nextCursor': None})
                return
            if self.real_api and target == VP and (query == {'limit': ['100']}):
                route.fulfill(json={'items': [], 'nextCursor': None})
                return
            if getattr(self, 'viewer_mode', None) == 'physician' and set(query) <= {'limit', 'cursor'} and query.get('limit') == ['100']:
                # B14: a writer account's viewer opened from the Physician mode asks the read-only list; the server answers
                # every caller in its ordinary shape (viewer.service.ts), the same items as to a clinician.
                route.fulfill(**self.clinician_page(target, query.get('cursor', [None])[0]))
                return
            first = {'includeHidden': ['true'], 'limit': ['100']}
            following = {**first, 'cursor': [WRITER_CURSOR]}
            if query != first and (not (self.writer_paged and query == following)):
                self.unexpected.append(f'writer viewer-items query {query}')
                route.abort()
                return
            if (target, 'first' if query == first else 'next') in self.hold_writer:
                self.held_writer.append((target, 'first' if query == first else 'next', route))
                return
            head = copy.deepcopy(WRITER_HEAD if query == first else WRITER_HEAD_2)
            head['authorSub'] = account['sub']
            route.fulfill(json={'items': [head], 'nextCursor': WRITER_CURSOR if self.writer_paged and query == first else None})
            return
        if 'includeHidden' in query and query['includeHidden'] != ['false'] or ('cursor' in query and 'recheck' in query):
            route.fulfill(status=HIDDEN_REFUSED[0], json=HIDDEN_REFUSED[1])
            return
        if query.get('limit') not in (['100'], ['1']):
            self.unexpected.append(f'clinician viewer-items limit {query}')
            route.abort()
            return
        if query.get('limit') == ['100'] and 'cursor' not in query and (target in self.hold_items):
            self.held_items.append((target, route))
            return
        if query.get('limit') == ['100'] and 'cursor' in query and (target in self.hold_next):
            self.held_next.append((target, query['cursor'][0], route))
            return
        if (query.get('limit') == ['1'] or query == {'limit': ['100']}) and target in self.hold_probes:
            self.hold_probes.discard(target)
            self.held_probes.append((target, route))
            return
        route.fulfill(**self.clinician_page(target, query.get('cursor', [None])[0], issue=query.get('limit') == ['100']))

    def clinician_page(self, target, cursor, issue=True):
        spec = self.items.get(target, NOT_FOUND)
        if isinstance(spec, tuple):
            return {'status': spec[0], 'json': spec[1]}
        index = 0
        if cursor is not None:
            if self.cursors.get(cursor, (None,))[0] != target:
                self.unexpected.append(f'unknown cursor {cursor!r} for {target}')
                return {'status': HIDDEN_REFUSED[0], 'json': HIDDEN_REFUSED[1]}
            index = self.cursors[cursor][1]
        pages = spec['pages']
        following = None
        if issue and index + 1 < len(pages):
            following = f'eyJ2IjoxLCJTWU4iOnsicGFnZSI6{index + 1}.SYN-sig_{target[-2:]}-{len(self.cursors)}_Q'
            self.cursors[following] = (target, index + 1)
        return {'json': {'items': copy.deepcopy(pages[index]), 'nextCursor': following}}

    def wait_until(self, predicate, what, timeout=10.0):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                self.fail(f'{what}: not observed within {timeout:.0f}s')
            self.page.wait_for_timeout(10)

    def settle(self, page=None):
        (page or self.page).wait_for_timeout(300)

    def release(self, route, payload, status=200):
        request = route.request
        route.fulfill(status=status, json=payload)
        self.wait_until(lambda: any((item is request for item in self.finished)), 'the released answer reaching the page')
        self.settle()

    def open_home(self, script=None):
        if script is not None:
            self.files['clinician.js'] = script
        self.page.goto(ORIGIN + BASE + 'clinician.html')
        all_studies(self.page)
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'ready')
        expect(self.page.locator('#studies tr[data-uid]')).to_have_count(len(self.rows))

    def pick(self, u):
        self.page.locator(f'#studies tr[data-uid="{u}"]').click()
        expect(self.page.locator('#detail')).to_have_attribute('data-uid', u)
        expect(self.page.locator('#report-state')).not_to_have_attribute('data-state', 'loading')
        return self.page.evaluate(COMPARE_VIEW)

    def opened(self, count):
        self.wait_until(lambda: len(self.viewer_opens) >= count, f'viewer window request {count}')
        self.settle()
        self.assertEqual(count, len(self.viewer_opens), 'viewer window requests')
        return self.viewer_opens[-1]

    def open_viewer(self, config=None, study=VA, uncancellable=False, enter=None, before_boot=None):
        self.viewer_page = True
        self.config = CONFIG if config is None else config
        self.page.goto(VIEWER_URL)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        self.bootstrap=True
        self.page.evaluate('kinCreateSessionBoundary().preRegistration()')
        self.bootstrap=False
        self.page.evaluate(END_REASONS)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        if before_boot:
            self.page.evaluate(before_boot)
        self.page.evaluate('([study, enter]) => enter ? synBoot(study, enter) : synBoot(study)', [study, enter])
        self.observe_document()

    def panel(self):
        return self.page.evaluate(PANEL)

    def wait_panel(self, state, study):
        self.wait_until(lambda: (lambda p: (p['state'], p['uid']) == (state, study))(self.panel()), f'panel {state} for {study}')
        return self.panel()

    def reads(self):
        return [(target, query) for target, query in self.item_requests if query.get('limit') != ['1']]

    def note_state(self):
        return self.page.evaluate('() => window.kinViewerNoteConnectionState()')

    def modules_settled(self):
        self.wait_until(lambda: self.note_state() not in ('stopped', 'unconfirmed'), 'the module gate answer')
        self.settle()

    def layout(self):
        return self.page.evaluate("() => { const p = document.querySelector('#kin-viewer-layout');\n          return {summary: p.querySelector('summary').textContent,\n            buttons: [...p.querySelectorAll('button')].map(b => [b.textContent, b.disabled])}; }")

    def probes(self):
        # A check: the writer's limit=1 probe, or a first-page read of the read-only list (its checks read the list whole).
        return len([1 for _, query in self.item_requests if query.get('limit') == ['1'] or query == {'limit': ['100']}])

    def focus(self):
        self.page.evaluate('synFocus()')

    def session(self):
        return self.page.evaluate('() => kinViewerSession.state()')


    def release_me(self, answer):
        self.me, self.hold_me = (answer, False)
        held, self.held_me = (self.held_me, [])
        for route in held:
            route.fulfill(json=answer)

    def frameless(self, on):
        self.page.evaluate('on => { window.synFrameless = on; }', on)

    def open_state(self, state):
        self.fresh_page()
        if state == 'refused+late-writer':
            self.refusal_then_late_writers('panel', 403)
            self.settle()
            self.assertEqual('refused', self.session())
            return
        if state == 'refused+layout-account':
            held, _ = self.layout_sees_account_change('save', OTHER_WRITER)
            self.release(held, RADIOLOGIST)
            self.item_requests, self.cursors = ([], {})
            self.page.evaluate('() => { synMounted.length = 0; synStopped.length = 0; }')
            self.assertEqual('refused', self.session())
            return
        if state in ('ended+reenter', 'read-only+ended'):
            if state == 'ended+reenter':
                self.writer_document()
                self.me = OTHER_WRITER
                self.page.evaluate('synReenter()')
            else:
                self.read_only_document()
                self.page.evaluate(LOGOUT)
                self.wait_until(lambda: self.session() == 'refused', 'the logout broadcast')
                self.page.evaluate('synReenter()')
            self.wait_until(lambda: self.session() == 'refused', "the document's end")
            self.settle()
            self.item_requests, self.cursors = ([], {})
            self.page.evaluate('() => { synMounted.length = 0; synStopped.length = 0; }')
            self.me_status, self.writer_paged = (None, False)
            return
        if state == 'read-only+held':
            self.hold_writer_work()
            start = len(self.item_requests)
            self.to_clinician_only(LATER)
            self.wait_panel('ready', VA)
            self.modules_settled()
            self.item_requests = self.item_requests[start:]
            self.settle()
            self.assertEqual('read-only', self.session())
            return
        self.me = RADIOLOGIST if state == 'writer' else CLINICIAN
        self.me_status = {'unconfirmed': 503, 'refused': 403}.get(state)
        self.writer_paged = state == 'writer'
        self.item_requests, self.cursors, self.me_requests = ([], {}, 0)
        self.open_viewer()
        if state == 'writer':
            self.wait_until(lambda: len(self.panel()['rows']) == 2, "the writer list's two pages")
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
            self.wait_until(lambda: any((not disabled for _, disabled in self.layout()['buttons'])), 'the layout buttons')
        elif state == 'read-only':
            self.wait_panel('ready', VA)
            self.modules_settled()
        else:
            self.wait_until(lambda: self.me_requests >= 3, "the panel's, the module gate's and the layout panel's /me")
        self.settle()
        self.assertEqual(state, self.session())

    def observe(self, action):
        start = len(self.item_requests)
        self.page.evaluate(action)
        self.ticks()
        return self.item_requests[start:]

    def ticks(self, rounds=2, count=2):
        for _ in range(rounds):
            self.page.evaluate('n => synTick(n)', count)
            self.quiet()

    def quiet(self):
        begin = time.monotonic()
        while time.monotonic() - max(self.last_request, begin) < QUIET:
            self.page.wait_for_timeout(20)

    @staticmethod
    def kind(requests):
        kinds = {'check' if query.get('limit') == ['1'] else 'read-all' if query.get('includeHidden') == ['true'] else 'read' for _, query in requests}
        return '+'.join(sorted(kinds)) or 'none'

    def observe_writes(self, state):
        seen = self.page.evaluate(PROBE_WRITES, AUTHORING)
        sr = tuple(seen.pop('sr'))
        refusal = {'read-only': RO_SR, 'read-only+held': RO_SR, 'refused': ENDED, 'refused+late-writer': ENDED, 'refused+layout-account': ENDED, 'ended+reenter': ENDED, 'read-only+ended': ENDED}.get(state, UNCONFIRMED_SR)
        seen['sr_commands'] = {(f'refused: {WRITER_SR}',) * 2: True, (f'refused: {refusal}',) * 2: False}.get(sr, f'unexpected {sr}')
        buttons, mounted = (set(self.panel()['buttons']), set(self.page.evaluate('synMounted')))
        seen['panel_controls'] = bool(buttons & {'Download SR', 'Store SR', 'Length', 'Angle', 'Ellipse ROI', 'Add Key Image'})
        seen['row_controls'] = bool(buttons & {'Edit', 'Save', 'Hide', 'Restore', 'History', 'Recheck Source'})
        seen.update(findings='findings' in mounted, jobs='jobs' in mounted, tech_note=self.note_state() == 'ready', layout_account='hanging-protocol' in mounted or any((not disabled for _, disabled in self.layout()['buttons'])))
        seen['marks_present'] = bool(self.page.evaluate('synMarks()'))
        stray = self.page.evaluate("synRawMark('Bidirectional')")
        self.settle()
        seen['stray_mark_kept'] = self.page.evaluate('uid => synHas(uid)', stray)
        return seen

    def observe_list(self):
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        outcome = self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None])
        return {'list_mark': ['Length', 'SYN-A length', True] in self.page.evaluate('synDrawn()'), 'go_to_image': outcome.get('ok') is True}

    def observe_rechecks(self, state):
        initial = list(self.item_requests)
        handed = [WRITER_CURSOR] if state == 'writer' else list(self.cursors)
        continued = [query['cursor'][0] for _, query in initial if 'cursor' in query]
        asked = self.me_requests
        seen = {'initial_read': self.kind([r for r in initial if r[1].get('limit') != ['1']]), 'page_continuation': 'none' if not continued else 'cursor' if continued == handed else f'unexpected {continued}', 'focus': self.kind(self.observe('synFocus()')), 'me_on_focus': self.me_requests > asked, 'periodic': self.kind(self.observe('synAdvance(16000)')), 'frame_lost': self.kind(self.observe('window.synFrameless = true')), 'frame_return': self.kind(self.observe('window.synFrameless = false'))}
        self.observe('window.synFrameless = true')
        seen['frameless_focus'] = self.kind(self.observe('synFocus()'))
        seen['study_change'] = self.kind([r for r in self.observe(f"window.synFrameless = false, synSwitch('{VP}')") if r[0] == VP])
        return seen

    def test_01_open_viewer_and_compare_use_one_named_window_with_the_opener_cut(self):
        self.open_home()
        expect(self.page.locator('#open-viewer')).to_be_disabled()
        seen = self.pick(A)
        self.assertTrue(seen['enabled'])
        with self.page.expect_popup() as info:
            self.page.locator('#open-viewer').click()
        popup = info.value
        self.assertEqual(viewer_query(A), self.opened(1))
        popup.wait_for_url(re.compile(r'.*/ohif/viewer\?StudyInstanceUIDs=.*'))
        popup.wait_for_function('window.verified===true')
        self.assertEqual([None],self.entry_reads)
        self.assertEqual('SYN-SESSION-'+CLINICIAN['sub'],popup.evaluate('KinWorkContext.session()'))
        self.assertEqual([VIEWER_WINDOW, True], popup.evaluate('() => [window.name, window.opener === null]'))
        self.assertEqual(VIEWER_ASKED, self.page.locator('#viewer-note').text_content())
        self.page.locator(f'#compare-list li[data-uid="{P1}"] button').click()
        self.assertEqual(viewer_query(A, P1), self.opened(2))
        popup.wait_for_url(re.compile(r'.*hangingProtocolId=.*'))
        self.assertEqual(2, len(self.context.pages), 'one viewer window, reused')
        self.assertEqual(COMPARE_ASKED, self.page.locator('#viewer-note').text_content())
        self.assertEqual([], self.scope_reads, 'ordinary viewer entry adds no exam-scope requests')
        self.pick(BAD)
        self.page.locator('#open-viewer').click()
        self.settle()
        self.assertEqual(BAD_UID, self.page.locator('#viewer-note').text_content())
        self.page.evaluate('() => { window.open = () => null; }')
        self.pick(A)
        self.page.locator('#open-viewer').click()
        self.assertEqual(BLOCKED, self.page.locator('#viewer-note').text_content())
        self.page.locator(f'#compare-list li[data-uid="{P2}"] button').click()
        self.assertEqual(BLOCKED, self.page.locator('#viewer-note').text_content())
        self.settle()
        self.assertEqual(2, len(self.viewer_opens))

    def test_original_row_opens_preserved_split_report_and_its_stored_images(self):
        target=uid(999)
        scope={**exam_scope(target), 'groupId':'syn-group', 'kind':'split', 'part':1, 'active':False,
               'sources':[{'studyUid':A,'series':{'mode':'include','uids':[A+'.2']}}]}
        self.rows[0]['exam']={'reports':[{'uid':target,'version':4,'action':'approve','scope':scope}]}
        self.extra_reports[target]={'uid':target,'scope':scope,'report':{**FINAL,'findings':'SYN preserved split',
            'conclusion':'SYN conclusion','recommendation':''},'keys':[]}
        self.open_home()
        self.pick(A)
        self.page.get_by_role('button',name='Split 2/2 · v4',exact=True).click()
        expect(self.page.locator('#report-body')).to_contain_text('SYN preserved split')
        with self.page.expect_popup():
            self.page.locator('#open-viewer').click()
        query=self.opened(1)
        self.assertEqual([target],query['kinReportUid'])
        self.assertEqual([A],query['StudyInstanceUIDs'])
        self.assertEqual(scope_reference(scope),json.loads(query['kinExamScopes'][0])['current'])

    def test_01b_open_annotated_image_hands_the_key_images_original_frame(self):
        """a key image's Open Annotated Image opens the one viewer window (the same named window, opener cut, the
        Physician mode) and hands it the original image the server named for that key: its own study, series, SOP, frame and
        the item id. A key whose original cannot be read opens nothing and says why."""
        row = next(r for r in self.rows if r['uid'] == A)
        good = {**key_item(5, 'SYN-A key five', 'SYN key note', frame=3), 'sourceUid': A}
        broken = {**key_item(6, 'SYN-A key six'), 'sourceUid': A}
        broken['item'] = {**broken['item'], 'sopUid': 'not-a-uid'}
        self.extra_reports[A] = {**report_of(row), 'keys': [good, broken]}
        self.open_home()
        self.pick(A)
        keys = self.page.locator('#key-list li')
        expect(keys).to_have_count(2)
        self.assertEqual(['Open Annotated Image', 'Open Annotated Image'], keys.locator('button').all_text_contents())
        self.assertEqual(['no', 'no'], [keys.nth(0).locator('.key-title').get_attribute('translate'), keys.nth(0).locator('.key-description').get_attribute('translate')])
        with self.page.expect_popup() as info:
            keys.nth(0).get_by_role('button', name='Open Annotated Image').click()
        popup = info.value
        self.assertEqual(viewer_query(A), self.opened(1))
        popup.wait_for_function('window.verified===true')
        self.assertEqual([VIEWER_WINDOW, True], popup.evaluate('() => [window.name, window.opener === null]'))
        self.assertEqual({'studyUid': A, 'seriesUid': SERIES, 'sopUid': SOP, 'frame': 3, 'itemId': item_id(5)},
                         popup.evaluate('() => KIN_VIEWER_ENTRY_TARGET'))
        self.assertEqual('physician', popup.evaluate("() => sessionStorage.getItem('kin-viewer-mode')"))
        self.assertEqual('뷰어 창에 그 원본 영상과 표식을 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요.',
                         self.page.locator('#viewer-note').text_content())
        keys.nth(1).get_by_role('button', name='Open Annotated Image').click()
        self.settle()
        self.assertEqual(1, len(self.viewer_opens), 'a key whose original cannot be read opens nothing')
        self.assertEqual('키 이미지의 원본 식별(시리즈·영상·프레임)을 확인할 수 없어 열지 않았습니다.', self.page.locator('#viewer-note').text_content())
        # Open Viewer after it hands no target: the same window opens the study, as before.
        self.page.locator('#open-viewer').click()
        self.opened(2)
        popup.wait_for_function('() => window.verified === true && KIN_VIEWER_ENTRY_TARGET === null')

    def test_01c_a_cited_line_opens_the_image_its_source_names(self):
        """The report's sentence -> the lesion in the image: a line of the shown report that the server's head
        citations name once, from a saved image item, is a button in the text; pressing it takes the viewer window at once,
        reads which item and study that finding revision cited and whether the item is still in the study's list, and hands
        the viewer that original frame and item. The text stays as sent. A line cited twice, a job source, an item hidden
        since, or a citation read of another version link or open nothing; a blank window taken for nothing is closed."""
        row = next(r for r in self.rows if r['uid'] == A)
        finding = 'b0000000-0000-4000-8000-000000000001'
        text = 'Liver lesion 12 mm.\nNo other finding.'
        self.extra_reports[A] = {**report_of(row), 'report': {**report_of(row)['report'], 'findings': text, 'conclusion': 'SYN conclusion'}}
        cite = lambda field, inserted, n=1, ref=None, cid='c-1': {'cid': cid, 'field': field, 'insertedText': inserted, 'sameTextCount': n,
            'findingId': finding, 'findingRevision': 2, 'sourceIndex': 0, 'sourceRef': ref or {'kind': 'item', 'itemId': item_id(2), 'sourceRevision': 1}}
        self.citations[A] = {'version': FINAL['version'], 'head': [cite('findings', 'Liver lesion 12 mm.'),
            cite('conclusion', 'SYN conclusion', n=2, cid='c-2'), cite('conclusion', 'SYN conclusion', n=2, cid='c-3')], 'draft': []}
        v3 = lambda *sources: {'schemaVersion': 3, 'title': 'SYN finding', 'text': '', 'characteristics': '', 'lesionLocation': '',
                               'sources': list(sources), 'primary': 0}
        self.finding_revisions[(A, finding)] = {'revisions': [
            {'revision': 1, 'item': v3({'itemId': item_id(1), 'revision': 1, 'studyUid': A})},
            {'revision': 2, 'item': v3({'itemId': item_id(2), 'revision': 1, 'studyUid': A})}], 'nextCursor': None}
        self.items[A] = {'pages': [[]]}
        self.open_home()
        self.pick(A)
        links = self.page.locator('#report-body button.cited-line')
        expect(links).to_have_count(1)
        self.assertEqual(['Liver lesion 12 mm.'], links.all_text_contents())
        self.assertEqual('no', links.first.get_attribute('translate'))
        self.assertEqual(text, self.page.locator('#report-body section[data-field="findings"] .body-text').text_content(), 'the text as sent')
        self.assertEqual('SYN conclusion', self.page.locator('#report-body section[data-field="conclusion"] .body-text').text_content())
        # The item hidden since the line was cited: the window taken at the press (blank) is closed, nothing is opened.
        with self.page.expect_popup() as info:
            links.first.click()
        blank = info.value
        expect(self.page.locator('#viewer-note')).to_have_text('인용한 표식이 지금 저장 항목에 없습니다(숨김 또는 삭제). 영상을 열지 않았습니다.')
        self.wait_until(lambda: blank.is_closed(), 'the blank window closed')
        self.assertEqual([], self.viewer_opens)
        self.assertEqual([((A, finding), {'limit': ['100']})], self.finding_reads)
        # The item there (revised since it was cited): the viewer opens at its frame with it named.
        self.items[A] = {'pages': [[mark_item(2, 'length', 'SYN-A length', revision=2)]]}
        with self.page.expect_popup() as info:
            links.first.click()
        popup = info.value
        self.assertEqual(viewer_query(A), self.opened(1))
        popup.wait_for_function('window.verified===true')
        self.assertEqual({'studyUid': A, 'seriesUid': SERIES, 'sopUid': SOP, 'frame': 1, 'itemId': item_id(2)},
                         popup.evaluate('() => KIN_VIEWER_ENTRY_TARGET'))
        self.assertEqual('뷰어 창에 그 원본 영상과 표식을 열도록 요청했습니다. 인용할 때의 표식은 r1, 지금 표시하는 표식은 r2입니다.',
                         self.page.locator('#viewer-note').text_content())
        self.assertIn((A, {'limit': ['100'], 'recheck': [item_id(2)]}), self.item_requests)
        # The item hidden again: the open viewer window is left as it is.
        self.items[A] = {'pages': [[]]}
        links.first.click()
        expect(self.page.locator('#viewer-note')).to_have_text('인용한 표식이 지금 저장 항목에 없습니다(숨김 또는 삭제). 영상을 열지 않았습니다.')
        self.assertFalse(popup.is_closed())
        self.assertEqual(1, len(self.viewer_opens))
        # A citation read of another version links nothing; nor does a job source, nor an image line that a job citation's
        # lines overlap.
        job = {'kind': 'job', 'jobId': finding, 'sourceRevision': 1}
        for answer in ({'version': FINAL['version'] + 1, 'head': self.citations[A]['head'], 'draft': []},
                       {'version': FINAL['version'], 'head': [cite('findings', 'Liver lesion 12 mm.', ref=job)], 'draft': []},
                       {'version': FINAL['version'], 'head': [cite('findings', 'Liver lesion 12 mm.'),
                                                              cite('findings', text, ref=job, cid='c-4')], 'draft': []}):
            with self.subTest(answer=answer['version']):
                self.citations[A] = answer
                self.pick(B)
                self.pick(A)
                expect(self.page.locator('#report-body section[data-field="findings"] .body-text')).to_have_text(text)
                self.settle()
                expect(links).to_have_count(0)
        # A line citing a mark of the comparison study (the same server patient key): that study opens beside this one, at
        # the mark's own frame of its own study.
        self.citations[A] = {'version': FINAL['version'], 'head': [cite('findings', 'Liver lesion 12 mm.')], 'draft': []}
        self.finding_revisions[(A, finding)] = {'revisions': [
            {'revision': 2, 'item': v3({'itemId': item_id(2), 'revision': 1, 'studyUid': P1})}], 'nextCursor': None}
        self.items[P1] = {'pages': [[mark_item(2, 'length', 'SYN-P1 length')]]}
        self.pick(B)
        self.pick(A)
        expect(links).to_have_count(1)
        links.first.click()
        self.assertEqual(viewer_query(A, P1), self.opened(2))
        popup.wait_for_function(f"() => window.verified === true && KIN_VIEWER_ENTRY_TARGET?.studyUid === '{P1}'")
        self.assertEqual({'studyUid': P1, 'seriesUid': SERIES, 'sopUid': SOP, 'frame': 1, 'itemId': item_id(2)},
                         popup.evaluate('() => KIN_VIEWER_ENTRY_TARGET'))
        self.assertEqual('뷰어 창에 그 원본 영상과 표식을 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요.', self.page.locator('#viewer-note').text_content())

    def test_01d_cited_line_paths_split_part_late_answer_and_stored_head(self):
        """A cited mark on a split comparison study opens the part whose series holds it, in the list's own shape: the
        second part, which only the original row's exam.reports carries, opens as its stored version, the first as the row's
        exam; another patient's or institution's split study opens nothing; a lookup answered after the user opened the viewer otherwise (Compare) does not take that window back; the
        report opened by its version (an Exam Reports button) links its lines when that version is the head the citations
        were read from."""
        row = next(r for r in self.rows if r['uid'] == A)
        finding = 'b0000000-0000-4000-8000-000000000002'
        original, logical, other_series = P1, uid(78), uid(901)
        text = 'Liver lesion 12 mm.'
        cite = {'cid': 'c-9', 'field': 'findings', 'insertedText': text, 'sameTextCount': 1, 'findingId': finding, 'findingRevision': 1,
                'sourceIndex': 0, 'sourceRef': {'kind': 'item', 'itemId': item_id(2), 'sourceRevision': 1}}
        self.extra_reports[A] = {**report_of(row), 'report': {**report_of(row)['report'], 'findings': text}}
        self.citations[A] = {'version': FINAL['version'], 'head': [cite], 'draft': []}
        source = {'itemId': item_id(2), 'revision': 1, 'studyUid': original}
        self.finding_revisions[(A, finding)] = {'revisions': [{'revision': 1, 'item': {'schemaVersion': 3, 'title': 'SYN', 'text': '',
            'characteristics': '', 'lesionLocation': '', 'sources': [source], 'primary': 0}}], 'nextCursor': None}
        self.items[original] = {'pages': [[mark_item(2, 'length', 'SYN split length')]]}

        def split(owner, second):
            # The clinician list answers a split original as ONE row (api/src/pacs/clinician.ts clinicianStudies/examOf):
            # its exam is the first part (the part whose logical UID is the original), and each part's readable report head
            # is in that row's exam.reports (relatedExamReports, the scope examScopeView gives). The second part, a logical
            # UID, is no row of the list.
            scope = lambda report, n: {'reportUid': report, 'groupId': 'syn-split', 'kind': 'split', 'part': n, 'active': True,
                'sources': [{'studyUid': owner, 'series': {'mode': 'exclude' if n == 0 else 'include', 'uids': [second]}}],
                'generation': f'syn-split-{n}', 'hasMembership': True}
            target = next(r for r in self.rows if r['uid'] == owner)
            target['report'] = {**FINAL, 'version': 2, 'scope': scope(owner, 0)}
            target['exam'] = {'id': 'syn-split', 'active': True, 'baseUid': owner, 'readable': True, 'studies': [owner],
                              'scope': scope(owner, 0), 'reports': [
                                  {'uid': owner, 'version': 2, 'action': 'approve', 'scope': scope(owner, 0)},
                                  {'uid': logical, 'version': 1, 'action': 'approve', 'scope': scope(logical, 1)}]}
            self.exam_scopes = {owner: scope(owner, 0), logical: scope(logical, 1)}

        split(original, SERIES)
        self.open_home()
        self.pick(A)
        link = self.page.locator('#report-body button.cited-line')
        expect(link).to_have_count(1)
        # The mark on the second part (its series): that part opens beside this exam, as its stored version, once.
        with self.page.expect_popup() as info:
            link.click()
        popup = info.value
        opened = self.opened(1)
        self.assertEqual([A + ',' + original], opened['StudyInstanceUIDs'])
        scopes = json.loads(opened['kinExamScopes'][0])
        self.assertEqual({'reportUid': logical, 'groupId': 'syn-split', 'part': 1}, scopes['prior'], 'the part whose series holds the mark')
        self.assertEqual(1, scopes['priorVersion'])
        self.assertIn((logical, {'purpose': ['stored'], 'version': ['1']}), self.scope_queries)
        popup.wait_for_function('window.verified===true')
        self.assertEqual(original, popup.evaluate('() => KIN_VIEWER_ENTRY_TARGET.studyUid'))
        self.assertEqual('뷰어 창에 그 원본 영상과 표식을 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요.', self.page.locator('#viewer-note').text_content())
        # The mark on the first part: the row's own exam opens beside, as before.
        split(original, other_series)
        self.page.locator('#refresh').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'ready')
        self.pick(A)
        expect(link).to_have_count(1)
        link.click()
        scopes = json.loads(self.opened(2)['kinExamScopes'][0])
        self.assertEqual({'reportUid': original, 'groupId': 'syn-split', 'part': 0}, scopes['prior'])
        popup.wait_for_function(f"() => window.verified === true && KIN_VIEWER_ENTRY_TARGET?.studyUid === '{original}'")
        # The same split shape on another patient's study, or another institution's: nothing opens.
        for stranger in (N, T):
            with self.subTest(stranger=stranger):
                source['studyUid'] = stranger
                self.items[stranger] = {'pages': [[mark_item(2, 'length', 'SYN stranger length')]]}
                split(stranger, SERIES)
                self.page.locator('#refresh').click()
                expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'ready')
                self.pick(A)
                expect(link).to_have_count(1)
                link.click()
                expect(self.page.locator('#viewer-note')).to_have_text('인용한 표식의 검사를 지금 목록에서 같은 환자로 확인할 수 없어 열지 않았습니다. 목록을 새로고침하세요.')
                self.settle()
                self.assertEqual(2, len(self.viewer_opens))
        source['studyUid'] = original
        split(original, SERIES)
        self.page.locator('#refresh').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'ready')
        self.pick(A)
        expect(link).to_have_count(1)
        # A lookup still on its way when Compare is pressed: its late answer opens nothing.
        self.hold_findings = True
        link.click()
        self.wait_until(lambda: self.held_findings, 'the finding lookup held')
        self.page.locator(f'#compare-list li[data-uid="{P1}"] button').click()
        self.wait_until(lambda: len(self.viewer_opens) == 3, 'the Compare opening')
        route, answer = self.held_findings.pop()
        self.hold_findings = False
        route.fulfill(json=answer)
        self.settle()
        self.assertEqual(3, len(self.viewer_opens), 'the late lookup does not take the window back')
        self.assertNotEqual('뷰어 창에 그 원본 영상과 표식을 열도록 요청했습니다. 영상 표시는 그 창에서 확인하세요.', self.page.locator('#viewer-note').text_content())
        # The report opened by its version from Exam Reports: it is the head the citations were read from, so its line links.
        row['exam'] = {'reports': [{'uid': A, 'version': FINAL['version'], 'action': 'approve', 'scope': exam_scope(A)}]}
        self.page.locator('#refresh').click()
        expect(self.page.locator('#list-state')).to_have_attribute('data-state', 'ready')
        self.pick(A)
        self.page.get_by_role('button', name=f"Original exam · v{FINAL['version']}").click()
        expect(self.page.locator('#report-target')).to_be_visible()
        expect(link).to_have_count(1)

    def test_02_candidates_are_the_same_server_patient_key_only(self):
        self.open_home()
        seen = self.pick(A)
        self.assertEqual({'note': VIEWER, 'section': A, 'candidates': [P1, P2], 'enabled': True}, seen)
        parts = self.page.evaluate("() => [...document.querySelectorAll('#compare-list li')].map(li =>\n          [li.querySelector('span:not(.status)').textContent, li.querySelector('.status').textContent,\n           li.querySelector('button').textContent, li.querySelector('p').textContent])")
        self.assertEqual([[f'2025-01-01 · CT · {HOSTILE}', 'Awaiting Report', 'Compare', 'SYN KIM · SYN-P-100 · SYN Hospital A'], ['2024-01-01 · MR · SYN DESC 13', 'Awaiting Report', 'Compare', 'SYN KIM (EDITED) · SYN-P-100-EDIT · SYN Hospital A']], parts)
        self.assertIsNone(self.page.evaluate('() => document.body.dataset.pwned ?? null'))
        self.assertEqual([A, P2], self.pick(P1)['candidates'])
        for lone in (N, O, T, B, BAD):
            with self.subTest(study=lone):
                self.assertEqual({'note': f'{VIEWER} {NONE}', 'section': None, 'candidates': [], 'enabled': True}, self.pick(lone))
        self.assertEqual({'note': f'{VIEWER} {NO_KEY}', 'section': None, 'candidates': [], 'enabled': True}, self.pick(K))

    def test_03_a_b_a_and_refresh_keep_candidates_to_the_selected_study(self):
        for name in ('shipped',):
            with self.subTest(file=name):
                self.rows = copy.deepcopy(ROWS)
                self.viewer_opens = []
                self.open_home(SHIPPED['clinician.js'])
                self.assertEqual([P1, P2], self.pick(A)['candidates'])
                self.page.evaluate(f'''() => {{ window.synStale = document.querySelector('#compare-list li[data-uid="{P2}"] button'); }}''')
                self.assertEqual({'note': f'{VIEWER} {NONE}', 'section': None, 'candidates': [], 'enabled': True}, self.pick(B))
                self.assertEqual({'note': VIEWER, 'section': A, 'candidates': [P1, P2], 'enabled': True}, self.pick(A))
                next((row for row in self.rows if row['uid'] == P2))['sourcePatientKey'] = patient(INST_A, 'SYN-P-999')
                self.page.locator('#refresh').click()
                self.wait_until(lambda: self.page.evaluate(COMPARE_VIEW)['candidates'] == [P1], 'A read again from the new list')
                expect(self.page.locator('#report-state')).to_have_attribute('data-state', 'final')
                self.assertEqual({'note': VIEWER, 'section': A, 'candidates': [P1], 'enabled': True}, self.page.evaluate(COMPARE_VIEW))
                self.assertFalse(self.page.evaluate('() => window.synStale.isConnected'))
                self.page.evaluate('() => window.synStale.click()')
                self.settle()
                self.assertEqual([], self.viewer_opens, 'a stale Compare opens nothing')
                self.assertEqual(GONE, self.page.locator('#viewer-note').text_content())
                for page in self.context.pages[1:]:
                    page.close()

    def test_04_wording_font_targets_and_keyboard(self):
        self.open_home()
        self.pick(A)
        labels = self.page.evaluate("() => ({buttons: [...document.querySelectorAll('#viewer-slot button, #compare button')]\n          .map(b => b.textContent), headings: [...document.querySelectorAll('#compare h3')].map(h => h.textContent)})")
        self.assertEqual({'buttons': ['Open Viewer', 'Compare', 'Compare'], 'headings': ['Comparison']}, labels)
        for text in labels['buttons'] + labels['headings']:
            self.assertFalse(has_hangul(text), text)
        explanations = [self.page.locator('#viewer-note').text_content(), self.page.locator('#compare > p.muted').text_content()]
        for text in explanations:
            self.assertTrue(has_hangul(text), text)
        states = [self.page.evaluate("() => [...document.querySelectorAll('#viewer-slot, #viewer-slot *, #compare, #compare *')]\n          .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))\n          .map(e => ({text: e.textContent, size: parseFloat(getComputedStyle(e).fontSize)}))")]
        for message in (NONE, NO_KEY, BLOCKED, BAD_UID, GONE, VIEWER_ASKED, COMPARE_ASKED):
            states.append([{'text': message, 'size': None}])
        for texts in states:
            for item in texts:
                with self.subTest(text=item['text'][:60]):
                    self.assertIsNone(AVOIDED.search(item['text']))
                    if item['size'] is not None:
                        self.assertGreaterEqual(item['size'], 12)
        targets = self.page.evaluate("() => [...document.querySelectorAll('#viewer-slot button, #compare button')]\n          .map(b => { const r = b.getBoundingClientRect(); return [b.textContent, r.width, r.height]; })")
        for text, width, height in targets:
            self.assertGreaterEqual(min(width, height), 24, text)
        self.page.locator(f'#compare-list li[data-uid="{P2}"] button').focus()
        with self.page.expect_popup():
            self.page.keyboard.press('Enter')
        self.assertEqual(viewer_query(A, P2), self.opened(1))
        self.assertEqual('polite', self.page.locator('#viewer-note').get_attribute('aria-live'))

    def test_05_clinician_viewer_offers_no_create_link_or_save_control(self):
        self.open_viewer()
        seen = self.wait_panel('ready', VA)
        self.assertEqual('저장 항목 4개 · 읽기 전용', seen['status'])
        self.assertEqual(['Refresh', 'Go to Image', 'Go to Image', 'Go to Image', 'Go to Image'], seen['buttons'])
        self.assertEqual(([], 0, [RO_NOTE]), (seen['links'], seen['inputs'], seen['notes']))
        self.assertEqual([['Key Image · Saved r1', 'Read-only', 'SYN-A key', 'SYN-A key note', '프레임 1', 'Go to Image'], ['Length · Saved r2', 'Read-only', 'SYN-A length', '프레임 1', 'Go to Image'], ['Angle · Saved r1', 'Read-only', 'SYN-A angle', '프레임 1', UNVERIFIED, 'Go to Image'], ['Arrow · Saved r1', 'Read-only', 'SYN-A arrow', '프레임 2', 'Go to Image']], seen['rows'])
        self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
        cursor = next(iter(self.cursors))
        self.assertEqual([(VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], self.reads())
        for _, query in self.item_requests:
            self.assertNotIn('includeHidden', query)
            self.assertNotIn('recheck', query)
        self.assertEqual('undefined', self.page.evaluate('synAddLength()'))
        self.assertEqual(RO_TOOL, self.panel()['status'])
        self.assertEqual([f'refused: {RO_SR}'] * 2, [self.page.evaluate('name => synSR(name)', name) for name in ('storeMeasurements', 'downloadReport')])
        self.assertEqual([], self.page.evaluate('synNative'))
        self.assertEqual([RO_SR, RO_SR], self.page.evaluate('synNotices'))
        self.modules_settled()
        self.wait_until(lambda: self.page.evaluate(LAYOUT)['summary'] == 'Viewer Status', "the layout panel's account")
        self.assertEqual('read-only', self.page.evaluate('kinViewerNoteConnectionState()'))
        self.assertEqual([], self.page.evaluate('synMounted'))
        self.assertEqual({'summary': 'Viewer Status', 'buttons': [], 'note': '읽기 전용 화면입니다. 배치 저장·복원과 Hanging Protocol은 제공하지 않습니다. 화면 배치는 뷰어의 기본 레이아웃 도구로 바꿀 수 있습니다.'}, self.page.evaluate(LAYOUT))
        self.assertEqual(0, self.page.locator('[data-syn-module]').count())
        for text in [seen['status'], RO_NOTE, RO_TOOL, RO_SR, RO_EMPTY, RO_DENIED, *sum(seen['rows'], [])]:
            self.assertIsNone(AVOIDED.search(text), text)

    def test_05b_writer_sessions_unanswered_me_and_controls(self):
        for session in (RADIOLOGIST, MIXED):
            with self.subTest(session=session['roles']):
                self.me = session
                self.item_requests, self.cursors = ([], {})
                self.open_viewer()
                self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
                self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
                seen = self.panel()
                self.assertTrue({'Download SR', 'Store SR', 'Length', 'Angle', 'Ellipse ROI', 'Add Key Image', 'Edit', 'Hide', 'History'} <= set(seen['buttons']), seen['buttons'])
                self.assertEqual(4, len(self.page.evaluate('synMounted')))
                self.assertEqual([(VA, {'includeHidden': ['true'], 'limit': ['100']})], self.reads())
                self.page.evaluate('synAddLength()')
                self.assertNotEqual(RO_TOOL, self.panel()['status'])
        self.me, self.me_status, self.item_requests, self.me_requests = (CLINICIAN, 500, [], 0)
        self.open_viewer()
        self.wait_until(lambda: self.me_requests >= 3, "the panel's, the module gate's and the layout panel's /me")
        self.settle()
        self.assertEqual([], self.page.evaluate('synMounted'))
        self.assertEqual('unconfirmed', self.note_state())
        self.assertEqual([], self.panel()['buttons'])
        self.assertEqual([], self.reads())
        self.assertTrue(all((disabled for _, disabled in self.layout()['buttons'])), self.layout())
        self.me, self.me_status = (CLINICIAN, None)

    def test_05c_physician_mode_is_read_only_for_a_mixed_account_and_survives_a_reload(self):
        """B14: Minhoon 11-01 "basically no different to the radiologist, except they can't annotate the images". A window
        Clinician Home (the Physician mode) opens says so in its hand-off; a clinician + radiologist account then gets the
        clinician's read-only viewer - no authoring tool, no write module - and a reload of that tab keeps it. The same
        account's window opened without that mode (the Radiologist screen) keeps its writer tools (test_05b)."""
        try:
            self.me, self.viewer_mode = MIXED, 'physician'
            self.item_requests, self.cursors = ([], {})
            self.open_viewer()
            self.modules_settled()
            self.assertEqual('read-only', self.session())
            self.assertEqual([], self.page.evaluate('synMounted'))
            self.assertFalse({'Download SR', 'Store SR', 'Length', 'Angle', 'Ellipse ROI', 'Add Key Image', 'Edit', 'Save', 'Hide'}
                             & set(self.panel()['buttons']), self.panel()['buttons'])
            self.assertEqual('undefined', self.page.evaluate('synAddLength()'))
            self.assertEqual(RO_TOOL, self.panel()['status'])
            # the list it reads is drawn (the server's {items, nextCursor}, to its last page) with its verified mark.
            seen = self.wait_panel('ready', VA)
            self.assertEqual(['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], [row[2] for row in seen['rows']])
            self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
            # A reload of the tab: no hand-off, the mode of the last one stays.
            self.viewer_handoff = False
            self.open_viewer()
            self.modules_settled()
            self.assertEqual(('read-only', []), (self.session(), self.page.evaluate('synMounted')))
            # A new hand-off without the mode (another screen reusing the tab) is a writer again.
            self.viewer_handoff, self.viewer_mode = True, None
            self.open_viewer()
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
            self.assertEqual('writer', self.session())
        finally:
            self.viewer_mode, self.viewer_handoff = None, True

    def test_05d_read_only_viewer_docks_its_panels_for_its_account(self):
        """Secondary panels without obstructing the images: the read-only document mounts the workspace dock for its
        two panels once both are there, keyed by its own account as a writer's dock is ([institution, sub]); a mode re-entry
        mounts it again (the dock adopts the new panels). A writer's dock stays the Tech Note bridge's (not mounted here).
        test_05e measures that the docked panels cover no image cell."""
        recorder = """() => { window.synDocks = []; window.KinViewerWorkspaceDock = (w, p) => { synDocks.push({ owner: p.owner(), allowed: p.allowed(),
          panels: ['kin-viewer-history', 'kin-viewer-layout'].every(id => !!document.getElementById(id)) }); }; }"""
        for account, expected in ((CLINICIAN, 1), (RADIOLOGIST, 0)):
            with self.subTest(roles=account['roles']):
                self.me, self.item_requests, self.cursors = (account, [], {})
                self.open_viewer(before_boot=recorder)
                self.modules_settled()
                self.settle()
                docks = self.page.evaluate('synDocks')
                owner = json.dumps([account['institution'], account['sub']], separators=(',', ':'))
                self.assertEqual([{'owner': owner, 'allowed': True, 'panels': True}] * expected, docks)
                if expected:
                    self.page.evaluate('synReenter()')
                    self.modules_settled()
                    self.wait_until(lambda: len(self.page.evaluate('synDocks')) == 2, 'the dock mounted again at re-entry')
        self.me = CLINICIAN

    def test_05e_docked_panels_cover_no_image_cell(self):
        """The secondary panels stay available without obstructing the images: in a 1366x768 window and a narrow one, with
        the dock at the bottom and at the top, folded and with either panel open, no visible panel or dock row overlaps an
        image cell, and the cells keep their height. The same panels floating (no dock) do overlap (the check bites)."""
        def panels(width, height):
            page = self.context.new_page()
            page.set_viewport_size({'width': width, 'height': height})
            page.set_content(DOCK_PAGE)
            page.add_script_tag(path=str(WORK_CONTEXT))
            page.evaluate("""styles => {
              KinWorkContext.follow({ onLifecycle(listener) { listener({ state: 'active', session: 'SYN' }); } });
              for (const [id, css] of Object.entries(styles)) {
                const p = document.createElement('details'); p.id = id; p.open = true; p.style.cssText = css;
                p.innerHTML = '<summary>' + id + '</summary><p role="status">SYN status</p><p>SYN line one</p><p>SYN line two</p>';
                document.body.append(p);
              } }""", DOCK_PANEL_STYLES)
            return page
        page = panels(1366, 768)
        try:
            self.assertGreater(page.evaluate(DOCK_OVERLAP)['area'], 0)
        finally:
            page.close()
        for width, height in ((1366, 768), (900, 640)):
            for placement in ('bottom', 'top'):
                for shown in (-1, 0, 1):
                    with self.subTest(size=(width, height), placement=placement, panel=shown):
                        page = panels(width, height)
                        try:
                            page.add_script_tag(path=str(DOCK_SOURCE))
                            mounted = page.evaluate("""pref => {
                              const dock = KinViewerWorkspaceDock(window, { owner: () => JSON.stringify(['SYN-INST', 'SYN-CLIN']), allowed: () => true });
                              return !!dock && dock.applyPreference(pref); }""",
                                                    {'version': 2, 'placement': placement, 'panel': shown, 'autoHide': False})
                            self.assertTrue(mounted)
                            page.wait_for_timeout(50)
                            seen = page.evaluate(DOCK_OVERLAP)
                            self.assertEqual(0, seen['area'], seen)
                            self.assertTrue(all(h > 200 for h in seen['cells']), seen)
                        finally:
                            page.close()

    def test_06_states_loading_empty_failed_and_denied(self):
        self.hold_items = {VA}
        self.open_viewer()
        self.wait_until(lambda: self.held_items, 'the held first read')
        seen = self.panel()
        self.assertEqual(('loading', LOADING, ['Refresh'], []), (seen['state'], seen['status'], seen['buttons'], seen['rows']))
        self.hold_items = set()
        self.release(self.held_items.pop()[1], {'items': [], 'nextCursor': None})
        self.assertEqual('empty', self.panel()['state'])
        cases = [(VE, 'empty', RO_EMPTY, ['Refresh']), (VX, 'failed', '저장 항목을 불러오지 못했습니다. 검사를 찾을 수 없습니다 (HTTP 404) Refresh로 다시 읽으세요.', ['Refresh']), (VY, 'failed', '저장 항목을 불러오지 못했습니다. 숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다 (HTTP 400) Refresh로 다시 읽으세요.', ['Refresh']), (VO, 'failed', '저장 항목을 불러오지 못했습니다. 응답 형식을 확인할 수 없습니다. Refresh로 다시 읽으세요.', ['Refresh']), (VZ, 'denied', RO_DENIED, ['Recheck Access'])]
        for target, state, status, buttons in cases:
            with self.subTest(study=target, state=state):
                self.page.evaluate('study => synSwitch(study)', target)
                self.wait_panel(state, target)
                self.settle()
                seen = self.panel()
                self.assertEqual((state, status, buttons, []), (seen['state'], seen['status'], seen['buttons'], seen['rows']))
        # the items of a study whose report is not signed are shown as the server sends them (to a radiologist alike),
        # and a list of two pages is read to its end.
        for target, rows in ((VW, [['Key Image · Saved r1', 'Read-only', 'SYN-W unsigned report key', '프레임 1', 'Go to Image']]),
                             (VQ, [['Key Image · Saved r1', 'Read-only', 'SYN-Q key one', '프레임 1', 'Go to Image'],
                                   ['Key Image · Saved r1', 'Read-only', 'SYN-Q key two', '프레임 1', 'Go to Image']])):
            with self.subTest(study=target, state='ready'):
                self.page.evaluate('study => synSwitch(study)', target)
                seen = self.wait_panel('ready', target)
                self.assertEqual((f'저장 항목 {len(rows)}개 · 읽기 전용', rows), (seen['status'], seen['rows']))
        self.assertEqual(2, len([1 for target, _ in self.reads() if target == VQ]))
        self.items[VE] = HIDDEN_REFUSED
        self.page.evaluate('study => synSwitch(study)', VE)
        self.wait_panel('failed', VE)
        self.assertEqual('저장 항목을 불러오지 못했습니다. 숨긴 표시 항목이나 형식이 잘못된 이어받기 값으로는 조회할 수 없습니다 (HTTP 400) Refresh로 다시 읽으세요.', self.panel()['status'])
        self.items[VE] = {'pages': [[key_item(51, 'SYN-E key')]]}
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        seen = self.wait_panel('ready', VE)
        self.assertEqual([['Key Image · Saved r1', 'Read-only', 'SYN-E key', '프레임 1', 'Go to Image']], seen['rows'])
        self.item_requests, self.cursors = ([], {})

    def test_06b_physician_hand_off_opens_the_named_frame_and_its_mark(self):
        """Clinician Home's Open Annotated Image and a cited line hand the viewer the original image the server named
        (study, series, SOP, frame and the saved item). The read-only viewer opens that frame once its list is drawn and
        highlights that item, says so, and lets the opening hold go (Auto Save View may save the view after it). An item no
        longer in the list, or a series this window does not hold, is said as such. A reload of the tab moves nowhere."""
        entry_note = "() => { const n = document.getElementById('kin-viewer-entry-note'); return n && !n.hidden ? n.textContent : null; }"
        highlighted = "() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.highlighted).map(a => a.data.label)"
        holds = "() => [window.kinViewerOpeningRestore?.holds?.size ?? null, window.kinViewerOpeningRestore?.held ?? null]"
        navigable = f"() => ({NAVIGABLE})({json.dumps([SERIES, SOP])})"
        cases = [
            (item_id(2), SERIES, '요청한 원본 영상(프레임 1)으로 이동했습니다. 표식을 강조했습니다.', ['SYN-A length'], 1),
            (item_id(1), SERIES, '요청한 원본 영상(프레임 1)으로 이동했습니다. 키 이미지입니다.', [], 1),
            (item_id(99), SERIES, '요청한 원본 영상(프레임 1)으로 이동했습니다. 그 표식은 지금 저장 항목에 없습니다(숨김 또는 삭제).', [], 1),
            (item_id(2), '1.2.826.0.1.3680043.10.5432.999', '요청한 원본 영상으로 이동하지 못했습니다. 이 창에서 원본 시리즈를 찾을 수 없습니다.', [], 0),
        ]
        try:
            for item, series, said, lit, moved in cases:
                with self.subTest(item=item, series=series):
                    self.me, self.viewer_mode = CLINICIAN, 'physician'
                    self.viewer_target = {'studyUid': VA, 'seriesUid': series, 'sopUid': SOP, 'frame': 1, 'itemId': item}
                    self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
                    self.open_viewer(before_boot=navigable)
                    self.wait_panel('ready', VA)
                    self.wait_until(lambda: self.page.evaluate(entry_note) is not None, 'the target opened')
                    self.assertEqual(said, self.page.evaluate(entry_note))
                    self.assertEqual(lit, self.page.evaluate(highlighted))
                    self.assertEqual(moved, self.page.evaluate('synIndexed.length'))
                    self.assertEqual([0, 0], self.page.evaluate(holds), 'the opening hold let go')
                    self.assertEqual('read-only', self.session())
                    if moved:
                        # A mode re-entry in the same document does not open the target again (the user's view stays).
                        self.page.evaluate('synReenter()')
                        self.wait_panel('ready', VA)
                        self.settle()
                        self.assertEqual(moved, self.page.evaluate('synIndexed.length'), 'no second move at a mode re-entry')
            # A reload of the tab: no hand-off, so no target and no hold.
            self.viewer_handoff = False
            self.open_viewer(before_boot=navigable)
            self.wait_panel('ready', VA)
            self.settle()
            self.assertEqual((None, [], 0, [None, None]), (self.page.evaluate(entry_note), self.page.evaluate(highlighted),
                                                           self.page.evaluate('synIndexed.length'), self.page.evaluate(holds)))
        finally:
            self.viewer_mode, self.viewer_target, self.viewer_handoff = None, None, True
            self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})

    def test_07_a_b_a_across_the_comparison_study(self):
        old = {'items': [key_item(61, 'SYN-A-OLD')], 'nextCursor': None}
        for name in ('shipped',):
            with self.subTest(file=name):
                self.item_requests, self.cursors, self.held_items = ([], {}, [])
                self.hold_items = {VA}
                self.open_viewer(CONFIG, uncancellable=True)
                self.wait_until(lambda: len(self.held_items) == 1, "A's first read held")
                first = self.held_items[0][1]
                self.page.evaluate('study => synSwitch(study)', VP)
                seen = self.wait_panel('ready', VP)
                self.assertEqual([['Key Image · Saved r1', 'Read-only', 'SYN-P key', '프레임 1', 'Go to Image']], seen['rows'])
                self.page.evaluate('study => synSwitch(study)', VA)
                self.wait_until(lambda: len(self.held_items) == 2, "A's second read held")
                second = self.held_items[1][1]
                self.release(first, old)
                seen = self.panel()
                self.assertEqual(('loading', LOADING, []), (seen['state'], seen['status'], seen['rows']), "A's late first answer does not paint while its newer read is pending")
                self.hold_items = set()
                self.release(second, self.clinician_page(VA, None)['json'])
                seen = self.wait_panel('ready', VA)
                self.assertEqual(['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], [row[2] for row in seen['rows']])
                self.assertNotIn('SYN-A-OLD', str(seen))
                self.assertNotIn('SYN-P', str(seen))

    def attempt_every_authoring_tool(self):
        outcomes = {}
        for name in AUTHORING:
            outcomes[name] = self.page.evaluate("name => {\n              const drag = () => [synDraw('default'), synDraw('mpr')];\n              const seen = { click: synClick(name) }; seen.afterClick = drag();\n              synRun('setToolActiveToolbar', { itemId: name, toolGroupIds: ['default', 'mpr', 'SRToolGroup', 'volume3d'] }); seen.toolbar = drag();\n              synRun('setToolActive', { toolName: name }); seen.hotkey = drag();\n              synGroup('default').setToolActive(name, { bindings: [{ mouseButton: 1 }] }); seen.group = drag();\n              synGroup('default').setToolPassive(name); seen.passive = synModes('default')[name];\n              return seen; }", name)
        return outcomes

    def test_08_native_authoring_paths_are_closed_for_a_clinician(self):
        self.open_viewer()
        self.wait_panel('ready', VA)
        self.wait_until(lambda: self.page.evaluate('synToolbar()')['primary'] == VIEW_SECTION, 'the trimmed toolbar')
        bar = self.page.evaluate('synToolbar()')
        self.assertEqual((VIEW_SECTION, VIEW_MORE, 'Reset'), (bar['primary'], bar['more'], bar['morePrimary']))
        self.assertNotIn('MeasurementTools', bar['buttons'])
        self.assertNotIn('Capture', bar['buttons'])
        self.assertEqual(['missing', []], self.page.evaluate("[synClick('Capture'), synNative.filter(x => x === 'view showDownloadViewportModal')]"))
        for group in ALL_GROUPS:
            with self.subTest(group=group):
                modes = self.page.evaluate('id => synModes(id)', group)
                self.assertEqual({}, {n: m for n, m in modes.items() if m in ('Active', 'Passive') and n not in VIEWING})
        self.assertEqual(['view WindowLevel', 'view WindowLevel'], self.page.evaluate("[synDraw('default'), synDraw('mpr')]"))
        for name, seen in self.attempt_every_authoring_tool().items():
            with self.subTest(tool=name):
                view = ['view WindowLevel', 'view WindowLevel']
                self.assertEqual({'click': 'missing', 'afterClick': view, 'toolbar': view, 'hotkey': view, 'group': view}, {k: v for k, v in seen.items() if k != 'passive'})
                self.assertIn(seen['passive'], ('Enabled', 'Disabled'))
        self.assertEqual(RO_TOOL, self.panel()['status'])
        self.assertEqual(['ran', 'view Zoom', 'ran', 'view StackScroll', 'ran', 'view Crosshairs', 'ran'], self.page.evaluate("() => [synClick('Zoom'), synDraw('default'), synClick('StackScroll'), synDraw('default'), synClick('Crosshairs'),\n                     synDraw('mpr'), synClick('Reset')]"))
        self.page.evaluate("synRun('setToolActive', { toolName: 'WindowLevel' })")
        late = self.page.evaluate("() => { synServices.toolGroupService.createToolGroupAndAddTools('syn-late', {\n            active: [{ toolName: 'WindowLevel', bindings: [{ mouseButton: 1 }] }], passive: [{ toolName: 'Length' }, { toolName: 'ArrowAnnotate' }] });\n          synGroup('syn-late').setToolActive('ArrowAnnotate', { bindings: [{ mouseButton: 1 }] });\n          const created = [synModes('syn-late'), synDraw('syn-late')];\n          SynGroup.prototype.setToolActive.call(synGroup('default'), 'Bidirectional', { bindings: [{ mouseButton: 1 }] });\n          return [...created, synModes('default').Bidirectional, synDraw('default')]; }")
        self.assertEqual([{'WindowLevel': 'Active', 'Length': 'Enabled', 'ArrowAnnotate': 'Enabled'}, 'view WindowLevel', 'Enabled', 'view WindowLevel'], late)
        answers = self.page.evaluate("() => { const answers = [];\n          synRun('showCornerstoneContextMenu', { requireNearbyToolData: true, menuId: 'measurementsContextMenu' });\n          synRun('deleteMeasurement', { uid: 'syn-uid' }); synRun('setMeasurementLabel', { uid: 'syn-uid' });\n          synRun('updateMeasurement', { uid: 'syn-uid', textLabel: 'SYN' });\n          synRun('arrowTextCallback', { callback: text => answers.push(['new', text ?? null]) });\n          synRun('arrowTextCallback', { data: { uid: 'syn-uid' }, callback: text => answers.push(['edit', text ?? null]) });\n          const m = synServices.measurementService;\n          m.update('syn-uid', { label: 'SYN renamed' }, true); m.update('syn-uid', { label: 'synced' }, false); m.toggleLockMeasurement('syn-uid');\n          return answers; }")
        self.assertEqual([['new', None]], answers)
        self.assertEqual([['update', 'syn-uid', False]], self.page.evaluate('synEdits'))
        self.assertEqual(RO_EDIT, self.panel()['status'])
        self.assertEqual(['view resetViewport'], self.page.evaluate('synNative'))
        self.assertEqual([], self.page.evaluate('synMarks()'))
        self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
        self.assertIsNone(AVOIDED.search(RO_EDIT))
        self.me, self.item_requests, self.cursors = (RADIOLOGIST, [], {})
        self.open_viewer()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
        bar = self.page.evaluate('synToolbar()')
        self.assertEqual((PRIMARY_SECTION, MORE_TOOLS), (bar['primary'], bar['more']))
        self.assertEqual(['ran', 'mark ArrowAnnotate'], self.page.evaluate("[synClick('ArrowAnnotate'), synDraw('default')]"))
        self.page.evaluate("() => { synRun('showCornerstoneContextMenu', {}); synRun('setMeasurementLabel', { uid: 'syn-uid' });\n          synServices.measurementService.update('syn-uid', {}, true); }")
        self.assertEqual(['ArrowAnnotate'], self.page.evaluate('synMarks()'))
        self.assertEqual(['add ArrowAnnotate', 'menu', 'label syn-uid'], self.page.evaluate('synNative'))
        self.assertEqual('ran', self.page.evaluate("synClick('Capture')"), 'the writer keeps Capture')
        self.assertEqual('view showDownloadViewportModal', self.page.evaluate('synNative.at(-1)'))
        self.assertEqual([['update', 'syn-uid', True]], self.page.evaluate('synEdits'))
        self.page.evaluate('synClearMarks()')
        self.me, self.item_requests, self.cursors = (CLINICIAN, [], {})

    def test_09_module_gate_waits_for_a_confirmed_writer_and_keeps_clinician_only(self):
        for failure in (500, 503, 'abort', 'bad-json'):
            with self.subTest(every_me=failure):
                self.me, self.me_status, self.me_requests, self.item_requests = (CLINICIAN, failure, 0, [])
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
                self.settle()
                self.assertEqual(([], 'unconfirmed'), (self.page.evaluate('synMounted'), self.note_state()))
        for session, mounted, state in ((RADIOLOGIST, WRITE_MODULES, 'ready'), (CLINICIAN, set(), 'read-only')):
            with self.subTest(later=session['roles'][0]):
                self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (session, 503, 0, [], {})
                self.open_viewer()
                self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
                self.settle()
                self.assertEqual([], self.page.evaluate('synMounted'))
                self.me_status = None
                self.page.evaluate('study => synSwitch(study)', VP)
                self.wait_until(lambda: self.note_state() == state, f'the bridge {state}')
                self.settle()
                self.assertEqual(mounted, set(self.page.evaluate('synMounted')))
        for name, failures in (('shipped', (500, 503, 'abort', 'bad-json')),):
            for failure in failures:
                with self.subTest(file=name, gate=failure):
                    self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (CLINICIAN, None, 0, [], {})
                    self.open_viewer(CONFIG, enter=['kin.viewer-history'])
                    self.wait_panel('ready', VA)
                    self.me_status = failure
                    self.page.evaluate('ids => synEnter(ids)', LATER)
                    self.wait_until(lambda: self.note_state() == 'read-only', 'the bridge read-only')
                    self.wait_until(lambda: self.layout()['summary'] == 'Viewer Status', 'the layout panel status only')
                    self.settle()
                    self.assertEqual(([], []), (self.page.evaluate('synMounted'), self.layout()['buttons']))
        for name in ('shipped',):
            with self.subTest(reenter=name):
                self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (CLINICIAN, None, 0, [], {})
                self.open_viewer(CONFIG)
                self.wait_panel('ready', VA)
                self.modules_settled()
                self.me_status, self.me_requests = (503, 0)
                after = self.page.evaluate("() => { synReenter();\n                  return [synToolbar().primary, Object.entries(synModes('default')).filter(([n, m]) => ['Active', 'Passive'].includes(m)).map(([n]) => n).sort()]; }")
                self.assertEqual([VIEW_SECTION, ['Magnify', 'Pan', 'StackScroll', 'WindowLevel', 'Zoom']], after)
                self.wait_until(lambda: self.me_requests >= 2, "the re-entered panels' /me (the gate asks none)")
                self.settle()
                self.assertEqual(([], 'read-only'), (self.page.evaluate('synMounted'), self.note_state()))
                self.assertEqual(('Viewer Status', []), (self.layout()['summary'], self.layout()['buttons']))
                self.assertFalse(WRITER_CONTROLS & set(self.panel()['buttons']), self.panel()['buttons'])

    def test_10_periodic_and_focus_checks_follow_the_server_list(self):
        """the read-only list is the server's current list. A check (focus, every 15 s) reads it whole again and redraws
        only when an item, its revision or its source verdict changed: an item hidden or deleted leaves the rows and the image,
        a new one appears, an unchanged list is left as drawn."""
        self.open_viewer()
        self.wait_panel('ready', VA)
        self.assertEqual([['Length', 'SYN-A length', True]], self.page.evaluate('synDrawn()'))
        # Unchanged: the rows stay the very same nodes.
        self.page.evaluate("() => { window.synRowsBefore = [...document.querySelectorAll('#kin-viewer-history section[data-item-id]')]; }")
        reads = len(self.reads())
        self.focus()
        self.wait_until(lambda: len(self.reads()) >= reads + 2, 'the whole list read again')
        self.settle()
        self.assertEqual(('ready', 4), (self.panel()['state'], len(self.panel()['rows'])))
        self.assertTrue(self.page.evaluate("() => window.synRowsBefore.every(n => n.isConnected)"), 'an unchanged list is not redrawn')
        # The length hidden by its radiologist: the server's list no longer has it.
        self.items[VA] = {'pages': [[key_item(1, 'SYN-A key', 'SYN-A key note')]]}
        self.focus()
        self.wait_until(lambda: len(self.panel()['rows']) == 1, 'the hidden length taken off')
        self.assertEqual(('저장 항목 1개 · 읽기 전용', []), (self.panel()['status'], self.page.evaluate('synDrawn()')))
        # The same revision whose source the server could not confirm this time: its mark is withdrawn.
        self.items[VA] = {'pages': [[mark_item(2, 'length', 'SYN-A length', revision=2)]]}
        self.focus()
        self.wait_until(lambda: self.page.evaluate('synDrawn()') == [['Length', 'SYN-A length', True]], 'the length back')
        self.items[VA] = {'pages': [[mark_item(2, 'length', 'SYN-A length', status='unverified', revision=2)]]}
        self.focus()
        self.wait_until(lambda: self.page.evaluate('synDrawn()') == [], 'the unverified length withdrawn')
        self.assertEqual([['Length · Saved r2', 'Read-only', 'SYN-A length', '프레임 1', UNVERIFIED, 'Go to Image']], self.panel()['rows'])
        # A check the server refuses (4xx) takes the list down; a check it could not answer (5xx) keeps it.
        self.items[VA] = {'pages': [[key_item(71, 'SYN-A new key')]]}
        self.focus()
        seen = self.wait_until(lambda: [r[2] for r in self.panel()['rows']] == ['SYN-A new key'], 'the new key shown')
        self.items[VA] = (503, {'statusCode': 503, 'message': 'SYN busy'})
        self.focus()
        self.wait_until(lambda: len(self.reads()) and self.reads()[-1] == (VA, {'limit': ['100']}), 'the check asked')
        self.settle()
        self.assertEqual(('ready', ['SYN-A new key']), (self.panel()['state'], [r[2] for r in self.panel()['rows']]))
        self.items[VA] = NOT_FOUND
        self.focus()
        seen = self.wait_panel('failed', VA)
        self.assertEqual(([], []), (seen['rows'], self.page.evaluate('synDrawn()')))
        # A->B->A: A's check answered after the study changed and came back changes nothing.
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
        self.open_viewer(uncancellable=True)
        self.wait_panel('ready', VA)
        self.hold_probes = {VA}
        self.focus()
        self.wait_until(lambda: self.held_probes, "A's check held")
        self.page.evaluate('study => synSwitch(study)', VP)
        self.wait_panel('ready', VP)
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_panel('ready', VA)
        self.release(self.held_probes.pop()[1], {'items': [], 'nextCursor': None})
        seen = self.panel()
        self.assertEqual(('ready', ['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow']), (seen['state'], [row[2] for row in seen['rows']]))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})

    def authoring_closed(self, status, primary=VIEW_SECTION):
        bar = self.page.evaluate('synToolbar()')
        self.assertEqual((primary, VIEW_MORE), (bar['primary'], bar['more']))
        for group in ALL_GROUPS:
            modes = self.page.evaluate('id => synModes(id)', group)
            self.assertEqual({}, {n: m for n, m in modes.items() if m in ('Active', 'Passive') and n not in VIEWING}, group)
        view = ['view WindowLevel', 'view WindowLevel']
        for name, seen in self.attempt_every_authoring_tool().items():
            with self.subTest(tool=name):
                self.assertEqual({'click': 'missing', 'afterClick': view, 'toolbar': view, 'hotkey': view, 'group': view}, {k: v for k, v in seen.items() if k != 'passive'})
                self.assertIn(seen['passive'], ('Enabled', 'Disabled'))
        self.assertEqual(['false', 'false', 'false', 'undefined'], self.page.evaluate("[synAdd('Bidirectional'), synAdd('ArrowAnnotate'), synAdd('SplineROI'), synAddLength()]"))
        self.assertEqual(status, self.panel()['status'])
        self.assertEqual([], self.page.evaluate('synMarks()'))

    def test_11_authoring_waits_for_a_verified_writer(self):
            self.hold_me = True
            self.open_viewer()
            self.wait_until(lambda: len(self.held_me) >= 3, "the panel's, the module gate's and the layout panel's /me held")
            self.assertEqual('unconfirmed', self.session())
            self.authoring_closed(UNCONFIRMED_TOOL)
            self.assertEqual([f'refused: {UNCONFIRMED_SR}'] * 2, [self.page.evaluate('name => synSR(name)', name) for name in ('storeMeasurements', 'downloadReport')])
            self.assertEqual([['new', None]], self.page.evaluate(EDIT_ATTEMPTS))
            self.assertEqual(UNCONFIRMED_EDIT, self.panel()['status'])
            self.assertEqual(([], [['update', 'syn-uid', False]]), (self.page.evaluate('synNative'), self.page.evaluate('synEdits')))
            stray = self.page.evaluate("synRawMark('Bidirectional')")
            self.wait_until(lambda: not self.page.evaluate('uid => synHas(uid)', stray), 'the stray mark removed')
            self.release_me(CLINICIAN)
            self.wait_panel('ready', VA)
            self.assertEqual('read-only', self.session())
            self.assertEqual(([], [['Length', 'SYN-A length', True]]), (self.page.evaluate('synMarks()'), self.page.evaluate('synDrawn()')))
            self.assertEqual(['missing', 'view WindowLevel'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
            for text in (UNCONFIRMED_TOOL, UNCONFIRMED_EDIT, UNCONFIRMED_SR):
                self.assertIsNone(AVOIDED.search(text), text)
            for failure in (500, 503, 'abort', 'bad-json'):
                with self.subTest(every_me=failure):
                    self.me_status, self.me_requests, self.item_requests, self.cursors = (failure, 0, [], {})
                    self.open_viewer()
                    self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
                    self.settle()
                    self.assertEqual('unconfirmed', self.session())
                    self.assertEqual(VIEW_SECTION, self.page.evaluate('synToolbar()')['primary'])
                    self.assertEqual(['missing', 'view WindowLevel', 'view WindowLevel', 'view WindowLevel', 'view WindowLevel'], self.page.evaluate("() => { const seen = [synClick('Bidirectional'), synDraw('default')];\n                                   synRun('setToolActive', { toolName: 'ArrowAnnotate' }); seen.push(synDraw('default'));\n                                   synRun('setToolActiveToolbar', { itemId: 'EllipticalROI', toolGroupIds: ['default', 'mpr'] });\n                                   return [...seen, synDraw('default'), synDraw('mpr')]; }"))
                    self.assertEqual([], self.page.evaluate('synMarks()'))
            self.me, self.me_status, self.me_requests, self.item_requests, self.cursors = (RADIOLOGIST, 503, 0, [], {})
            self.open_viewer()
            self.wait_until(lambda: self.me_requests >= 3, 'every /me asked')
            self.settle()
            self.assertEqual(('unconfirmed', VIEW_SECTION), (self.session(), self.page.evaluate('synToolbar()')['primary']))
            self.me_status = None
            self.focus()
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the writer panel after the focus retry')
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) >= WRITE_MODULES, 'the write modules after the retry')
            self.assertEqual(('writer', PRIMARY_SECTION), (self.session(), self.page.evaluate('synToolbar()')['primary']))
            self.assertEqual(['ran', 'mark Bidirectional'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]"))
            self.me = CLINICIAN
            self.me, self.item_requests, self.cursors = (RADIOLOGIST, [], {})
            self.open_viewer()
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel (no policy)')
            native_bar = self.page.evaluate('synToolbar()')
            native_modes = {group: self.page.evaluate('id => synModes(id)', group) for group in ALL_GROUPS}
            self.assertEqual((PRIMARY_SECTION, MORE_TOOLS), (native_bar['primary'], native_bar['more']))
            self.hold_me, self.me, self.item_requests, self.cursors = (True, CLINICIAN, [], {})
            self.open_viewer()
            self.wait_until(lambda: len(self.held_me) >= 3, 'every /me held')
            self.assertEqual(VIEW_SECTION, self.page.evaluate('synToolbar()')['primary'])
            self.release_me(RADIOLOGIST)
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
            self.assertEqual('writer', self.session())
            self.assertEqual(native_bar, self.page.evaluate('synToolbar()'))
            self.assertEqual(native_modes, {group: self.page.evaluate('id => synModes(id)', group) for group in ALL_GROUPS})
            self.assertEqual(['ran', 'mark Bidirectional', 'true'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default'), synAdd('ArrowAnnotate')]"))
            stray = self.page.evaluate("synRawMark('CircleROI')")
            self.settle()
            self.assertTrue(self.page.evaluate('uid => synHas(uid)', stray), "a writer's local mark stays")
            self.wait_until(lambda: set(self.page.evaluate('synMounted')) >= WRITE_MODULES, 'the write modules mounted')
            self.me_status = 403
            self.focus();self.settle()
            self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
            self.server_end();self.assert_closed()

    def test_12_list_is_rechecked_without_a_source_frame(self):
        self.open_viewer()
        ready = self.wait_panel('ready', VA)['status']
        before = self.probes()
        self.frameless(True)
        self.wait_until(lambda: self.panel()['frame'] == 'unmatched', 'the list marked unmatched')
        self.settle()
        seen = self.panel()
        self.assertEqual(('ready', 4, f'{ready} · {RO_UNMATCHED}'), (seen['state'], len(seen['rows']), seen['status']))
        self.assertEqual(before, self.probes())
        self.items[VA] = {'pages': [[]]}
        self.focus()
        seen = self.wait_panel('empty', VA)
        self.assertEqual(([], f'{RO_EMPTY} · {RO_UNMATCHED}', 'unmatched'), (seen['rows'], seen['status'], seen['frame']))
        self.assertEqual([], self.page.evaluate('synDrawn()'))
        self.items[VA] = {'pages': [[key_item(71, 'SYN-A new key')], [mark_item(72, 'length', 'SYN-A new length')]]}
        reads = len(self.reads())
        self.page.evaluate('synAdvance(16000)')
        seen = self.wait_panel('ready', VA)
        cursor = list(self.cursors)[-1]
        self.assertEqual([(VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], self.reads()[reads:])
        self.assertEqual((['SYN-A new key', 'SYN-A new length'], 'unmatched', []), ([row[2] for row in seen['rows']], seen['frame'], self.page.evaluate('synDrawn()')))
        before = self.probes()
        self.frameless(False)
        self.wait_until(lambda: self.probes() > before and self.panel()['frame'] is None, "the check on the frame's return")
        self.settle()
        seen = self.panel()
        self.assertEqual(('ready', '저장 항목 2개 · 읽기 전용'), (seen['state'], seen['status']))
        self.assertEqual([['Length', 'SYN-A new length', True]], self.page.evaluate('synDrawn()'))
        self.assertIsNone(AVOIDED.search(RO_UNMATCHED))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
        self.open_viewer(uncancellable=True)
        self.wait_panel('ready', VA)
        self.frameless(True)
        self.wait_until(lambda: self.panel()['frame'] == 'unmatched', 'A unmatched')
        self.hold_probes = {VA}
        self.focus()
        self.wait_until(lambda: self.held_probes, "A's frameless check held")
        self.page.evaluate(f"() => {{ window.synFrameless = false; synSwitch('{VP}'); }}")
        self.wait_panel('ready', VP)
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_panel('ready', VA)
        self.release(self.held_probes.pop()[1], {'items': [], 'nextCursor': None})
        seen = self.panel()
        self.assertEqual(('ready', None, ['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow']), (seen['state'], seen['frame'], [row[2] for row in seen['rows']]))
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})

    def test_13_viewer_state_matrix(self):
        for state in ('unconfirmed','read-only','writer','read-only+held'):
            with self.subTest(state=state):
                self.open_state(state)
                seen=self.observe_list();seen.update(self.observe_writes(state));seen.update(self.observe_rechecks(state))
                self.assertEqual(set(VIEWER_STATE_MATRIX),set(seen))
                for row,expected in VIEWER_STATE_MATRIX.items():
                    with self.subTest(row=row):self.assertEqual(expected[STATES.index(state)],seen[row])
        # The five old refused/end rows now share the document boundary: neither viewing,
        # capture nor authoring can survive a real session end, including late writer answers.
        for role in (CLINICIAN,RADIOLOGIST):
            for status,code in ((401,'AUTH_SESSION_ENDED'),(403,'AUTH_SESSION_MISMATCH'),(409,'AUTH_SESSION_MISMATCH')):
                with self.subTest(role=role['user'],code=code,status=status):
                    self.fresh_page();self.me=role;self.me_status=None;self.hold_me=False;self.writer_paged=False
                    self.open_viewer();self.settle();self.server_end(status,code);self.assert_closed()

    def writer_open(self, config=None, hold=(), paged=False):
        self.me, self.me_status, self.list_me, self.writer_paged, self.hold_me, self.held_me = (MIXED, None, None, paged, False, [])
        self.hold_writer, self.held_writer, self.hold_items, self.held_items = (set(hold), [], set(), [])
        self.hold_next, self.held_next, self.accept_writes, self.held_writes, self.writes = (set(), [], False, [], [])
        self.items, self.item_requests, self.cursors, self.me_requests = (copy.deepcopy(ITEMS), [], {}, 0)
        self.open_viewer(config, uncancellable=True, enter=[HISTORY])

    def to_clinician_only(self, ids=None, hold_final=False):
        self.hold_writer, self.me = (set(), MIXED_NOW_CLINICIAN)
        if hold_final:
            self.hold_items = {VA}
        self.page.evaluate('ids => synEnter(ids)', ids or OTHER)
        self.wait_until(lambda: self.session() == 'read-only', 'the clinician-only answer')

    def snapshot(self):
        seen = self.panel()
        return (seen['state'], seen['rows'], self.page.evaluate('synDrawn()'))

    def labels(self):
        return [row[2] for row in self.panel()['rows']]

    def first_reads(self, start):
        return '+'.join((self.kind([request]) for request in self.item_requests[start:] if request[1].get('limit') != ['1'] and 'cursor' not in request[1])) or 'none'

    @staticmethod
    def change_effect(before, after):
        if after[1:] == before[1:]:
            return 'kept'
        return 'taken down' if after[1:] == ([], []) else f'changed {after}'

    def late(self, route, payload, marker):
        before = self.snapshot()
        self.release(route, payload)
        deadline = time.monotonic() + 2
        while marker not in str(self.snapshot()) and time.monotonic() < deadline:
            self.page.wait_for_timeout(50)
        after = self.snapshot()
        return 'shown' if marker in str(after) else 'dropped' if after == before else f'changed {after}'

    def test_14_clinician_only_change_voids_in_flight_writer_reads(self):
        a_labels, a_drawn = (['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], [['Length', 'SYN-A length', True]])
        late = ['SYN LATE WRITER LENGTH', 'SYN LATE WRITER KEY']
        for name in ('shipped',):
            with self.subTest(step='a', file=name):
                self.writer_open(None, hold={(VA, 'first')})
                self.wait_until(lambda: self.held_writer, 'the first author page held')
                self.assertEqual('writer', self.session())
                self.to_clinician_only(LATER, hold_final=True)
                self.wait_until(lambda: self.held_items, 'the final read held')
                self.release(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY))
                seen, drawn = (self.panel(), self.page.evaluate('synDrawn()'))
                self.assertEqual(([], []), (seen['rows'], drawn), 'nothing of the late author page')
                self.assertEqual('loading', seen['state'])
                self.hold_items = set()
                self.release(self.held_items.pop()[1], self.clinician_page(VA, None)['json'])
                seen = self.wait_panel('ready', VA)
                self.assertEqual((a_labels, a_drawn), ([row[2] for row in seen['rows']], self.page.evaluate('synDrawn()')))
                cursor = next(iter(self.cursors))
                self.assertEqual([(VA, {'includeHidden': ['true'], 'limit': ['100']}), (VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], self.reads())
                self.items[VA] = {'pages': [[]]}
                self.focus()
                seen = self.wait_panel('empty', VA)
                self.assertEqual((RO_EMPTY, [], []), (seen['status'], seen['rows'], self.page.evaluate('synDrawn()')))
        with self.subTest(step='c'):
            self.writer_open(hold={(VA, 'first')})
            self.wait_until(lambda: self.held_writer, 'the first author page held')
            self.items[VA] = {'pages': [[]]}
            self.to_clinician_only()
            seen = self.wait_panel('empty', VA)
            self.assertEqual((RO_EMPTY, [], []), (seen['status'], seen['rows'], self.page.evaluate('synDrawn()')))
            self.assertEqual('dropped', self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE'))
            self.items[VA], self.hold_next = (copy.deepcopy(ITEMS[VA]), {VA})
            self.focus()
            self.wait_until(lambda: self.held_next, 'the second page of the check held')
            # The list on screen stays as drawn while its check reads the whole list again.
            self.assertEqual(('empty', [], []), self.snapshot())
            _, cursor, route = self.held_next.pop()
            self.release(route, {'items': 'SYN-not-a-list', 'nextCursor': None})
            seen = self.wait_panel('failed', VA)
            self.assertEqual(([], []), (seen['rows'], self.page.evaluate('synDrawn()')))
            self.hold_next = set()
            self.page.get_by_role('button', name='Refresh', exact=True).click()
            seen = self.wait_panel('ready', VA)
            self.assertEqual((a_labels, a_drawn), ([row[2] for row in seen['rows']], self.page.evaluate('synDrawn()')))
        with self.subTest(step='d: refresh, frameless'):
            self.writer_open(hold={(VA, 'first')})
            self.wait_until(lambda: self.held_writer, 'the first author page held')
            self.release(self.held_writer.pop()[2], author_page(SHOWN_MARK, SHOWN_KEY))
            self.wait_until(lambda: self.page.evaluate('synDrawn()') == [['Length', 'SYN WRITER SHOWN LENGTH', True]], 'the author mark drawn')
            self.frameless(True)
            self.settle()
            self.page.get_by_role('button', name='Refresh', exact=True).click()
            self.wait_until(lambda: self.held_writer, 'the Refresh page held')
            self.to_clinician_only(hold_final=True)
            self.assertEqual(([], []), self.snapshot()[1:], 'rows and marks taken down at once')
            self.wait_until(lambda: self.held_items, 'the final read held')
            self.assertEqual('dropped', self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE'))
            self.hold_items = set()
            self.release(self.held_items.pop()[1], self.clinician_page(VA, None)['json'])
            seen = self.wait_panel('ready', VA)
            self.assertEqual(('unmatched', a_labels, []), (seen['frame'], [row[2] for row in seen['rows']], self.page.evaluate('synDrawn()')))
            before = self.probes()
            self.frameless(False)
            self.wait_until(lambda: self.page.evaluate('synDrawn()') == a_drawn, 'the final mark drawn with the frame back')
            self.assertIsNone(self.panel()['frame'])
            # The frame's return checks the list again (test_12). That check is this clinician-only document's own: it is
            # answered before the next step makes the account a writer, so the harness judges its read by the account it was
            # sent for.
            self.wait_until(lambda: self.probes() > before, "the check on the frame's return")
            self.settle()
            self.assertEqual((a_labels, a_drawn), (self.labels(), self.page.evaluate('synDrawn()')))
        with self.subTest(step='d: a-b-a'):
            self.writer_open(hold={(VA, 'first')})
            self.wait_until(lambda: len(self.held_writer) == 1, "A's first author page held")
            self.page.evaluate('study => synSwitch(study)', VP)
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "B's author list")
            self.page.evaluate('study => synSwitch(study)', VA)
            self.wait_until(lambda: len(self.held_writer) == 2, "A's second author page held")
            self.to_clinician_only()
            self.wait_panel('ready', VA)
            held, self.held_writer = (self.held_writer, [])
            for _, _, route in held:
                self.assertEqual('dropped', self.late(route, author_page(LATE_MARK, LATE_KEY), 'SYN LATE'))
            self.assertEqual((a_labels, a_drawn), (self.labels(), self.page.evaluate('synDrawn()')))

    def test_15_session_change_matrix(self):
        seen = {change: {} for change in SESSION_CHANGES}
        authors = lambda requests: [r for r in requests if r[1].get('includeHidden') == ['true']]
        finals = lambda requests: [r for r in requests if 'includeHidden' not in r[1] and r[1].get('limit') == ['100']]
        offered = lambda buttons: 'none' if not set(buttons) & WRITER_CONTROLS else f'offered {buttons}'
        u = seen['unconfirmed->writer']
        self.me, self.hold_me = (RADIOLOGIST, True)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: len(self.held_me) == 1, "the panel's /me held")
        self.assertEqual('unconfirmed', self.session())
        before, asked, buttons = (self.snapshot(), list(self.item_requests), self.panel()['buttons'])
        start, me_before, self.hold_me = (len(self.item_requests), self.me_requests, False)
        self.page.evaluate('ids => synEnter(ids)', OTHER)
        self.wait_until(lambda: self.session() == 'writer', "the layout panel's writer answer")
        self.settle()
        u['shown_at_change'] = self.change_effect(before, self.snapshot())
        u['reads_by_other_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        self.release(self.held_me.pop(), RADIOLOGIST)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "the author list after the panel's /me")
        u['read_awaiting_me'] = self.first_reads(start)
        u['state_after'] = self.session()
        for row in ('author_first_page', 'author_next_page', 'author_refresh'):
            u[row] = 'none' if not authors(asked) else 'asked'
        u['final_page'] = 'none' if not finals(asked) else 'asked'
        u['write_awaiting_me'] = u['write_sent'] = offered(buttons)
        self.item_requests, self.cursors, self.me_requests = ([], {}, 0)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.settle()
        u['reads_by_own_me'] = ('me+' if self.me_requests > 1 else '') + self.first_reads(0)
        w = seen['writer->read-only']
        self.writer_open(hold={(VA, 'first')})
        self.wait_until(lambda: self.held_writer, 'the first author page held')
        start, me_before = (len(self.item_requests), self.me_requests)
        w['final_page'] = 'none' if not finals(self.item_requests) else 'asked'
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        w['reads_by_other_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        w['author_first_page'] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE')
        w['state_after'] = self.session()
        self.writer_open(hold={(VA, 'next')}, paged=True)
        self.wait_until(lambda: self.held_writer, 'the next author page held')
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        w['author_next_page'] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK), 'SYN LATE')
        self.writer_open(hold={(VA, 'first')})
        self.wait_until(lambda: self.held_writer, 'the first author page held')
        self.release(self.held_writer.pop()[2], author_page(SHOWN_MARK, SHOWN_KEY))
        self.wait_until(lambda: self.page.evaluate('synDrawn()') == [['Length', 'SYN WRITER SHOWN LENGTH', True]], 'the author mark drawn')
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_writer, 'the Refresh page held')
        before = self.snapshot()
        self.to_clinician_only(hold_final=True)
        w['shown_at_change'] = self.change_effect(before, self.snapshot())
        self.wait_until(lambda: self.held_items, 'the final read held')
        w['author_refresh'] = self.late(self.held_writer.pop()[2], author_page(LATE_MARK, LATE_KEY), 'SYN LATE')
        self.hold_items = set()
        self.release(self.held_items.pop()[1], self.clinician_page(VA, None)['json'])
        self.wait_panel('ready', VA)
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.hold_me = True
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_me, 'the Refresh /me held')
        start, self.hold_me = (len(self.item_requests), False)
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        self.release(self.held_me.pop(), MIXED)
        self.settle()
        self.assertEqual(('read-only', 'ready'), (self.session(), self.panel()['state']))
        w['read_awaiting_me'] = self.first_reads(start)
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.hold_me = True
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_me, 'the Refresh /me held')
        start, me_before, self.hold_me, self.me = (len(self.item_requests), self.me_requests, False, MIXED_NOW_CLINICIAN)
        self.release(self.held_me.pop(), MIXED_NOW_CLINICIAN)
        self.wait_panel('ready', VA)
        w['reads_by_own_me'] = ('me+' if self.me_requests > me_before else '') + self.first_reads(start)
        history = self.page.locator('#kin-viewer-history')
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.accept_writes = True
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        self.wait_until(lambda: 'Save' in self.panel()['buttons'], "the new key image's Save")
        self.hold_me = True
        history.get_by_role('button', name='Save', exact=True).click()
        self.wait_until(lambda: self.held_me, "the Save's /me held")
        self.hold_me, self.me = (False, MIXED_NOW_CLINICIAN)
        self.release(self.held_me.pop(), MIXED_NOW_CLINICIAN)
        self.wait_panel('ready', VA)
        self.settle()
        w['write_awaiting_me'] = 'not sent' if not self.writes else f'sent {self.writes}'
        for route in self.held_writes:
            self.release(route, author_page(LATE_WRITE)['items'][0])
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.accept_writes = True
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        self.wait_until(lambda: 'Save' in self.panel()['buttons'], "the new key image's Save")
        history.get_by_role('button', name='Save', exact=True).click()
        self.wait_until(lambda: self.held_writes, 'the Save on the wire')
        self.to_clinician_only()
        self.wait_panel('ready', VA)
        w['write_sent'] = self.late(self.held_writes.pop(), author_page(LATE_WRITE)['items'][0], 'SYN LATE WRITTEN')
        r = seen['read-only->writer']
        self.me, self.list_me, self.hold_items, self.held_items = (CLINICIAN, CLINICIAN, {VA}, [])
        self.item_requests, self.cursors, self.me_requests, self.accept_writes = ([], {}, 0, False)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_until(lambda: self.held_items, 'the final read held')
        self.assertEqual('read-only', self.session())
        me_before, self.me = (self.me_requests, CLINICIAN_NOW_MIXED)
        self.page.evaluate('ids => synEnter(ids)', OTHER)
        self.wait_until(lambda: self.me_requests > me_before, "the layout panel's /me")
        self.settle()
        self.hold_items = set()
        r['final_page'] = self.late(self.held_items.pop()[1], self.clinician_page(VA, None)['json'], 'SYN-A key')
        asked = list(self.item_requests)
        self.me, self.item_requests, self.cursors, self.me_requests = (CLINICIAN, [], {}, 0)
        self.open_viewer(uncancellable=True, enter=[HISTORY])
        self.wait_panel('ready', VA)
        buttons, self.hold_me = (self.panel()['buttons'], True)
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_me, 'the Refresh /me held')
        before, start, me_before = (self.snapshot(), len(self.item_requests), self.me_requests)
        self.me, self.hold_me = (CLINICIAN_NOW_MIXED, False)
        self.page.evaluate('ids => synEnter(ids)', OTHER)
        self.wait_until(lambda: self.me_requests > me_before, "the layout panel's /me")
        self.settle()
        r['shown_at_change'] = self.change_effect(before, self.snapshot())
        r['reads_by_other_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        self.release(self.held_me.pop(), CLINICIAN_NOW_MIXED)
        self.wait_until(lambda: self.first_reads(start) != 'none', "the read after the panel's /me")
        self.wait_panel('ready', VA)
        r['read_awaiting_me'] = self.first_reads(start)
        start, me_before = (len(self.item_requests), self.me_requests)
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.first_reads(start) != 'none', 'the Refresh read')
        self.wait_panel('ready', VA)
        r['reads_by_own_me'] = ('me+' if self.me_requests - me_before > 1 else '') + self.first_reads(start)
        r['state_after'] = self.session()
        asked += self.item_requests
        for row in ('author_first_page', 'author_next_page', 'author_refresh'):
            r[row] = 'none' if not authors(asked) else 'asked'
        r['write_awaiting_me'] = r['write_sent'] = offered(buttons)
        for change in SESSION_CHANGES:
            self.assertEqual(set(SESSION_CHANGE_MATRIX), set(seen[change]), change)
            for row, expected in SESSION_CHANGE_MATRIX.items():
                with self.subTest(change=change, row=row):
                    self.assertEqual(expected[SESSION_CHANGES.index(change)], seen[change][row])

    def hold_writer_work(self, config=None):
        history = self.page.locator('#kin-viewer-history')
        self.writer_open(config)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "A's author list")
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        history.get_by_label('Key Title', exact=True).fill(HELD_TITLE)
        self.page.evaluate('study => synSwitch(study)', VP)
        self.wait_until(lambda: (lambda p: p['uid'] == VP and 'SYN writer key' in str(p['rows']))(self.panel()), "B's author list")
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_until(lambda: (lambda p: p['uid'] == VA and 'Resume Held Work' in p['buttons'])(self.panel()), "A's work held")
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])

    def on_screen(self):
        return self.page.evaluate("() => document.body.innerText + ' ' + [...document.querySelectorAll('input, textarea')].map(e => e.value).join(' ')")

    def list_view(self, item):
        seen, drawn = (self.panel(), self.page.evaluate('synDrawn()'))
        suspended, before = (self.page.evaluate('kinViewerHistoryState().suspended'), self.page.evaluate('synIndexed.length'))
        self.page.locator(f'#kin-viewer-history section[data-item-id="{item}"]').get_by_role('button', name='Go to Image', exact=True).click()
        self.settle()
        clicked = self.page.evaluate('synIndexed.length') > before
        return {'panel': seen, 'drawn': drawn, 'suspended': suspended, 'go_to_image': clicked, 'navigate': self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, item])}

    def refresh_final(self):
        reads = len(self.reads())
        self.page.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: len(self.reads()) >= reads + 2 and self.panel()['state'] == 'ready', 'the Refresh read')
        self.settle()

    def test_16_held_writer_work_never_blocks_the_final_list(self):
        a_labels, length = (['SYN-A key', 'SYN-A length', 'SYN-A angle', 'SYN-A arrow'], item_id(2))
        arrived = {'ok': True, 'highlighted': True, 'annotation': 'shown', 'present': True, 'revision': 2, 'hidden': False, 'working': False}
        unsaved = '() => kinViewerHistoryHasUnsaved()'
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "A's author list")
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        self.to_clinician_only(LATER)
        self.wait_panel('ready', VA)
        clear = self.list_view(length)
        self.assertEqual((a_labels, [['Length', 'SYN-A length', True]], False, True, arrived), ([row[2] for row in clear['panel']['rows']], clear['drawn'], clear['suspended'], clear['go_to_image'], clear['navigate']))
        self.assertEqual(({'Refresh', 'Go to Image'}, [RO_NOTE], 0), (set(clear['panel']['buttons']), clear['panel']['notes'], clear['panel']['inputs']))
        self.assertFalse(self.page.evaluate(unsaved))
        self.fresh_page()
        self.hold_writer_work()
        self.assertEqual(([], True, {'ok': False, 'reason': 'busy'}), (self.page.evaluate('synDrawn()'), self.page.evaluate('kinViewerHistoryState().suspended'), self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None])), "the writer's held-work pause")
        self.to_clinician_only(LATER)
        self.wait_panel('ready', VA)
        self.assertEqual(clear, self.list_view(length))
        self.assertTrue(self.page.evaluate(unsaved))
        for step in ('refresh', 'frame lost and back', 'emptied, then back'):
            with self.subTest(step=step):
                if step == 'refresh':
                    self.refresh_final()
                elif step == 'frame lost and back':
                    self.frameless(True)
                    self.wait_until(lambda: self.panel()['frame'] == 'unmatched', 'the list unmatched')
                    before = self.probes()
                    self.frameless(False)
                    self.wait_until(lambda: self.probes() > before and self.panel()['frame'] is None, "the check on the frame's return")
                    self.settle()
                else:
                    self.items[VA] = {'pages': [[]]}
                    self.focus()
                    seen = self.wait_panel('empty', VA)
                    self.assertEqual((RO_EMPTY, [], [], ['Refresh']), (seen['status'], seen['rows'], self.page.evaluate('synDrawn()'), seen['buttons']))
                    self.items[VA] = copy.deepcopy(ITEMS[VA])
                    self.focus()
                    self.wait_panel('ready', VA)
                    self.settle()
                self.assertEqual(clear, self.list_view(length))
                self.assertNotIn(HELD_TITLE, self.on_screen())
                self.assertNotIn('Unsaved', str(self.panel()['rows']))
                self.assertTrue(self.page.evaluate(unsaved))
        self.fresh_page()
        self.hold_writer_work()
        history = self.page.locator('#kin-viewer-history')
        history.get_by_role('button', name='Resume Held Work', exact=True).click()
        self.wait_until(lambda: 'Key Image · Unsaved' in str(self.panel()['rows']), 'the held key image resumed')
        resumed = self.panel()['rows']
        self.assertEqual(HELD_TITLE, history.get_by_label('Key Title', exact=True).input_value())
        self.assertFalse({'Resume Held Work', 'Discard Held Work'} & set(self.panel()['buttons']))
        self.fresh_page()

    def refusal_then_late_writers(self, refuser, status, config=None, late_bodies=False):
        self.me, self.me_status, self.hold_me, self.held_me = (RADIOLOGIST, None, True, [])
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = ([], {}, 0, False)
        self.open_viewer(config, uncancellable=True, enter=[HISTORY], before_boot=SLOW_ME_BODIES if late_bodies else None)
        producers = {}
        for name, ids in (('panel', []), ('gate', GATES), ('layout', [LAYOUT_ID])):
            if ids:
                self.page.evaluate('ids => synEnter(ids)', ids)
            self.wait_until(lambda: len(self.held_me) > len(producers), f"the {name}'s /me held")
            producers[name] = self.held_me[-1]
        self.assertEqual((3, 'unconfirmed'), (len(self.held_me), self.session()))
        self.hold_me, self.held_me = (False, [])
        writers = [route for name, route in producers.items() if name != refuser]
        if late_bodies:
            for route in writers:
                self.release(route, RADIOLOGIST)
            self.assertEqual('unconfirmed', self.session(), 'the writer answers are in, their bodies are not')
        self.release(producers[refuser], {'statusCode': status, 'message': 'SYN refused'}, status=status)
        self.wait_until(lambda: self.session() == 'refused', 'the refusal')
        if late_bodies:
            self.page.evaluate('() => window.synBodies.forEach(release => release())')
            self.settle()
        else:
            for route in writers:
                self.release(route, RADIOLOGIST)

    def writer_document(self, config=None):
        self.me, self.me_status, self.hold_me, self.held_me = (RADIOLOGIST, None, False, [])
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = ([], {}, 0, False)
        self.open_viewer(config, uncancellable=True)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the writer panel')
        self.wait_until(lambda: set(self.page.evaluate('synMounted')) == MODULES, 'every module mounted')
        self.wait_until(lambda: any((not disabled for _, disabled in self.layout()['buttons'])), 'the layout buttons')
        self.assertEqual(('writer', ['ran', 'mark Bidirectional']), (self.session(), self.page.evaluate("[synClick('Bidirectional'), synDraw('default')]")))

    def layout_status(self):
        return self.page.evaluate("() => document.querySelector('#kin-viewer-layout-status').textContent")


    def test_17_plain_failures_preserve_the_document_and_only_session_codes_end_it(self):
        self.writer_document()
        for status in (401,403,409,428,500):
            self.page.route(ORIGIN+'/api/syn-failure',lambda route:route.fulfill(status=status,json={'message':'SYN failure'}))
            self.page.evaluate("fetch('/api/syn-failure').then(r=>r.status)")
            self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
            self.assertEqual('writer',self.session())
        self.hold_writer={(VP,'first')};self.page.evaluate('uid=>synSwitch(uid)',VP)
        self.wait_until(lambda:bool(self.held_writer),'late item read')
        self.server_end();self.assert_closed()
        for _,_,route in self.held_writer:
            try:route.fulfill(json=author_page(LATE_MARK,LATE_KEY))
            except Exception:pass
        self.assert_closed()

    def layout_sees_account_change(self, via, account, config=None):
        self.writer_document(config)
        self.hold_me = True
        self.focus()
        self.wait_until(lambda: len(self.held_me) == 1, "the Measurements panel's /me asked on focus, held")
        held, self.hold_me, self.held_me, self.me = (self.held_me[0], False, [], account)
        asked = self.me_requests
        if via == 'save':
            self.page.evaluate("() => [...document.querySelectorAll('#kin-viewer-layout button')]\n              .find(b => b.textContent === 'Save Recent Layout').click()")
            self.wait_until(lambda: self.me_requests > asked and self.layout_status() != LAYOUT_CHECKING, "Save Recent Layout's /me answered")
            outcome = self.layout_status()
        else:
            self.page.evaluate("() => { window.synHpOutcome = null;\n              synHpAccess({ signal: new AbortController().signal }).then(() => 'ok', error => error.message)\n                .then(outcome => { window.synHpOutcome = outcome; }); }")
            self.wait_until(lambda: self.page.evaluate('window.synHpOutcome') is not None, "the editor's access check answered")
            outcome = self.page.evaluate('window.synHpOutcome')
        self.settle()
        return (held, outcome)


    def test_18_layout_binding_mismatch_ends_the_document_before_held_panel_answers(self):
        for via in ('save', 'hanging-protocol', 'measurements'):
            with self.subTest(via=via):
                self.fresh_page();self.writer_document();self.hold_me=True
                self.focus();self.wait_until(lambda:bool(self.held_me),'held Measurements check')
                first=self.held_me.pop()
                if via=='save':self.page.get_by_role('button',name='Save Recent Layout',exact=True).click()
                elif via=='hanging-protocol':self.page.evaluate("void synHpAccess({signal:new AbortController().signal}).catch(()=>{})")
                else:self.focus()
                if via=='measurements':route=first;first=None
                else:self.wait_until(lambda:bool(self.held_me),'layout account check');route=self.held_me.pop()
                route.fulfill(status=409,headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'},json={'code':'AUTH_SESSION_MISMATCH'})
                self.assert_closed()
                if first:first.fulfill(json=RADIOLOGIST)
                self.assert_closed()
                self.assertEqual([],self.ended_value("Object.keys(localStorage).filter(key=>key.startsWith('kin-viewer-layout'))"))

    def read_only_document(self, config=None):
        self.me, self.me_status, self.hold_me, self.held_me = (CLINICIAN, None, False, [])
        self.items, self.item_requests, self.cursors = (copy.deepcopy(ITEMS), [], {})
        self.me_requests, self.writer_paged = (0, False)
        self.open_viewer(config)
        self.wait_panel('ready', VA)
        self.modules_settled()
        self.wait_until(lambda: self.layout()['summary'] == 'Viewer Status', "the layout panel's status line")
        self.assertEqual(('read-only', [['Length', 'SYN-A length', True]], []), (self.session(), self.page.evaluate('synDrawn()'), self.page.evaluate('synMounted')))


    def history_state(self):
        return self.page.evaluate('() => { const s = kinViewerHistoryState(); return {subject: s.subject, ended: s.ended}; }')


    def test_19_binding_mismatch_on_reentry_and_later_panels_never_adopts_the_other_account(self):
        for producer in ('reentry','layout','modules'):
            with self.subTest(producer=producer):
                self.fresh_page();self.me=RADIOLOGIST;self.me_status=None;self.hold_me=False
                self.open_viewer(enter=[HISTORY]);self.wait_until(lambda:bool(self.panel()['rows']),'writer history')
                self.hold_me=True
                if producer=='reentry':self.page.evaluate('synReenter()')
                else:self.page.evaluate('ids=>synEnter(ids)',[LAYOUT_ID] if producer=='layout' else GATES)
                self.wait_until(lambda:bool(self.held_me),'later producer account check')
                self.held_me.pop().fulfill(status=403,headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'},json=OTHER_WRITER)
                self.assert_closed()
                self.assertEqual('SYN-SESSION-'+RADIOLOGIST['sub'],self.ended_value('KinWorkContext.session()'))


    def test_20_read_only_end_remains_closed_after_reload(self):
        self.read_only_document();self.server_end();self.assert_closed()
        before=len(self.entry_reads)
        self.viewer_page=True
        # A reload has history binding, not a fresh clinician handoff.
        self.page.route(VIEWER_URL,lambda route:route.fulfill(body=VIEWER_HARNESS,content_type='text/html'))
        self.held_navigation.clear()
        self.page.goto(VIEWER_URL)
        self.page.evaluate("void kinCreateSessionBoundary().preRegistration()")
        self.assert_closed();self.assertEqual(before,len(self.entry_reads))

    def test_21_the_same_account_re_entering_is_not_an_end(self):
        self.writer_document()
        self.page.evaluate('synClearMarks()')
        asked, reads = (self.me_requests, len(self.reads()))
        self.page.evaluate('synReenter()')
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']) and Counter(self.page.evaluate('synMounted')) == Counter({m: 2 for m in MODULES}) and (self.layout()['buttons'] == [[n, False] for n in LAYOUT_BUTTONS + ['Save to Account']]), 'the writer document back after the re-entry')
        self.settle()
        self.assertEqual(('writer', 3, [(VA, {'includeHidden': ['true'], 'limit': ['100']})], 'ready', PRIMARY_SECTION, {'subject': RADIOLOGIST['sub'], 'ended': False}), (self.session(), self.me_requests - asked, self.reads()[reads:], self.note_state(), self.page.evaluate('synToolbar()')['primary'], self.history_state()))
        self.assertEqual(['ran', 'mark Bidirectional', 'true'], self.page.evaluate("[synClick('Bidirectional'), synDraw('default'), synAdd('ArrowAnnotate')]"))
        self.page.evaluate('synClearMarks()')
        self.fresh_page()
        self.read_only_document()
        asked, reads, cursors = (self.me_requests, len(self.reads()), len(self.cursors))
        self.page.evaluate('synReenter()')
        self.wait_panel('ready', VA)
        self.modules_settled()
        self.wait_until(lambda: self.layout()['summary'] == 'Viewer Status', "the layout panel's status line after the re-entry")
        self.settle()
        cursor = list(self.cursors)[cursors]
        self.assertEqual(('read-only', 2, [(VA, {'limit': ['100']}), (VA, {'limit': ['100'], 'cursor': [cursor]})], [['Length', 'SYN-A length', True]], [], 'read-only', {'subject': CLINICIAN['sub'], 'ended': False}), (self.session(), self.me_requests - asked, self.reads()[reads:], self.page.evaluate('synDrawn()'), self.page.evaluate('synMounted'), self.note_state(), self.history_state()))
        self.fresh_page()
        self.hold_writer_work()
        self.to_clinician_only(LATER)
        self.wait_panel('ready', VA)
        self.page.evaluate('synReenter()')
        self.wait_panel('ready', VA)
        self.settle()
        self.page.evaluate(NAVIGABLE, [SERIES, SOP])
        self.assertEqual(('read-only', [['Length', 'SYN-A length', True]], True, {'subject': MIXED_NOW_CLINICIAN['sub'], 'ended': False}), (self.session(), self.page.evaluate('synDrawn()'), self.page.evaluate(NAVIGATE, [VA, SERIES, SOP, None]).get('ok'), self.history_state()))

    def serve_real(self, module):
        self.files = dict(SHIPPED)
        for name in REAL_MODULES[module]:
            self.files[name] = lf_text(HPACS / name)
        self.real_api, self.module_requests, self.module_status = (True, [], {})
        return REAL_NOTE_DEPS if module == 'tech-note' else None

    def text_of(self, selector):
        return self.page.evaluate('s => document.querySelector(s)?.textContent ?? null', selector)

    def control_enabled(self, module):
        return self.page.evaluate("label => [...document.querySelectorAll('button')].some(b => b.textContent === label && !b.disabled)", MODULE_CONTROL[module])

    def module_ready(self, module):
        selector, ready = MODULE_READY[module]
        self.wait_until(lambda: ready in (self.text_of(selector) or '') and self.control_enabled(module), f'the real {module} working')




    def real_writer_document(self, module, config=None, files=None):
        before_boot = self.serve_real(module)
        self.files.update(files or {})
        self.me, self.me_status, self.hold_me, self.held_me = (RADIOLOGIST, None, False, [])
        self.item_requests, self.cursors, self.me_requests, self.writer_paged = ([], {}, 0, False)
        self.open_viewer(config, uncancellable=True, before_boot=before_boot)
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the writer panel')
        self.wait_until(lambda: any((not disabled for _, disabled in self.layout()['buttons'])), 'the layout buttons')
        self.module_ready(module)
        if module == 'findings':
            self.wait_until(lambda: '연결할 수 있는 저장 표식' in (self.text_of('#kin-viewer-findings-comparison') or ''), "the Findings store's comparison read")

    def module_recheck(self, module):
        self.hold_me = True
        self.page.evaluate(MODULE_RECHECK[module])
        header = MODULE_ME_HEADER[module]
        self.wait_until(lambda: any((header in route.request.headers for route in self.held_me)), f"the real {module}'s recheck /me held")
        own = next((route for route in self.held_me if header in route.request.headers))
        self.held_me.remove(own)
        return own

    def release_held(self, answer):
        held, self.held_me, self.hold_me = (self.held_me, [], False)
        for route in held:
            self.release(route, answer)

    def test_22_each_real_write_module_observes_bound_checks_and_real_session_end(self):
        for module in ('jobs','findings','tech-note'):
            with self.subTest(module=module):
                self.fresh_page();self.real_writer_document(module)
                for status in (401,403,500):
                    own=self.module_recheck(module)
                    self.release(own,{'message':'SYN local failure'},status=status)
                    self.release_held(RADIOLOGIST);self.settle()
                    self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
                    own=self.module_recheck(module)
                    self.release(own,RADIOLOGIST);self.release_held(RADIOLOGIST)
                    self.module_ready(module)
                own=self.module_recheck(module)
                own.fulfill(status=401,headers={'X-KIN-Auth-Code':'AUTH_SESSION_ENDED'},json={'code':'AUTH_SESSION_ENDED'})
                self.assert_closed()
                self.release_held(RADIOLOGIST);self.assert_closed()
            with self.subTest(first_me=module):
                self.fresh_page();before=self.serve_real(module);self.me=RADIOLOGIST;self.hold_me=False
                self.open_viewer(uncancellable=True,enter=[HISTORY,LAYOUT_ID],before_boot=before)
                self.wait_until(lambda:bool(self.panel()['rows']),'confirmed first account')
                self.hold_me=True;self.page.evaluate('ids=>synEnter(ids)',GATES)
                self.wait_until(lambda:bool(self.held_me),'module gate check')
                self.release(self.held_me.pop(),RADIOLOGIST)
                self.wait_until(lambda:len(self.held_me)==1,'real module first check')
                own=self.held_me.pop()
                own.fulfill(status=409,headers={'X-KIN-Auth-Code':'AUTH_SESSION_MISMATCH'},json=OTHER_WRITER)
                self.assert_closed();self.release_held(RADIOLOGIST);self.assert_closed()

    def test_23_scoped_logout_while_extensions_are_down_closes_the_document(self):
        for account in (CLINICIAN,RADIOLOGIST):
            for kind in ('broadcast','storage'):
                with self.subTest(account=account['user'],kind=kind):
                    self.fresh_page();self.me=account;self.me_status=None;self.hold_me=False
                    self.open_viewer();self.settle();self.page.evaluate('synLeave()')
                    self.notice('SYN-OTHER',kind);self.settle()
                    self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
                    self.notice('SYN-SESSION-'+account['sub'],kind);self.assert_closed()

    def api_paths(self, start):
        paths = []
        for request in self.finished[start:]:
            url = urlparse(request.url)
            if url.path.startswith('/api/'):
                paths.append(url.path + (f'?{url.query}' if url.query else ''))
        return paths

    def ct_sync_document(self, uncancellable=False, checked=True):
        self.viewer_page = True
        self.page.goto(VIEWER_URL)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        self.bootstrap=True
        self.page.evaluate('kinCreateSessionBoundary().preRegistration()')
        self.bootstrap=False
        self.page.evaluate(END_REASONS)
        if uncancellable:
            self.page.evaluate('() => { const real = window.fetch.bind(window);\n              window.fetch = (url, options = {}) => { const { signal, ...rest } = options; return real(url, rest); }; }')
        start = len(self.finished)
        self.page.evaluate(CT_SYNC_BOOT, [VA, VP])
        self.observe_document()
        if not checked:
            return None
        self.wait_until(lambda: len(self.api_paths(start)) >= 3, 'the CT sync access check')
        self.settle()
        return self.api_paths(start)

    def test_24_clinician_ct_sync_uses_narrow_scope_and_recovers_plain_failures(self):
        self.ct_pair()
        self.assertEqual(['/api/me','/api/clinician/studies?limit=100','/api/me'],self.ct_sync_document())
        self.page.evaluate("synCt.scroll('syn-ct-a',4)")
        self.wait_until(lambda:self.page.evaluate("synCt.z('syn-ct-b')")==8,'synced prior')
        for status in (401,403,500):
            self.page.evaluate('synCt.exit()');self.me_status=status;self.page.evaluate("synCt.enter();synCt.scroll('syn-ct-a',6)")
            self.wait_until(lambda:(self.page.evaluate('synCt.notice()') or {}).get('recheck'),'retryable access failure')
            self.assertFalse(self.page.evaluate('KinViewerSessionBoundary.ended()'))
            hit=self.page.evaluate(CT_SYNC_HIT);self.assertTrue(hit['button']);self.assertTrue(hit['words_pass'])
            self.assertGreaterEqual(hit['height'],24);self.assertGreaterEqual(hit['font'],12)
            self.me_status=None;self.page.locator('#kin-ct-sync-recheck').click()
            self.wait_until(lambda:self.page.evaluate('synCt.notice()')['text']==CT_SYNC_TEXT['confirmed'],'access recovered')
        self.server_end();self.assert_closed()
        self.fresh_page();self.me=RADIOLOGIST;self.me_status=None
        self.page.route(ORIGIN+'/api/studies',lambda route:route.fulfill(json={'studies':self.rows,'observedAt':'2026-10-05T00:00:00Z'}))
        self.assertEqual(['/api/me','/api/studies','/api/me'],self.ct_sync_document())
        self.page.evaluate("synCt.scroll('syn-ct-a',4)")
        self.wait_until(lambda:self.page.evaluate("synCt.z('syn-ct-b')")==8,'writer sync uses the full list')

    def test_25_ct_sync_end_during_image_decode_never_moves_the_prior(self):
        for status,code in ((401,'AUTH_SESSION_ENDED'),(403,'AUTH_SESSION_MISMATCH'),(409,'AUTH_SESSION_MISMATCH')):
            with self.subTest(status=status):
                self.fresh_page();self.ct_pair();self.ct_sync_document();self.page.evaluate(CT_SYNC_HOLD_IMAGES)
                self.page.evaluate("synCt.scroll('syn-ct-a',4)")
                self.wait_until(lambda:self.page.evaluate('synCtImages.length')==1,'pending image decode')
                self.server_end(status,code);self.assert_closed()
                self.ended_value('('+CT_SYNC_RELEASE_IMAGES+')()');self.settle()
                self.assertEqual(0,self.ended_value("synCt.z('syn-ct-b')"));self.assert_closed()



    def test_26_late_auth_code_after_mode_exit_still_ends_the_document(self):
        for producer in ('ct','measurements','layout'):
            for status,code in ((401,'AUTH_SESSION_ENDED'),(409,'AUTH_SESSION_MISMATCH')):
                with self.subTest(producer=producer,status=status):
                    self.fresh_page();self.me_status=None;self.hold_me=False
                    if producer=='ct':
                        self.ct_pair();self.ct_sync_document(uncancellable=True)
                        self.hold_me=True;self.page.evaluate("synCt.scroll('syn-ct-a',4)")
                    else:
                        self.writer_document();self.hold_me=True
                        if producer=='measurements':self.focus()
                        else:self.page.get_by_role('button',name='Save Recent Layout',exact=True).click()
                    self.wait_until(lambda:bool(self.held_me),'pending account check')
                    route=self.held_me.pop();self.page.evaluate('synCt.exit()' if producer=='ct' else 'synLeave()')
                    route.fulfill(status=status,headers={'X-KIN-Auth-Code':code},json={'code':code})
                    self.assert_closed()


    def test_27_findings_late_end_code_closes_ct_sync_and_all_other_panels(self):
        self.ct_pair();self.real_writer_document('findings')
        self.page.route(ORIGIN+'/api/studies',lambda route:route.fulfill(json={'studies':self.rows,'observedAt':'2026-10-05T00:00:00Z'}))
        self.page.evaluate(CT_SYNC_BESIDE_PANELS,[VA,VP]);self.settle()
        own=self.module_recheck('findings');self.release_held(RADIOLOGIST)
        self.page.evaluate('uid=>synSwitch(uid)',VE);self.settle()
        own.fulfill(status=401,headers={'X-KIN-Auth-Code':'AUTH_SESSION_ENDED'},json={'code':'AUTH_SESSION_ENDED'})
        self.assert_closed()

    def test_28_capture_is_offered_to_a_confirmed_writer_only(self):

            def capture():
                return self.page.evaluate("() => { const from = synNative.length, offered = synToolbar().primary.includes('Capture');\n              return [offered, synClick('Capture'), synNative.slice(from).filter(x => x === 'view showDownloadViewportModal').length]; }")
            self.hold_me = True
            self.open_viewer()
            self.wait_until(lambda: len(self.held_me) >= 3, 'every /me held')
            self.assertEqual(('unconfirmed', VIEW_SECTION, [False, 'missing', 0]), (self.session(), self.page.evaluate('synToolbar()')['primary'], capture()))
            self.release_me(RADIOLOGIST)
            self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'writer panel')
            self.assertEqual(('writer', PRIMARY_SECTION), (self.session(), self.page.evaluate('synToolbar()')['primary']))
            self.assertEqual([True, 'ran', 1], capture())
            self.page.evaluate(EXTRA_BUTTONS)
            self.assertEqual([['SYN-Download', 'SYN-Reset'], 'ran', 'ran', ['view showDownloadViewportModal', 'view resetViewport']], self.page.evaluate(EXTRA_PRESSED))
            self.me, self.item_requests, self.cursors = (CLINICIAN, [], {})
            self.open_viewer()
            self.wait_panel('ready', VA)
            self.wait_until(lambda: self.page.evaluate('synToolbar()')['primary'] == VIEW_SECTION, 'the trimmed toolbar')
            self.assertEqual([False, 'missing', 0], capture())
            self.assertEqual(VIEW_SECTION, self.page.evaluate('() => { synReenter(); return synToolbar().primary; }'))
            self.wait_panel('ready', VA)
            self.settle()
            self.assertEqual([False, 'missing', 0], capture())
            self.page.evaluate(EXTRA_BUTTONS)
            self.assertEqual([['SYN-Reset'], 'missing', 'ran', ['view resetViewport']], self.page.evaluate(EXTRA_PRESSED))
            self.server_end();self.assert_closed()
            self.fresh_page();self.writer_document();self.server_end();self.assert_closed()

    def observe_document(self):
        # The child observes the retained viewer while its landing navigation is held.
        # The viewer itself still has no opener, as in the clinician handoff.
        with self.page.expect_popup() as opened:
            self.page.evaluate("() => { window.open('/harness/observer'); }")
        self.observer = opened.value
        self.observer.wait_for_load_state()

    def ended_value(self, expression):
        return self.observer.evaluate("() => window.opener.eval(" + json.dumps(expression) + ")")

    def server_end(self,status=401,code='AUTH_SESSION_ENDED'):
        self.page.route(ORIGIN+'/api/syn-end',lambda route:route.fulfill(status=status,headers={'X-KIN-Auth-Code':code},json={'code':code}))
        self.page.evaluate("void fetch('/api/syn-end').catch(()=>{})")

    def assert_closed(self):
        self.wait_until(lambda:bool(self.held_navigation),'landing navigation')
        self.wait_until(lambda:self.ended_value('KinViewerSessionBoundary.ended()'),'document ended')
        self.settle()
        self.assertEqual(0,self.ended_value('document.body.children.length'))
        before=len(self.finished)
        self.ended_value("void fetch('/api/should-not-leave',{method:'POST',body:'{}'}).catch(()=>{})")
        self.settle();self.assertEqual(before,len(self.finished))

    def unsaved_work(self):
        """What the viewer document tells Log out (S7-U5 A006): the kinds its `kin-unsaved:` lock declares now, and its
        answer to the session's unsaved-work question."""
        return self.page.evaluate("""async () => {
          const session = KinWorkContext.session(), prefix = 'kin-unsaved:' + session + ':';
          const held = (await navigator.locks.query()).held.map(lock => lock.name).filter(name => name.startsWith(prefix))
            .map(name => name.split(':').pop()).sort();
          const answers = await new Promise(done => {
            const query = crypto.randomUUID(), seen = [], channel = new BroadcastChannel('kin-session');
            channel.onmessage = event => { if (event.data?.type === 'session-work' && event.data.query === query) seen.push(event.data.unsaved); };
            channel.postMessage({ type: 'session-work-query', session, query });
            setTimeout(() => { channel.close(); done(seen); }, 300);
          });
          return [held, answers]; }""")

    def test_29_log_out_asks_about_a_job_save_that_is_out_but_not_about_a_job_restore(self):
        """S7-U5 A006 / review DR-F04 (commander's decision): with the shipped Job panel, a restore in progress is not
        unsaved work - nothing is declared and Log out's question is answered with nothing; a Job save whose answer has
        not come is declared as `jobs` until the save is confirmed."""
        row = {'id': 'syn-job-1', 'revision': 1, 'title': 'SYN saved job', 'description': 'SYN description', 'hidden': False,
               'authorActor': 'syn-radiologist', 'authorSub': RADIOLOGIST['sub'], 'createdAt': '2026-10-05T00:00:00.000Z',
               'snapshotVersion': 2}
        held_saves = []
        def jobs(route):
            path = urlparse(route.request.url).path
            if route.request.method == 'POST':
                return held_saves.append(route)
            if path.endswith('/viewer-jobs'):
                return route.fulfill(json={'jobs': [row]})
            route.fulfill(status=404, json={'statusCode': 404, 'message': 'SYN job unavailable'})
        self.real_writer_document('jobs')
        self.page.route('**/api/studies/*/viewer-jobs**', jobs)
        self.page.get_by_role('button', name='Refresh Jobs', exact=True).click()
        self.wait_until(lambda: self.page.get_by_role('button', name='Restore Job', exact=True).count() == 1, 'the listed Job')
        self.settle()
        self.assertEqual([[], [[]]], self.unsaved_work())
        # Restore Job: the panel is busy with the restore (its account check held). Not unsaved work.
        self.hold_me = True
        self.page.get_by_role('button', name='Restore Job', exact=True).click()
        self.wait_until(lambda: any('x-kin-subject' in route.request.headers for route in self.held_me), "the restore's /me held")
        self.page.wait_for_timeout(700)
        self.assertEqual([[], [[]]], self.unsaved_work(), 'a Job restore in progress would be asked about at Log out')
        self.release_held(RADIOLOGIST)
        self.wait_until(lambda: 'SYN job unavailable' in (self.text_of('#kin-viewer-jobs-status') or '')
                        or '복원' in (self.text_of('#kin-viewer-jobs-status') or ''), 'the restore finished')
        self.settle()
        # Save Changes of the Job's details: declared while its answer is out, withdrawn when the save is confirmed.
        self.page.get_by_role('button', name='Edit Details', exact=True).click()
        self.page.get_by_role('button', name='Save Changes', exact=True).click()
        self.wait_until(lambda: held_saves, 'the Job save sent')
        self.wait_until(lambda: self.unsaved_work()[0] == ['jobs'], 'the Job save that is out declared')
        self.assertEqual([['jobs']], self.unsaved_work()[1])
        # The revision receipt is the API summary (viewer-job.service.ts revise): it names this Job's study.
        saved = held_saves.pop()
        saved.fulfill(json={'id': row['id'], 'studyUid': unquote(urlparse(saved.request.url).path.split('/')[3]), 'revision': 2})
        self.wait_until(lambda: self.unsaved_work() == [[], [[]]], 'the confirmed Job save withdrawn')

    def test_30_an_unfinished_drawing_is_not_judged_and_ends_cleanly_when_access_is_refused(self):
        """A measuring tool holds a new mark as a drawing until it is ended. While it is one, a shape stretched one way only
        gives no reason text; a refusal of access that arrives during a drawing ends it, closes authoring and offers the
        recheck, though the pinned deselection raises for a mark that is already gone."""
        drawing_tools = r'''() => {
          const meta = {Modality: 'CT', SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', PixelSpacing: [1, 1], ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
            ImagePositionPatient: [0, 0, 0], FrameOfReferenceUID: 'SYN-FOR', Rows: 128, Columns: 128, RescaleSlope: 1, RescaleIntercept: 0, RescaleType: 'HU'};
          cornerstone.metaData.get = type => type === 'instance' ? meta : {rowPixelSpacing: 1, columnPixelSpacing: 1};
          cornerstoneTools.annotation.selection.setAnnotationSelected = (uid, on = true) => {
            const a = cornerstoneTools.annotation.state.getAnnotation(uid);
            if (!a) throw new TypeError("Cannot set properties of undefined (setting 'isSelected')");
            a.isSelected = on; };
          window.synInteracting = false;
          const drawingTool = (name, count, configuration) => ({ mode: 'Active', configuration,
            addNewAnnotation() {
              const a = {annotationUID: 'syn-drawing-' + name, metadata: {toolName: name, referencedImageId: synImage()},
                data: {handles: {points: Array.from({length: count}, () => [20, 20, 0])}, cachedStats: {}}};
              cornerstoneTools.annotation.state.addAnnotation(a);
              this.editData = {annotation: a, newAnnotation: true}; this.isDrawing = true; synInteracting = true; return a; },
            cancel() { this.editData = null; this.isDrawing = false; synInteracting = false; } });
          synTools.Length = drawingTool('Length', 2, {getTextLines: () => []});
          synTools.EllipticalROI = drawingTool('EllipticalROI', 4,
            {statsCalculator: {statsCallback() {}, getStatistics: () => ({array: []})}, getTextLines: () => []});
        }'''
        press = '''name => { const a = synTools[name].addNewAnnotation({detail: {element: cornerstone.getEnabledElement().viewport.element}});
          cornerstoneTools.annotation.selection.setAnnotationSelected(a.annotationUID); return a.annotationUID; }'''
        denied = []
        served = self.viewer_items
        def items(route, target, query):
            if denied:
                route.fulfill(status=403, json={'code': 'STUDY_ACCESS_DENIED', 'message': 'synthetic study denial'})
            else:
                served(route, target, query)
        self.viewer_items = items
        self.me = RADIOLOGIST
        self.open_viewer(before_boot=drawing_tools)
        self.wait_until(lambda: 'Length' in self.panel()['buttons'], 'writer controls')
        # An ellipse stretched one way only is still being drawn: no reason text until it is finished. Escape ends it.
        self.assertEqual('syn-drawing-EllipticalROI', self.page.evaluate(press, 'EllipticalROI'))
        self.assertEqual(['측정을 완료하세요'], self.page.evaluate('''() => { const a = cornerstoneTools.annotation.state.getAnnotation('syn-drawing-EllipticalROI');
          a.data.handles.points = [[20, 20, 0], [20, 20, 0], [10, 20, 0], [30, 20, 0]];
          return synTools.EllipticalROI.configuration.getTextLines(a.data, 'imageId:' + synImage()); }'''))
        self.page.evaluate("() => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))")
        self.assertEqual([False, False], self.page.evaluate("() => [synInteracting, !!cornerstoneTools.annotation.state.getAnnotation('syn-drawing-EllipticalROI')]"))
        # Enter on a control reached by Tab (an export button outside the cell) works it as a press would: the drawing goes first.
        self.page.evaluate(press, 'Length')
        self.assertEqual([False, False], self.page.evaluate('''() => { const b = document.createElement('button'); b.textContent = 'SYN export';
          document.body.append(b); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); b.remove();
          return [synInteracting, !!cornerstoneTools.annotation.state.getAnnotation('syn-drawing-Length')]; }'''))
        # A Length being drawn when the study's access is refused (an access check of its own, not a press).
        self.page.evaluate(press, 'Length')
        self.page.wait_for_timeout(600)
        self.assertEqual([True, False], self.page.evaluate('() => [synInteracting, window.kinViewerHistoryHasUnsaved()]'))
        denied.append(True)
        self.page.evaluate("() => [...document.querySelectorAll('#kin-viewer-history button')].find(b => b.textContent === 'Refresh').click()")
        self.wait_until(lambda: 'Recheck Access' in self.panel()['buttons'], 'the recheck offered after the refusal')
        self.assertNotIn('Length', self.panel()['buttons'])
        self.assertEqual([False, False], self.page.evaluate("() => [synInteracting, !!cornerstoneTools.annotation.state.getAnnotation('syn-drawing-Length')]"))

    def test_30b_a_ct_ellipse_is_in_hu_unless_the_original_names_another_rescale(self):
        """An Ellipse ROI on a CT is drawn when the original's values are HU: Rescale Type HU, or not given (the CT Image module's
        default) unless the acquisition is multi-energy. Another Rescale Type, a Modality LUT Sequence, a slope of 0 or a missing
        intercept is refused with the HU reason, and no mark is made."""
        tools = r'''() => {
          window.synCt = {Modality: 'CT', SOPClassUID: '1.2.840.10008.5.1.4.1.1.2', PixelSpacing: [1, 1], ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
            ImagePositionPatient: [0, 0, 0], FrameOfReferenceUID: 'SYN-FOR', Rows: 128, Columns: 128, RescaleSlope: '1', RescaleIntercept: '-1024'};
          window.synCtMeta = synCt;
          cornerstone.metaData.get = type => type === 'instance' ? synCtMeta : {rowPixelSpacing: 1, columnPixelSpacing: 1};
          synTools.EllipticalROI = { mode: 'Active',
            configuration: {statsCalculator: {statsCallback() {}, getStatistics: () => ({array: []})}, getTextLines: () => []},
            addNewAnnotation() {
              const a = {annotationUID: 'syn-ct-ellipse', metadata: {toolName: 'EllipticalROI', referencedImageId: synImage()},
                data: {handles: {points: Array.from({length: 4}, () => [20, 20, 0])}, cachedStats: {}}};
              cornerstoneTools.annotation.state.addAnnotation(a);
              this.editData = {annotation: a, newAnnotation: true}; this.isDrawing = true; return a; },
            cancel() { this.editData = null; this.isDrawing = false; } };
        }'''
        self.me = RADIOLOGIST
        self.open_viewer(before_boot=tools)
        self.wait_until(lambda: 'Ellipse ROI' in self.panel()['buttons'], 'writer controls')
        press = r'''([change, drop]) => {
          const meta = {...synCt, ...change}; for (const key of drop) delete meta[key]; window.synCtMeta = meta;
          document.querySelector('#kin-viewer-history [role=status]').textContent = '';
          const a = synTools.EllipticalROI.addNewAnnotation({detail: {element: cornerstone.getEnabledElement().viewport.element}});
          const made = !!a?.annotationUID && !!cornerstoneTools.annotation.state.getAnnotation(a.annotationUID);
          const status = document.querySelector('#kin-viewer-history [role=status]').textContent;
          window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
          return [made, status]; }'''
        for change, drop in [({}, []), ({'RescaleType': 'HU'}, []), ({'RescaleType': ''}, []), ({'MultienergyCTAcquisition': 'NO'}, []),
                             ({'RescaleType': 'HU', 'MultienergyCTAcquisition': 'YES'}, [])]:
            with self.subTest(change=change, drop=drop):
                made, status = self.page.evaluate(press, [change, drop])
                self.assertTrue(made, status)
                self.assertNotIn('HU 보정', status)
        for change, drop in [({'RescaleType': 'OD'}, []), ({'RescaleType': 'US'}, []), ({'ModalityLUTSequence': [{}]}, []),
                             ({'RescaleSlope': '0'}, []), ({}, ['RescaleIntercept']), ({'MultienergyCTAcquisition': 'YES'}, [])]:
            with self.subTest(change=change, drop=drop):
                made, status = self.page.evaluate(press, [change, drop])
                self.assertFalse(made, status)
                self.assertEqual('HU 보정을 확인할 수 없습니다', status)
        self.assertEqual(0, self.page.evaluate("() => cornerstoneTools.annotation.state.getAllAnnotations().filter(a => a.metadata.toolName === 'EllipticalROI').length"))

    CALIBRATION_TOOLS = r'''() => {
      // An image whose original gives no pixel spacing (a scanned film, an outside CR): no PixelSpacing, no ImagerPixelSpacing.
      window.synMeta = {Modality: 'CR', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: 512, Columns: 512};
      // The Calibration tool's answer as the pinned viewer keeps it: the calibrated-spacing metadata of that image, and the
      // cached image's calibration while the image is in the cache (synCached false: dropped from the cache meanwhile).
      window.synCalibration = null; window.synCached = true;
      cornerstone.metaData.get = (type, id) => type === 'instance' ? synMeta : type === 'calibratedPixelSpacing' ? (synCalibration || undefined) :
        type === 'imagePlaneModule' ? (synMeta.PixelSpacing ? {frameOfReferenceUID: 'SYN-FOR', rowPixelSpacing: 0.5, columnPixelSpacing: 0.5} : {frameOfReferenceUID: 'SYN-FOR'}) : undefined;
      // synCacheCalibration: what the cached image holds when it differs from the metadata (undefined: the same).
      window.synCacheCalibration = undefined;
      cornerstone.cache.getImage = () => synCached ? {calibration: (synCacheCalibration === undefined ? synCalibration : synCacheCalibration) || undefined} : undefined;
      cornerstoneTools.annotation.selection.setAnnotationSelected = (uid, on = true) => {
        const a = cornerstoneTools.annotation.state.getAnnotation(uid);
        if (!a) throw new TypeError("Cannot set properties of undefined (setting 'isSelected')");
        a.isSelected = on; };
      window.synInteracting = false; let made = 0;
      const drawingTool = (name, count, configuration) => ({ mode: 'Active', configuration,
        addNewAnnotation() {
          const a = {annotationUID: 'syn-drawing-' + name + '-' + (++made), metadata: {toolName: name, referencedImageId: synImage()},
            data: {handles: {points: Array.from({length: count}, () => [20, 20, 0])}, cachedStats: {}}};
          cornerstoneTools.annotation.state.addAnnotation(a);
          this.editData = {annotation: a, newAnnotation: true}; this.isDrawing = true; synInteracting = true; return a; },
        cancel() { this.editData = null; this.isDrawing = false; synInteracting = false; } });
      synTools.Length = drawingTool('Length', 2, {getTextLines: () => []});
      synTools.EllipticalROI = drawingTool('EllipticalROI', 4,
        {statsCalculator: {statsCallback() {}, getStatistics: () => ({array: []})}, getTextLines: () => []});
      // A press of Length on the cell: 'refused' or the new mark's uid.
      window.synPressLength = () => { const a = synTools.Length.addNewAnnotation({detail: {element: cornerstone.getEnabledElement().viewport.element}});
        if (!a?.annotationUID) return 'refused';
        cornerstoneTools.annotation.selection.setAnnotationSelected(a.annotationUID); return a.annotationUID; };
      // The tool ends the drawing at the second point and computes its length (as the pinned Length does, in the calibrated unit).
      window.synFinishLength = (uid, length) => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
        a.data.handles.points = [[10, 20, 0], [110, 20, 0]];
        a.data.cachedStats['imageId:' + a.metadata.referencedImageId] = {length, unit: 'mm User'};
        synTools.Length.editData = null; synTools.Length.isDrawing = false; synInteracting = false; };
      window.synLengthText = uid => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
        return synTools.Length.configuration.getTextLines(a.data, 'imageId:' + a.metadata.referencedImageId); };
      window.synCellNote = () => [...document.querySelectorAll('[data-kin-cell-note]')].map(n => n.textContent);
    }'''

    def length_rows(self):
        return [row for row in self.panel()['rows'] if row and row[0].startswith('Length')]

    def test_31_length_on_an_image_without_pixel_spacing_follows_the_screen_calibration(self):
        """An image whose original gives no pixel spacing: Length is refused, the reason shown over the cell as well as in the
        panel, until the reader sets a spacing with Calibration. Then Length is drawn with its value marked as a screen
        calibration that is not saved: no row, no save, no unsaved-work warning, no number in the SR or the export. The
        calibration lasts while the image's calibrated spacing does (a cache drop does not undo it); an image without it is
        refused again, and an image with original spacing keeps its own rule (a calibration over it is refused as before)."""
        self.me = RADIOLOGIST
        self.open_viewer(before_boot=self.CALIBRATION_TOOLS)
        self.wait_until(lambda: 'Length' in self.panel()['buttons'], 'writer controls')
        reason = '원본에 픽셀 간격이 없습니다 · Calibration으로 화면 보정 후 잴 수 있습니다'
        # 1. No spacing, no calibration: refused, with the reason over the cell and in the panel.
        self.assertEqual('refused', self.page.evaluate('synPressLength()'))
        self.assertEqual(reason, self.panel()['status'])
        self.assertEqual([reason], self.page.evaluate('synCellNote()'))
        # 2. Calibration (the reader's distance on this screen): Length is drawn, its value marked as not saved.
        self.page.evaluate("() => { synCalibration = {type: 'User', scale: 2}; }")
        uid = self.page.evaluate('synPressLength()')
        self.assertNotEqual('refused', uid)
        self.page.evaluate('([uid]) => synFinishLength(uid, 50)', [uid])
        self.assertEqual(['50.0 mm', '화면 보정 · 저장 안 됨'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.page.evaluate('synTick(3)'); self.settle()
        self.assertEqual([], self.length_rows(), 'a screen-calibrated Length is no saved measurement: no row, no Save')
        self.assertEqual([False, True], self.page.evaluate('([uid]) => [window.kinViewerHistoryHasUnsaved(), !!cornerstoneTools.annotation.state.getAnnotation(uid)]', [uid]))
        self.assertEqual([], self.writes, 'nothing of a screen-calibrated Length is sent to the server')
        # Chosen for an SR: refused with why, nothing sent.
        for name in ('storeMeasurements', 'downloadReport'):
            answer = self.page.evaluate("([name, uid]) => synSRWith(name, [{uid, toolName: 'Length'}])", [name, uid])
            self.assertTrue(answer.startswith('refused: ') and '화면 보정 측정은 저장되지 않아 SR에 넣지 않습니다.' in answer, answer)
        self.assertNotIn('sr storeMeasurements', self.page.evaluate('synNative'))
        self.assertEqual([], self.writes)
        # 3. The image leaves the cache but its calibrated spacing stays (another image and back): the same.
        self.page.evaluate('() => { synCached = false; }')
        self.assertEqual(['50.0 mm', '화면 보정 · 저장 안 됨'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.page.evaluate('synTick(3)'); self.settle()
        self.assertEqual([], self.length_rows())
        # 4. No calibrated spacing (another image of the series, a viewer opened again): refused; a mark drawn under the
        #    calibration says why it has no value and is still never saved.
        self.page.evaluate('() => { synCached = true; synCalibration = null; }')
        self.assertEqual([reason], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.assertEqual('refused', self.page.evaluate('synPressLength()'))
        self.page.evaluate('synTick(3)'); self.settle()
        self.assertEqual([], self.length_rows())
        self.assertFalse(self.page.evaluate('() => window.kinViewerHistoryHasUnsaved()'))
        # 5. An image with original spacing and a calibration over it: refused as before (the display spacing differs).
        self.page.evaluate("""() => { synMeta = {Modality: 'CR', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: 512, Columns: 512,
          PixelSpacing: [0.5, 0.5]}; synCalibration = {type: 'User', scale: 2}; }""")
        self.assertEqual('refused', self.page.evaluate('synPressLength()'))
        self.assertEqual('표시 간격과 원본 간격이 일치하지 않습니다', self.panel()['status'])

    def test_31b_length_inside_an_ultrasound_region_is_measured_with_its_deltas(self):
        """An ultrasound image without spacing or orientation, with Region Calibrations: Length is drawn where the viewer shows
        the image (pixel (x, y) at [0, x, -y], display spacing 1) and measured with the deltas of the region that holds both
        points, its basis named. A line across two regions says why it has no value; a region that is not 2D in cm, Angle on
        the same image and a screen calibration over it keep the rules they had."""
        self.me = RADIOLOGIST
        self.open_viewer(before_boot=self.CALIBRATION_TOOLS)
        self.wait_until(lambda: 'Length' in self.panel()['buttons'], 'writer controls')
        self.page.evaluate("""() => {
          const region = (x0, x1, dx, dy, more = {}) => ({RegionSpatialFormat: 1, PhysicalUnitsXDirection: 3, PhysicalUnitsYDirection: 3,
            PhysicalDeltaX: dx, PhysicalDeltaY: dy, RegionLocationMinX0: x0, RegionLocationMinY0: 0, RegionLocationMaxX1: x1, RegionLocationMaxY1: 199, ...more});
          window.synRegion = region;
          window.synMeta = {Modality: 'US', SOPClassUID: '1.2.840.10008.5.1.4.1.1.6.1', SOPInstanceUID: 'SYN-US', Rows: 200, Columns: 300,
            SequenceOfUltrasoundRegions: [region(0, 149, 0.02, 0.03), region(150, 299, 0.05, 0.04)]};
          // The cell drew this very image in the viewer's plane at display spacing 1 (viewer-info-bar.js, the stack's image data).
          window.KinViewerInfoBar = {identity: () => ({instance: synMeta})};
          cornerstone.getEnabledElement().viewport.getImageData = () => ({spacing: [1, 1, 1], direction: [0, 1, 0, 0, 0, -1, -1, 0, 0], origin: [0, 0, 0]});
          window.synPlace = (uid, points) => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
            a.data.handles.points = points; a.data.cachedStats['imageId:' + a.metadata.referencedImageId] = {length: 1, unit: 'px'};
            synTools.Length.editData = null; synTools.Length.isDrawing = false; synInteracting = false; };
        }""")
        # Inside the left region: (20,20)→(50,60) is hypot(30 × 0.2, 40 × 0.3) = 13.4 mm.
        uid = self.page.evaluate('synPressLength()')
        self.assertNotEqual('refused', uid, self.panel()['status'])
        self.page.evaluate('([uid]) => synPlace(uid, [[0, 20, -20], [0, 50, -60]])', [uid])
        self.assertEqual(['13.4 mm', 'US Region Calibration'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        # Inside the right region, its own deltas: (160,10)→(190,50) is hypot(30 × 0.5, 40 × 0.4) = 21.9 mm.
        self.page.evaluate('([uid]) => synPlace(uid, [[0, 160, -10], [0, 190, -50]])', [uid])
        self.assertEqual(['21.9 mm', 'US Region Calibration'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        # 17 columns of 0.15 mm are 2.55 mm: one decimal as the saved value is said (History, Findings) — 2.6 mm.
        self.page.evaluate("() => { window.synTwoRegions = synMeta.SequenceOfUltrasoundRegions; synMeta = {...synMeta, SequenceOfUltrasoundRegions: [synRegion(0, 299, 0.015, 0.03)]}; }")
        self.page.evaluate('([uid]) => synPlace(uid, [[0, 20, -20], [0, 37, -20]])', [uid])
        self.assertEqual(['2.6 mm', 'US Region Calibration'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.page.evaluate("() => { synMeta = {...synMeta, SequenceOfUltrasoundRegions: synTwoRegions}; }")
        # Across the two regions: no value, the reason.
        self.page.evaluate('([uid]) => synPlace(uid, [[0, 100, -20], [0, 200, -20]])', [uid])
        self.assertEqual(['초음파 보정 영역 안에서만 mm로 잴 수 있습니다'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        # A screen calibration over it: refused as an image with its own spacing.
        self.page.evaluate("() => { synCalibration = {type: 'User', scale: 2}; }")
        self.assertEqual('refused', self.page.evaluate('synPressLength()'))
        self.assertEqual('표시 간격과 원본 간격이 일치하지 않습니다', self.panel()['status'])
        self.page.evaluate("() => { synCalibration = null; }")
        # Only Doppler (a spectral region in cm/s) or regions without deltas: refused as before, never a screen calibration.
        for regions in ("[synRegion(0, 299, 0.02, 0.03, {RegionSpatialFormat: 3, PhysicalUnitsYDirection: 7})]",
                        "[synRegion(0, 299, undefined, undefined)]"):
            with self.subTest(regions=regions):
                self.page.evaluate("regions => { synMeta = {...synMeta, SequenceOfUltrasoundRegions: eval(regions)}; }", regions)
                self.assertEqual('refused', self.page.evaluate('synPressLength()'))
                self.assertEqual('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다', self.panel()['status'])
        # An Ellipse on the image with a usable region: the rules it had (no spacing of its own), no mark.
        self.page.evaluate("() => { synMeta = {...synMeta, SequenceOfUltrasoundRegions: [synRegion(0, 299, 0.02, 0.03)]}; }")
        self.assertEqual('refused', self.page.evaluate("""() => { const a = synTools.EllipticalROI.addNewAnnotation(
            {detail: {element: cornerstone.getEnabledElement().viewport.element}}); return a?.annotationUID ? 'made' : 'refused'; }"""))
        self.assertEqual('원본 프레임의 좌표·간격·보정을 확인할 수 없습니다', self.panel()['status'])

    def test_32_screen_calibration_is_read_from_the_calibrated_spacing_and_recalibration_waits_for_the_new_value(self):
        """Which answer counts as a screen calibration, and a calibration made again over a drawn Length."""
        self.me = RADIOLOGIST
        self.open_viewer(before_boot=self.CALIBRATION_TOOLS)
        self.wait_until(lambda: 'Length' in self.panel()['buttons'], 'writer controls')
        cases = [
            # The calibrated-spacing metadata says "uncalibrated": an older cached calibration does not count.
            ("() => { synCalibration = {type: 'Uncalibrated'}; synCacheCalibration = {type: 'User', scale: 2}; }", 'refused'),
            # No metadata: the cached image's calibration counts.
            ("() => { synCalibration = null; synCacheCalibration = {type: 'User', scale: 2}; }", 'mark'),
            # A scale that is not a positive number, an ultrasound region: no screen calibration.
            ("() => { synCalibration = {type: 'User', scale: 0}; synCacheCalibration = undefined; }", 'refused'),
            ("() => { synCalibration = {type: 'Region', scale: 2}; }", 'refused'),
            # Functional groups without a pixel measure: no spacing of its own, so the screen calibration counts.
            ("() => { synMeta = {...synMeta, SharedFunctionalGroupsSequence: [{PlaneOrientationSequence: [{}]}]}; synCalibration = {type: 'User', scale: 2}; }", 'mark'),
            # A pixel measure without a pixel spacing in it (a slice thickness only): still no spacing of its own.
            ("() => { synMeta = {...synMeta, SharedFunctionalGroupsSequence: [{PixelMeasuresSequence: [{SliceThickness: 1}]}]}; }", 'mark'),
            # A pixel spacing in the functional groups (even one that cannot be read): the original's rules, not the screen's.
            ("() => { synMeta = {...synMeta, SharedFunctionalGroupsSequence: [{PixelMeasuresSequence: [{PixelSpacing: 'x'}]}]}; }", 'refused'),
            ("() => { synMeta = {...synMeta, SharedFunctionalGroupsSequence: undefined, PerFrameFunctionalGroupsSequence: [{FramePixelDataPropertiesSequence: [{ImagerPixelSpacing: [0.2, 0.2]}]}]}; }", 'refused'),
        ]
        for setup, want in cases:
            self.page.evaluate(setup)
            got = self.page.evaluate('synPressLength()')
            if got != 'refused':
                self.page.evaluate("([uid]) => { synTools.Length.cancel(); cornerstoneTools.annotation.state.removeAnnotation(uid); }", [got])
            self.assertEqual(want, 'refused' if got == 'refused' else 'mark', setup)
        # Calibration made again over a drawn Length: the tool replaces the mark's calculated values, which wait for the
        # new calculation before a value is shown again.
        self.page.evaluate("() => { synMeta = {Modality: 'CR', SOPClassUID: '1.2.840.10008.5.1.4.1.1.1', Rows: 512, Columns: 512}; synCalibration = {type: 'User', scale: 2}; }")
        uid = self.page.evaluate('synPressLength()')
        self.page.evaluate('([uid]) => synFinishLength(uid, 50)', [uid])
        self.page.evaluate('synTick(2)')
        self.assertEqual(['50.0 mm', '화면 보정 · 저장 안 됨'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.page.evaluate("""([uid]) => { synCalibration = {type: 'User', scale: 4}; const a = cornerstoneTools.annotation.state.getAnnotation(uid);
          a.data.cachedStats = {['imageId:' + a.metadata.referencedImageId]: {length: 50, unit: 'mm User'}}; }""", [uid])
        self.assertEqual(['재확인 필요: 현재 좌표로 계산되지 않았습니다'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.page.evaluate('synTick(2)')
        self.page.evaluate("""([uid]) => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
          a.data.cachedStats['imageId:' + a.metadata.referencedImageId] = {length: 25, unit: 'mm User'}; }""", [uid])
        self.assertEqual(['25.0 mm', '화면 보정 · 저장 안 됨'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        # A value the tool gives in pixels is no mm.
        self.page.evaluate("""([uid]) => { const a = cornerstoneTools.annotation.state.getAnnotation(uid);
          a.data.cachedStats['imageId:' + a.metadata.referencedImageId] = {length: 100, unit: 'px'}; }""", [uid])
        self.assertEqual(['측정을 완료하세요'], self.page.evaluate('([uid]) => synLengthText(uid)', [uid]))
        self.assertEqual([], self.length_rows())

    FREEHAND_TOOL = r'''() => {
      // The pinned PlanarFreehandROI tool's own words (its defaultGetTextLines): the perimeter or length it computed (a sum of
      // distances on the screen) with the unit read from `unit`, which the pinned tool never fills.
      const round = x => String(Math.round(x));
      const pinned = (data, targetId) => {
        const { area, mean, stdDev, length, perimeter, max, unit, areaUnit, modalityUnit } = data.cachedStats[targetId] || {};
        const lines = [];
        if (area) lines.push('Area: ' + round(area) + ' ' + areaUnit);
        if (mean) lines.push('Mean: ' + round(mean) + ' ' + modalityUnit);
        if (Number.isFinite(max)) lines.push('Max: ' + round(max) + ' ' + modalityUnit);
        if (stdDev) lines.push('Std Dev: ' + round(stdDev) + ' ' + modalityUnit);
        if (perimeter) lines.push('Perimeter: ' + round(perimeter) + ' ' + unit);
        if (length) lines.push(round(length) + ' ' + unit);
        return lines; };
      window.synFreehandPinned = pinned;
      // The image a target names, as the tool reads it (getTargetImageData), and the pinned unit function: mm with a pixel
      // spacing, px without, a calibration's name after it and its scale.
      // Its grid's world-to-index answer is continuous (column, row): twice the world x and y, as transformWorldToIndex below.
      window.synGrid = { syn: true, worldToIndex: p => [p[0] * 2, p[1] * 2, 0] };
      window.synFreehandImage = { imageData: synGrid, hasPixelSpacing: true };
      // The Measurements panel's rows (the pinned OHIF 3.9.1 PlanarFreehandROI mapping: the area first, in the tool's areaUnit;
      // its CSV report's Mean, Max, Area and Unit columns).
      window.synMeasurements = [];
      synServices.measurementService.getMeasurements = () => synMeasurements;
      // The image's own header (synFreehandHeader): its pixel spacing, or none, or an ultrasound region.
      window.synFreehandHeader = { Modality: 'CT', PixelSpacing: [0.7, 0.7] };
      const plane = cornerstone.metaData.get;
      cornerstone.metaData.get = (type, id) => type === 'instance' ? synFreehandHeader : plane(type, id);
      synTools.PlanarFreehandROI = { configuration: { getTextLines: pinned }, addNewAnnotation() { return {}; },
        getTargetImageData: () => window.synFreehandImage };
      // The cell showing that image, turned a quarter and zoomed (screen x = zoom * world y, screen y = -zoom * world x): the
      // tool takes the outline's box on the screen and reads its corners back on the image. [] = no cell shows the image.
      window.synZoom = 1;
      window.synFreehandViewports = [{ getCurrentImageId: () => synImage(),
        worldToCanvas: p => [synZoom * p[1], -synZoom * p[0]], canvasToWorld: c => [-c[1] / synZoom, c[0] / synZoom, 0] }];
      cornerstone.utilities = { ...(cornerstone.utilities || {}), transformWorldToIndex: (imageData, p) => [p[0] * 2, p[1] * 2, 0],
        imageIdToURI: id => id, getViewportsWithImageURI: () => synFreehandViewports };
      window.synUnitCalls = [];
      cornerstoneTools.utilities = { ...(cornerstoneTools.utilities || {}), getCalibratedLengthUnitsAndScale: (image, handles) => {
        synUnitCalls.push(handles());
        const c = image.calibration, suffix = c && c.type ? ' ' + c.type : '';
        const unit = (image.hasPixelSpacing ? 'mm' : 'px') + suffix;
        return { unit, areaUnit: unit.replace(/^(mm|px)/, '$1²'), scale: c && c.scale ? c.scale : 1 }; } };
      window.synFreehandText = (stats, polyline, closed) => {
        const target = 'imageId:' + synImage(), data = { contour: { polyline, closed }, cachedStats: { [target]: stats } };
        const before = JSON.stringify(data);
        const lines = synTools.PlanarFreehandROI.configuration.getTextLines(data, target);
        return { lines, untouched: JSON.stringify(data) === before }; };
    }'''

    def test_33_freehand_roi_words_give_the_outline_length_on_the_image(self):
        """Where a Freehand ROI's length is known to be physical — the image's own header gives a pixel spacing, no ultrasound
        region, the tool measures in mm with a positive scale — its perimeter (closed outline) and length (open line) are the
        outline's length on the image, the same at any zoom, never a distance on the screen or "undefined"; the other lines
        stay as they are. Where the header gives no spacing at all (the viewer stands in a spacing of 1), the outline is measured
        on the image's pixel grid: its length in px and a closed outline's area in px², at any zoom and with a screen calibration
        too — never mm, and the Measurements panel and its CSV say the same area in px². Anywhere else (an ultrasound region; the
        image not shown) no length is said, rather than a distance on the screen in "undefined". The measurement itself is
        never changed by its words."""
        self.me = RADIOLOGIST
        self.open_viewer(before_boot=self.FREEHAND_TOOL)
        self.wait_until(lambda: 'Length' in self.panel()['buttons'], 'writer controls')
        self.page.evaluate('synTick(2)')
        self.wait_until(lambda: self.page.evaluate('() => synTools.PlanarFreehandROI.configuration.getTextLines !== synFreehandPinned'),
                        "the viewer's measurement settings over the Freehand ROI tool")
        # A triangle on the image: sides 30, 20 and 36.06 — closed 86.06, open (two sides) 50. The tool's own numbers (253, 209)
        # are distances on the screen.
        line = [[10, 10, 0], [40, 10, 0], [40, 30, 0]]
        closed = "{area: 283.2, areaUnit: '%s', perimeter: 253.39, mean: -800, max: -800, stdDev: 3.2, modalityUnit: 'HU', unit: undefined}"
        opened = "{length: 208.8, modalityUnit: 'HU', getPixelValueUnitunit: undefined}"
        spaced = "{imageData: synGrid, hasPixelSpacing: true}"
        user = "{imageData: synGrid, hasPixelSpacing: true, calibration: {type: 'User', scale: 2}}"
        ct, bare = "{Modality: 'CT', PixelSpacing: [0.7, 0.7]}", "{Modality: 'CR'}"
        us = "{Modality: 'US', SequenceOfUltrasoundRegions: [{RegionDataType: 1}]}"
        region = "{imageData: synGrid, hasPixelSpacing: true, calibration: {sequenceOfUltrasoundRegions: [{}]}}"
        values = lambda unit: ['Area: 283 ' + unit, 'Mean: -800 HU', 'Max: -800 HU', 'Std Dev: 3 HU']
        area_px = ['Area: 1200 px²', 'Mean: -800 HU', 'Max: -800 HU', 'Std Dev: 3 HU']
        cases = [
            (closed % 'mm²', True, ct, spaced, 1, values('mm²') + ['Perimeter: 86 mm']),
            (closed % 'mm²', True, ct, spaced, 3, values('mm²') + ['Perimeter: 86 mm']),
            (closed % 'mm² User', True, ct, user, 1, values('mm² User') + ['Perimeter: 43 mm User']),
            (opened, False, ct, spaced, 1, ['50 mm']),
            (opened, False, ct, spaced, 3, ['50 mm']),
            (opened, False, ct, user, 1, ['25 mm User']),
            # The header gives no spacing (the viewer stands in 1 and says it has one): on the pixel grid — image (20,20), (80,20),
            # (80,60): sides 60, 40 and 72.11, closed 172.11, open 100, area 1200 — at any zoom, a screen calibration or not.
            (closed % 'mm²', True, bare, spaced, 1, area_px + ['Perimeter: 172 px']),
            (closed % 'mm²', True, bare, spaced, 3, area_px + ['Perimeter: 172 px']),
            (closed % 'mm² User', True, bare, user, 1, area_px + ['Perimeter: 172 px']),
            (opened, False, bare, spaced, 1, ['100 px']),
            (opened, False, bare, user, 3, ['100 px']),
            # An ultrasound region, in the header or in the image's calibration: no length, the area as the tool gave it.
            (opened, False, us, spaced, 1, []),
            (opened, False, ct, region, 1, []),
            (closed % 'cm² US Region', True, us, region, 1, values('cm² US Region')),
            # The image cannot be read (no cell shows it now): no length.
            (opened, False, ct, 'undefined', 1, []),
            (opened, False, bare, 'undefined', 1, []),
            # A tool that does fill the unit (a fixed release) is left as it is.
            ("{length: 208.8, modalityUnit: 'HU', unit: 'mm'}", False, ct, spaced, 1, ['209 mm']),
        ]
        for stats, is_closed, head, image, zoom, want in cases:
            with self.subTest(stats=stats, header=head, image=image, zoom=zoom):
                self.page.evaluate('([zoom]) => { window.synFreehandHeader = %s; window.synFreehandImage = %s; window.synZoom = zoom; }' % (head, image), [zoom])
                got = self.page.evaluate('([line, closed]) => synFreehandText(%s, line, closed)' % stats, [line, is_closed])
                self.assertEqual(want, got['lines'])
                self.assertTrue(got['untouched'], 'the measurement is not changed by its words')
        # The unit's box as the tool takes it: around the outline on the screen, its corners read back on the image —
        # (10,-40)..(30,-10) on the turned screen are world (40,10) and (10,30), image (80,20) and (20,60).
        self.assertEqual([[80, 20, 0], [20, 60, 0]], self.page.evaluate('() => synUnitCalls[0]'))
        # No cell shows the image: the outline's own box on the image, lowest corner then highest.
        self.page.evaluate("() => { synFreehandViewports = []; synUnitCalls.length = 0; synFreehandHeader = {Modality: 'CT', PixelSpacing: [0.7, 0.7]}; synFreehandImage = {imageData: {syn: true}, hasPixelSpacing: true}; }")
        got = self.page.evaluate("([line]) => synFreehandText({length: 208.8, modalityUnit: 'HU'}, line, false)", [line])
        self.assertEqual(['50 mm'], got['lines'])
        self.assertEqual([[20, 20, 0], [80, 60, 0]], self.page.evaluate('() => synUnitCalls[0]'))
        # The Measurements panel's row and its CSV: on an image without spacing the area is the pixel grid's, in px²; on one with
        # spacing the row is the tool's own.
        # The pinned report (getColumnValueReport) names its customised entries by a key they lack: unnamed columns after
        # AnnotationType, in the order of the 'cornerstone.measurements' customisation.
        panel = r'''([uid, header, shown, closed]) => {
          synServices.customizationService = { get: name => name === 'cornerstone.measurements' ? { PlanarFreehandROI: { report: [
            { displayName: 'Mean', value: 'mean' }, { displayName: 'Max', value: 'max' }, { displayName: 'Area', value: 'area' },
            { displayName: 'Unit', value: 'unit' }] } } : undefined };
          window.synFreehandHeader = header; window.synFreehandImage = shown ? { imageData: synGrid, hasPixelSpacing: true } : undefined;
          const target = 'imageId:' + synImage();
          if (!cornerstoneTools.annotation.state.getAnnotation(uid)) cornerstoneTools.annotation.state.addAnnotation({ annotationUID: uid,
            metadata: { toolName: 'PlanarFreehandROI', referencedImageId: synImage() },
            data: { contour: { polyline: [[10, 10, 0], [40, 10, 0], [40, 30, 0]], closed }, handles: { points: [] },
              cachedStats: { [target]: closed ? { area: 283.2, areaUnit: 'mm²', mean: -800, max: -800 } : { length: 208.8 } } } });
          synMeasurements = [{ uid, toolName: 'PlanarFreehandROI', displayText: { primary: [(closed ? 283.2 : 0) + ' mm²', 'Max: -800 HU'], secondary: ['S: 1'] },
            getReport: () => ({ columns: ['AnnotationType', undefined, undefined, undefined, undefined, 'points'],
              values: ['Cornerstone:PlanarFreehandROI', -800, -800, closed ? 283.2 : 'not available', 'not available', '10 10 0;40 10 0;40 30 0'] }) }];
          const [row] = synServices.measurementService.getMeasurements(), report = row.getReport();
          return { primary: row.displayText.primary, columns: report.columns, values: report.values }; }'''
        spaced_ct, bare_ct = {'Modality': 'CT', 'PixelSpacing': [0.7, 0.7]}, {'Modality': 'CT'}
        pixels = lambda area, unit: ['Cornerstone:PlanarFreehandROI', -800, -800, area, unit, '10 10 0;40 10 0;40 30 0']
        named = ['AnnotationType', None, None, 'Area', 'Area unit', 'points']
        # No spacing in the header: the area on the pixel grid in the panel and in the CSV's named Area / Area unit columns.
        self.assertEqual({'primary': ['1200 px²', 'Max: -800 HU'], 'columns': named, 'values': pixels(1200, 'px²')},
                         self.page.evaluate(panel, ['syn-freehand-ring', bare_ct, True, True]))
        # The reader scrolls to another slice (no cell shows the image): the same outline keeps its px² — never the tool's mm².
        self.assertEqual({'primary': ['1200 px²', 'Max: -800 HU'], 'columns': named, 'values': pixels(1200, 'px²')},
                         self.page.evaluate(panel, ['syn-freehand-ring', bare_ct, False, True]))
        # An open line has no area: the panel says its length in px, the CSV no area.
        self.assertEqual({'primary': ['100 px', 'Max: -800 HU'], 'columns': named, 'values': pixels('not available', 'not available')},
                         self.page.evaluate(panel, ['syn-freehand-line', bare_ct, True, False]))
        # An outline never measured on its shown image: no number at all rather than the tool's mm².
        self.assertEqual({'primary': ['Max: -800 HU'], 'columns': named, 'values': pixels('not available', 'not available')},
                         self.page.evaluate(panel, ['syn-freehand-unseen', bare_ct, False, True]))
        # An image with spacing of its own: the tool's row as it is.
        self.assertEqual({'primary': ['283.2 mm²', 'Max: -800 HU'], 'columns': ['AnnotationType', None, None, None, None, 'points'],
                          'values': ['Cornerstone:PlanarFreehandROI', -800, -800, 283.2, 'not available', '10 10 0;40 10 0;40 30 0']},
                         self.page.evaluate(panel, ['syn-freehand-spaced', spaced_ct, True, True]))
    def test_34_the_saved_item_count_follows_saves_and_deletes(self):
        """The panel's "n개 저장 항목" is the study's saved items now: a save answered adds one, a delete answered takes one
        away (with the delete's own words), not only when the list is read again. A list read that began before a save or a
        delete was answered does not undo it: the item saved meanwhile is not taken for deleted elsewhere, the item deleted
        meanwhile does not come back."""
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), 'the author list')
        self.assertEqual('1개 저장 항목 · 저장은 판독 확정과 별개입니다.', self.panel()['status'])
        history = self.page.locator('#kin-viewer-history')
        self.accept_writes = True
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        self.wait_until(lambda: 'Save' in self.panel()['buttons'], "the new key image's Save")
        history.get_by_role('button', name='Save', exact=True).click()
        self.wait_until(lambda: self.held_writes, 'the Save on the wire')
        saved = author_page(LATE_WRITE)['items'][0]
        self.release(self.held_writes.pop(), saved)
        self.wait_until(lambda: 'SYN LATE WRITTEN KEY' in str(self.panel()['rows']), 'the saved row')
        self.assertEqual('2개 저장 항목 · 저장은 판독 확정과 별개입니다.', self.panel()['status'])
        # Delete the saved key image (after its question): one left.
        self.page.evaluate('() => { window.confirm = () => true; }')
        history.locator('section').filter(has_text='SYN LATE WRITTEN KEY').get_by_role('button', name='Delete', exact=True).click()
        self.wait_until(lambda: self.held_writes, 'the delete on the wire')
        deleted = copy.deepcopy(saved); deleted['revision'] = 2; deleted['item']['deleted'] = True
        self.release(self.held_writes.pop(), deleted)
        self.assertEqual('Key Image 항목을 지웠습니다. 저장 이력은 서버에 남습니다. 1개 저장 항목 · 저장은 판독 확정과 별개입니다.',
                         self.panel()['status'])
        self.assertNotIn('SYN LATE WRITTEN KEY', str(self.panel()['rows']))
        writer_head = author_page(WRITER_HEAD)['items'][0]
        # A Refresh whose answer is held; meanwhile a new key image is saved; then the older answer (without it) arrives.
        self.hold_writer = {(VA, 'first')}
        history.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_writer, 'the Refresh held')
        history.get_by_role('button', name='Add Key Image', exact=True).click()
        self.wait_until(lambda: 'Save' in self.panel()['buttons'], "the second key image's Save")
        history.get_by_role('button', name='Save', exact=True).click()
        self.wait_until(lambda: self.held_writes, 'the second Save on the wire')
        second = author_page(key_item(86, 'SYN SECOND KEY'))['items'][0]
        self.release(self.held_writes.pop(), second)
        self.release(self.held_writer.pop()[-1], {'items': [writer_head], 'nextCursor': None})
        self.assertIn('SYN SECOND KEY', str(self.panel()['rows']), 'saved while the read was on its way: not taken for deleted')
        self.assertEqual('2개 저장 항목 · 저장은 판독 확정과 별개입니다.', self.panel()['status'])
        # A Refresh whose answer is held; meanwhile that key image is deleted; then the older answer (with it) arrives.
        history.get_by_role('button', name='Refresh', exact=True).click()
        self.wait_until(lambda: self.held_writer, 'the second Refresh held')
        history.locator('section').filter(has_text='SYN SECOND KEY').get_by_role('button', name='Delete', exact=True).click()
        self.wait_until(lambda: self.held_writes, 'the second delete on the wire')
        gone = copy.deepcopy(second); gone['revision'] = 2; gone['item']['deleted'] = True
        self.release(self.held_writes.pop(), gone)
        self.release(self.held_writer.pop()[-1], {'items': [writer_head, second], 'nextCursor': None})
        self.assertNotIn('SYN SECOND KEY', str(self.panel()['rows']), 'deleted while the read was on its way: does not come back')
        self.assertEqual('1개 저장 항목 · 저장은 판독 확정과 별개입니다.', self.panel()['status'])
    def test_35_resumed_held_work_whose_item_was_deleted_elsewhere_is_not_counted(self):
        """Held work taken up again (Resume Held Work) on a saved item that another window deleted meanwhile: the answer lists
        no items, so the count is 0 as the list says; the work itself is kept and told it can no longer be saved."""
        history = self.page.locator('#kin-viewer-history')
        self.writer_open()
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "A's author list")
        row = history.locator('section').filter(has_text='SYN writer key')
        row.get_by_role('button', name='Edit', exact=True).click()
        history.get_by_label('Key Title', exact=True).fill('SYN EDITED KEY')
        self.page.evaluate('study => synSwitch(study)', VP)
        self.wait_until(lambda: self.panel()['uid'] == VP, "B's author list")
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_until(lambda: (lambda p: p['uid'] == VA and 'Resume Held Work' in p['buttons'])(self.panel()), "A's work held")
        self.hold_writer = {(VA, 'first')}
        history.get_by_role('button', name='Resume Held Work', exact=True).click()
        self.wait_until(lambda: self.held_writer, 'the list read of the resumed work held')
        self.release(self.held_writer.pop()[-1], {'items': [], 'nextCursor': None})
        self.assertEqual('0개 저장 항목 · 저장은 판독 확정과 별개입니다.', self.panel()['status'])
        self.assertIn('다른 창에서 지운 항목입니다', str(self.panel()['rows']))
        # The same with marks saved on their own (Auto Save View): the held work is taken up by the first read on coming back.
        self.fresh_page()
        self.writer_open()
        history = self.page.locator('#kin-viewer-history')
        self.wait_until(lambda: 'SYN writer key' in str(self.panel()['rows']), "A's author list")
        self.accept_writes = True
        history.locator('section').filter(has_text='SYN writer key').get_by_role('button', name='Edit', exact=True).click()
        history.get_by_label('Key Title', exact=True).fill('SYN EDITED KEY')
        self.page.evaluate('study => synSwitch(study)', VP)
        self.wait_until(lambda: self.panel()['uid'] == VP, "B's author list")
        self.page.evaluate('() => { window.KinViewerAutoSave = { marks: () => true }; }')
        self.hold_writer = {(VA, 'first')}
        self.page.evaluate('study => synSwitch(study)', VA)
        self.wait_until(lambda: self.held_writer, "A's list read held")
        self.release(self.held_writer.pop()[-1], {'items': [], 'nextCursor': None})
        self.wait_until(lambda: 'SYN EDITED KEY' in self.page.evaluate("() => [...document.querySelectorAll('#kin-viewer-history input')].map(e => e.value).join(' ')"),
                        'the held work taken up')
        self.assertEqual('0개 저장 항목 · 저장은 판독 확정과 별개입니다.', self.panel()['status'])
        self.assertIn('다른 창에서 지운 항목입니다', str(self.panel()['rows']))
    def notice(self,session,kind='broadcast'):
        self.observer.evaluate("""([session,kind])=>{const notice={type:'session-ended',session,operation:Date.now(),status:'ending'};
          if(kind==='storage')localStorage.setItem('kin-session-end',JSON.stringify(notice));
          else {const c=new BroadcastChannel('kin-session');c.postMessage(notice);c.close();}}""",[session,kind])

    def ct_pair(self):
        self.rows=[study(VA,'SYN KIM','SYN-P-100',patient(INST_A,'SYN-P-100'),'20260320',FINAL),
                   study(VP,'SYN KIM','SYN-P-100',patient(INST_A,'SYN-P-100'),'20250101',OPEN)]

if __name__ == "__main__":
    unittest.main(verbosity=2)
