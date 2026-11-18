"""Known-vulnerability check of the product's dependencies and images. Read-only: it never changes a file it checks.

python3 scripts/ops_dependency_audit.py targets
python3 scripts/ops_dependency_audit.py run --out DIR [--pip-audit PATH] [--trivy-cache DIR]

The targets are found, not listed: every npm lock file, every requirements*.txt, every image the product's
Dockerfiles build (built here, with --pull, and scanned as built - what ships, not only its base) and every image a
Compose file runs. Test-only files (under tests/, or with "test" in the file name) are reported but never decide
the verdict. Each scanner reads public vulnerability databases with package names and versions only.

Exit 0: every target was checked and nothing shipped needs action. Exit 1: something shipped has a critical or high
finding (npm: whatever its fix state - npm cannot always fix through a pinned parent; images: with a fixed
version; pip-audit gives no severity, so there: any finding with a fixed version). Exit 2: a target could not be
checked - an incomplete check is never reported as clean; its findings are still listed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
# Pinned by version and digest: the scanner is itself a dependency.
TRIVY_IMAGE = "aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"
SKIP_DIRS = {".git", "node_modules", "tmp", ".venv", "venv", "dist", "__pycache__"}
SEVERITIES = ("critical", "high", "moderate", "low", "unrated")
ACT_ON = {"critical", "high"}
SEVERITY = {"critical": "critical", "high": "high", "moderate": "moderate", "medium": "moderate",
            "low": "low", "info": "low", "negligible": "low"}
TIMEOUT = {"npm": 300, "pip": 300, "image": 1200, "build": 1800}
KINDS = {"npm": "npm lock file", "pip": "Python requirements file", "image": "image"}
# Shipped inside an image or the viewer as a binary/bundle: no scanner here sees them, so they are named, not judged.
INVENTORY = "worklist-v0/legal/licenses/components.json"
BUNDLED_SECTIONS = ("OHIF", "Orthanc", "ASR")
SOF3_BUILD = "scripts/build-sof3-wasm.py"


class Unchecked(Exception):
    """The target's scan did not produce a complete, readable result."""


def files(root):
    for directory, subdirs, names in os.walk(root):
        subdirs[:] = sorted(d for d in subdirs if d not in SKIP_DIRS)
        for name in sorted(names):
            yield (Path(directory) / name).relative_to(root).as_posix()


def test_only(path):
    return path.startswith("tests/") or "test" in path.rsplit("/", 1)[-1].lower()


def dockerfile_images(text):
    """Base images of a Dockerfile; a FROM that names an earlier stage, scratch or a build argument is not an image."""
    stages, images = set(), []
    for line in text.splitlines():
        words = line.split("#", 1)[0].split()
        if not words or words[0].upper() != "FROM":
            continue
        words = [w for w in words[1:] if not w.startswith("--")]
        if not words:
            continue
        image = words[0]
        if len(words) >= 3 and words[1].upper() == "AS":
            stages.add(words[2].lower())
        if image.lower() in stages or image.lower() == "scratch" or "$" in image:
            continue
        images.append(image)
    return images


COMPOSE_IMAGE = re.compile(r"""(?:^|[\s{,])image:\s*["']?((?:\$\{[^}]*\}|[^"'\s,}#])+)""")


def compose_images(text):
    """Every `image:` of a Compose file, block or flow style, variables included (the caller decides what a variable
    means)."""
    return [m.group(1) for line in text.splitlines() for m in COMPOSE_IMAGE.finditer(line.split(" #", 1)[0])]


