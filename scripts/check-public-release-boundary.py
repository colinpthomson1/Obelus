#!/usr/bin/env python3

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
failures: list[str] = []


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def fail(message: str) -> None:
    failures.append(message)


npm_manifests = [ROOT / "ui/package.json", ROOT / "contracts/fact-check/v2/package.json"]
npm_manifests.extend(
    path
    for path in (ROOT / "ui").glob("**/package.json")
    if "node_modules" not in path.parts and path != ROOT / "ui/package.json"
)

for manifest in sorted(set(npm_manifests)):
    package = load_json(manifest)
    if package.get("private") is not True:
        fail(f"npm package must be private: {manifest.relative_to(ROOT)}")
    if "publishConfig" in package:
        fail(f"npm publishConfig is not allowed: {manifest.relative_to(ROOT)}")
    for script_name, command in package.get("scripts", {}).items():
        if re.search(r"(?:^|\s)(?:npm|pnpm|yarn|changeset)\s+publish(?:\s|$)", command):
            fail(
                f"npm publication command is not allowed: "
                f"{manifest.relative_to(ROOT)} scripts.{script_name}"
            )

for manifest in sorted((ROOT / "crates").glob("*/Cargo.toml")):
    cargo = manifest.read_text(encoding="utf-8")
    package_match = re.search(r"(?ms)^\[package\]\s*(.*?)(?=^\[|\Z)", cargo)
    if package_match and not re.search(
        r"(?m)^publish\s*=\s*false\s*$", package_match.group(1)
    ):
        fail(f"Cargo package must set publish=false: {manifest.relative_to(ROOT)}")

python_package = (ROOT / "crates/goose-sdk/python/pyproject.toml").read_text(
    encoding="utf-8"
)
if '"Private :: Do Not Upload"' not in python_package:
    fail("Python compatibility package must retain the do-not-upload classifier")

for relative_path in (
    "Dockerfile",
    "documentation",
    "oidc-proxy",
    "recipe-scanner",
    "scripts/pre-release.sh",
    "services/ask-ai-bot",
    "ui/scripts/publish.sh",
):
    target = ROOT / relative_path
    contains_files = target.is_dir() and any(
        path.is_file() for path in target.rglob("*")
    )
    if target.is_file() or contains_files:
        fail(f"retired upstream release surface must stay absent: {relative_path}")

for relative_path, patterns in {
    "Justfile": (
        r"\bgit\s+push\s+origin\s+tag\b",
        r"\bgit\s+commit\b",
    ),
    "crates/goose-sdk/justfile": (
        r"\btwine\s+upload\b",
        r"\bcargo\s+publish\b",
        r"publishAndReleaseToMavenCentral",
    ),
    "crates/goose-sdk/maven/build.gradle.kts": (
        r"publishToMavenCentral",
        r"signAllPublications",
    ),
    "ui/desktop/forge.config.ts": (
        r"@electron-forge/publisher-github",
        r"\bpublishers\s*:",
        r"\bosxNotarize\b",
        r"\bWINDOWS_CERTIFICATE_FILE\b",
        r"\bWINDOW_SIGNING_ROLE\b",
        r"\bAPPLE_TEAM_ID\b",
        r"\bAPPLE_ID(?:_PASSWORD)?\b",
        r"\bKEYCHAIN_PATH\b",
    ),
}.items():
    text = (ROOT / relative_path).read_text(encoding="utf-8")
    for pattern in patterns:
        if re.search(pattern, text):
            fail(f"forbidden publisher remains in {relative_path}: {pattern}")

workflow_publish = re.compile(
    r"(?:npm|pnpm|yarn|cargo)\s+publish\b|twine\s+upload\b|"
    r"publishAndReleaseToMavenCentral|gh\s+release\s+(?:create|upload)\b"
)
for workflow in sorted((ROOT / ".github/workflows").glob("*.yml")):
    if workflow_publish.search(workflow.read_text(encoding="utf-8")):
        fail(f"registry or release publisher is not allowed in {workflow.relative_to(ROOT)}")

runtime_shim_forbidden = re.compile(
    r"\bcurl\b|\bwget\b|Invoke-WebRequest|Expand-Archive|\bmsiexec\b|"
    r"sh\.jbang\.dev|cashapp/hermit|nodejs\.org/dist|\beval\b|"
    r"jbang[^\n]*trust\s+add\s+\*",
    re.IGNORECASE,
)
for relative_path in (
    "ui/desktop/src/bin/jbang",
    "ui/desktop/src/bin/node",
    "ui/desktop/src/bin/node-setup-common.sh",
    "ui/desktop/src/bin/npx",
    "ui/desktop/src/bin/uvx",
    "ui/desktop/src/platform/windows/bin/jbang.cmd",
    "ui/desktop/src/platform/windows/bin/npx.cmd",
):
    if runtime_shim_forbidden.search((ROOT / relative_path).read_text(encoding="utf-8")):
        fail(f"desktop runtime shim must not download or trust tooling: {relative_path}")

if failures:
    for message in failures:
        print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)

print("Public release boundary is closed: registry and release publishers are disabled.")
