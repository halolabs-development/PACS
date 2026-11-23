"""Known-vulnerability check: target discovery, scanner results and the verdict. Offline: scanners are faked."""
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import ops_dependency_audit as audit


NPM = {"auditReportVersion": 2, "metadata": {"vulnerabilities": {"total": 5}}, "vulnerabilities": {
    "proxy-addr": {"name": "proxy-addr", "severity": "critical", "range": "1.1.0 - 2.0.7", "fixAvailable": True,
                   "via": [{"source": 1, "url": "https://github.com/advisories/GHSA-aaaa"}]},
    "multer": {"name": "multer", "severity": "high", "range": "<=2.4.0",
               "fixAvailable": {"name": "@nestjs/platform-express", "version": "12.0.0", "isSemVerMajor": True},
               "via": [{"source": 2, "url": "https://github.com/advisories/GHSA-bbbb"},
                       {"source": 3, "url": "https://github.com/advisories/GHSA-cccc"}]},
    "@nestjs/platform-express": {"name": "@nestjs/platform-express", "severity": "high", "range": "<=11",
                                 "fixAvailable": True, "via": ["multer"]},
    "qs": {"name": "qs", "severity": "moderate", "range": "<6.16.1", "fixAvailable": True,
           "via": [{"source": 4, "url": "https://github.com/advisories/GHSA-dddd"}]},
    "tmp": {"name": "tmp", "severity": "high", "range": "<=0.2.5", "fixAvailable": False,
            "via": [{"source": 5, "url": "https://github.com/advisories/GHSA-eeee"}]}}}
EMPTY_NPM = {"auditReportVersion": 2, "metadata": {"vulnerabilities": {"total": 0}}, "vulnerabilities": {}}

PIP = {"dependencies": [
    {"name": "pydicom", "version": "2.4.4", "vulns": [
        {"id": "PYSEC-1", "fix_versions": ["2.4.5", "3.0.2"]}, {"id": "PYSEC-1", "fix_versions": ["3.0.2"]}]},
    {"name": "six", "version": "1.17.0", "vulns": []},
    {"name": "old", "version": "1.0", "vulns": [{"id": "PYSEC-2", "fix_versions": []}]}], "fixes": []}
CLEAN_PIP = {"dependencies": [{"name": "six", "version": "1.17.0", "vulns": []}], "fixes": []}

TRIVY = {"SchemaVersion": 2, "Metadata": {"ImageID": "sha256:1111", "RepoDigests": ["x@sha256:2222"]}, "Results": [
    {"Target": "x (debian 12)", "Vulnerabilities": [
        {"VulnerabilityID": "CVE-1", "PkgName": "libssl3", "InstalledVersion": "3.0.1", "FixedVersion": "3.0.2", "Severity": "HIGH"},
        {"VulnerabilityID": "CVE-1", "PkgName": "libssl3", "InstalledVersion": "3.0.1", "FixedVersion": "3.0.2", "Severity": "HIGH"},
        {"VulnerabilityID": "CVE-2", "PkgName": "zlib", "InstalledVersion": "1.2", "FixedVersion": "", "Severity": "CRITICAL"},
        {"VulnerabilityID": "CVE-3", "PkgName": "bash", "InstalledVersion": "5", "FixedVersion": "5.1", "Severity": "MEDIUM"}]},
    {"Target": "app/package.json", "Vulnerabilities": None}]}


def fake(answers):
    """answers: kind -> (exit code, stdout); 'build' answers `docker build`. Records every call."""
    calls = []

    def run(argv, cwd, timeout):
        calls.append((argv, cwd, timeout))
        kind = ("npm" if argv[0] == "npm" else "build" if argv[:2] == ["docker", "build"]
                else "image" if argv[0] == "docker" else "pip")
        code, out = answers.get(kind, (0, "")) if kind == "build" else answers[kind]
        return code, out, "boom\n" if code not in (0, 1) else ""
    run.calls = calls
    return run


def write(root, path, text):
    target = Path(root) / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


