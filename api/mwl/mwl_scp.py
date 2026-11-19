"""Modality Worklist helper: the DICOM side of the API's Modality Worklist (C-FIND SCP, Modality Worklist
Information Model - FIND, and C-ECHO).

The API server (modality-worklist.service.ts) starts this process once and keeps it running while KIN_MWL_PORT is set.
Everything about what a device is answered is decided by the API: this process accepts an association addressed to its
own AE Title, hands each query to the API and sends back what the API answered. It decides nothing and logs no
identifier (no patient value, no search value).

  stdout  {"type": "listening", "port"}          the port is open
          {"type": "bind_failed", "error"}        the port could not be opened (the process then exits)
          {"type": "find", "id", "calling", "called", "identifier": DICOM JSON model}
  stdin   {"id", "status", "warning", "items": [DICOM JSON model, ...]}

A query the API does not answer within --answer-seconds ends Unable to process (0xC001), never an empty success. A
C-CANCEL ends it Cancel (0xFE00); an answer that arrives after either is dropped. When stdin closes (the API stopped)
the process ends, and with it every association it held.
"""
import argparse
import itertools
import json
import os
import sys
import threading
import uuid

from pydicom.dataset import Dataset
from pynetdicom import AE, evt, _config
from pynetdicom.sop_class import ModalityWorklistInformationFind, Verification

# No identifier in any log line (the library logs them by default).
_config.LOG_REQUEST_IDENTIFIERS = False
_config.LOG_RESPONSE_IDENTIFIERS = False
_config.LOG_HANDLER_LEVEL = 'none'

CANCEL = 0xFE00
UNAVAILABLE = 0xC001
INVALID = 0xA900

_out = threading.Lock()
_waiting = {}
_waiting_lock = threading.Lock()
_boot = uuid.uuid4().hex[:12]
_ids = itertools.count(1)


def send(message):
    line = json.dumps(message, ensure_ascii=True, separators=(',', ':')) + '\n'
    with _out:
        sys.stdout.write(line)
        sys.stdout.flush()


def read_answers():
    """Hands each answer line to the query that waits for it; a line nobody waits for is dropped."""
    for line in sys.stdin:
        try:
            answer = json.loads(line)
        except ValueError:
            continue
        if not isinstance(answer, dict) or not isinstance(answer.get('id'), str):
            continue
        with _waiting_lock:
            slot = _waiting.get(answer['id'])
        if slot is not None:
            slot['answer'] = answer
            slot['done'].set()


def text(value):
    if isinstance(value, bytes):
        value = value.decode('ascii', 'replace')
    return str(value or '').strip()


def on_find(event, answer_seconds):
    if event.is_cancelled:
        yield CANCEL, None
        return
    try:
        identifier = event.identifier.to_json_dict()
    except Exception:
        yield INVALID, None
        return
    rid = _boot + ':' + str(next(_ids))
    slot = {'done': threading.Event(), 'answer': None}
    with _waiting_lock:
        _waiting[rid] = slot
    try:
        send({'type': 'find', 'id': rid, 'calling': text(event.assoc.requestor.ae_title),
              'called': text(event.assoc.acceptor.ae_title), 'identifier': identifier})
        waited = 0.0
        while not slot['done'].wait(0.2):
            waited += 0.2
            if event.is_cancelled:
                yield CANCEL, None
                return
            if waited >= answer_seconds:
                yield UNAVAILABLE, None
                return
    finally:
        with _waiting_lock:
            _waiting.pop(rid, None)
    answer = slot['answer']
    status = answer.get('status')
    if not isinstance(status, int):
        yield UNAVAILABLE, None
        return
    if status != 0:
        yield status, None
        return
    pending = 0xFF01 if answer.get('warning') else 0xFF00
    items = answer.get('items') or []
    try:
        datasets = [Dataset.from_json(item) for item in items]
    except Exception:
        yield UNAVAILABLE, None
        return
    for ds in datasets:
        if event.is_cancelled:
            yield CANCEL, None
            return
        yield pending, ds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--aet', required=True)
    parser.add_argument('--answer-seconds', type=float, default=10)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()

    ae = AE(ae_title=args.aet)
    # An association addressed to another AE Title is rejected (called AE title not recognised).
    ae.require_called_aet = True
    ae.add_supported_context(ModalityWorklistInformationFind)
    ae.add_supported_context(Verification)
    handlers = [(evt.EVT_C_FIND, on_find, [args.answer_seconds])]
    try:
        server = ae.start_server((args.host, args.port), block=False, evt_handlers=handlers)
    except Exception as error:   # the port is taken or not allowed
        send({'type': 'bind_failed', 'error': type(error).__name__ + ': ' + str(error)[:160]})
        sys.exit(3)
    send({'type': 'listening', 'port': args.port})
    reader = threading.Thread(target=read_answers, daemon=True)
    reader.start()
    reader.join()
    # stdin closed: the API is gone, so is every answer; end the associations with it.
    server.shutdown()
    os._exit(0)


if __name__ == '__main__':
    main()
