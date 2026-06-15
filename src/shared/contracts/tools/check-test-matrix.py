#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_ROOT = ROOT / "src/shared/contracts"
FIXTURES_ROOT = ROOT / "src/shared/fixtures"
MATRIX_PATH = CONTRACTS_ROOT / "test-matrix.toml"
GENERATED_MANIFEST = ROOT / "target/shared-fixtures/manifest.generated.json"
GENERATED_CONSUMPTION_REPORT = ROOT / "target/shared-fixtures/consumption-report.json"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9.-]*[a-z0-9]$")
FORMATS = {"json", "properties", "tsv"}
EVIDENCE_KINDS = {"fixture-file", "semantic-contract"}
CONSUMPTION_SCAN_ROOTS = [
    "src/sdks/rust/tests",
    "src/sdks/swift/Tests",
    "src/sdks/kotlin/oliphaunt/src",
    "src/sdks/js/src",
    "src/sdks/react-native/src",
    "src/bindings/wasix-rust/crates/oliphaunt-wasix/src",
    "tools/release",
]
CODE_SUFFIXES = {
    ".bash",
    ".c",
    ".cjs",
    ".cpp",
    ".gradle",
    ".h",
    ".java",
    ".js",
    ".kt",
    ".kts",
    ".mjs",
    ".mm",
    ".py",
    ".rs",
    ".sh",
    ".swift",
    ".ts",
    ".tsx",
}
IGNORED_DIR_NAMES = {
    ".build",
    ".gradle",
    ".moon",
    ".next",
    "__pycache__",
    "build",
    "DerivedData",
    "dist",
    "lib",
    "node_modules",
    "target",
}
PROJECT_ROOTS = {
    "src/runtimes/liboliphaunt/native": "liboliphaunt-native",
    "src/sdks/rust": "oliphaunt-rust",
    "src/sdks/swift": "oliphaunt-swift",
    "src/sdks/kotlin": "oliphaunt-kotlin",
    "src/sdks/js": "oliphaunt-js",
    "src/sdks/react-native": "oliphaunt-react-native",
    "src/bindings/wasix-rust": "oliphaunt-wasix-rust",
    "tools/policy": "policy-tools",
    "tools/release": "release-tools",
}


def fail(message: str) -> None:
    raise SystemExit(message)


def load_matrix() -> dict:
    try:
        with MATRIX_PATH.open("rb") as handle:
            return tomllib.load(handle)
    except tomllib.TOMLDecodeError as error:
        fail(f"{MATRIX_PATH}: invalid TOML: {error}")


def validate_fixture_entry(entry: dict, seen: set[str]) -> dict:
    fixture_id = require_string(entry, "id")
    if not ID_RE.match(fixture_id):
        fail(f"{MATRIX_PATH}: invalid fixture id {fixture_id!r}")
    if fixture_id in seen:
        fail(f"{MATRIX_PATH}: duplicate fixture id {fixture_id!r}")
    seen.add(fixture_id)

    relative_path = require_string(entry, "path")
    path = Path(relative_path)
    if path.is_absolute() or ".." in path.parts:
        fail(f"{MATRIX_PATH}: fixture {fixture_id} has unsafe path {relative_path!r}")

    fixture_format = require_string(entry, "format")
    if fixture_format not in FORMATS:
        fail(f"{MATRIX_PATH}: fixture {fixture_id} has unsupported format {fixture_format!r}")

    contract = require_string(entry, "contract")
    proof_owner = require_string(entry, "proof_owner")
    ci_tier = require_string(entry, "ci_tier")
    if not re.match(r"^T[0-8]$", ci_tier):
        fail(f"{MATRIX_PATH}: fixture {fixture_id} has invalid ci_tier {ci_tier!r}")
    consumers = entry.get("consumers")
    if not isinstance(consumers, list) or not consumers or not all(isinstance(item, str) and item for item in consumers):
        fail(f"{MATRIX_PATH}: fixture {fixture_id} must declare non-empty string consumers")
    non_consumers = entry.get("non_consumers")
    if not isinstance(non_consumers, list) or not all(isinstance(item, str) and item for item in non_consumers):
        fail(f"{MATRIX_PATH}: fixture {fixture_id} must declare string non_consumers")
    overlap = set(consumers).intersection(non_consumers)
    if overlap:
        fail(f"{MATRIX_PATH}: fixture {fixture_id} declares consumers as non-consumers: {sorted(overlap)}")

    shared = entry.get("shared")
    if not isinstance(shared, bool):
        fail(f"{MATRIX_PATH}: fixture {fixture_id} must declare shared = true/false")
    if shared and len(set(consumers)) < 2:
        fail(f"{MATRIX_PATH}: shared fixture {fixture_id} must have at least two consumers")
    if not shared and not isinstance(entry.get("reason"), str):
        fail(f"{MATRIX_PATH}: product-specific fixture {fixture_id} must explain why it is cataloged")
    evidence = entry.get("evidence", [])
    if not isinstance(evidence, list) or not evidence:
        fail(f"{MATRIX_PATH}: fixture {fixture_id} must declare evidence for every consumer")
    evidence_consumers: list[str] = []
    for item in evidence:
        if not isinstance(item, dict):
            fail(f"{MATRIX_PATH}: fixture {fixture_id} evidence entries must be TOML tables")
        consumer = require_string(item, "consumer")
        if consumer not in consumers:
            fail(f"{MATRIX_PATH}: fixture {fixture_id} has evidence for undeclared consumer {consumer!r}")
        evidence_consumers.append(consumer)
        kind = item.get("kind", "fixture-file")
        if kind not in EVIDENCE_KINDS:
            fail(f"{MATRIX_PATH}: fixture {fixture_id} evidence for {consumer} has unsupported kind {kind!r}")
        evidence_path = require_string(item, "path")
        path = Path(evidence_path)
        if path.is_absolute() or ".." in path.parts:
            fail(f"{MATRIX_PATH}: fixture {fixture_id} evidence for {consumer} has unsafe path {evidence_path!r}")
        markers = item.get("markers")
        if not isinstance(markers, list) or not markers or not all(isinstance(marker, str) and marker for marker in markers):
            fail(f"{MATRIX_PATH}: fixture {fixture_id} evidence for {consumer} must declare non-empty string markers")
    missing_evidence = sorted(set(consumers).difference(evidence_consumers))
    if missing_evidence:
        fail(f"{MATRIX_PATH}: fixture {fixture_id} lacks evidence for consumers: {missing_evidence}")

    return {
        "id": fixture_id,
        "path": relative_path,
        "format": fixture_format,
        "contract": contract,
        "proof_owner": proof_owner,
        "ci_tier": ci_tier,
        "shared": shared,
        "consumers": consumers,
        "non_consumers": non_consumers,
        "evidence": evidence,
    }