class TargetTests(unittest.TestCase):
    def test_dockerfile_stages_scratch_and_arguments_are_not_images(self):
        text = "\n".join(["FROM --platform=linux/amd64 node:22-slim AS base", "FROM base AS development",
                          "from development as build", "FROM scratch", "FROM ${BASE}", "  FROM python:3.12-slim # comment",
                          "RUN echo FROM nothing"])
        self.assertEqual(audit.dockerfile_images(text), ["node:22-slim", "python:3.12-slim"])

    def test_compose_images_keep_variables_and_strip_quotes(self):
        text = "services:\n  a:\n    image: 'postgres:16-alpine'\n  b:\n    image: ${API_IMAGE:-kin-api:x}\n" \
               "  c:\n    image: \"quay.io/k/k:1\"  # pinned\n  d:\n    build: ./d\n"
        self.assertEqual(audit.compose_images(text), ["postgres:16-alpine", "${API_IMAGE:-kin-api:x}", "quay.io/k/k:1"])
        flow = "services:\n  db: {image: postgres:16-alpine, restart: always}\n  x: {build: ., image_name: no}\n" \
               "  # image: commented:1\n  y: {image: \"${A:-b:1}\"}\n  z:\n    image: $BARE\n"
        self.assertEqual(audit.compose_images(flow), ["postgres:16-alpine", "${A:-b:1}", "$BARE"])

    def test_targets_are_found_not_listed(self):
        with tempfile.TemporaryDirectory() as root:
            write(root, "api/package-lock.json", "{}")
            write(root, "api/node_modules/x/package-lock.json", "{}")
            write(root, "api/print/requirements.txt", "pydicom==2.4.4\n")
            write(root, "tests/e2e/requirements.txt", "pypdf==6\n")
            write(root, "api/Dockerfile", "FROM node:22-slim AS base\nFROM base\n")
            write(root, "docker-compose.yml", "services:\n  db:\n    image: postgres:16-alpine\n  o:\n    image: node:22-slim\n")
            write(root, "docker-compose.prod.yml", "services:\n  x:\n    image: ${PICKED}\n")
            write(root, "docker-compose.runtime-test.yml", "services:\n  x:\n    image: ${TEST_IMAGE}\n")
            write(root, "tests/fixtures/asr/Dockerfile", "FROM debian:bookworm-slim\n")
            write(root, "tmp/Dockerfile", "FROM ignored:1\n")
            found = {t["name"]: t for t in audit.targets(root)}
        self.assertEqual(sorted(found), sorted([
            "npm api (production)", "npm api (with build tools)", "pip api/print/requirements.txt",
            "pip tests/e2e/requirements.txt", "image built from api/Dockerfile", "image node:22-slim",
            "image postgres:16-alpine", "image ${PICKED}"]))
        self.assertTrue(found["npm api (production)"]["shipped"])
        self.assertFalse(found["npm api (with build tools)"]["shipped"])
        self.assertFalse(found["pip tests/e2e/requirements.txt"]["shipped"])
        built = found["image built from api/Dockerfile"]
        self.assertEqual((built["build"], built["context"], built["image"]), ("api/Dockerfile", "api", "dependency-audit/api"))
        self.assertEqual(found["image ${PICKED}"]["unresolved"], "the image is chosen by a variable in docker-compose.prod.yml")
        self.assertNotIn("unresolved", found["image postgres:16-alpine"])

    def test_this_repository_targets_cover_what_ships(self):
        names = {t["name"]: t for t in audit.targets()}
        for name in ("npm api (production)", "pip api/print/requirements.txt", "pip gateway/agent/requirements.txt",
                     "image built from api/Dockerfile", "image built from proxy/Dockerfile",
                     "image built from gateway/agent/Dockerfile", "image built from gateway/orthanc/Dockerfile"):
            self.assertIn(name, names)
            self.assertTrue(names[name]["shipped"], name)
        # Every Orthanc runs the image built from that Dockerfile, so it is what gets checked: no Compose file runs
        # the upstream image as it is, and each Orthanc service builds from the one file.
        self.assertEqual([n for n in names if n.startswith("image orthancteam/")], [])
        for path, service, context in (("docker-compose.yml", "orthanc", "./gateway/orthanc"),
                                       ("docker-compose.qr-peer.yml", "qr-peer", "./gateway/orthanc"),
                                       ("gateway/docker-compose.yml", "gw-orthanc", "./orthanc")):
            text = (audit.ROOT / path).read_text(encoding="utf-8")
            block = re.search(r"^  " + re.escape(service) + r":\n((?:    .*\n|\s*\n)*)", text, re.M)
            self.assertIsNotNone(block, path)
            self.assertRegex(block.group(1), r"(?m)^    build: " + re.escape(context) + r"$", path)
            self.assertNotRegex(block.group(1), r"(?m)^    image:", path)
        # By image name, not tag: a security update of an engine image must not fail this test.
        for prefix in ("image postgres:", "image quay.io/keycloak/keycloak:"):
            self.assertTrue(any(n.startswith(prefix) and names[n]["shipped"] for n in names), prefix)
        # Today every shipped Compose image is pinned by name; a variable one would make every run incomplete.
        self.assertEqual([n for n, t in names.items() if t.get("unresolved")], [])
        sections = {row[0] for row in audit.bundled()}
        self.assertTrue({"OHIF", "Orthanc", "ASR", "Viewer decoder", "Database"} <= sections, sections)
        self.assertNotIn("unreadable", {row[2] for row in audit.bundled()})


