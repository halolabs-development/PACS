"""S4-EG1 Gateway stability end to end: the real agent and hospital Orthanc against the whole KIN stack.

One class, six fixed methods, dispatch only: .github/workflows/gateway-e2e.yml runs tests/measurement_ci.py --profile
gateway-e2e, which runs this module through scripts/run-tests.py (LiveStack refuses any other entry). It evidences the
existing implementation and changes no product file; a product defect it finds is stopped and reported, not worked
around. The local C-6 verification script is neither imported nor executed (D-2): it cannot run on a hosted runner.

This module only records what it observes. tests/gateway_pipeline_judge.py decides every assertion ID, after each block
here and again offline over the uploaded evidence. Requirement -> risk -> test (contract sections 1 and 4):
  R1  C-STORE reaches the worklist as Unverified, K = M = N    silent loss or wrong owner            N-1..N-5
  R2  a late instance sends only the delta                     duplicate or lost SOP                 N-6, B-4
  R3  batching targets 24 MiB; larger objects pass alone       body refused or split wrongly         B-1, B-4
  R4  outage: hospital receive continues, retry, recovery      false progress, lost instances        B-2, B-4, B-5
  R5  graceful and crash restart keep rows, SOPs and epoch     a lost queue is a refused new epoch   B-3, B-5, R-3, R-4, R-10
  R6  Now Retry reaches the poll and pulls next_at forward     a request that is never applied       R-5..R-9
  R7  no duplicate rows after any re-send                      duplicates after retry or crash       R-8, X-1
  R8  a large object arrives, then a late slice converges     retry storm or hidden failure         F-1..F-8
  R9  agent logs carry UIDs and counts only                    patient data in logs                  X-4
  R10 producer stops before the consumer is cleaned            recreated rows, leftover resources    T-1..T-5
  R11 bound sources, exact selection, offline re-judgement     an unbound or partial pass            S-1, S-2, X-5
  R12 Gateway settings: a rule sends a study to KIN and a       success at one destination written    G-1..G-7
      hospital PACS, each with its own success; a copy is        as another's; a copy deleted while a
      kept while a destination lacks it and deleted after;       destination lacks it; lossy or changed
      lossless compression keeps every pixel                     pixels; a routed peer removed
"""
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

import gateway_pipeline_judge as judge
from invariants_live import Fixture, LiveStack, psql


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'tests' / 'e2e' / 'artifacts' / 'gateway-e2e-ci'
GATEWAY_COMPOSE = ROOT / 'gateway' / 'docker-compose.yml'
AGENT_SOURCE = ROOT / 'gateway' / 'agent' / 'agent.py'
SEND_CSTORE = ROOT / 'scripts' / 'send_cstore.py'
# A3: tests/measurement_ci.py reads this beside the evidence when a killed suite never reached its class cleanup.
HANDOFF = 'gateway-project.json'
# The agent reaches KIN only through nginx on its own network, as in production (outbound 443 only).
KIN_BASE_URL = 'https://kin-cloud'
CLOUD_ALIAS = 'kin-cloud'
PROXY = 'kin-proxy'
CLOUD_ORTHANC = 'kin-orthanc'
INSTITUTION = judge.INSTITUTION
DICOM_PORT = 14243
ORTHANC_HTTP_PORT = 18043
GATEWAY_USER = 'agent'
# D-4 with A1: test timing only. The flat 90 s backoff gives Block R a ~60 s Now Retry window over two 30 s polls;
# production defaults (5/300, STOW 300, StableAge 10) and their post-outage receipt lag (O-3) stay not proven.
AGENT_ENV = {
    'GW_STABLE_AGE': '5', 'GW_POLL_SECONDS': '1', 'GW_HTTP_TIMEOUT_SECONDS': '10', 'GW_STOW_TIMEOUT_SECONDS': '30',
    'GW_BACKOFF_BASE_SECONDS': '90', 'GW_BACKOFF_MAX_SECONDS': '90', 'GW_BYTE_BUDGET_MIB': '24',
}
# Contract section 5 with A1 (B 290 -> 320, R 205 -> 235); their sum plus a 45 s teardown margin is the suite cap. Block G
# waits for the settings read (60 s) and the independent forward retry (90 s).
DEADLINES = {'setup': 240, 'fixtures': 60, 'N': 90, 'B': 320, 'R': 235, 'F': 90, 'X': 180, 'G': 360}
# After Block G (not a block: no scenario ID): the DICOM receive self-check over two 30 s beats (each C-ECHO bounded by
# 5 s) and one admin Operations read.
LISTENER_CHECK_SECONDS = 75
# Block G's hospital PACS: a second Orthanc of the same image on the Gateway's own networks, labelled into the Gateway
# project so its residue is the project's. The Gateway reaches it by an alias on the local network only, so detaching
# that network is a destination that is down.
PEER_IMAGE = 'orthancteam/orthanc:24.12.0'
# The institution of the test Gateway credential: the group LiveStack.service_identity('gateway') puts it in (its client
# name carries a test suffix, so it is not derived from the name). Block G's administrator belongs to the same one.
GATEWAY_GROUP = 'kin-center'
PEER_AET = 'EG1PEER'
PEER_ALIAS = 'eg1-peer'
PEER_HTTP_PORT = 18044
NATIVE_SYNTAX = '1.2.840.10008.1.2.1'
MIN_FREE_DISK = 4 * 1024 ** 3
MIN_MEM_AVAILABLE = 1536 * 1024 ** 2
RESOLVE_PROBE = '''import json, socket
found = {}
for name in %r:
    try:
        socket.getaddrinfo(name, 443)
        found[name] = True
    except OSError:
        found[name] = False
print(json.dumps(found))'''


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def lit(value):
    return "'" + str(value).replace("'", "''") + "'"


def scrubbed_environment():
    # F-EG1-3: measurement_ci exports the main stack's COMPOSE_PROJECT_NAME, which Compose ranks above the file's name:.
    # Without this and the explicit -p, the Gateway project's down would take the main stack's containers as its own.
    return {key: value for key, value in os.environ.items() if not key.startswith('COMPOSE_')}


