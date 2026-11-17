"""Python adapter for the single page-source implementation in page_source.cjs.

The legacy page view retains markup and reconstructs only the moved inline block.
Historical git blobs are deliberately not routed through this helper.
"""
import json
from pathlib import Path
import subprocess
import time

_HELPER = Path(__file__).with_suffix('.cjs')


def read_page_bytes(path):
    return subprocess.check_output(['node', str(_HELPER), 'source', str(path)])


def read_page_source(path):
    return read_page_bytes(path).decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')


def read_source(path):
    path = Path(path)
    return read_page_source(path) if path.suffix.lower() == '.html' else path.read_text(encoding='utf-8')


def moved_files(path):
    return tuple(Path(p) for p in json.loads(subprocess.check_output(
        ['node', str(_HELPER), 'files', str(path)], text=True, encoding='utf-8')))


def settle(page, call, timeout=10000):
    """Run `call`, a page expression that returns a promise (for example "load()"), and wait until it settles.

    Waiting for a page promise through page.evaluate failed now and then: the browser protocol holds the promise it
    awaits only weakly, and a garbage collection between the promise settling and the protocol's answer ended the wait
    with 'Promise was collected', which Playwright reports as "Execution context was destroyed, most likely because of
    a navigation" although nothing navigated and the call had finished. So no promise is awaited through the protocol:
    the page starts the call and records how it ended (window.synSettled), and the test reads that record with short
    evaluations that return at once. The call's value comes back; a rejection fails the test with its message; a real
    navigation still fails the read as before.
    """
    page.evaluate(f"""() => {{
      const state = window.synSettled = {{ done: false }};
      const end = (key, value) => {{ state.done = true; state[key] = value; }};
      try {{ Promise.resolve({call}).then(value => end('value', value), error => end('error', String(error?.stack || error))); }}
      catch (error) {{ end('error', String(error?.stack || error)); }}
    }}""")
    deadline = time.monotonic() + timeout / 1000
    while True:
        state = page.evaluate("() => window.synSettled")
        if state["done"]:
            break
        if time.monotonic() > deadline:
            raise AssertionError(f"{call} did not settle within {timeout} ms")
        page.wait_for_timeout(10)
    if "error" in state:
        raise AssertionError(f"{call} failed in the page: {state['error']}")
    return state.get("value")


def include_moved_files(files, root):
    """Extend an existing served-input allowlist; keep every existing entry and its order."""
    root = Path(root).resolve()
    added = [p.relative_to(root).as_posix() for p in moved_files(root/'worklist-v0/hpacs-lite/main.html')]
    # Standalone page assets served beside the moved files (the W6 report frame; S9-U4b's transfer panel; MODULE_A A5's
    # report display reports; CD-01's Product Information panel and its embedded facts; FA-090's EMR Link builder;
    # FC-070's Query/Retrieve panel; FC-076's Attach Document dialog; the Technician Order List's tabs, action row and windows;
    # Merge Exam · Split / Unmerge).
    for name in ("report-editor-frame.js", "study-transfer-local.js", "clinical-signature.js", "report-view-observation.js",
                 "product-info-data.js", "product-info.js", "emr-link.js", "query-retrieve.js", "study-attachments.js",
                 "technician-orders.js", "technician-scheduled.js", "technician-report.js", "exam-merge.js", "exam-scope.js", "viewer-exam-scope.js"):
        asset = root / "worklist-v0/hpacs-lite" / name
        if asset.is_file():
            added.append(asset.relative_to(root).as_posix())
    return tuple(dict.fromkeys([*files, *added]))