class CheckTests(unittest.TestCase):
    def target(self, kind, shipped=True):
        return {"npm": {"kind": "npm", "name": "npm api (production)", "dir": "api", "scope": "production", "shipped": shipped},
                "pip": {"kind": "pip", "name": "pip a.txt", "file": "a.txt", "shipped": shipped},
                "image": {"kind": "image", "name": "image x:1", "image": "x:1", "sources": ["c.yml"], "shipped": shipped},
                "built": {"kind": "image", "name": "image built from a/Dockerfile", "build": "a/Dockerfile", "context": "a",
                          "image": "dependency-audit/a", "shipped": shipped}}[kind]

    def test_findings_are_a_result_not_an_error(self):
        run = fake({"npm": (1, json.dumps(NPM)), "pip": (1, json.dumps(PIP)), "image": (0, json.dumps(TRIVY))})
        npm = audit.check(self.target("npm"), run)
        self.assertEqual(npm["status"], "checked")
        # The entry that only names another package repeats multer's advisories and is not counted again.
        self.assertEqual([f["package"] for f in npm["findings"]], ["multer", "proxy-addr", "qs", "tmp"])
        self.assertEqual({f["package"]: f["fix"] for f in npm["findings"]},
                         {"multer": "major", "proxy-addr": "yes", "qs": "yes", "tmp": "none"})
        self.assertEqual(run.calls[0][0], ["npm", "audit", "--json", "--omit=dev"])
        self.assertTrue(run.calls[0][1].endswith("api"))
        pip = audit.check(self.target("pip"), run)
        self.assertEqual([(f["package"], f["ids"], f["fix"]) for f in pip["findings"]],
                         [("pydicom", ["PYSEC-1"], "yes"), ("old", ["PYSEC-2"], "none")])
        image = audit.check(self.target("image"), run)
        self.assertEqual([(f["package"], f["severity"], f["fix"]) for f in image["findings"]],
                         [("libssl3", "high", "yes"), ("zlib", "critical", "none"), ("bash", "moderate", "yes")])
        self.assertEqual(image["identity"], "x@sha256:2222")
        self.assertIn(audit.TRIVY_IMAGE, run.calls[-1][0])
        self.assertRegex(audit.TRIVY_IMAGE, r":[0-9.]+@sha256:[0-9a-f]{64}$")

    def test_the_same_advisory_in_two_results_merges_whatever_the_order(self):
        rows = [{"VulnerabilityID": "CVE-9", "PkgName": "lib", "InstalledVersion": "1", "FixedVersion": "", "Severity": "MEDIUM"},
                {"VulnerabilityID": "CVE-9", "PkgName": "lib", "InstalledVersion": "1", "FixedVersion": "2", "Severity": "HIGH"}]
        for order in (rows, rows[::-1]):
            doc = {"SchemaVersion": 2, "Results": [{"Target": "a", "Vulnerabilities": [order[0]]},
                                                   {"Target": "b", "Vulnerabilities": [order[1]]}]}
            result = audit.check(self.target("image"), fake({"image": (0, json.dumps(doc))}))
            self.assertEqual([(f["severity"], f["fix"], f["fixed"]) for f in result["findings"]], [("high", "yes", "2")])
            self.assertTrue(audit.actionable(result, result["findings"][0]))

    def test_a_built_image_is_built_with_pull_then_scanned_as_built(self):
        run = fake({"build": (0, "sha256:abc\n"), "image": (0, json.dumps(TRIVY))})
        result = audit.check(self.target("built"), run, trivy_cache="/cache")
        self.assertEqual(result["status"], "checked")
        self.assertEqual(run.calls[0][0], ["docker", "build", "--pull", "--quiet", "-t", "dependency-audit/a",
                                           "-f", "a/Dockerfile", "a"])
        scan = run.calls[1][0]
        self.assertEqual(scan[-1], "dependency-audit/a")
        self.assertIn("/var/run/docker.sock:/var/run/docker.sock", scan)
        self.assertIn("/cache:/root/.cache/trivy", scan)
        failed = fake({"build": (1, ""), "image": (0, json.dumps(TRIVY))})
        result = audit.check(self.target("built"), failed)
        self.assertEqual((result["status"], len(failed.calls)), ("not checked", 1))
        self.assertIn("docker build exit 1", result["reason"])

    def test_every_failure_is_not_checked(self):
        cases = {
            "scanner missing or timed out": {"npm": (None, "")},
            "scanner error exit": {"npm": (2, json.dumps(NPM))},
            "not JSON": {"npm": (1, "npm ERR! network")},
            "npm error report": {"npm": (1, json.dumps({"error": {"code": "ENOTFOUND"}}))},
            "npm without report": {"npm": (0, json.dumps({"auditReportVersion": 2}))},
            "npm without metadata": {"npm": (0, json.dumps({"vulnerabilities": {}}))},
        }
        for label, answers in cases.items():
            with self.subTest(label):
                result = audit.check(self.target("npm"), fake(answers))
                self.assertEqual(result["status"], "not checked")
                self.assertEqual(result["findings"], [])
        for label, out in (("pip skipped a dependency", {"dependencies": [{"name": "x", "skip_reason": "no"}]}),
                           ("pip without a vulnerability list", {"dependencies": [{"name": "x", "version": "1"}]}),
                           ("pip checked nothing", {"dependencies": []}), ("pip no report", {"fixes": []})):
            with self.subTest(label):
                self.assertEqual(audit.check(self.target("pip"), fake({"pip": (0, json.dumps(out))}))["status"], "not checked")
        for label, out, code in (("trivy found something but exits 1", TRIVY, 1), ("not a trivy report", {"Results": []}, 0),
                                 ("trivy report without results", {"SchemaVersion": 2}, 0)):
            with self.subTest(label):
                self.assertEqual(audit.check(self.target("image"), fake({"image": (code, json.dumps(out))}))["status"], "not checked")
        run = fake({})
        unresolved = audit.check(dict(self.target("image"), unresolved="the image is chosen by a variable in c.yml"), run)
        self.assertEqual((unresolved["status"], run.calls), ("not checked", []))