def require_string(entry: dict, key: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value:
        fail(f"{MATRIX_PATH}: fixture entry missing string {key!r}")
    return value


def validate_fixture_file(entry: dict) -> dict:
    relative_path = entry["path"]
    fixture_path = FIXTURES_ROOT / relative_path
    if not fixture_path.is_file():
        fail(f"missing shared fixture {fixture_path}")

    if entry["format"] == "json":
        with fixture_path.open("r", encoding="utf-8") as handle:
            parsed = json.load(handle)
        if not isinstance(parsed, dict):
            fail(f"{fixture_path}: JSON fixture must be an object")
    elif entry["format"] == "properties":
        validate_properties(fixture_path)
    elif entry["format"] == "tsv":
        validate_tsv(fixture_path)

    return {
        "id": entry["id"],
        "path": f"src/shared/fixtures/{relative_path}",
        "format": entry["format"],
        "proofOwner": entry["proof_owner"],
        "ciTier": entry["ci_tier"],
        "consumers": entry["consumers"],
        "nonConsumers": entry["non_consumers"],
        "shared": entry["shared"],
        "evidence": [
            validate_evidence_file(entry, evidence)
            for evidence in entry["evidence"]
        ],
    }


def validate_evidence_file(fixture: dict, evidence: dict) -> dict:
    evidence_path = ROOT / evidence["path"]
    if not evidence_path.is_file():
        fail(f"{MATRIX_PATH}: fixture {fixture['id']} evidence file does not exist: {evidence_path}")
    text = evidence_path.read_text(encoding="utf-8")
    for marker in evidence["markers"]:
        if marker not in text:
            fail(
                f"{MATRIX_PATH}: fixture {fixture['id']} evidence file {evidence['path']} "
                f"for {evidence['consumer']} lacks marker {marker!r}"
            )
    return {
        "consumer": evidence["consumer"],
        "kind": evidence.get("kind", "fixture-file"),
        "path": evidence["path"],
        "markers": evidence["markers"],
    }


def load_project_roots() -> dict[str, str]:
    roots = dict(PROJECT_ROOTS)
    for root, project_id in PROJECT_ROOTS.items():
        moon_file = ROOT / root / "moon.yml"
        if not moon_file.is_file():
            fail(f"{MATRIX_PATH}: fixture matrix project root {root} is missing moon.yml")
        match = re.search(r"(?m)^id:\s*[\"']?([^\"'\s#]+)", moon_file.read_text(encoding="utf-8"))
        if not match:
            fail(f"{MATRIX_PATH}: fixture matrix project root {root} moon.yml has no id")
        actual_project_id = match.group(1)
        if actual_project_id != project_id:
            fail(
                f"{MATRIX_PATH}: fixture matrix project root {root} expected id "
                f"{project_id}, got {actual_project_id}"
            )
    return roots


def project_for_path(path: Path, project_roots: dict[str, str]) -> str | None:
    relative = path.relative_to(ROOT).as_posix()
    best_root = ""
    best_project: str | None = None
    for root, project_id in project_roots.items():
        if relative == root or relative.startswith(f"{root}/"):
            if len(root) > len(best_root):
                best_root = root
                best_project = project_id
    return best_project


def validate_project_ids(entries: list[dict], project_roots: dict[str, str]) -> None:
    known_ids = set(project_roots.values())
    for entry in entries:
        ids = set(entry["consumers"]) | set(entry["non_consumers"])
        ids.update(evidence["consumer"] for evidence in entry["evidence"])
        unknown = sorted(ids.difference(known_ids))
        if unknown:
            fail(f"{MATRIX_PATH}: fixture {entry['id']} references unknown Moon project ids: {unknown}")


def detect_fixture_references(entries: list[dict], project_roots: dict[str, str]) -> list[dict]:
    by_pattern: dict[str, dict] = {}
    for entry in entries:
        relative_path = entry["path"]
        by_pattern[f"src/shared/fixtures/{relative_path}"] = entry
        by_pattern[relative_path] = entry

    detections: list[dict] = []
    seen: set[tuple[str, str, str]] = set()
    for scan_root in CONSUMPTION_SCAN_ROOTS:
        root = ROOT / scan_root
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in CODE_SUFFIXES:
                continue
            relative_parts = path.relative_to(ROOT).parts
            if any(part in IGNORED_DIR_NAMES for part in relative_parts):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for pattern, entry in by_pattern.items():
                if pattern not in text:
                    continue
                project_id = project_for_path(path, project_roots)
                if project_id is None:
                    fail(f"{MATRIX_PATH}: fixture reference in unmanaged path {path.relative_to(ROOT)}")
                if project_id in entry["non_consumers"] or project_id not in entry["consumers"]:
                    fail(
                        f"{MATRIX_PATH}: {project_id} references fixture {entry['id']} "
                        f"from {path.relative_to(ROOT)}, but allowed consumers are {entry['consumers']}"
                    )
                detection_key = (entry["id"], project_id, path.relative_to(ROOT).as_posix())
                if detection_key in seen:
                    continue
                seen.add(detection_key)
                detections.append(
                    {
                        "fixtureId": entry["id"],
                        "project": project_id,
                        "path": path.relative_to(ROOT).as_posix(),
                        "matched": pattern,
                    }
                )
    return detections


def write_consumption_report(entries: list[dict], detections: list[dict]) -> None:
    detections_by_fixture: dict[str, list[dict]] = {entry["id"]: [] for entry in entries}
    for detection in detections:
        detections_by_fixture.setdefault(detection["fixtureId"], []).append(detection)

    report = {
        "schemaVersion": 1,
        "fixtures": [
            {
                "id": entry["id"],
                "path": f"src/shared/fixtures/{entry['path']}",
                "consumers": entry["consumers"],
                "evidence": [
                    {
                        "consumer": evidence["consumer"],
                        "kind": evidence.get("kind", "fixture-file"),
                        "path": evidence["path"],
                    }
                    for evidence in entry["evidence"]
                ],
                "detectedReferences": detections_by_fixture.get(entry["id"], []),
            }
            for entry in entries
        ],
    }
    GENERATED_CONSUMPTION_REPORT.parent.mkdir(parents=True, exist_ok=True)
    GENERATED_CONSUMPTION_REPORT.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def validate_properties(path: Path) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    entries = [
        line
        for line in lines
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not entries:
        fail(f"{path}: properties fixture is empty")
    for line in entries:
        if "=" not in line:
            fail(f"{path}: properties line lacks '=': {line!r}")


def validate_tsv(path: Path) -> None:
    with path.open("r", encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle, delimiter="\t"))
    if len(rows) < 2:
        fail(f"{path}: TSV fixture must contain a header and at least one data row")
    width = len(rows[0])
    if width == 0:
        fail(f"{path}: TSV fixture header is empty")
    for index, row in enumerate(rows[1:], start=2):
        if len(row) != width:
            fail(f"{path}: row {index} has {len(row)} cells, expected {width}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fixtures",
        action="store_true",
        help="also validate fixture files and emit the generated manifest",
    )
    args = parser.parse_args()

    matrix = load_matrix()
    if matrix.get("schema_version") != 1:
        fail(f"{MATRIX_PATH}: schema_version must be 1")
    raw_fixtures = matrix.get("fixtures")
    if not isinstance(raw_fixtures, list) or not raw_fixtures:
        fail(f"{MATRIX_PATH}: must declare at least one [[fixtures]] entry")

    seen: set[str] = set()
    entries = [validate_fixture_entry(entry, seen) for entry in raw_fixtures]

    if args.fixtures:
        project_roots = load_project_roots()
        validate_project_ids(entries, project_roots)
        detections = detect_fixture_references(entries, project_roots)
        generated = {
            "schemaVersion": 1,
            "fixtures": [validate_fixture_file(entry) for entry in entries],
        }
        GENERATED_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        GENERATED_MANIFEST.write_text(json.dumps(generated, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        write_consumption_report(entries, detections)

    return 0


if __name__ == "__main__":
    sys.exit(main())
