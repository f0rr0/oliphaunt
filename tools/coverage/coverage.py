#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path
from typing import Any


PRODUCTS = (
    "oliphaunt-rust",
    "oliphaunt-swift",
    "oliphaunt-kotlin",
    "oliphaunt-js",
    "oliphaunt-react-native",
    "oliphaunt-wasix-rust",
)

PRODUCT_SOURCE_ROOTS = {
    "oliphaunt-rust": "src/sdks/rust",
    "oliphaunt-swift": "src/sdks/swift",
    "oliphaunt-kotlin": "src/sdks/kotlin",
    "oliphaunt-js": "src/sdks/js",
    "oliphaunt-react-native": "src/sdks/react-native",
    "oliphaunt-wasix-rust": "src/bindings/wasix-rust/crates/oliphaunt-wasix",
}

FORBIDDEN_PATH_PARTS = (
    "/node_modules/",
    "/target/",
    "/.build/",
    "/DerivedData/",
    "/build/",
    "/.cxx/",
    "/generated/",
    "/vendor/",
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


ROOT = repo_root()
BASELINE = ROOT / "coverage" / "baseline.toml"
COVERAGE_ROOT = ROOT / "target" / "coverage"


def fail(message: str) -> None:
    raise SystemExit(message)


def run(command: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print(f"\n==> {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def capture(command: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> str:
    print(f"\n==> {' '.join(command)}", flush=True)
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    print(result.stdout, end="")
    return result.stdout


def optional_capture(command: list[str], *, cwd: Path = ROOT) -> str | None:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except FileNotFoundError:
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def require_tool(name: str, install_hint: str) -> None:
    if shutil.which(name) is None:
        fail(f"missing required coverage tool: {name}\n\nInstall with:\n  {install_hint}")


def load_baseline() -> dict[str, Any]:
    if not BASELINE.is_file():
        fail(f"missing coverage baseline: {BASELINE.relative_to(ROOT)}")
    with BASELINE.open("rb") as handle:
        data = tomllib.load(handle)
    products = data.get("products")
    if not isinstance(products, dict):
        fail("coverage baseline must define [products.<id>] tables")
    return data


def product_config(product: str) -> dict[str, Any]:
    data = load_baseline()
    config = data["products"].get(product)
    if not isinstance(config, dict):
        fail(f"coverage baseline does not define product {product!r}")
    return config


def output_dir(product: str) -> Path:
    return COVERAGE_ROOT / product


def product_source_root(product: str) -> Path:
    source = PRODUCT_SOURCE_ROOTS.get(product)
    if source is None:
        fail(f"missing source root mapping for coverage product {product}")
    return ROOT / source


def product_source_prefix(product: str) -> str:
    return product_source_root(product).relative_to(ROOT).as_posix()


def reset_output(product: str) -> Path:
    out = output_dir(product)
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    return out


def rel_path(path: str | Path) -> str:
    raw = Path(path)
    try:
        return raw.resolve().relative_to(ROOT).as_posix()
    except (OSError, ValueError):
        return raw.as_posix()


@lru_cache(maxsize=512)
def repo_glob_regex(pattern: str) -> re.Pattern[str]:
    normalized = pattern.replace(os.sep, "/")
    parts: list[str] = ["^"]
    index = 0
    while index < len(normalized):
        char = normalized[index]
        if char == "*":
            if index + 1 < len(normalized) and normalized[index + 1] == "*":
                index += 2
                if index < len(normalized) and normalized[index] == "/":
                    index += 1
                    parts.append("(?:.*/)?")
                else:
                    parts.append(".*")
                continue
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        else:
            parts.append(re.escape(char))
        index += 1
    parts.append("$")
    return re.compile("".join(parts))


def matches_any(path: str, patterns: list[str]) -> bool:
    normalized = path.replace(os.sep, "/")
    return any(repo_glob_regex(pattern).match(normalized) is not None for pattern in patterns)


def source_globs(config: dict[str, Any]) -> list[str]:
    globs = config.get("source_globs")
    if not isinstance(globs, list) or not all(isinstance(item, str) for item in globs) or not globs:
        fail("coverage product config must define non-empty source_globs")
    return globs


def exclude_globs(config: dict[str, Any]) -> list[str]:
    globs = config.get("exclude_globs") or []
    if not isinstance(globs, list) or not all(isinstance(item, str) for item in globs):
        fail("coverage product config exclude_globs must be a list of strings")
    return globs


def waiver_entries(config: dict[str, Any]) -> list[dict[str, str]]:
    entries = config.get("waivers") or []
    if not isinstance(entries, list):
        fail("coverage waivers must be an array of tables")
    normalized = []
    for entry in entries:
        if not isinstance(entry, dict):
            fail("coverage waiver entries must be tables")
        path = entry.get("path")
        pattern = entry.get("glob")
        reason = entry.get("reason")
        evidence = entry.get("evidence")
        owner = entry.get("owner")
        expires = entry.get("expires")
        if (path is None) == (pattern is None):
            fail("coverage waiver must define exactly one of path or glob")
        if (
            not isinstance(path or pattern, str)
            or not isinstance(reason, str)
            or not isinstance(evidence, str)
            or not isinstance(owner, str)
            or not isinstance(expires, str)
        ):
            fail("coverage waiver path/glob, reason, evidence, owner, and expires must be strings")
        if not reason.strip() or not evidence.strip() or not owner.strip() or not expires.strip():
            fail("coverage waiver reason, evidence, owner, and expires must be non-empty")
        normalized.append(
            {
                "path": path or "",
                "glob": pattern or "",
                "reason": reason,
                "evidence": evidence,
                "owner": owner,
                "expires": expires,
            }
        )
    return normalized


def waiver_patterns(config: dict[str, Any]) -> list[str]:
    patterns: list[str] = []
    for waiver in waiver_entries(config):
        patterns.append(waiver["path"] or waiver["glob"])
    return patterns


def is_waived(path: str | Path, config: dict[str, Any]) -> bool:
    relative = rel_path(path)
    for waiver in waiver_entries(config):
        exact = waiver["path"]
        pattern = waiver["glob"]
        if exact and relative == exact:
            return True
        if pattern and matches_any(relative, [pattern]):
            return True
    return False


def allowed_file(path: str | Path, config: dict[str, Any]) -> bool:
    relative = rel_path(path)
    normalized = f"/{relative}"
    if not matches_any(relative, source_globs(config)):
        return False
    if matches_any(relative, exclude_globs(config)):
        return False
    if is_waived(relative, config):
        return False
    return not any(part in normalized for part in FORBIDDEN_PATH_PARTS)


def tracked_or_local_source_files(config: dict[str, Any]) -> list[str]:
    files: set[str] = set()
    for pattern in source_globs(config):
        for candidate in ROOT.glob(pattern):
            if candidate.is_file():
                files.add(rel_path(candidate))
    return sorted(files)


def validate_waivers(config: dict[str, Any]) -> list[dict[str, str]]:
    files = tracked_or_local_source_files(config)
    for waiver in waiver_entries(config):
        exact = waiver["path"]
        pattern = waiver["glob"]
        matched = [file for file in files if (exact and file == exact) or (pattern and matches_any(file, [pattern]))]
        if not matched:
            target = exact or pattern
            fail(f"coverage waiver does not match an owned source file: {target}")
    return waiver_entries(config)


def owned_unwaived_source_files(config: dict[str, Any]) -> list[str]:
    validate_waivers(config)
    owned = []
    for file in tracked_or_local_source_files(config):
        normalized = f"/{file}"
        if matches_any(file, exclude_globs(config)):
            continue
        if is_waived(file, config):
            continue
        if any(part in normalized for part in FORBIDDEN_PATH_PARTS):
            continue
        owned.append(file)
    return sorted(owned)


def percent(covered: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((covered / total) * 100.0, 2)


def parse_lcov(path: Path, config: dict[str, Any]) -> tuple[int, int, list[dict[str, Any]]]:
    files: list[dict[str, Any]] = []
    current_file: str | None = None
    current_lines: dict[int, int] = {}

    def flush() -> None:
        nonlocal current_file, current_lines
        if current_file is None:
            return
        if allowed_file(current_file, config):
            total = len(current_lines)
            covered = sum(1 for count in current_lines.values() if count > 0)
            if total > 0:
                files.append({"path": rel_path(current_file), "covered_lines": covered, "total_lines": total})
        current_file = None
        current_lines = {}

    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\n")
            if line.startswith("SF:"):
                flush()
                current_file = line[3:]
            elif line.startswith("DA:") and current_file is not None:
                line_no, count, *_ = line[3:].split(",")
                current_lines[int(line_no)] = int(count)
            elif line == "end_of_record":
                flush()
    flush()
    covered = sum(file["covered_lines"] for file in files)
    total = sum(file["total_lines"] for file in files)
    return covered, total, files


def normalize_javascript_report_path(product: str, raw_path: str) -> str:
    path = Path(raw_path)
    if path.is_absolute():
        return raw_path
    source_prefix = product_source_prefix(product)
    if raw_path.startswith(f"{source_prefix}/"):
        return raw_path
    return f"{source_prefix}/{raw_path}"


def parse_javascript_summary(
    path: Path,
    product: str,
    config: dict[str, Any],
) -> tuple[int, int, list[dict[str, Any]]]:
    data = json.loads(path.read_text())
    files: list[dict[str, Any]] = []
    for raw_path, entry in data.items():
        source_path = normalize_javascript_report_path(product, raw_path)
        if raw_path == "total" or not allowed_file(source_path, config):
            continue
        lines = entry.get("lines") or {}
        total = int(lines.get("total") or 0)
        covered = int(lines.get("covered") or 0)
        if total > 0:
            files.append({"path": rel_path(source_path), "covered_lines": covered, "total_lines": total})
    covered = sum(file["covered_lines"] for file in files)
    total = sum(file["total_lines"] for file in files)
    return covered, total, files


def resolve_kover_source_path(package_name: str, sourcefile_name: str) -> str:
    package_path = package_name.replace(".", "/")
    source_root = product_source_root("oliphaunt-kotlin") / "oliphaunt" / "src"
    candidates = sorted(source_root.glob(f"**/{package_path}/{sourcefile_name}"))
    source_candidates = [candidate for candidate in candidates if "Test" not in candidate.parts]
    if source_candidates:
        return rel_path(source_candidates[0])
    if candidates:
        return rel_path(candidates[0])
    return f"src/sdks/kotlin/oliphaunt/src/{package_path}/{sourcefile_name}"


def parse_kover_xml(path: Path, config: dict[str, Any]) -> tuple[int, int, list[dict[str, Any]]]:
    root = ET.parse(path).getroot()
    files: list[dict[str, Any]] = []
    for package in root.findall(".//package"):
        package_name = package.attrib.get("name", "")
        for sourcefile in package.findall("sourcefile"):
            name = sourcefile.attrib.get("name", "")
            source_path = resolve_kover_source_path(package_name, name)
            if not allowed_file(source_path, config):
                continue
            lines = sourcefile.findall("line")
            total = len(lines)
            covered = 0
            for line in lines:
                covered_instructions = int(line.attrib.get("ci", "0"))
                if covered_instructions > 0:
                    covered += 1
            if total > 0:
                files.append(
                    {
                        "path": source_path,
                        "covered_lines": covered,
                        "total_lines": total,
                    }
                )
    covered = sum(file["covered_lines"] for file in files)
    total = sum(file["total_lines"] for file in files)
    return covered, total, files


def parse_swift_json(path: Path, config: dict[str, Any]) -> tuple[int, int, list[dict[str, Any]]]:
    data = json.loads(path.read_text())
    files: list[dict[str, Any]] = []
    for report in data.get("data", []):
        for file_entry in report.get("files", []):
            filename = file_entry.get("filename") or file_entry.get("name")
            if not filename or not allowed_file(filename, config):
                continue
            summary = file_entry.get("summary") or {}
            lines = summary.get("lines") or {}
            total = int(lines.get("count") or lines.get("total") or 0)
            covered = int(lines.get("covered") or 0)
            if total > 0:
                files.append({"path": rel_path(filename), "covered_lines": covered, "total_lines": total})
    covered = sum(file["covered_lines"] for file in files)
    total = sum(file["total_lines"] for file in files)
    return covered, total, files


def write_summary(
    product: str,
    tool: str,
    covered_lines: int,
    total_lines: int,
    files: list[dict[str, Any]],
    reports: list[Path],
) -> Path:
    out = output_dir(product)
    config = product_config(product)
    files = sorted(files, key=lambda item: item["path"])
    summary = {
        "schema": "oliphaunt-coverage-summary-v1",
        "product": product,
        "tool": tool,
        "line_coverage": percent(covered_lines, total_lines),
        "line_threshold": float(config["line_threshold"]),
        "covered_lines": covered_lines,
        "total_lines": total_lines,
        "files": files,
        "reports": [rel_path(path) for path in reports],
        "source_globs": source_globs(config),
        "exclude_globs": exclude_globs(config),
        "waived_files": [
            {
                "path": waiver["path"] or waiver["glob"],
                "reason": waiver["reason"],
                "evidence": waiver["evidence"],
                "owner": waiver["owner"],
                "expires": waiver["expires"],
            }
            for waiver in waiver_entries(config)
        ],
    }
    path = out / "summary.json"
    path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    return path


def check_summary(product: str) -> dict[str, Any]:
    config = product_config(product)
    summary_path = ROOT / config["summary"]
    if not summary_path.is_file():
        fail(f"{product}: missing measured coverage summary {summary_path.relative_to(ROOT)}")
    summary = json.loads(summary_path.read_text())
    if summary.get("product") != product:
        fail(f"{product}: coverage summary product mismatch")
    total = int(summary.get("total_lines") or 0)
    covered = int(summary.get("covered_lines") or 0)
    if total <= 0 or covered <= 0:
        fail(f"{product}: coverage summary is unmeasured: covered={covered} total={total}")
    files = summary.get("files", [])
    if not isinstance(files, list) or not files:
        fail(f"{product}: coverage summary contains no measured source files")
    measured = float(summary.get("line_coverage") or 0.0)
    threshold = float(config["line_threshold"])
    committed_measured = float(config.get("measured_line_coverage", 0.0))
    if committed_measured < threshold:
        fail(f"{product}: committed measured_line_coverage is below line_threshold")
    if measured + 0.005 < threshold:
        fail(f"{product}: line coverage {measured:.2f}% is below threshold {threshold:.2f}%")
    summary_reports = set(summary.get("reports", []))
    for report in config.get("reports", []):
        if report not in summary_reports:
            fail(f"{product}: coverage summary is missing expected report {report}")
    for report in summary_reports:
        report_path = ROOT / report
        if not report_path.is_file() or report_path.stat().st_size == 0:
            fail(f"{product}: missing or empty coverage report {report}")
    for file in files:
        source_path = file.get("path", "")
        path = f"/{source_path}"
        if any(part in path for part in FORBIDDEN_PATH_PARTS):
            fail(f"{product}: coverage includes generated/vendor/build path {source_path}")
        if not allowed_file(source_path, config):
            fail(f"{product}: coverage includes a source path outside the baseline scope: {source_path}")
    per_file_threshold = float(config.get("per_file_line_threshold", 0.0))
    if per_file_threshold > 0.0:
        for file in files:
            source_path = file.get("path", "")
            file_total = int(file.get("total_lines") or 0)
            file_covered = int(file.get("covered_lines") or 0)
            file_percent = percent(file_covered, file_total)
            if file_percent + 0.005 < per_file_threshold:
                fail(
                    f"{product}: {source_path} line coverage {file_percent:.2f}% "
                    f"is below per-file threshold {per_file_threshold:.2f}%"
                )
    measured_paths = {file.get("path", "") for file in files}
    missing_owned = sorted(set(owned_unwaived_source_files(config)) - measured_paths)
    if missing_owned:
        fail(
            f"{product}: owned source files are neither measured nor waived: "
            + ", ".join(missing_owned[:20])
            + (" ..." if len(missing_owned) > 20 else "")
        )
    return summary


def run_rust(product: str) -> None:
    package = "oliphaunt" if product == "oliphaunt-rust" else "oliphaunt-wasix"
    out = reset_output(product)
    lcov = out / "lcov.info"
    require_tool("cargo", "rustup toolchain install 1.93")
    if subprocess.run(["cargo", "llvm-cov", "--version"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        fail("missing required coverage tool: cargo-llvm-cov\n\nInstall with:\n  cargo install cargo-llvm-cov")
    if subprocess.run(["cargo", "nextest", "--version"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        fail("missing required coverage tool: cargo-nextest\n\nInstall with:\n  cargo install cargo-nextest --locked")
    env = os.environ.copy()
    if "LLVM_COV" not in env:
        llvm_cov = shutil.which("llvm-cov") or optional_capture(["xcrun", "--find", "llvm-cov"])
        if llvm_cov:
            env["LLVM_COV"] = llvm_cov
    if "LLVM_PROFDATA" not in env:
        llvm_profdata = shutil.which("llvm-profdata") or optional_capture(["xcrun", "--find", "llvm-profdata"])
        if llvm_profdata:
            env["LLVM_PROFDATA"] = llvm_profdata
    feature_args = ["--no-default-features"] if product == "oliphaunt-wasix-rust" else []
    target_args = ["--lib"] if product == "oliphaunt-wasix-rust" else []
    run(["cargo", "llvm-cov", "clean", "--profraw-only"], env=env)
    run(
        [
            "cargo",
            "llvm-cov",
            "nextest",
            "--package",
            package,
            *target_args,
            *feature_args,
            "--locked",
            "--profile",
            "ci",
            "--no-tests=fail",
            "--test-threads=1",
            "--no-report",
        ],
        env=env,
    )
    run(
        [
            "cargo",
            "test",
            "--doc",
            "--package",
            package,
            "--locked",
        ],
        env=env,
    )
    run(["cargo", "llvm-cov", "report", "--lcov", "--output-path", str(lcov)], env=env)
    covered, total, files = parse_lcov(lcov, product_config(product))
    write_summary(product, "cargo-llvm-cov", covered, total, files, [lcov])
    check_summary(product)


def run_swift() -> None:
    out = reset_output("oliphaunt-swift")
    scratch = ROOT / "target" / "coverage-build" / "oliphaunt-swift"
    shutil.rmtree(scratch, ignore_errors=True)
    require_tool("swift", "Install Xcode or the Swift toolchain")
    run(
        [
            "swift",
            "test",
            "--package-path",
            str(ROOT),
            "--scratch-path",
            str(scratch),
            "--enable-code-coverage",
        ]
    )
    output = capture(
        [
            "swift",
            "test",
            "--package-path",
            str(ROOT),
            "--scratch-path",
            str(scratch),
            "--show-codecov-path",
        ]
    )
    candidates = [
        Path(line.strip())
        for line in output.splitlines()
        if line.strip().endswith(".json") and Path(line.strip()).is_file()
    ]
    if not candidates:
        candidates = list(scratch.rglob("*.json"))
    if not candidates:
        fail("oliphaunt-swift: swift test did not emit a code coverage JSON path")
    report = out / "swift-coverage.json"
    shutil.copyfile(candidates[-1], report)
    covered, total, files = parse_swift_json(report, product_config("oliphaunt-swift"))
    write_summary("oliphaunt-swift", "swift test --enable-code-coverage", covered, total, files, [report])
    check_summary("oliphaunt-swift")


def run_kotlin() -> None:
    out = reset_output("oliphaunt-kotlin")
    require_tool("java", "Install JDK 17")
    package_dir = product_source_root("oliphaunt-kotlin")
    gradle = package_dir / "gradlew"
    build_root = ROOT / "target" / "coverage-build" / "oliphaunt-kotlin" / "gradle"
    cxx_build_root = ROOT / "target" / "coverage-build" / "oliphaunt-kotlin" / "cxx"
    project_cache = ROOT / "target" / "coverage-build" / "oliphaunt-kotlin" / "gradle-cache"
    shutil.rmtree(build_root, ignore_errors=True)
    shutil.rmtree(cxx_build_root, ignore_errors=True)
    run(
        [
            str(gradle),
            "-p",
            str(package_dir.relative_to(ROOT)),
            ":oliphaunt:koverXmlReport",
            ":oliphaunt:koverVerify",
            "--no-daemon",
            f"-PoliphauntBuildRoot={build_root}",
            f"-PoliphauntCxxBuildRoot={cxx_build_root}",
            "--project-cache-dir",
            str(project_cache),
        ]
    )
    reports = sorted(build_root.rglob("reports/kover/**/*.xml"))
    if not reports:
        reports = sorted(package_dir.rglob("build/reports/kover/**/*.xml"))
    if not reports:
        fail("oliphaunt-kotlin: Kover did not emit an XML report")
    report = out / "kover.xml"
    shutil.copyfile(reports[-1], report)
    covered, total, files = parse_kover_xml(report, product_config("oliphaunt-kotlin"))
    write_summary("oliphaunt-kotlin", "kover", covered, total, files, [report])
    check_summary("oliphaunt-kotlin")


def run_javascript(product: str) -> None:
    out = reset_output(product)
    package_dir = product_source_root(product)
    require_tool("pnpm", "corepack enable && corepack prepare pnpm@11.5.0 --activate")
    config = product_config(product)
    threshold = str(int(float(config["line_threshold"])))
    include_patterns: list[str] = []
    for pattern in source_globs(config):
        prefix = f"{product_source_prefix(product)}/"
        include_patterns.append(pattern.removeprefix(prefix))
    exclude_patterns: list[str] = []
    for pattern in [*exclude_globs(config), *waiver_patterns(config)]:
        prefix = f"{product_source_prefix(product)}/"
        exclude_patterns.append(pattern.removeprefix(prefix))
    env = os.environ.copy()
    env.update(
        {
            "OLIPHAUNT_VITEST_COVERAGE": "1",
            "OLIPHAUNT_VITEST_COVERAGE_DIR": str(out),
            "OLIPHAUNT_VITEST_COVERAGE_INCLUDE": json.dumps(include_patterns),
            "OLIPHAUNT_VITEST_COVERAGE_EXCLUDE": json.dumps(exclude_patterns),
            "OLIPHAUNT_VITEST_COVERAGE_LINES": threshold,
        }
    )
    run(["pnpm", "--dir", str(package_dir), "test"], env=env)
    summary_report = out / "coverage-summary.json"
    if not summary_report.is_file():
        fail(f"{product}: Vitest did not emit {summary_report.relative_to(ROOT)}")
    covered, total, files = parse_javascript_summary(summary_report, product, config)
    reports = [summary_report]
    lcov = out / "lcov.info"
    if lcov.is_file():
        reports.append(lcov)
    write_summary(product, "vitest-v8", covered, total, files, reports)
    check_summary(product)


def run_product(product: str) -> None:
    if product not in PRODUCTS:
        fail(f"unknown product {product!r}; expected one of {', '.join(PRODUCTS)}")
    if product in ("oliphaunt-rust", "oliphaunt-wasix-rust"):
        run_rust(product)
    elif product == "oliphaunt-swift":
        run_swift()
    elif product == "oliphaunt-kotlin":
        run_kotlin()
    elif product in ("oliphaunt-js", "oliphaunt-react-native"):
        run_javascript(product)
    else:
        fail(f"unhandled coverage product {product}")


def parse_products_json(value: str | None) -> list[str]:
    if value is None or not value.strip():
        return list(PRODUCTS)
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        fail(f"coverage products JSON is invalid: {error}")
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        fail("coverage products JSON must be a string array")
    unknown = sorted(set(parsed) - set(PRODUCTS))
    if unknown:
        fail("unknown coverage product(s): " + ", ".join(unknown))
    return sorted(set(parsed), key=PRODUCTS.index)


def summarize(*, allow_missing: bool = False, products_json: str | None = None) -> None:
    data = load_baseline()
    products = data["products"]
    selected_products = parse_products_json(products_json)
    rows = []
    all_summaries = []
    for product in selected_products:
        if product not in products:
            if data.get("policy", {}).get("fail_on_unmeasured_product", True):
                fail(f"missing coverage baseline for {product}")
            continue
        summary_path = ROOT / products[product]["summary"]
        if allow_missing and not summary_path.is_file():
            continue
        if not summary_path.is_file():
            fail(f"missing required coverage summary: {summary_path.relative_to(ROOT)}")
        summary = check_summary(product)
        all_summaries.append(summary)
        rows.append(
            "| {product} | {tool} | {line_coverage:.2f}% | {line_threshold:.2f}% | {covered_lines}/{total_lines} |".format(
                **summary
            )
        )
    COVERAGE_ROOT.mkdir(parents=True, exist_ok=True)
    aggregate = {
        "schema": "oliphaunt-coverage-aggregate-v1",
        "products": all_summaries,
    }
    (COVERAGE_ROOT / "summary.json").write_text(json.dumps(aggregate, indent=2, sort_keys=True) + "\n")
    markdown = "\n".join(
        [
            "| Product | Tool | Lines | Threshold | Covered |",
            "| --- | --- | ---: | ---: | ---: |",
            *rows,
            "",
        ]
    )
    (COVERAGE_ROOT / "summary.md").write_text(markdown)
    print(markdown)


def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Oliphaunt coverage runner")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run-product")
    run_parser.add_argument("product", choices=PRODUCTS)
    check_parser = subparsers.add_parser("check-product")
    check_parser.add_argument("product", choices=PRODUCTS)
    summarize_parser = subparsers.add_parser("summarize")
    summarize_parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="summarize only measured product reports that are present",
    )
    summarize_parser.add_argument(
        "--products-json",
        help="JSON string array of product reports that must be present",
    )
    args = parser.parse_args(argv)
    if args.command == "run-product":
        run_product(args.product)
    elif args.command == "check-product":
        summary = check_summary(args.product)
        print(f"{args.product}: {summary['line_coverage']:.2f}% line coverage")
    elif args.command == "summarize":
        summarize(allow_missing=args.allow_missing, products_json=args.products_json)


if __name__ == "__main__":
    main(sys.argv[1:])