class VerdictTests(unittest.TestCase):
    def results(self, answers, shipped=True):
        run = fake(answers)
        return [audit.check(t, run) for t in (
            {"kind": "npm", "name": "npm api (production)", "dir": "api", "scope": "production", "shipped": shipped},
            {"kind": "pip", "name": "pip a.txt", "file": "a.txt", "shipped": shipped},
            {"kind": "image", "name": "image x:1", "image": "x:1", "sources": ["c.yml"], "shipped": shipped})]

    def test_shipped_critical_or_high_needs_action(self):
        code, markdown, summary = audit.summarize(
            self.results({"npm": (1, json.dumps(NPM)), "pip": (1, json.dumps(PIP)), "image": (0, json.dumps(TRIVY))}), "abc")
        self.assertEqual(code, 1)
        # npm: proxy-addr (fix), multer (fix only with a major version), tmp (npm cannot fix it through its parent -
        # still high); pip: pydicom (unrated, fix); image: libssl3 (high, fix).
        # Not: qs and bash (moderate), zlib (image, no fixed version), old (pip, no fixed version).
        self.assertEqual(summary["actionable"], 5)
        section = markdown.split("## Needs action", 1)[1]
        for package in ("proxy-addr", "multer", "tmp", "pydicom", "libssl3"):
            self.assertIn("| " + package + " |", section)
        for package in ("| qs |", "| bash |", "| zlib |", "| old |"):
            self.assertNotIn(package, section)
        self.assertIn("major version only", section)
        self.assertIn("not automatic - see the advisory", section)
        self.assertIn("at abc", markdown)
        # qs and bash have a fixed version but are below the bar: counted, not hidden.
        self.assertEqual(summary["below_bar_fixable"], 2)
        self.assertIn("below the action bar that have a fixed version: 2", markdown)

    def test_needs_action_is_one_row_per_package_and_version(self):
        many = {"SchemaVersion": 2, "Results": [{"Target": "x", "Vulnerabilities": [
            {"VulnerabilityID": f"CVE-{n}", "PkgName": "curl", "InstalledVersion": "8.1", "FixedVersion": f"8.{n}",
             "Severity": "CRITICAL" if n == 4 else "HIGH"} for n in range(2, 7)]}]}
        results = self.results({"npm": (0, json.dumps(EMPTY_NPM)), "pip": (0, json.dumps(CLEAN_PIP)), "image": (0, json.dumps(many))})
        code, markdown, summary = audit.summarize(results)
        self.assertEqual((code, summary["actionable"]), (1, 5))
        rows = [line for line in markdown.split("## Needs action", 1)[1].splitlines() if line.startswith("| image x:1 |")]
        self.assertEqual(rows, ["| image x:1 | curl | 8.1 | critical | CVE-2, CVE-3, CVE-4 (+2 more) | available (8.2; 8.3; 8.4; …) |"])

    def test_test_only_and_build_tool_findings_are_reported_but_do_not_need_action(self):
        code, markdown, summary = audit.summarize(
            self.results({"npm": (1, json.dumps(NPM)), "pip": (1, json.dumps(PIP)), "image": (0, json.dumps(TRIVY))}, shipped=False))
        self.assertEqual((code, summary["actionable"], summary["below_bar_fixable"]), (0, 0, 0))
        self.assertIn("| npm api (production) | no | checked | 1 | 2 | 1 | 0 | 0 | 3 | 0 |", markdown)

    def test_an_unchecked_target_is_never_clean_and_keeps_the_rest(self):
        clean = self.results({"npm": (0, json.dumps(EMPTY_NPM)), "pip": (0, json.dumps(CLEAN_PIP)),
                              "image": (0, json.dumps({"SchemaVersion": 2, "Results": []}))})
        self.assertEqual(audit.summarize(clean)[0], 0)
        broken = self.results({"npm": (0, json.dumps(EMPTY_NPM)), "pip": (0, json.dumps(CLEAN_PIP)), "image": (None, "")})
        code, markdown, summary = audit.summarize(broken)
        self.assertEqual((code, summary["unchecked"]), (2, 1))
        self.assertIn("## Not checked", markdown)
        self.assertIn("- image x:1: docker run exit None", markdown)
        # Unchecked outranks findings: exit 2, and the findings of what was checked are still listed.
        mixed = self.results({"npm": (1, json.dumps(NPM)), "pip": (None, ""), "image": (0, json.dumps(TRIVY))})
        code, markdown, summary = audit.summarize(mixed)
        self.assertEqual((code, summary["actionable"]), (2, 4))
        self.assertIn("## Needs action", markdown)
        self.assertIn("4 shipped critical/high finding(s) among the rest", markdown)

    def test_bundled_components_are_named_but_do_not_decide(self):
        results = self.results({"npm": (0, json.dumps(EMPTY_NPM)), "pip": (0, json.dumps(CLEAN_PIP)),
                                "image": (0, json.dumps({"SchemaVersion": 2, "Results": []}))})
        code, markdown, summary = audit.summarize(results, bundle=[("OHIF", "OHIF embedded build", "3.9.1")])
        self.assertEqual(code, 0)
        self.assertIn("## Not seen by the scanners", markdown)
        self.assertIn("- OHIF: OHIF embedded build 3.9.1", markdown)

    def test_run_writes_raw_output_and_both_summaries(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as out:
            write(root, "api/package-lock.json", "{}")
            write(root, "Dockerfile", "FROM x:1\n")
            run = fake({"npm": (1, json.dumps(NPM)), "build": (0, ""), "image": (None, "")})
            code, markdown = audit.run_all(out, root=root, run=run, trivy_cache="/cache")
            self.assertEqual(code, 2)
            raw = sorted(p.name for p in (Path(out) / "raw").iterdir())
            self.assertEqual(raw, ["image_built_from_Dockerfile.json", "npm_api_production.json", "npm_api_with_build_tools.json"])
            self.assertEqual(json.loads((Path(out) / "raw/npm_api_production.json").read_text(encoding="utf-8")), NPM)
            summary = json.loads((Path(out) / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["exit"], 2)
            self.assertNotIn("raw", summary["targets"][0])
            self.assertEqual((Path(out) / "summary.md").read_text(encoding="utf-8"), markdown)
            # No requirements file at all is not "nothing to check": the search itself is reported.
            self.assertIn("- any shipped Python requirements file: none found", markdown)
            self.assertIn("- inventory: worklist-v0/legal/licenses/components.json unreadable", markdown)


if __name__ == "__main__":
    unittest.main()
