#!/usr/bin/env python3

from __future__ import annotations

import csv
import hashlib
import importlib.util
import os
import subprocess
import sys
import tempfile
from unittest import mock
from pathlib import Path


SCRIPT = Path(__file__).with_name("compare-libpq-latency.py")
SPEC = importlib.util.spec_from_file_location("compare_libpq_latency", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
LATENCY_HEADER = [
    "schema_version", "target", "mode", "status", "clock", "warmup_count",
    "sample_count", "p50_ns", "p95_ns", "p99_ns", "p50_ms", "p95_ms",
    "p99_ms", "raw_tsv", "libpq_path", "libpq_sha256", "probe_sha256",
]
RUN_HEADER = [
    "schema_version", "block", "order", "pair", "position", "target",
    "run_label", "harness_status", "report_dir", "effective_settings",
    "effective_settings_sha256", "carrier_closure_identity",
    "native_oracle_identity", "postgres_profile_resolution_identity",
    "qualification_plan_identity",
]
PROFILE_HEADER = [
    "schema_version", "block", "order", "pair", "native_settings",
    "wasix_settings", "comparison", "comparison_sha256", "status",
]
REQUIRED_SETTINGS = (
    "autovacuum_worker_slots", "backend_flush_after", "bgwriter_flush_after",
    "checkpoint_flush_after", "checkpoint_timeout", "fsync",
    "full_page_writes", "io_method", "max_connections", "max_wal_senders",
    "max_worker_processes", "max_wal_size", "min_wal_size",
    "shared_buffers", "synchronous_commit", "wal_segment_size",
)
SANITIZED_WAIT_DUMP_ENVIRONMENT = " ".join((
    "WASIX_PERF_WAIT_DUMP_INTERVAL_MS", "WASIX_PERF_WAIT_DUMP_FILE",
    "WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT", "WASIX_PERF_WAIT_DUMP_VERBOSE",
    "WASIX_WAIT_DUMP_INTERVAL_MS", "WASIX_WAIT_DUMP_FILE",
    "WASIX_WAIT_DUMP_MAX_PER_WAIT", "WASIX_WAIT_DUMP_VERBOSE",
    "WASIX_WAIT_DUMP_FENCE_REQUEST_FILE",
    "WASIX_WAIT_DUMP_FENCE_ACK_FILE",
))


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_tsv(path: Path, header: list[str], rows: list[list[object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def file_digest(path: Path) -> str:
    return digest(path.read_bytes())


def make_fixture(root: Path) -> dict[str, object]:
    install = root / "native"
    (install / "lib").mkdir(parents=True)
    libpq = install / "lib" / "libpq.so.5"
    libpq.write_bytes(b"exact fake libpq\n")
    libpq_sha = file_digest(libpq)
    manifest = root / "native-oracle.tsv"
    write_tsv(
        manifest,
        ["schema", "kind", "path", "bytes", "sha256_or_target"],
        [["oliphaunt.wasix-postmaster.native-oracle.v1", "file", "lib/libpq.so.5", len(libpq.read_bytes()), libpq_sha]],
    )
    native_identity = file_digest(manifest)

    profile_source = root / "embedded-concurrent-v1.gucs"
    profile_source.write_text("shared_buffers=32MB\n", encoding="utf-8")
    profile_source_sha = file_digest(profile_source)
    profile_inputs = root / "postgres-profile-inputs.tsv"
    profile_resolution = root / "postgres-profile-resolution.tsv"
    write_tsv(profile_inputs, ["kind", "id", "path", "sha256"], [["runtime-footprint", "embedded-concurrent", profile_source, profile_source_sha]])
    write_tsv(profile_resolution, ["name", "value", "source", "profile_id", "profile_path", "profile_sha256", "precedence"], [["shared_buffers", "32MB", "runtime-footprint", "embedded-concurrent", profile_source, profile_source_sha, "1"]])

    carrier = "a" * 64
    profile = digest(
        (
            "schema\toliphaunt.wasix-postmaster.postgres-profile-resolution.v1\n"
            f"input\truntime-footprint\tembedded-concurrent\t{profile_source_sha}\n"
            f"setting\tshared_buffers\t32MB\truntime-footprint\tembedded-concurrent\t{profile_source_sha}\t1\n"
        ).encode()
    )
    probe_source = "c" * 64
    plan = "d" * 64
    probe_bytes = b"exact fake latency probe\n"
    probe = digest(probe_bytes)
    run_root = root / "runs-root"
    run_rows: list[list[object]] = []
    comparison_rows: list[list[object]] = []
    settings_by_key: dict[tuple[int, int, str], Path] = {}
    reports: list[Path] = []
    for block in (1, 2):
        order = "ABBA" if block == 1 else "BAAB"
        targets = ("native", "wasix", "wasix", "native") if block == 1 else ("wasix", "native", "native", "wasix")
        for position, target in enumerate(targets, 1):
            pair = (position + 1) // 2
            label = f"fixture-b{block:02d}-p{position}-{target}"
            report = root / "reports" / label
            report.mkdir(parents=True)
            reports.append(report)
            probe_path = run_root / label / "libpq-latency-probe"
            probe_path.parent.mkdir(parents=True)
            probe_path.write_bytes(probe_bytes)
            settings = report / target / "effective-postgres-settings.tsv"
            write_tsv(
                settings,
                ["name", "setting", "unit", "source"],
                [[name, "value", "", "command line"] for name in REQUIRED_SETTINGS],
            )
            settings_by_key[(block, pair, target)] = settings
            (report / "postgres-profile-inputs.tsv").write_bytes(profile_inputs.read_bytes())
            (report / "postgres-profile-resolution.tsv").write_bytes(profile_resolution.read_bytes())

            latency_rows: list[list[object]] = []
            for mode in ("persistent", "reconnect"):
                if mode == "persistent":
                    value = 100_000 if target == "native" else 150_000
                else:
                    value = 5_000_000 if target == "native" else 12_000_000
                raw = report / target / "libpq-latency" / f"{mode}.raw.tsv"
                write_tsv(
                    raw,
                    ["schema_version", "mode", "phase", "sample_index", "duration_ns", "status"],
                    [["1", mode, "warmup", 1, value, "ok"]]
                    + [["1", mode, "measure", sample, value, "ok"] for sample in range(1, 6)],
                )
                latency_rows.append([
                    "1", target, mode, "ok", "CLOCK_MONOTONIC", 1, 5,
                    value, value, value, f"{value / 1_000_000:.6f}",
                    f"{value / 1_000_000:.6f}", f"{value / 1_000_000:.6f}",
                    raw, libpq, libpq_sha, probe,
                ])
            write_tsv(report / "libpq-latency-summary.tsv", LATENCY_HEADER, latency_rows)
            write_tsv(
                report / "host-fd-churn-summary.tsv",
                ["target", "mode", "before_open_fds", "after_open_fds", "quiescent_open_fds", "quiescent_growth", "allowance", "status"],
                [[target, mode, 10, 10, 10, 0, 0, "passed"] for mode in ("persistent", "reconnect")],
            )
            write_tsv(
                report / "server-limits.tsv",
                ["target", "requested_soft_nofile", "pre_soft_nofile", "pre_hard_nofile", "actual_soft_nofile", "actual_hard_nofile", "status", "launch_record"],
                [[target, 1024, 4096, 4096, 1024, 4096, "passed", report / "launch.tsv"]],
            )
            write_tsv(
                report / "server-lifecycle.tsv",
                ["target", "server_pid", "server_pgid", "server_birth_identity", "cgroup_path", "cgroup_identity", "orderly_int", "forced", "wait_status", "clean_shutdown_marker", "process_group_residue", "cgroup_residue", "port_residue", "status", "report"],
                [[target, 100, 100, "birth", "", "", 1, "none", 0, 1, 0, 0, 0, "passed", report / "shutdown.tsv"]],
            )
            write_tsv(
                report / "instrumentation-policy.tsv",
                ["schema_version", "lane", "wasix_perf_stats", "wait_dump_policy", "wait_dump_interval_ms", "wait_dump_max_per_wait", "wait_dump_verbose", "fence_protocol", "sanitized_environment"],
                [["oliphaunt.wasix-postmaster.instrumentation.v1", "benchmark", 0, "prohibited", 0, 0, 0, "none", SANITIZED_WAIT_DUMP_ENVIRONMENT]],
            )
            run_rows.append([
                "1", block, order, pair, position, target, label, 0, report,
                settings, file_digest(settings), carrier, native_identity, profile, plan,
            ])
        for pair in (1, 2):
            native = settings_by_key[(block, pair, "native")]
            wasix = settings_by_key[(block, pair, "wasix")]
            comparison = root / "comparisons" / f"b{block:02d}-p{pair}.tsv"
            write_tsv(
                comparison,
                ["name", "native_setting", "native_unit", "native_source", "wasix_setting", "wasix_unit", "wasix_source", "status"],
                [[name, "value", "", "command line", "value", "", "command line", "matched"] for name in REQUIRED_SETTINGS],
            )
            comparison_rows.append(["1", block, order, pair, native, wasix, comparison, file_digest(comparison), "passed"])

    runs = root / "runs.tsv"
    comparisons = root / "profile-comparisons.tsv"
    write_tsv(runs, RUN_HEADER, run_rows)
    write_tsv(comparisons, PROFILE_HEADER, comparison_rows)
    return {
        "root": root,
        "install": install,
        "libpq": libpq,
        "manifest": manifest,
        "native_identity": native_identity,
        "profile_inputs": profile_inputs,
        "profile_resolution": profile_resolution,
        "carrier": carrier,
        "profile": profile,
        "probe_source": probe_source,
        "plan": plan,
        "runs": runs,
        "comparisons": comparisons,
        "reports": reports,
        "run_root": run_root,
    }


def command(fixture: dict[str, object], suffix: str, *extra: str) -> list[str]:
    root = fixture["root"]
    assert isinstance(root, Path)
    return [
        sys.executable, str(SCRIPT),
        "--runs", str(fixture["runs"]),
        "--profile-comparisons", str(fixture["comparisons"]),
        "--profile-inputs", str(fixture["profile_inputs"]),
        "--profile-resolution", str(fixture["profile_resolution"]),
        "--native-oracle-manifest", str(fixture["manifest"]),
        "--native-install-dir", str(fixture["install"]),
        "--benchmark-reports-root", str(root / "reports"),
        "--benchmark-runs-root", str(fixture["run_root"]),
        "--expected-blocks", "2", "--expected-warmup", "1", "--expected-samples", "5",
        "--carrier-identity", str(fixture["carrier"]),
        "--native-oracle-identity", str(fixture["native_identity"]),
        "--profile-identity", str(fixture["profile"]),
        "--probe-source-sha256", str(fixture["probe_source"]),
        "--plan-identity", str(fixture["plan"]),
        "--receipt-output", str(root / f"samples-{suffix}.tsv"),
        "--pairs-output", str(root / f"pairs-{suffix}.tsv"),
        "--summary-output", str(root / f"summary-{suffix}.tsv"),
        "--identity-output", str(root / f"identity-{suffix}.tsv"),
        *extra,
    ]


def run(command_line: list[str], expected: int) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command_line, text=True, capture_output=True, check=False)
    if result.returncode != expected:
        raise AssertionError(f"expected exit {expected}, got {result.returncode}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result


def replace_cell(path: Path, header_name: str, row_index: int, value: str) -> None:
    with path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.reader(handle, delimiter="\t"))
    column = rows[0].index(header_name)
    rows[row_index][column] = value
    write_tsv(path, rows[0], rows[1:])


def publication_set(root: Path, value: str = "exact"):
    root.mkdir(parents=True, exist_ok=True)
    return tuple(
        (root / name, ("kind", "value"), ((kind, value),))
        for name, kind in (
            ("samples.tsv", "samples"),
            ("paired-samples.tsv", "pairs"),
            ("paired-summary.tsv", "summary"),
            ("sample-identity.tsv", "identity"),
        )
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="libpq-latency-comparator-") as temporary:
        root = Path(temporary)

        raced_outputs = publication_set(root / "publication-race")
        raced = raced_outputs[0][0]
        competitor = b"concurrent owner\n"
        real_publish_set = MODULE.publish_no_replace_set

        def publish_after_competitor(paths) -> None:
            raced.write_bytes(competitor)
            real_publish_set(paths)

        with mock.patch.object(
            MODULE, "publish_no_replace_set", publish_after_competitor
        ):
            try:
                MODULE.publish_tsv_set(raced_outputs)
            except MODULE.EvidenceError:
                pass
            else:
                raise AssertionError("commit-time destination race was accepted")
        assert raced.read_bytes() == competitor
        assert all(
            not destination.exists()
            for destination, _, _ in raced_outputs[1:]
        )
        assert not list((root / "publication-race").glob(".*.pending.*"))

        crash_outputs = publication_set(root / "publication-crash")
        durable_module = sys.modules[MODULE.publish_no_replace_set.__module__]
        real_publish = durable_module.publish_identified
        if hasattr(os, "fork"):
            child = os.fork()
            if child == 0:
                published = 0

                def crash_after_second(source: Path, destination: Path, expected) -> None:
                    nonlocal published
                    real_publish(source, destination, expected)
                    published += 1
                    if published == 2:
                        os._exit(91)

                with mock.patch.object(
                    durable_module, "publish_identified", crash_after_second
                ):
                    MODULE.publish_tsv_set(crash_outputs)
                os._exit(92)
            waited, status = os.waitpid(child, 0)
            assert waited == child and os.WIFEXITED(status)
            assert os.WEXITSTATUS(status) == 91
            assert [
                destination.exists() for destination, _, _ in crash_outputs
            ] == [True, True, False, False]
        crashed_private_sources = set(
            (root / "publication-crash").glob(".*.pending.*")
        )
        assert len(crashed_private_sources) == (2 if hasattr(os, "fork") else 0)

        MODULE.publish_tsv_set(crash_outputs)
        admitted = {
            destination: (destination.stat().st_dev, destination.stat().st_ino)
            for destination, _, _ in crash_outputs
        }
        assert all(destination.is_file() for destination in admitted)
        assert set(
            (root / "publication-crash").glob(".*.pending.*")
        ) == crashed_private_sources
        MODULE.publish_tsv_set(crash_outputs)
        assert admitted == {
            destination: (destination.stat().st_dev, destination.stat().st_ino)
            for destination in admitted
        }
        assert set(
            (root / "publication-crash").glob(".*.pending.*")
        ) == crashed_private_sources

        try:
            MODULE.publish_tsv_set(
                publication_set(root / "publication-crash", "different")
            )
        except MODULE.EvidenceError:
            pass
        else:
            raise AssertionError("different output-set replay was accepted")
        assert admitted == {
            destination: (destination.stat().st_dev, destination.stat().st_ino)
            for destination in admitted
        }
        assert set(
            (root / "publication-crash").glob(".*.pending.*")
        ) == crashed_private_sources
        MODULE.publish_tsv_set(crash_outputs)
        assert admitted == {
            destination: (destination.stat().st_dev, destination.stat().st_ino)
            for destination in admitted
        }

        valid = make_fixture(root / "valid")
        run(command(valid, "valid"), 0)
        summary = (valid["root"] / "summary-valid.tsv").read_text(encoding="utf-8")
        assert "persistent\tpassed\t4\t4\t4" in summary
        assert "reconnect\tpassed\t4\t4\t4" in summary
        assert len((valid["root"] / "samples-valid.tsv").read_text().splitlines()) == 17
        assert len((valid["root"] / "pairs-valid.tsv").read_text().splitlines()) == 9
        valid_outputs = tuple(
            valid["root"] / name
            for name in (
                "samples-valid.tsv",
                "pairs-valid.tsv",
                "summary-valid.tsv",
                "identity-valid.tsv",
            )
        )
        valid_identities = {
            path: (path.stat().st_dev, path.stat().st_ino)
            for path in valid_outputs
        }
        run(command(valid, "valid"), 0)
        assert valid_identities == {
            path: (path.stat().st_dev, path.stat().st_ino)
            for path in valid_outputs
        }

        gated = make_fixture(root / "gated")
        run(command(gated, "gated", "--max-persistent-p95-ratio", "1.49"), 1)
        gated_summary = (gated["root"] / "summary-gated.tsv").read_text(encoding="utf-8")
        assert "persistent\tfailed" in gated_summary
        assert "paired_p95_ratio_p95=1.5>1.49" in gated_summary
        assert (gated["root"] / "samples-gated.tsv").is_file()

        gate_cases = (
            ("persistent-p99-ratio", "--max-persistent-p99-ratio", "1.49", "paired_p99_ratio_p95"),
            ("reconnect-p95-ratio", "--max-reconnect-p95-ratio", "2.39", "paired_p95_ratio_p95"),
            ("reconnect-p99-ratio", "--max-reconnect-p99-ratio", "2.39", "paired_p99_ratio_p95"),
            ("persistent-p95-absolute", "--max-wasix-persistent-p95-ms", "0.149", "wasix_p95_ms_p95"),
            ("persistent-p99-absolute", "--max-wasix-persistent-p99-ms", "0.149", "wasix_p99_ms_p95"),
            ("reconnect-p95-absolute", "--max-wasix-reconnect-p95-ms", "11.9", "wasix_p95_ms_p95"),
            ("reconnect-p99-absolute", "--max-wasix-reconnect-p99-ms", "11.9", "wasix_p99_ms_p95"),
        )
        for suffix, option, limit, expected_detail in gate_cases:
            gate_fixture = make_fixture(root / suffix)
            run(command(gate_fixture, suffix, option, limit), 1)
            gate_summary = (gate_fixture["root"] / f"summary-{suffix}.tsv").read_text(encoding="utf-8")
            assert expected_detail in gate_summary

        boundary = make_fixture(root / "boundary")
        run(
            command(
                boundary,
                "boundary",
                "--max-persistent-p95-ratio", "1.5",
                "--max-persistent-p99-ratio", "1.5",
                "--max-reconnect-p95-ratio", "2.4",
                "--max-reconnect-p99-ratio", "2.4",
                "--max-wasix-persistent-p95-ms", "0.15",
                "--max-wasix-persistent-p99-ms", "0.15",
                "--max-wasix-reconnect-p95-ms", "12",
                "--max-wasix-reconnect-p99-ms", "12",
            ),
            0,
        )

        malformed = make_fixture(root / "raw-mutation")
        report = malformed["reports"][0]
        assert isinstance(report, Path)
        raw = report / "native" / "libpq-latency" / "persistent.raw.tsv"
        replace_cell(raw, "duration_ns", 2, "100001")
        result = run(command(malformed, "raw-mutation"), 2)
        assert "summary percentiles do not match raw evidence" in result.stderr
        assert not (malformed["root"] / "samples-raw-mutation.tsv").exists()

        wrong_order = make_fixture(root / "wrong-order")
        replace_cell(wrong_order["runs"], "order", 1, "BAAB")
        result = run(command(wrong_order, "wrong-order"), 2)
        assert "block 1 must use ABBA" in result.stderr

        identity = make_fixture(root / "identity")
        replace_cell(identity["runs"], "qualification_plan_identity", 1, "f" * 64)
        result = run(command(identity, "identity"), 2)
        assert "qualification plan identity mismatch" in result.stderr

        probe = make_fixture(root / "probe")
        report = probe["reports"][0]
        assert isinstance(report, Path)
        replace_cell(report / "libpq-latency-summary.tsv", "probe_sha256", 1, "f" * 64)
        result = run(command(probe, "probe"), 2)
        assert "probe SHA-256 does not match the exact run binary" in result.stderr

        profile = make_fixture(root / "profile")
        replace_cell(profile["comparisons"], "status", 1, "failed")
        result = run(command(profile, "profile"), 2)
        assert "profile comparison did not pass" in result.stderr

        source = make_fixture(root / "profile-source")
        source_path = source["root"] / "embedded-concurrent-v1.gucs"
        source_path.write_text("shared_buffers=64MB\n", encoding="utf-8")
        result = run(command(source, "profile-source"), 2)
        assert "profile input source hash mismatch" in result.stderr

        settings = make_fixture(root / "settings")
        wasix_settings = settings["reports"][1] / "wasix" / "effective-postgres-settings.tsv"
        replace_cell(wasix_settings, "setting", 1, "different")
        replace_cell(settings["runs"], "effective_settings_sha256", 2, file_digest(wasix_settings))
        result = run(command(settings, "settings"), 2)
        assert "native/WASIX effective settings differ" in result.stderr

        instrumentation = make_fixture(root / "instrumentation")
        report = instrumentation["reports"][0]
        assert isinstance(report, Path)
        replace_cell(report / "instrumentation-policy.tsv", "wasix_perf_stats", 1, "1")
        result = run(command(instrumentation, "instrumentation"), 2)
        assert "noncanonical instrumentation policy" in result.stderr

    print("libpq latency comparator tests passed")


if __name__ == "__main__":
    main()