class GatewayPipelineLive(unittest.TestCase):
    blocked = None   # the first failed method: every later one fails on it at once and is never skipped
    passed = False

    @classmethod
    def setUpClass(cls):
        cls.ev = {'schema': judge.SCHEMA, 'agent_env': dict(AGENT_ENV), 'markers': {'names': [], 'ids': []},
                  'setup': {}, 'agent_log': {'stdout': [], 'stderr': []}}
        cls.hidden = []
        cls.stack = cls.work = cls.env_file = cls.client_uuid = cls.project = None
        cls.proxy_attached = False
        # One cleanup, registered before the first resource: a failing setUpClass skips tearDownClass, and the
        # cleanup releases whatever part of the setup exists.
        cls.addClassCleanup(cls.teardown)
        deadline = time.monotonic() + DEADLINES['setup']
        cls.preflight()
        cls.work = Path(os.environ['RUNNER_TEMP']) / ('kin-eg1-' + secrets.token_hex(6))
        cls.work.mkdir()
        cls.stack = LiveStack()
        cls.stack.require_stack()
        identity = cls.stack.service_identity('gateway')
        cls.client_uuid = identity['id']
        cls.gateway_password = secrets.token_hex(24)
        cls.hidden += [cls.gateway_password, identity['secret']]
        cls.project = 'kin-eg1-gw-' + secrets.token_hex(6)
        cls.agent, cls.gw_orthanc = cls.project + '-agent', cls.project + '-orthanc'
        cls.peer = cls.project + '-peer'
        cls.cloud_network = cls.project + '-cloud'
        cls.ev['setup']['project'] = cls.project
        cls.write_env_file(identity['client_id'], identity['secret'])
        cls.write_artifact(HANDOFF, {'project': cls.project, 'cloud_network': cls.cloud_network, 'agent': cls.agent,
                                     'orthanc': cls.gw_orthanc})
        cls.compose('build', 'gw-agent', timeout=cls.left(deadline))
        # Created, not started: the proxy alias exists before the agent's first cloud call.
        cls.compose('up', '--no-start', timeout=cls.left(deadline))
        cls.docker('network', 'connect', '--alias', CLOUD_ALIAS, cls.cloud_network, PROXY)
        cls.proxy_attached = True
        # The hospital Orthanc answers before the agent starts, so the agent's first change-feed read is no agent.retry.
        cls.compose('start', 'gw-orthanc', timeout=cls.left(deadline))
        cls.until('gw-orthanc ready', deadline, cls.gateway_ready)
        cls.compose('start', 'gw-agent', timeout=cls.left(deadline))
        cls.wait_event('agent.started', deadline, event='agent.started')
        setup = cls.ev['setup']
        inside = cls.docker('exec', cls.agent, 'python', '-c',
                            "import hashlib; print(hashlib.sha256(open('/app/agent.py', 'rb').read()).hexdigest())")
        setup['agent_sha256'] = {'checkout': hashlib.sha256(AGENT_SOURCE.read_bytes()).hexdigest(),
                                 'container': inside.stdout.strip()}
        probe = RESOLVE_PROBE % (tuple(judge.RESOLVE),)
        setup['resolve'] = json.loads(cls.docker('exec', cls.agent, 'python', '-c', probe, timeout=90).stdout)
        started = time.monotonic()
        cls.write_fixtures()
        setup['fixtures_seconds'] = round(time.monotonic() - started, 1)
        if setup['fixtures_seconds'] > DEADLINES['fixtures']:
            raise AssertionError('fixtures: over the %d s deadline' % DEADLINES['fixtures'])
        failed = judge.judge({'scenario': cls.ev}, ids=judge.BLOCK_IDS['setup'])
        if failed:
            raise AssertionError('setup assertions failed: ' + ', '.join(failed))
        setup['complete'] = True

    # ── resources and reads ──────────────────────────────────────────────────────────────────────────────────────

    @classmethod
    def preflight(cls):
        # Guards, not measurements (contract section 5): refuse to start the Gateway on a runner without room for it.
        free = shutil.disk_usage('/').free
        meminfo = Path('/proc/meminfo').read_text(encoding='ascii').splitlines()
        available = next(int(line.split()[1]) * 1024 for line in meminfo if line.startswith('MemAvailable:'))
        cls.ev['setup']['preflight'] = {'disk_free': free, 'mem_available': available}
        if free < MIN_FREE_DISK or available < MIN_MEM_AVAILABLE:
            raise RuntimeError('runner below the preflight guard: %d bytes free, %d bytes available' % (free, available))

    @classmethod
    def write_env_file(cls, client_id, client_secret):
        values = {
            'GW_PROJECT_NAME': cls.project, 'GW_ORTHANC_CONTAINER': cls.gw_orthanc, 'GW_AGENT_CONTAINER': cls.agent,
            'GW_LOCAL_NETWORK': cls.project + '-local', 'GW_CLOUD_NETWORK': cls.cloud_network,
            'GW_INGRESS_NETWORK': cls.project + '-ingress', 'GW_ORTHANC_USER': GATEWAY_USER,
            'GW_ORTHANC_PASS': cls.gateway_password, 'GW_DICOM_BIND': '127.0.0.1', 'GW_DICOM_PORT': str(DICOM_PORT),
            'GW_ORTHANC_HTTP_PORT': str(ORTHANC_HTTP_PORT), 'KIN_BASE_URL': KIN_BASE_URL, 'KIN_CLIENT_ID': client_id,
            # The CI stack's certificate is self-signed (gateway/README.md:63-64); trusted-CA TLS stays not proven.
            'KIN_CLIENT_SECRET': client_secret, 'KIN_TLS_VERIFY': 'false', **AGENT_ENV,
        }
        cls.env_file = cls.work / 'gateway.env'
        descriptor = os.open(cls.env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(''.join('%s=%s\n' % item for item in values.items()))

    @classmethod
    def write_fixtures(cls):
        # Synthetic CT only, written under RUNNER_TEMP and never uploaded (T-5). 512x512 16-bit slices make exactly 47
        # per 24 MiB batch (contract section 4); one 3600x3600 slice's 25,920,000 pixel bytes exceed the instance limit.
        import numpy as np
        from pydicom.dataset import FileDataset, FileMetaDataset
        from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

        def series(folder, count, size, pattern=False):
            folder.mkdir()
            study, series_uid, frame = (generate_uid() for _ in range(3))
            for z in range(count):
                sop = generate_uid()
                meta = FileMetaDataset()
                meta.TransferSyntaxUID = ExplicitVRLittleEndian
                meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID = CTImageStorage, sop
                meta.ImplementationClassUID = generate_uid()
                ds = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
                ds.is_little_endian, ds.is_implicit_VR = True, False
                ds.SOPClassUID, ds.SOPInstanceUID = CTImageStorage, sop
                ds.PatientName, ds.PatientID = 'SYNTHETIC^EG1', 'SYNTHETIC-EG1'
                ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.FrameOfReferenceUID = study, series_uid, frame
                ds.StudyDate, ds.StudyTime, ds.Modality = '20260925', '120000', 'CT'
                ds.SeriesNumber, ds.InstanceNumber = 1, z + 1
                ds.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
                ds.ImageOrientationPatient, ds.ImagePositionPatient = [1, 0, 0, 0, 1, 0], [0, 0, z * 2]
                ds.PixelSpacing, ds.SliceThickness = [1, 1], 2
                ds.Rows = ds.Columns = size
                ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, 'MONOCHROME2'
                ds.BitsAllocated = ds.BitsStored = 16
                ds.HighBit, ds.PixelRepresentation = 15, 0
                ds.RescaleSlope, ds.RescaleIntercept = 1, -1000
                if pattern:   # Block G: varied pixels, so a lossless round trip is a real comparison
                    values = (np.arange(size * size, dtype='<u4').reshape(size, size) * 7919 + z * 31) % 4096
                    ds.PixelData = values.astype('<u2').tobytes()
                else:
                    ds.PixelData = np.full((size, size), 1000 + z, dtype='<u2').tobytes()
                ds.save_as(folder / ('%03d.dcm' % z), write_like_original=False)

        cls.small, cls.batch, cls.big = cls.work / 'small', cls.work / 'batch', cls.work / 'big'
        cls.routed = cls.work / 'routed'
        series(cls.small, 1, 256)
        series(cls.batch, 48, 512)
        series(cls.big, 1, 3600)
        series(cls.routed, 2, 256, pattern=True)

    @classmethod
    def write_artifact(cls, name, value):
        # Exclusive: evidence is written once and never replaced. Neither secret reaches an artifact, and no mask
        # command is printed either: measurement_ci captures this suite's output into the uploaded log.
        text = cls.redact(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))
        with (OUT / name).open('x', encoding='utf-8') as stream:
            stream.write(text + '\n')

    @classmethod
    def redact(cls, text):
        for secret in cls.hidden:
            text = text.replace(secret, '[REDACTED]')
        return text

    @staticmethod
    def left(deadline):
        return max(1.0, deadline - time.monotonic())

    @classmethod
    def docker(cls, *args, timeout=60, check=True):
        done = subprocess.run(['docker', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
                              errors='replace', timeout=timeout)
        if check and done.returncode:
            raise RuntimeError(cls.redact('docker %s exited %d: %s' % (args[0], done.returncode,
                                                                       (done.stdout + done.stderr)[-1500:])))
        return done

    @classmethod
    def compose(cls, *args, timeout=240):
        done = subprocess.run(['docker', 'compose', '-p', cls.project, '--env-file', str(cls.env_file),
                               '-f', str(GATEWAY_COMPOSE), *args], cwd=ROOT, env=scrubbed_environment(),
                              capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
        if done.returncode:
            raise RuntimeError(cls.redact('gateway compose %s exited %d: %s' % (args[0], done.returncode,
                                                                              (done.stdout + done.stderr)[-1500:])))
        return done

    @classmethod
    def inspect(cls, name, field):
        # State and network attachment only: the container environment holds the secrets and is never read.
        return json.loads(cls.docker('inspect', '--format', '{{json .%s}}' % field, name).stdout)

    @classmethod
    def attached(cls):
        return cls.cloud_network in (cls.inspect(cls.agent, 'NetworkSettings.Networks') or {})

    @classmethod
    def agent_log(cls):
        done = cls.docker('logs', '--timestamps', cls.agent)
        cls.ev['agent_log'] = {'stdout': done.stdout.splitlines(), 'stderr': done.stderr.splitlines()}
        return judge.events(cls.ev)

    @classmethod
    def until(cls, what, deadline, probe):
        # One bounded observation: the same read until the block deadline, never a retried operation.
        while True:
            value = probe()
            if value:
                return value
            if time.monotonic() >= deadline:
                raise AssertionError(what + ': not observed before the deadline')
            time.sleep(1)

    @classmethod
    def wait_event(cls, what, deadline, **match):
        return cls.until(what, deadline, lambda: judge.pick(cls.agent_log(), **match))

    @classmethod
    def gateway_orthanc(cls, method, path, body=None):
        token = base64.b64encode(('%s:%s' % (GATEWAY_USER, cls.gateway_password)).encode('ascii')).decode('ascii')
        headers = {'Authorization': 'Basic ' + token}
        if body is not None:
            headers['Content-Type'] = 'text/plain'
        request = Request('http://127.0.0.1:%d%s' % (ORTHANC_HTTP_PORT, path), data=body, headers=headers,
                          method=method)
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))

    @classmethod
    def gateway_ready(cls):
        try:
            cls.gateway_orthanc('GET', '/system')
            return True
        except (OSError, ValueError):
            return False

    @classmethod
    def local_instances(cls, uid):
        found = []
        for item in cls.gateway_orthanc('POST', '/tools/lookup', uid.encode('ascii')):
            if item.get('Type') == 'Study':
                for row in cls.gateway_orthanc('GET', '/studies/%s/instances' % quote(item['ID'])):
                    found.append({'sop': row['MainDicomTags']['SOPInstanceUID'], 'size': int(row['FileSize'])})
        return found

    def local_sops(self, uid):
        return [item['sop'] for item in self.local_instances(uid)]

    def cloud_sops(self, uid):
        lookup = self.stack._orthanc_request('POST', '/tools/lookup', uid.encode('ascii'))
        self.assertEqual(lookup.status, 200, lookup.text[:500])
        sops = []
        for item in lookup.body:
            if item.get('Type') == 'Study':
                listed = self.stack._orthanc_request('GET', '/studies/%s/instances' % quote(item['ID']))
                self.assertEqual(listed.status, 200, listed.text[:500])
                sops += [row['MainDicomTags']['SOPInstanceUID'] for row in listed.body]
        return sops

    def row(self, uid):
        # The worklist exactly as a kin-center technician reads it (GET /api/studies calls QIDO).
        listed = self.stack.request('GET', '/studies', 'ktech')
        self.assertEqual(listed.status, 200, listed.text[:500])
        rows = [row for row in listed.body['studies'] if row['uid'] == uid]
        if len(rows) != 1:
            return None
        return {'uid': uid, 'count': rows[0]['count'], 'institutionName': rows[0]['institutionName'],
                'ss': rows[0]['state']['ss'], 'gatewayReceipt': rows[0]['gatewayReceipt']}

    def row_with(self, uid, phase, success, local):
        row = self.row(uid)
        receipt = row['gatewayReceipt'] if row else None
        if receipt and (receipt['phase'], receipt['successCount'], receipt['localCount']) == (phase, success, local):
            return row
        return None

    def observed(self, uid):
        listed = self.stack.request('GET', '/studies', 'ktech')
        self.assertEqual(listed.status, 200, listed.text[:500])
        absent = [item for item in listed.body.get('notObserved') or [] if item.get('uid') == uid]
        entry = absent[0] if len(absent) == 1 else None
        return {'in_studies': any(row['uid'] == uid for row in listed.body['studies']), 'not_observed': entry,
                # A4: S4-F01V may attach the receipt projection here; it is recorded as data and never judged.
                'receipt_projection_present': bool(entry and entry.get('gatewayReceipt'))}

    def audits(self, uid):
        return psql('SELECT action FROM "AuditLog" WHERE target=%s ORDER BY id' % lit(uid))

    def retry_rows(self, uid):
        return int(psql('SELECT count(*) FROM "GatewayRetryRequest" WHERE "studyUid"=%s' % lit(uid))[0])

    def db_receipt(self, uid, local):
        rows = [json.loads(row) for row in
                psql('SELECT to_jsonb(t)::text FROM "GatewayReceipt" t WHERE "studyUid"=%s' % lit(uid))]
        if len(rows) == 1 and rows[0]['phase'] == 'complete' and rows[0]['localCount'] == local:
            return {key: rows[0][key] for key in ('phase', 'errorCode', 'successCount', 'localCount', 'epoch', 'seq')}
        return None

    @classmethod
    def status_row(cls, uid):
        summary = json.loads(cls.docker('exec', cls.agent, 'python', '/app/agent.py', 'status',
                                        '--db', '/data/queue.db').stdout)
        rows = [row for row in summary['rows'] if row['uid'] == uid]
        return rows[0] if len(rows) == 1 else None

    def sending(self, uid):
        row = self.status_row(uid)
        return row if row and row['phase'] == 'sending' else None

    # ── Block G helpers ──────────────────────────────────────────────────────────────────────────────────────────

    @staticmethod
    def pixel_digest(raw):
        # The pixel bytes of one uncompressed DICOM file as one digest: equal digests are equal pixels, bit for bit.
        import io
        import pydicom
        return 'sha256:' + hashlib.sha256(pydicom.dcmread(io.BytesIO(raw)).PixelData).hexdigest()

    @classmethod
    def raw_get(cls, url, headers=None):
        with urlopen(Request(url, headers=headers or {}), timeout=60) as response:
            return response.read()

    @classmethod
    def local_digests(cls, uid):
        # As the hospital sent them: the Gateway Orthanc stores the C-STORE bytes as they came (uncompressed).
        token = base64.b64encode(('%s:%s' % (GATEWAY_USER, cls.gateway_password)).encode('ascii')).decode('ascii')
        found = {}
        for item in cls.gateway_orthanc('POST', '/tools/lookup', uid.encode('ascii')):
            if item.get('Type') == 'Study':
                for row in cls.gateway_orthanc('GET', '/studies/%s/instances' % quote(item['ID'])):
                    raw = cls.raw_get('http://127.0.0.1:%d/instances/%s/file' % (ORTHANC_HTTP_PORT, quote(row['ID'])),
                                      {'Authorization': 'Basic ' + token})
                    found[row['MainDicomTags']['SOPInstanceUID']] = cls.pixel_digest(raw)
        return found

    def listener_row(self, admin):
        """This Gateway's newest line in the admin's Gateway Status (the stack's only Gateway of the institution)."""
        answer = self.stack.request('GET', '/admin/gateway-status', admin)
        self.assertEqual(answer.status, 200, answer.text[:500])
        recent = [row for row in answer.body['gateways'] if row['contact'] == 'recent']
        return recent[0] if recent else None

    def receive_check_and_server_status(self, admin):
        """After Block G, on the same stack: the DICOM receive self-check against the real hospital Orthanc (Accepted:
        the agent's own C-ECHO was accepted by Orthanc's DICOM listener), and the admin Operations answer (Server Status
        and this institution's storage) against the real KIN services.

        The No Answer side is not run here: pausing the hospital Orthanc also fails the agent's main-loop reads
        (agent.retry), which X-2 rightly forbids over the whole run. The agent cases cover it against real sockets.
        """
        deadline = time.monotonic() + LISTENER_CHECK_SECONDS
        record = {}
        newer = lambda result, after: (lambda: (lambda row: row if row and row['dicomListener']
            and row['dicomListener']['result'] == result and (after is None or row['dicomListener']['observedAt'] > after)
            else None)(self.listener_row(admin)))
        first = self.until('DICOM listener Accepted', deadline, newer('accepted', None))
        record['accepted'] = first['dicomListener']
        self.assertEqual(first['localOrthanc']['answered'], True)
        # The admin Operations answer: every server component answered this request; uptimes as they report them.
        metrics = self.stack.request('GET', '/admin/metrics', admin)
        self.assertEqual(metrics.status, 200, metrics.text[:500])
        server = {row['component']: row for row in metrics.body['server']}
        record['server'] = server
        self.assertEqual(sorted(server), ['api', 'database', 'image_store', 'login_server'])
        self.assertEqual({key: row['answer'] for key, row in server.items()}, dict.fromkeys(server, 'answered'))
        for key in ('api', 'image_store', 'database'):
            self.assertEqual(server[key]['uptime']['state'], 'observed', key)
            self.assertIsInstance(server[key]['uptime']['seconds'], int, key)
        self.assertEqual(server['login_server']['uptime']['reason'], 'no_source')
        # This institution's storage: exactly the DiskSize of the Study resources of its own original studies.
        institution = metrics.body['institutionId']
        owned = psql('SELECT s.uid FROM "StudyState" s WHERE s."institutionId" = %s AND NOT EXISTS (SELECT 1 FROM '
                     '"StudyGroupMember" m WHERE m."logicalUid" = s.uid AND m."logicalUid" <> m."studyUid")' % lit(institution))
        expected = 0
        for uid in owned:
            lookup = self.stack._orthanc_request('POST', '/tools/lookup', uid.encode('ascii'))
            self.assertEqual(lookup.status, 200, lookup.text[:500])
            for item in [item for item in lookup.body if item.get('Type') == 'Study']:
                stats = self.stack._orthanc_request('GET', '/studies/%s/statistics' % quote(item['ID']))
                self.assertEqual(stats.status, 200, stats.text[:500])
                expected += int(stats.body['DiskSize'])
        storage = next(row for row in metrics.body['metrics'] if row['key'] == 'storage.institution')
        record['storage'] = {'owned': len(owned), 'expected': expected, 'row': storage}
        self.assertTrue(owned and expected > 0, 'the institution owns the studies this suite sent')
        self.assertEqual((storage['state'], storage['value']), ('observed', expected))
        # A later beat checks again: a newer Accepted, never the first result carried over.
        again = self.until('DICOM listener checked again', deadline, newer('accepted', record['accepted']['observedAt']))
        record['again'] = again['dicomListener']
        self.write_artifact('receive-check.json', record)

    def cloud_instances(self, uid):
        lookup = self.stack._orthanc_request('POST', '/tools/lookup', uid.encode('ascii'))
        self.assertEqual(lookup.status, 200, lookup.text[:500])
        found = {}
        for item in lookup.body:
            if item.get('Type') == 'Study':
                listed = self.stack._orthanc_request('GET', '/studies/%s/instances' % quote(item['ID']))
                self.assertEqual(listed.status, 200, listed.text[:500])
                found.update({row['MainDicomTags']['SOPInstanceUID']: row['ID'] for row in listed.body})
        return found

    def peer_digests(self, uid):
        found = {}
        lookup = json.loads(self.raw_get_post('/tools/lookup', uid.encode('ascii')))
        for item in lookup:
            if item.get('Type') == 'Study':
                for row in json.loads(self.raw_get('http://127.0.0.1:%d/studies/%s/instances' % (PEER_HTTP_PORT, quote(item['ID'])))):
                    raw = self.raw_get('http://127.0.0.1:%d/instances/%s/file' % (PEER_HTTP_PORT, quote(row['ID'])))
                    found[row['MainDicomTags']['SOPInstanceUID']] = self.pixel_digest(raw)
        return found

    def raw_get_post(self, path, body):
        request = Request('http://127.0.0.1:%d%s' % (PEER_HTTP_PORT, path), data=body,
                          headers={'Content-Type': 'text/plain'}, method='POST')
        with urlopen(request, timeout=30) as response:
            return response.read()

    @classmethod
    def peer_ready(cls):
        try:
            cls.raw_get('http://127.0.0.1:%d/system' % PEER_HTTP_PORT)
            return True
        except (OSError, ValueError):
            return False

    @classmethod
    def peer_on_local(cls):
        return cls.project + '-local' in (cls.inspect(cls.peer, 'NetworkSettings.Networks') or {})

    @classmethod
    def applied_revision(cls):
        # The settings the agent took, from the copy it keeps beside its queue (no environment is read).
        done = cls.docker('exec', cls.agent, 'python', '-c',
                          "import json; print(json.load(open('/data/settings.json'))['answer']['revision'])", check=False)
        return int(done.stdout.strip()) if done.returncode == 0 and done.stdout.strip().isdigit() else None

    @classmethod
    def restart(cls, grace):
        before = cls.inspect(cls.agent, 'State')['StartedAt']
        at = now()
        cls.docker('restart', '-t', str(grace), cls.agent, timeout=grace + 90)
        return at, before, cls.inspect(cls.agent, 'State')['StartedAt']

    @staticmethod
    def plan(instances):
        # EG2 E3 pattern: gateway/agent is not a package, so the agent's own planner is loaded from its file here and
        # only here; importing this module needs neither requests nor the agent.
        import importlib.util
        spec = importlib.util.spec_from_file_location('eg1_gateway_agent', AGENT_SOURCE)
        agent = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = agent   # @dataclass resolves its module through sys.modules while the body runs
        try:
            spec.loader.exec_module(agent)
        finally:
            sys.modules.pop(spec.name, None)
        ordered = sorted(instances, key=lambda item: item['sop'])   # the agent's own order (agent.py:449)
        return [len(batch) for batch in agent.plan_batches(ordered, judge.BUDGET)]

    @classmethod
    def cstore(cls, study, source, slices, offset):
        # Parts of one study share its UID and PatientID: another PatientID would split the hospital Orthanc study.
        done = subprocess.run([sys.executable, str(SEND_CSTORE), '--host', '127.0.0.1', '--port', str(DICOM_PORT),
                               '--called-aet', 'KINGW', '--calling-aet', 'KINC_CT', '--institution', INSTITUTION,
                               '--name', study['name'], '--id', study['pid'], '--desc', 'S4-EG1 synthetic',
                               '--slices', str(slices), '--source-dir', str(source), '--study-uid', study['uid'],
                               '--instance-offset', str(offset)],
                              cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180)
        counted = re.search(r'C-STORE 완료: 성공 (\d+) / 실패 (\d+)', done.stdout)
        return {'exit': done.returncode, 'ok': int(counted.group(1)) if counted else None,
                'fail': int(counted.group(2)) if counted else None}

    def new_study(self, block):
        mark = secrets.token_hex(4)
        study = {'uid': '2.25.' + str(uuid.uuid4().int), 'name': 'EG1SYN^' + mark.upper(), 'pid': 'EG1SYN-' + mark}
        self.ev['markers']['names'].append(study['name'])
        self.ev['markers']['ids'].append(study['pid'])
        # Owned before its first C-STORE, so the owned cleanup also covers a partial send.
        self.stack.active[study['uid']] = Fixture(study['uid'], study['pid'], INSTITUTION, 'kdoctor', '')
        self.ev[block] = {'uid': study['uid']}
        return study

    def sent(self, record, count, what):
        self.assertEqual(record, {'exit': 0, 'ok': count, 'fail': 0}, what)

    @contextmanager
    def block(self, name):
        cls = type(self)
        if cls.blocked:
            self.fail('blocked by ' + cls.blocked)
        try:
            yield time.monotonic() + DEADLINES[name]
            self.ev[name]['t_end'] = now()
            self.agent_log()
            self.assertEqual(judge.judge({'scenario': self.ev}, ids=judge.BLOCK_IDS[name]), [], name + ' block')
            self.ev[name]['complete'] = True
        except BaseException:
            cls.blocked = self._testMethodName
            raise

    # ── the five fixed methods ───────────────────────────────────────────────────────────────────────────────────

    def test_eg1_1_normal_transfer_and_late_delta(self):
        with self.block('N') as deadline:
            study = self.new_study('N')
            uid, block = study['uid'], self.ev['N']
            block['first'] = first = {'t_send': now()}
            first['cstore'] = self.cstore(study, self.small, 1, 0)
            self.sent(first['cstore'], 1, 'N-1')
            self.wait_event('N-2 study.complete', deadline, event='study.complete', uid=uid, after=first['t_send'])
            first['list'] = self.until('N-4 receipt complete 1/1', deadline,
                                       lambda: self.row_with(uid, 'complete', 1, 1))
            first['local'], first['cloud'], first['audit'] = self.local_sops(uid), self.cloud_sops(uid), self.audits(uid)
            # N-6: one more SOP of the same study and PatientID sends only itself.
            block['late'] = late = {'t_send': now()}
            late['cstore'] = self.cstore(study, self.small, 1, 1)
            self.sent(late['cstore'], 1, 'N-6')
            self.wait_event('N-6 study.complete', deadline, event='study.complete', uid=uid, after=late['t_send'])
            late['list'] = self.until('N-6 receipt complete 2/2', deadline, lambda: self.row_with(uid, 'complete', 2, 2))
            late['local'], late['cloud'], late['audit'] = self.local_sops(uid), self.cloud_sops(uid), self.audits(uid)

    def test_eg1_2_multibatch_outage_restart_resume(self):
        with self.block('B') as deadline:
            study = self.new_study('B')
            uid, block = study['uid'], self.ev['B']
            block['a'] = part = {'t_send': now()}
            part['cstore'] = self.cstore(study, self.batch, 47, 0)
            self.sent(part['cstore'], 47, 'B-1')
            self.wait_event('B-1 study.complete', deadline, event='study.complete', uid=uid, after=part['t_send'])
            delivered = self.local_instances(uid)
            part['local_sizes'] = [item['size'] for item in delivered]
            part['plan'] = self.plan(delivered)
            part['list'] = self.until('B-1 receipt complete 47/47', deadline,
                                      lambda: self.row_with(uid, 'complete', 47, 47))
            # B-2: the cloud link goes (marked before it goes); hospital receive must not notice.
            block['outage'] = outage = {'t_disconnect': now()}
            self.docker('network', 'disconnect', self.cloud_network, self.agent)
            outage['detached'] = not self.attached()
            outage['cstore'] = self.cstore(study, self.batch, 48, 47)
            self.sent(outage['cstore'], 48, 'B-2')
            self.wait_event('B-2 study.retry', deadline, event='study.retry', uid=uid, after=outage['t_disconnect'])
            outage['list'] = self.row(uid)
            # B-3: graceful restart during the outage (A5: -t 30, and the link must still be down afterwards).
            block['restart'] = restart = {}
            restart['t_restart'], restart['started_before'], restart['started_after'] = self.restart(30)
            self.wait_event('B-3 agent.started', deadline, event='agent.started', after=restart['t_restart'])
            restart['t_done'] = now()
            restart['status'] = self.status_row(uid)
            restart['detached_after'] = not self.attached()
            # B-4: the link returns; the row resumes at its own backoff with no operator action.
            block['reconnect'] = reconnect = {}
            self.docker('network', 'connect', self.cloud_network, self.agent)
            reconnect['t_reconnect'] = now()
            reconnect['attached'] = self.attached()
            first = {item['sop'] for item in delivered}
            reconnect['plan'] = self.plan([item for item in self.local_instances(uid) if item['sop'] not in first])
            self.wait_event('B-4 study.complete', deadline, event='study.complete', uid=uid,
                            after=reconnect['t_reconnect'])
            block['final'] = final = {}
            final['list'] = self.until('B-5 receipt complete 95/95', deadline,
                                       lambda: self.row_with(uid, 'complete', 95, 95))
            final['t_receipt_seen'] = now()
            final['local'], final['cloud'], final['audit'] = self.local_sops(uid), self.cloud_sops(uid), self.audits(uid)

    def test_eg1_3_storage_stall_crash_restart_now_retry(self):
        with self.block('R') as deadline:
            study = self.new_study('R')
            uid, block = study['uid'], self.ev['R']
            block['c1'] = first = {'t_send': now()}
            first['cstore'] = self.cstore(study, self.small, 1, 0)
            self.sent(first['cstore'], 1, 'R-1')
            self.wait_event('R-1 study.complete', deadline, event='study.complete', uid=uid, after=first['t_send'])
            first['list'] = self.until('R-1 receipt complete 1/1', deadline, lambda: self.row_with(uid, 'complete', 1, 1))
            # R-2: stall the cloud storage only. Announce, receipts and the retry routes never touch Orthanc; the
            # worklist does (QIDO), so nothing reads it until kin-orthanc runs again.
            block['stall'] = stall = {'t_pause': now()}
            self.docker('pause', CLOUD_ORTHANC)
            stall['paused'] = self.inspect(CLOUD_ORTHANC, 'State')['Paused'] is True
            stall['t_send'] = now()
            stall['cstore'] = self.cstore(study, self.small, 1, 1)
            self.sent(stall['cstore'], 1, 'R-2')
            stall['status'] = self.until('R-2 status sending', deadline, lambda: self.sending(uid))
            # R-3: kill the agent while its STOW waits on the paused storage (-t 0: no grace, no agent.stopped).
            block['crash'] = crash = {}
            crash['t_crash'], crash['started_before'], crash['started_after'] = self.restart(0)
            self.wait_event('R-3 agent.started', deadline, event='agent.started', after=crash['t_crash'])
            crash['t_done'] = now()
            crash['status'] = self.status_row(uid)
            self.wait_event('R-4 study.retry', deadline, event='study.retry', uid=uid, after=crash['t_crash'])
            block['retry_audit'] = self.audits(uid)
            self.docker('unpause', CLOUD_ORTHANC)
            block['t_unpause'] = now()
            block['unpaused'] = self.inspect(CLOUD_ORTHANC, 'State')['Paused'] is False
            block['retry_list'] = self.until('R-5 retry receipt', deadline, lambda: self.row_with(uid, 'retry', 1, 2))
            # R-6: one technician request; KIN binds it to the stored retry receipt.
            block['request'] = asked = {'t': now()}
            answer = self.stack.request('POST', '/studies/%s/gateway-retry' % quote(uid), 'ktech')
            asked['status'], asked['body'] = answer.status, answer.body
            block['request_audits'] = self.audits(uid).count('gateway.retry.request')
            self.wait_event('R-7 study.retry_now', deadline, event='study.retry_now', uid=uid, after=asked['t'])
            self.wait_event('R-8 study.complete', deadline, event='study.complete', uid=uid, after=asked['t'])
            block['final'] = final = {}
            final['list'] = self.until('R-9 receipt complete 2/2', deadline, lambda: self.row_with(uid, 'complete', 2, 2))
            polled = self.stack.bearer_request('GET', '/gateway/retry-requests?epoch='
                                               + quote(final['list']['gatewayReceipt']['epoch']),
                                               self.stack.service_token('gateway'))
            final['poll'] = {'status': polled.status, 'body': polled.body}
            again = self.stack.request('POST', '/studies/%s/gateway-retry' % quote(uid), 'ktech')
            final['second'] = {'status': again.status,
                               'code': again.body.get('code') if isinstance(again.body, dict) else None}
            final['request_audits'] = self.audits(uid).count('gateway.retry.request')
            final['local'], final['cloud'] = self.local_sops(uid), self.cloud_sops(uid)

    def test_eg1_4_oversized_f01_boundary_bounded_repeat(self):
        with self.block('F') as deadline:
            study = self.new_study('F')
            uid, block = study['uid'], self.ev['F']
            block['big'] = big = {'t_send': now()}
            big['cstore'] = self.cstore(study, self.big, 1, 0)
            self.sent(big['cstore'], 1, 'F-1')
            self.wait_event('F-2 study.complete', deadline, event='study.complete', uid=uid, after=big['t_send'])
            block['status'] = self.status_row(uid)
            block['db_receipt'] = self.until('F-3 complete receipt 1/1', deadline, lambda: self.db_receipt(uid, 1))
            block['list'] = self.observed(uid)
            answer = self.stack.request('POST', '/studies/%s/gateway-retry' % quote(uid), 'ktech')
            block['request'] = {'status': answer.status,
                                'code': answer.body.get('code') if isinstance(answer.body, dict) else None}
            block['request_rows'] = self.retry_rows(uid)
            block['request_audits'] = self.audits(uid).count('gateway.retry.request')
            block['cloud'] = self.cloud_sops(uid)
            block['local'] = self.local_sops(uid)
            # F-7: a later small slice joins the already delivered large object.
            block['normal'] = normal = {'t_send': now()}
            normal['cstore'] = self.cstore(study, self.small, 1, 1)
            self.sent(normal['cstore'], 1, 'F-7')
            self.wait_event('F-7 study.complete', deadline, event='study.complete', uid=uid, after=normal['t_send'])
            block['quiet'] = quiet = {'t_start': now()}
            normal['db_receipt'] = self.until('F-7 complete receipt 2/2', deadline, lambda: self.db_receipt(uid, 2))
            normal['cloud'], normal['audit'] = self.cloud_sops(uid), self.audits(uid)
            normal['local'] = self.local_sops(uid)
            # F-8: a bounded window of three StableAge-plus-poll periods, not a proof of never.
            time.sleep(max(0.0, judge.stamp(quiet['t_start']) + judge.QUIET + 1 - time.time()))
            quiet['t_end'] = now()

    def test_eg1_5_cross_study_convergence_and_negative_controls(self):
        with self.block('X'):
            self.ev['X'] = {'studies': {key: {'local': self.local_sops(self.ev[key]['uid']),
                                              'cloud': self.cloud_sops(self.ev[key]['uid'])}
                                        for key in ('N', 'B', 'R', 'F')}}

    def test_eg1_6_routing_kept_copies_and_lossless_compression(self):
        with self.block('G') as deadline:
            study = self.new_study('G')
            uid, block = study['uid'], self.ev['G']
            admin = 'eg1-gw-admin'
            try:
                self.stack.create_test_identity(admin, ['admin'], GATEWAY_GROUP)
            except Exception as error:   # the product's own refusal, kept as evidence (it names no patient value)
                read = getattr(error, 'read', None)
                block['identity_error'] = [type(error).__name__, getattr(error, 'code', None),
                                           (read().decode('utf-8', 'replace') if read else str(error))[:400],
                                           GATEWAY_GROUP]
                raise
            # The hospital PACS, registered as the institution's DICOM Peer, and the rule: CT -> KIN and that PACS.
            self.docker('run', '-d', '--rm', '--name', self.peer, '--label', 'com.docker.compose.project=' + self.project,
                        '--label', 'com.docker.compose.service=eg1-peer', '--network', self.project + '-ingress',
                        '-p', '127.0.0.1:%d:8042' % PEER_HTTP_PORT, '-e', 'ORTHANC__AUTHENTICATION_ENABLED=false',
                        '-e', 'ORTHANC__DICOM_AET=' + PEER_AET, '-e', 'ORTHANC__DICOM_ALWAYS_ALLOW_STORE=true',
                        '-e', 'ORTHANC__DICOM_CHECK_CALLED_AET=false', PEER_IMAGE, timeout=180)
            self.docker('network', 'connect', '--alias', PEER_ALIAS, self.project + '-local', self.peer)
            self.until('G peer ready', deadline, self.peer_ready)
            registered = self.stack.request('POST', '/admin/dicom-peers', admin,
                                            {'name': 'EG1 SYN PACS', 'aet': PEER_AET, 'host': PEER_ALIAS, 'port': 4242})
            peer_id = (registered.body or {}).get('peer', {}).get('id') if isinstance(registered.body, dict) else None
            block['peer'] = {'status': registered.status, 'id': peer_id, 'up': self.peer_on_local()}
            current = self.stack.request('GET', '/admin/gateway-settings', admin)
            self.assertEqual(current.status, 200, current.text[:500])
            routes = [{'modality': 'CT', 'sourceAe': None, 'destinations': ['kin', peer_id]}]
            saved = self.stack.request('PUT', '/admin/gateway-settings', admin, {
                'revision': current.body['settings']['revision'], 'routes': routes,
                'compression': 'lossless'})
            body = saved.body if isinstance(saved.body, dict) else {}
            settings = body.get('settings') or {}
            block['settings'] = {'status': saved.status, 'changed': body.get('changed'), 'revision': settings.get('revision'),
                                 'routes': settings.get('routes'),
                                 'compression': settings.get('compression')}
            revision = settings.get('revision')
            self.until('G-1 settings applied', deadline, lambda: self.applied_revision() == revision)
            block['applied'] = {'revision': self.applied_revision(), 't': now()}
            # G-4: the PACS is down (its alias leaves the local network) when the study comes.
            self.docker('network', 'disconnect', self.project + '-local', self.peer)
            block['down'] = {'t': now(), 'detached': not self.peer_on_local()}
            block['send'] = send = {'t_send': now()}
            send['cstore'] = self.cstore(study, self.routed, 2, 0)
            self.sent(send['cstore'], 2, 'G-2')
            self.wait_event('G-2 study.complete', deadline, event='study.complete', uid=uid, after=send['t_send'])
            block['kin'] = kin = {'t_complete': now()}
            kin['list'] = self.until('G-2 receipt complete 2/2', deadline, lambda: self.row_with(uid, 'complete', 2, 2))
            original = self.local_digests(uid)
            block['original'] = {'sops': sorted(original), 'pixels': [original[sop] for sop in sorted(original)]}
            # G-3: what KIN stores is JPEG Lossless; decoded by KIN's Orthanc it is the same pixels as sent.
            cloud = self.cloud_instances(uid)
            kin['cloud'] = sorted(cloud)
            kin['syntaxes'] = [self.stack._orthanc_request('GET', '/instances/%s/metadata/TransferSyntax'
                                                           % quote(cloud[sop])).text.strip() for sop in sorted(cloud)]
            kin['pixels'] = [self.pixel_digest(self.stack.orthanc_bytes('/instances/%s/file?transcode=%s'
                                                                        % (quote(cloud[sop]), NATIVE_SYNTAX)))
                             for sop in sorted(cloud)]
            self.wait_event('G-4 forward.retry', deadline, event='forward.retry', uid=uid, after=send['t_send'])
            block['hold'] = {'local': self.local_sops(uid), 'peer_sops': sorted(self.peer_digests(uid)), 't': now()}
            # The peer's next attempt can start as soon as its network is reattached.
            reconnect = now()
            self.docker('network', 'connect', '--alias', PEER_ALIAS, self.project + '-local', self.peer)
            block['up'] = {'t': reconnect, 'attached': self.peer_on_local()}
            self.wait_event('G-5 forward.complete', deadline, event='forward.complete', uid=uid, after=block['up']['t'])
            received = self.peer_digests(uid)
            block['peer_received'] = {'sops': sorted(received), 'pixels': [received[sop] for sop in sorted(received)]}
            block['copies'] = {'local': self.local_sops(uid), 'cloud': self.cloud_sops(uid), 't': now()}
            # G-7: the routed peer is kept until the rule goes; then the settings are emptied again.
            refused = self.stack.request('DELETE', '/admin/dicom-peers/' + quote(str(peer_id)), admin)
            block['refuse'] = {'status': refused.status,
                               'code': refused.body.get('code') if isinstance(refused.body, dict) else None}
            cleared = self.stack.request('PUT', '/admin/gateway-settings', admin, {
                'revision': revision, 'routes': [], 'compression': 'none'})
            block['cleared'] = {'status': cleared.status,
                                'revision': (cleared.body.get('settings') or {}).get('revision')
                                if isinstance(cleared.body, dict) else None}
        self.receive_check_and_server_status('eg1-gw-admin')
        # X-5: every block is complete and every scenario ID holds together; the T IDs follow the teardown, offline.
        self.assertEqual(judge.judge({'scenario': self.ev}, ids=judge.SCENARIO_IDS), [], 'X-5')
        type(self).passed = True

    # ── teardown ─────────────────────────────────────────────────────────────────────────────────────────────────

    @classmethod
    def teardown(cls):
        """Capture, restore, then producer before consumer (contract section 8); every step runs, every failure counts."""
        errors = []
        record = {'schema': judge.TEARDOWN_SCHEMA}

        def step(name, action):
            try:
                action()
            except Exception as error:   # keep going: a later step may still release an owned resource
                errors.append(cls.redact('%s: %s: %s' % (name, type(error).__name__, error))[:1500])

        created = cls.env_file is not None
        if created:
            step('agent log', cls.agent_log)
            if not cls.passed:
                step('diagnostics', cls.capture_diagnostics)
        if cls.stack is not None:
            # The stall ends before anything stops: kin-orthanc serves the owned cleanup below. The agent is not
            # reconnected, it is removed next.
            step('unpause', cls.restore_cloud_orthanc)
        step('scenario evidence', lambda: cls.write_artifact('scenario-evidence.json', cls.ev))
        if cls.proxy_attached:
            step('proxy detach', lambda: cls.docker('network', 'disconnect', cls.cloud_network, PROXY))
        if created:
            # Block G's hospital PACS (labelled into the Gateway project; removing it is a no-op when G never ran).
            step('peer', lambda: cls.docker('rm', '-f', cls.peer, check=False))
            # Producer before consumer: a running agent could re-announce and recreate a StudyState deleted below.
            step('gateway down', lambda: cls.compose('down', '-v', '--remove-orphans', timeout=180))
            step('gateway residue', lambda: record.update(gateway_project=cls.project_residue()))
        if cls.stack is not None:
            owned = sorted(cls.stack.active)
            step('owned cleanup', cls.stack.cleanup_all)
            step('owned residue', lambda: record.update(owned={uid: cls.owned_counts(uid) for uid in owned}))
            step('identities', cls.stack.cleanup_test_identities)
            if cls.client_uuid:
                step('gateway client', lambda: record.update(gateway_client={
                    'id': cls.client_uuid,
                    'status_after': cls.stack.kc_admin('GET', '/clients/' + quote(cls.client_uuid)).status}))
        step('fixtures', cls.remove_work)
        record['fixtures'] = {'dir_exists': bool(cls.work is not None and cls.work.exists()),
                              'dcm_in_artifacts': sorted(path.name for path in OUT.rglob('*.dcm'))}
        record['errors'] = errors
        step('teardown evidence', lambda: cls.write_artifact('teardown-evidence.json', record))
        if errors:
            raise RuntimeError('teardown incomplete: ' + '; '.join(errors))

    @classmethod
    def restore_cloud_orthanc(cls):
        if cls.inspect(CLOUD_ORTHANC, 'State').get('Paused'):
            cls.docker('unpause', CLOUD_ORTHANC)

    @classmethod
    def remove_work(cls):
        # Fixtures and the env file, after the Gateway project that needed the env file is down.
        if cls.work is not None and cls.work.exists():
            shutil.rmtree(cls.work)

    @classmethod
    def project_residue(cls):
        label = 'label=com.docker.compose.project=' + cls.project
        return {'project': cls.project,
                'containers': cls.docker('ps', '-aq', '--filter', label).stdout.split(),
                'volumes': cls.docker('volume', 'ls', '-q', '--filter', label).stdout.split(),
                'networks': cls.docker('network', 'ls', '-q', '--filter', label).stdout.split()}

    @classmethod
    def owned_counts(cls, uid):
        lookup = cls.stack._orthanc_request('POST', '/tools/lookup', uid.encode('ascii'))
        counts = {'orthanc_studies': len([item for item in lookup.body if item.get('Type') == 'Study'])
                  if lookup.status == 200 else None}
        for table, column in (('StudyState', 'uid'), ('GatewayReceipt', '"studyUid"'),
                              ('GatewayRetryRequest', '"studyUid"'), ('AuditLog', 'target')):
            counts[table] = int(psql('SELECT count(*) FROM "%s" WHERE %s=%s' % (table, column, lit(uid)))[0])
        return counts

    @classmethod
    def capture_diagnostics(cls):
        found = {}
        for name in (cls.agent, cls.gw_orthanc, CLOUD_ORTHANC, PROXY):
            try:
                found[name] = {'State': cls.inspect(name, 'State'),
                               'networks': sorted(cls.inspect(name, 'NetworkSettings.Networks') or {})}
            except Exception as error:
                found[name] = {'error': type(error).__name__}
        try:
            found['status'] = json.loads(cls.docker('exec', cls.agent, 'python', '/app/agent.py', 'status',
                                                    '--db', '/data/queue.db').stdout)
        except Exception as error:
            found['status'] = {'error': type(error).__name__}
        tail = cls.docker('logs', '--tail', '200', cls.gw_orthanc, check=False)
        text = tail.stdout + tail.stderr
        for marker in cls.ev['markers']['names'] + cls.ev['markers']['ids']:
            text = text.replace(marker, '[SYNTHETIC]')
        found['gw_orthanc_tail'] = text.splitlines()
        cls.write_artifact('failure-diagnostics.json', found)


if __name__ == '__main__':
    unittest.main(verbosity=2)