def slug(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def targets(root=ROOT):
    root = Path(root)
    found, images = [], {}
    for path in files(root):
        name = path.rsplit("/", 1)[-1]
        if name == "package-lock.json":
            directory = path.rsplit("/", 1)[0] if "/" in path else "."
            found.append({"kind": "npm", "name": f"npm {directory} (production)", "dir": directory,
                          "scope": "production", "shipped": not test_only(path)})
            found.append({"kind": "npm", "name": f"npm {directory} (with build tools)", "dir": directory,
                          "scope": "all", "shipped": False})
        elif re.fullmatch(r"requirements[^/]*\.txt", name):
            found.append({"kind": "pip", "name": f"pip {path}", "file": path, "shipped": not test_only(path)})
        elif name.startswith("Dockerfile"):
            if test_only(path):
                continue  # a test fixture's image is not shipped and is not built here
            context = path.rsplit("/", 1)[0] if "/" in path else "."
            found.append({"kind": "image", "name": f"image built from {path}", "build": path, "context": context,
                          "image": "dependency-audit/" + slug(context).lower(), "shipped": True})
        elif re.fullmatch(r"(docker-)?compose[^/]*\.ya?ml", name):
            if test_only(path):
                continue
            for image in compose_images((root / path).read_text(encoding="utf-8")):
                images.setdefault(image, []).append(path)
    for image, sources in sorted(images.items()):
        target = {"kind": "image", "name": f"image {image}", "image": image, "sources": sorted(set(sources)), "shipped": True}
        if "$" in image:
            # Chosen when the stack starts: this check cannot know what runs there.
            target["unresolved"] = "the image is chosen by a variable in " + ", ".join(target["sources"])
        found.append(target)
    return found


def commands(target, pip_audit="pip-audit", trivy_cache=None):
    """[(argv, cwd, accepted exit codes, timeout)]; the last command's output is the scanner's report."""
    if target["kind"] == "npm":
        argv = ["npm", "audit", "--json"] + (["--omit=dev"] if target["scope"] == "production" else [])
        return [(argv, target["dir"], (0, 1), TIMEOUT["npm"])]
    if target["kind"] == "pip":
        return [([pip_audit, "-r", target["file"], "--no-deps", "--disable-pip", "--progress-spinner", "off", "-f", "json"],
                 ".", (0, 1), TIMEOUT["pip"])]
    steps = []
    if "build" in target:
        steps.append((["docker", "build", "--pull", "--quiet", "-t", target["image"], "-f", target["build"], target["context"]],
                      ".", (0,), TIMEOUT["build"]))
    cache = ["-v", f"{trivy_cache}:/root/.cache/trivy"] if trivy_cache else []
    # The daemon socket lets the scanner read the image just built; a pulled image comes from its registry.
    steps.append((["docker", "run", "--rm", "-v", "/var/run/docker.sock:/var/run/docker.sock", *cache, TRIVY_IMAGE,
                   "image", "--quiet", "--format", "json", "--scanners", "vuln", target["image"]], ".", (0,), TIMEOUT["image"]))
    return steps


def execute(argv, cwd, timeout):
    try:
        argv = [shutil.which(argv[0]) or argv[0], *argv[1:]]  # npm is npm.cmd on Windows
        done = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, "", type(error).__name__
    return done.returncode, done.stdout, done.stderr[-2000:]


def severity(value):
    return SEVERITY.get(str(value or "").lower(), "unrated")


def parse_npm(doc):
    if (type(doc) is not dict or "error" in doc or type(doc.get("vulnerabilities")) is not dict
            or type((doc.get("metadata") or {}).get("vulnerabilities")) is not dict):
        raise Unchecked("npm audit gave no vulnerability report")
    findings = []
    for package, entry in sorted(doc["vulnerabilities"].items()):
        # An entry whose `via` names only other packages repeats their advisories; count each advisory once, at the
        # package that has it (the production run already keeps only production paths).
        own = [via for via in entry.get("via", []) if type(via) is dict]
        if not own:
            continue
        fix = entry.get("fixAvailable")
        findings.append({"package": package, "version": entry.get("range", ""), "severity": severity(entry.get("severity")),
                         "ids": sorted({str(via.get("url", "")).rsplit("/", 1)[-1] or str(via.get("source")) for via in own}),
                         "fix": "none" if not fix else "major" if type(fix) is dict and fix.get("isSemVerMajor") else "yes"})
    return findings


def parse_pip(doc):
    if type(doc) is not dict or type(doc.get("dependencies")) is not list or not doc["dependencies"]:
        raise Unchecked("pip-audit gave no dependency report")
    skipped = sorted(str(d.get("name")) for d in doc["dependencies"] if type(d) is not dict or d.get("skip_reason")
                     or type(d.get("vulns")) is not list)
    if skipped:
        raise Unchecked("pip-audit did not check " + ", ".join(skipped))
    findings = []
    for dep in doc["dependencies"]:
        seen = set()
        for vuln in dep["vulns"]:
            if vuln.get("id") in seen:
                continue
            seen.add(vuln.get("id"))
            findings.append({"package": dep.get("name"), "version": dep.get("version"), "severity": "unrated",
                             "ids": [vuln.get("id")], "fix": "yes" if vuln.get("fix_versions") else "none",
                             "fixed": ", ".join(vuln.get("fix_versions") or [])})
    return findings


def parse_trivy(doc):
    if type(doc) is not dict or "SchemaVersion" not in doc or type(doc.get("Results")) is not list:
        raise Unchecked("trivy gave no image report")
    findings = {}
    for result in doc["Results"]:
        for vuln in result.get("Vulnerabilities") or []:
            # The same package, version and advisory can appear under several of the image's results: merge them,
            # keeping the highest severity and any fixed version, so the order of the results never decides.
            key = (vuln.get("PkgName"), vuln.get("InstalledVersion"), vuln.get("VulnerabilityID"))
            found = findings.setdefault(key, {"package": key[0], "version": key[1], "severity": "unrated",
                                              "ids": [key[2]], "fix": "none", "fixed": ""})
            level = severity(vuln.get("Severity"))
            if SEVERITIES.index(level) < SEVERITIES.index(found["severity"]):
                found["severity"] = level
            if vuln.get("FixedVersion") and found["fix"] == "none":
                found.update(fix="yes", fixed=vuln["FixedVersion"])
    return list(findings.values())


PARSE = {"npm": parse_npm, "pip": parse_pip, "image": parse_trivy}


def actionable(target, finding):
    if not target["shipped"] or finding["severity"] not in ACT_ON | {"unrated"}:
        return False
    if target["kind"] == "npm":
        return finding["severity"] in ACT_ON
    return finding["fix"] != "none" and (finding["severity"] in ACT_ON or target["kind"] == "pip")


def image_identity(doc):
    metadata = doc.get("Metadata") or {}
    return ", ".join((metadata.get("RepoDigests") or [])[:1] or [metadata.get("ImageID") or ""]).strip(", ")


def check(target, run, pip_audit="pip-audit", trivy_cache=None, root=ROOT):
    """One target: run its scanner and read the result. Every failure is the target's 'not checked', never a pass."""
    result = dict(target, raw="", status="checked", reason="", findings=[], identity="")
    try:
        if target.get("unresolved"):
            raise Unchecked(target["unresolved"])
        for argv, cwd, accepted, timeout in commands(target, pip_audit, trivy_cache):
            code, out, err = run(argv, str(Path(root) / cwd), timeout)
            result["raw"] = out
            if code not in accepted:
                raise Unchecked(f"{argv[0]} {argv[1]} exit {code}: "
                                + (err.strip().splitlines()[-1] if err.strip() else "no message"))
        try:
            doc = json.loads(result["raw"])
        except ValueError:
            raise Unchecked("scanner output is not JSON") from None
        result["findings"] = PARSE[target["kind"]](doc)
        if target["kind"] == "image":
            result["identity"] = image_identity(doc)
    except Unchecked as error:
        result.update(status="not checked", reason=str(error)[:300], findings=[])
    return result


def bundled(root=ROOT):
    """Components shipped as binaries or bundles, by the product's own inventory and the viewer decoder's build pin."""
    root, rows = Path(root), []
    try:
        inventory = json.loads((root / INVENTORY).read_text(encoding="utf-8"))
        rows = [(r["section"], r["name"], r["version"]) for r in inventory["components"] if r.get("section") in BUNDLED_SECTIONS]
    except (OSError, ValueError, KeyError, TypeError):
        rows = [("inventory", INVENTORY, "unreadable")]
    # The official PostgreSQL image builds the server from source: the image scan sees its OS packages, not the server.
    for target in targets(root):
        if target["kind"] == "image" and target["image"].split("@")[0].rsplit("/", 1)[-1].startswith("postgres:"):
            rows.append(("Database", "PostgreSQL server (built from source in the image)", target["image"]))
    try:
        pin = re.search(r"libjpeg-turbo/releases/download/([0-9][^/]*)/", (root / SOF3_BUILD).read_text(encoding="utf-8"))
        rows.append(("Viewer decoder", "libjpeg-turbo (worklist-v0/hpacs-lite/kin-sof3.wasm)", pin.group(1) if pin else "unreadable"))
    except OSError:
        pass
    return rows


def counts(findings):
    return {s: sum(1 for f in findings if f["severity"] == s) for s in SEVERITIES}


FIX = {"yes": "available", "major": "major version only", "none": "not automatic - see the advisory"}


def summarize(results, commit=None, now=None, bundle=()):
    now = now or datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    unchecked = [r for r in results if r["status"] != "checked"]
    act = [(r, f) for r in results for f in r["findings"] if actionable(r, f)]
    below = sum(1 for r in results if r["shipped"] for f in r["findings"] if f["fix"] != "none" and not actionable(r, f))
    code = 2 if unchecked else 1 if act else 0
    verdict = {0: "Clean: every target checked, nothing shipped needs action.",
               1: f"Action needed: {len(act)} shipped critical/high finding(s).",
               2: f"Incomplete: {len(unchecked)} target(s) could not be checked"
                  + (f"; {len(act)} shipped critical/high finding(s) among the rest." if act else ".")}[code]
    lines = ["# Dependency audit", "", f"Checked {now}" + (f" at {commit}" if commit else "") + ".", "",
             f"**{verdict}**", "", f"Shipped findings below the action bar that have a fixed version: {below}.", "",
             "| Target | Shipped | Status | Critical | High | Moderate | Low | Unrated | With fix | Action | Image |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        c = counts(r["findings"])
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            r["name"], "yes" if r["shipped"] else "no", r["status"], *(c[s] for s in SEVERITIES),
            sum(1 for f in r["findings"] if f["fix"] != "none"), sum(1 for f in r["findings"] if actionable(r, f)),
            r.get("identity", "")))
    if act:
        # One row per package and version: an image package can carry dozens of advisories.
        groups = {}
        for r, f in act:
            groups.setdefault((r["name"], f["package"], f["version"]), []).append(f)
        lines += ["", "## Needs action", "", "| Target | Package | Version | Severity | Advisories | Fix |", "|---|---|---|---|---|---|"]
        for (name, package, version), found in groups.items():
            top = min((f["severity"] for f in found), key=SEVERITIES.index)
            ids = sorted({i for f in found for i in f["ids"]})
            fixed = sorted({f["fixed"] for f in found if f.get("fixed")})
            fix = (FIX[found[0]["fix"]] if len({f["fix"] for f in found}) == 1 else "varies") + \
                (f" ({'; '.join(fixed[:3])}{'; …' if len(fixed) > 3 else ''})" if fixed else "")
            more = f" (+{len(ids) - 3} more)" if len(ids) > 3 else ""
            lines.append(f"| {name} | {package} | {version} | {top} | {', '.join(ids[:3])}{more} | {fix} |")
    if unchecked:
        lines += ["", "## Not checked", ""] + [f"- {r['name']}: {r['reason']}" for r in unchecked]
    if bundle:
        lines += ["", "## Not seen by the scanners", "",
                  "Shipped as binaries or bundles; compare their vendors' advisories with these versions at each release.", ""]
        lines += [f"- {section}: {name} {version}" for section, name, version in bundle]
    lines += ["", "Raw scanner output for every target is in this run's artifact."]
    summary = {"checked_at": now, "commit": commit, "exit": code, "verdict": verdict, "actionable": len(act),
               "below_bar_fixable": below, "unchecked": len(unchecked), "bundled": [list(b) for b in bundle],
               "targets": [{k: v for k, v in r.items() if k != "raw"} for r in results]}
    return code, "\n".join(lines) + "\n", summary


def run_all(out, pip_audit="pip-audit", trivy_cache=None, root=ROOT, run=execute, commit=None):
    out = Path(out)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    found, results = targets(root), []
    for target in found:
        result = check(target, run, pip_audit, trivy_cache, root)
        (out / "raw" / (slug(target["name"]) + ".json")).write_text(result["raw"], encoding="utf-8")
        results.append(result)
    for kind, label in KINDS.items():
        if not any(t["kind"] == kind and t["shipped"] for t in found):
            results.append({"kind": kind, "name": f"any shipped {label}", "shipped": True, "status": "not checked",
                            "reason": "none found - the search for targets is broken or the repository moved", "findings": []})
    code, markdown, summary = summarize(results, commit, bundle=bundled(root))
    (out / "summary.md").write_text(markdown, encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return code, markdown


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("targets")
    run = sub.add_parser("run")
    run.add_argument("--out", type=Path, required=True)
    run.add_argument("--pip-audit", default="pip-audit")
    run.add_argument("--trivy-cache")
    args = parser.parse_args(argv)
    if args.mode == "targets":
        print(json.dumps(targets(), indent=2))
        return 0
    code, markdown = run_all(args.out, args.pip_audit, args.trivy_cache, commit=os.environ.get("GITHUB_SHA"))
    print(markdown)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as handle:
            handle.write(markdown)
    return code


if __name__ == "__main__":
    sys.exit(main())
