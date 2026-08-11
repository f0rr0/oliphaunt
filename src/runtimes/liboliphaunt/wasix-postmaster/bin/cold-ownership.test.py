#!/usr/bin/env python3

from __future__ import annotations

import csv
import hashlib
import importlib.util
import io
import json
import os
import resource
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PROVER = ROOT / "bin" / "prove-linux-cold-residency.py"
CAPTURE = ROOT / "bin" / "capture-linux-cgroup-v2.py"
VALIDATOR = ROOT / "bin" / "validate-wasix-cold-ownership.py"
SUMMARIZER = ROOT / "bin" / "summarize-wasix-cold-ownership.py"
BENCH = ROOT / "bin" / "bench-wasix-concurrent-query-suite.sh"
PROCESS_SUPERVISION = ROOT / "lib" / "process-supervision.sh"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def shell_function(path: Path, name: str) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    marker = f"{name}() {{"
    start = lines.index(marker)
    for end in range(start + 1, len(lines)):
        if lines[end] == "}":
            return "\n".join(lines[start : end + 1])
    raise AssertionError(f"unterminated shell function: {name}")


class ColdOwnershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cold-ownership-test-")
        self.root = Path(self.temp.name)
        self.carrier = self.root / "carrier"
        self.pgdata = self.root / "pgdata"
        (self.carrier / "bin").mkdir(parents=True)
        (self.carrier / "aot").mkdir()
        self.pgdata.mkdir()
        (self.carrier / "bin" / "wasmer-headless").write_bytes(b"runtime\n" * 8192)
        (self.carrier / "aot" / "module.bin").write_bytes(b"aot\n" * 4096)
        (self.pgdata / "PG_VERSION").write_text("18\n", encoding="ascii")
        (self.pgdata / "base").mkdir()
        (self.pgdata / "base" / "relation").write_bytes(b"relation\n" * 4096)
        for directory, _, files in os.walk(self.carrier, topdown=False):
            for name in files:
                path = Path(directory) / name
                path.chmod(0o555 if path.name == "wasmer-headless" else 0o444)
            Path(directory).chmod(0o555)
        self.execution = self.root / "execution.tsv"
        self.execution.write_text("fixture execution identity\n", encoding="utf-8")
        self.receipt = self.root / "cold.json"

    def tearDown(self) -> None:
        # Restore carrier ownership so TemporaryDirectory can clean it.
        for directory, _, files in os.walk(self.carrier, topdown=False):
            Path(directory).chmod(0o755)
            for name in files:
                (Path(directory) / name).chmod(0o644)
        self.temp.cleanup()

    def prover_command(
        self,
        *,
        output: Path | None = None,
        roots: list[tuple[str, Path]] | None = None,
        read_only_roles: tuple[str, ...] = ("carrier",),
    ) -> list[str]:
        command = ["python3", str(PROVER)]
        for role, path in roots or [("carrier", self.carrier), ("pgdata", self.pgdata)]:
            command.extend(["--root", f"{role}={path}"])
        for role in read_only_roles:
            command.extend(["--read-only-root", role])
        command.extend(
            [
                "--binding",
                f"execution_identity_sha256={digest(self.execution)}",
                "--output",
                str(output or self.receipt),
            ]
        )
        return command

    def run_prover(
        self,
        *,
        output: Path | None = None,
        roots: list[tuple[str, Path]] | None = None,
        read_only_roles: tuple[str, ...] = ("carrier",),
        nofile_limit: int | None = None,
        check: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        def constrain_nofile() -> None:
            assert nofile_limit is not None
            resource.setrlimit(resource.RLIMIT_NOFILE, (nofile_limit, nofile_limit))

        return subprocess.run(
            self.prover_command(
                output=output,
                roots=roots,
                read_only_roles=read_only_roles,
            ),
            check=check,
            preexec_fn=constrain_nofile if nofile_limit is not None else None,
            text=True,
            capture_output=True,
        )

    def prove(self, nofile_limit: int | None = None) -> dict[str, object]:
        result = self.run_prover(nofile_limit=nofile_limit)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(self.receipt.read_text(encoding="utf-8"))

    def test_targeted_proof_is_zero_and_hash_bound(self) -> None:
        receipt = self.prove()
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o444)
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(receipt["totals"]["resident_after_pages"], 0)
        self.assertGreater(receipt["totals"]["page_count"], 0)
        self.assertEqual(
            receipt["bindings"]["execution_identity_sha256"], digest(self.execution)
        )
        roles = {entry["role"] for entry in receipt["roots"]}
        self.assertEqual(roles, {"carrier", "pgdata"})
        scope = receipt["proof_scope"]
        self.assertEqual(
            scope["root_activity_requirement"],
            "quiescent before initial inventory through measured spawn",
        )
        self.assertEqual(
            scope["inventory_revalidation"],
            "exact-before-eviction-and-after-mincore",
        )
        timestamps = receipt["timestamps"]
        self.assertLessEqual(
            scope["quiescence_required_from_monotonic_ns"],
            timestamps["inventory_started_monotonic_ns"],
        )
        self.assertLessEqual(
            timestamps["pre_eviction_inventory_verified_monotonic_ns"],
            timestamps["eviction_started_monotonic_ns"],
        )
        self.assertLessEqual(
            timestamps["post_proof_inventory_verified_monotonic_ns"],
            timestamps["proof_completed_monotonic_ns"],
        )
        for root in receipt["roots"]:
            self.assertRegex(root["exact_inventory_sha256"], r"^[0-9a-f]{64}$")

    def test_streaming_proof_stays_bounded_below_file_count(self) -> None:
        fixture = self.pgdata / "base" / "low-fd-fixture"
        fixture.mkdir()
        for index in range(192):
            (fixture / f"relation-{index:03d}").write_bytes(
                (f"relation {index:03d}\n".encode("ascii")) * 256
            )

        receipt = self.prove(nofile_limit=32)

        self.assertGreater(receipt["totals"]["unique_file_count"], 100)
        bounds = receipt["resource_bounds"]
        self.assertEqual(bounds["cold_file_descriptor_strategy"], "bounded-streaming-reopen")
        self.assertEqual(bounds["cold_file_descriptor_limit"], 1)
        self.assertEqual(bounds["cold_file_descriptor_peak"], 1)
        self.assertEqual(bounds["persistent_cold_file_descriptors"], 0)
        self.assertEqual(bounds["final_mincore_sweeps"], 2)
        self.assertEqual(bounds["final_mincore_resident_pages"], [0, 0])

    def test_concurrent_addition_is_rejected_before_eviction(self) -> None:
        prover = load_module(PROVER, "prove_linux_cold_residency_concurrent_addition")
        original = prover.require_exact_inventories
        injected = False

        def add_entry_then_validate(roots, descriptor_budget, phase):
            nonlocal injected
            if phase == "pre-eviction boundary" and not injected:
                injected = True
                (self.pgdata / "base" / "concurrent-addition").write_bytes(b"raced\n")
            return original(roots, descriptor_budget, phase)

        argv = self.prover_command()[1:]
        with mock.patch.object(prover, "require_exact_inventories", add_entry_then_validate):
            with mock.patch.object(sys, "argv", argv):
                with self.assertRaisesRegex(
                    prover.ProofError,
                    "(inventory changed|directory changed|descriptor changed identity)",
                ):
                    prover.main()
        self.assertTrue(injected)
        self.assertFalse(self.receipt.exists())

    def test_proof_pending_replacement_is_never_unlinked_by_cleanup(self) -> None:
        prover = load_module(PROVER, "prove_linux_cold_residency_pending_replacement")
        output_parent = prover.pin_output_parent(self.receipt)
        held = self.root / "held-original-proof-pending"
        attacker = b"different private generation\n"

        def replace_pending(source: Path, _destination: Path, _identity) -> None:
            source.rename(held)
            source.write_bytes(attacker)
            source.chmod(0o444)
            raise prover.PublicationError("injected publication failure")

        try:
            with mock.patch.object(prover, "publish_identified", replace_pending):
                with self.assertRaisesRegex(
                    prover.PublicationError,
                    "private publication generation changed",
                ):
                    prover.publish_receipt({"status": "fixture"}, output_parent)
        finally:
            os.close(output_parent.fd)

        pending = list(self.root.glob(".cold.json.pending.*"))
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].read_bytes(), attacker)
        self.assertTrue(held.is_file())
        self.assertFalse(self.receipt.exists())

    def test_output_symlink_and_symlinked_parent_are_rejected(self) -> None:
        target = self.root / "receipt-target"
        target.write_text("must remain unchanged\n", encoding="utf-8")
        self.receipt.symlink_to(target)
        result = self.run_prover()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("output must not be a symlink", result.stderr)
        self.assertEqual(target.read_text(encoding="utf-8"), "must remain unchanged\n")

        self.receipt.unlink()
        aliased_parent = self.root / "pgdata-output-alias"
        aliased_parent.symlink_to(self.pgdata, target_is_directory=True)
        aliased_output = aliased_parent / "receipt.json"
        result = self.run_prover(output=aliased_output)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must already be canonical", result.stderr)
        self.assertFalse((self.pgdata / "receipt.json").exists())

    def test_internal_hardlinks_are_recorded_when_all_aliases_are_in_one_root(self) -> None:
        relation = self.pgdata / "base" / "relation"
        alias = self.pgdata / "base" / "relation-alias"
        os.link(relation, alias)

        receipt = self.prove()

        hard_links = receipt["hard_links"]
        self.assertEqual(hard_links["external_alias_count"], 0)
        self.assertEqual(hard_links["internal_hard_link_object_count"], 1)
        recorded = hard_links["internal_hard_links"][0]
        self.assertEqual(recorded["link_count"], 2)
        self.assertEqual(
            recorded["paths"],
            [["pgdata", "base/relation"], ["pgdata", "base/relation-alias"]],
        )

    def test_external_hardlink_is_rejected(self) -> None:
        relation = self.pgdata / "base" / "relation"
        os.link(relation, self.root / "external-relation-alias")

        result = self.run_prover()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("external or otherwise unobserved hard-link aliases", result.stderr)
        self.assertFalse(self.receipt.exists())

    def test_cross_root_hardlink_is_rejected(self) -> None:
        carrier_file = self.carrier / "aot" / "module.bin"
        os.link(carrier_file, self.pgdata / "base" / "carrier-alias")

        result = self.run_prover()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cold roots share one hard-linked inode", result.stderr)
        self.assertFalse(self.receipt.exists())

    def test_validator_binds_boundary_cgroup_and_full_samples(self) -> None:
        proof_end = 1_000_000_000
        self.receipt.write_text(
            json.dumps(
                {
                    "schema_version": "oliphaunt.wasix-postmaster.cold-residency.v1",
                    "status": "passed",
                    "bindings": {
                        "execution_identity_sha256": digest(self.execution),
                    },
                    "roots": [
                        {
                            "role": "carrier",
                            "path": str(self.carrier),
                            "require_read_only": True,
                        },
                        {
                            "role": "pgdata",
                            "path": str(self.pgdata),
                            "require_read_only": False,
                        },
                    ],
                    "totals": {
                        "regular_path_count": 4,
                        "unique_file_count": 4,
                        "logical_bytes": 65_536,
                        "page_count": 16,
                        "resident_before_pages": 8,
                        "resident_after_pages": 0,
                    },
                    "timestamps": {
                        "proof_completed_monotonic_ns": proof_end,
                    },
                },
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        spawn = proof_end + 1_000_000
        first_query = spawn + 25_000_000
        first = self.root / "first.json"
        final = self.root / "final.json"

        def snapshot(path: Path, captured: int, peak: int, rbytes: int | None) -> None:
            if rbytes is None:
                io = {
                    "status": "unavailable",
                    "controller_status": "missing",
                    "missing_reason": "io-controller-missing",
                    "source": None,
                    "devices": None,
                    "totals": None,
                }
            else:
                io = {
                    "status": "available",
                    "controller_status": "available",
                    "missing_reason": None,
                    "source": "io.stat",
                    "devices": [
                        {
                            "device": "8:0",
                            "metrics": {
                                "rbytes": rbytes,
                                "wbytes": 8192,
                                "rios": 4,
                                "wios": 2,
                            },
                        }
                    ],
                    "totals": {
                        "rbytes": rbytes,
                        "wbytes": 8192,
                        "rios": 4,
                        "wios": 2,
                    },
                }
            path.write_text(
                json.dumps(
                    {
                        "schema_version": "oliphaunt.wasix-postmaster.cgroup-v2-snapshot.v1",
                        "status": "passed",
                        "captured_monotonic_ns": captured,
                        "cgroup": {"path": "/fixture.scope", "identity": "dev:ino"},
                        "memory": {
                            "current": 80_000_000,
                            "peak": peak,
                            "max": 268_435_456,
                            "high": 234_881_024,
                            "swap_current": 0,
                            "swap_peak": 0,
                            "swap_max": 0,
                            "stat": {"file": 40_000_000, "file_dirty": 4096, "file_writeback": 0},
                        },
                        "io": io,
                    },
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )

        snapshot(first, first_query + 1_000_000, 120_000_000, 1_048_576)
        snapshot(final, first_query + 5_000_000, 125_000_000, 2_097_152)
        samples = self.root / "resources.tsv"
        fields = [
            "target",
            "smaps_status",
            "cgroup_status",
            "cgroup_path",
            "cgroup_scope_memory_peak_bytes",
            "cgroup_scope_swap_peak_bytes",
            "cgroup_memory_stat_file_dirty_bytes",
            "cgroup_memory_stat_file_writeback_bytes",
        ]
        with samples.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream, fieldnames=fields, delimiter="\t", lineterminator="\n"
            )
            writer.writeheader()
            writer.writerow(
                {
                    "target": "wasix",
                    "smaps_status": "ok",
                    "cgroup_status": "ok",
                    "cgroup_path": "/fixture.scope",
                    "cgroup_scope_memory_peak_bytes": "125000000",
                    "cgroup_scope_swap_peak_bytes": "0",
                    "cgroup_memory_stat_file_dirty_bytes": "4096",
                    "cgroup_memory_stat_file_writeback_bytes": "0",
                }
            )
        output = self.root / "sample.tsv"
        command = [
            "python3",
            str(VALIDATOR),
            "--residency-receipt",
            str(self.receipt),
            "--first-query-snapshot",
            str(first),
            "--final-snapshot",
            str(final),
            "--resource-samples",
            str(samples),
            "--execution-identity",
            str(self.execution),
            "--carrier-root",
            str(self.carrier),
            "--pgdata-root",
            str(self.pgdata),
            "--spawn-monotonic-ns",
            str(spawn),
            "--first-query-monotonic-ns",
            str(first_query),
            "--readiness-attempts",
            "2",
            "--memory-max",
            "256M",
            "--memory-high",
            "224M",
            "--swap-max",
            "0",
            "--output",
            str(output),
        ]
        validator = load_module(
            VALIDATOR, "validate_wasix_cold_ownership_stable_inputs"
        )
        stable_regular_bytes = validator.stable_regular_bytes
        input_paths = {
            self.receipt,
            first,
            final,
            samples,
            self.execution,
        }
        captured: dict[Path, bytes] = {}
        reads: dict[Path, int] = {}

        def stable_then_replace(path: Path) -> bytes:
            absolute = Path(os.path.abspath(path))
            data = stable_regular_bytes(absolute)
            reads[absolute] = reads.get(absolute, 0) + 1
            if absolute in input_paths:
                captured[absolute] = data
                replacement = absolute.with_name(f".{absolute.name}.replacement")
                replacement.write_bytes(b"untrusted replacement generation\n")
                os.replace(replacement, absolute)
            return data

        try:
            with mock.patch.object(
                validator, "stable_regular_bytes", stable_then_replace
            ):
                with mock.patch.object(
                    sys, "argv", [str(VALIDATOR), *command[2:]]
                ):
                    self.assertEqual(validator.main(), 0)
        finally:
            for path, data in captured.items():
                path.write_bytes(data)

        self.assertEqual(set(captured), input_paths)
        for path in input_paths:
            self.assertEqual(reads[path], 1, path)
        with output.open("r", encoding="utf-8", newline="") as stream:
            row = next(csv.DictReader(stream, delimiter="\t"))
        self.assertEqual(row["status"], "passed")
        self.assertEqual(row["resident_after_pages"], "0")
        self.assertEqual(row["spawn_to_first_query_ms"], "25.000000")
        self.assertEqual(row["io_observation_status"], "available")
        self.assertEqual(row["io_first_touch_status"], "attributable")
        self.assertEqual(
            row["execution_identity_sha256"],
            hashlib.sha256(captured[self.execution]).hexdigest(),
        )
        self.assertEqual(
            row["residency_receipt_sha256"],
            hashlib.sha256(captured[self.receipt]).hexdigest(),
        )
        self.assertEqual(
            row["first_query_snapshot_sha256"],
            hashlib.sha256(captured[first]).hexdigest(),
        )
        self.assertEqual(
            row["final_snapshot_sha256"],
            hashlib.sha256(captured[final]).hexdigest(),
        )
        self.assertEqual(
            row["resource_samples_sha256"],
            hashlib.sha256(captured[samples]).hexdigest(),
        )
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o444)

        output_bytes = output.read_bytes()
        output_inode = output.stat().st_ino
        replay = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(replay.returncode, 0)
        self.assertIn("publication destination already exists", replay.stderr)
        self.assertEqual(output.read_bytes(), output_bytes)
        self.assertEqual(output.stat().st_ino, output_inode)

        invalid_high_output = self.root / "sample-invalid-high.tsv"
        invalid_high_command = list(command)
        invalid_high_command[invalid_high_command.index("--memory-high") + 1] = "257M"
        invalid_high_command[invalid_high_command.index("--output") + 1] = str(
            invalid_high_output
        )
        invalid_high = subprocess.run(
            invalid_high_command, text=True, capture_output=True
        )
        self.assertNotEqual(invalid_high.returncode, 0)
        self.assertIn("memory high limit exceeds hard limit", invalid_high.stderr)
        self.assertFalse(invalid_high_output.exists())

        overflow_proof = json.loads(captured[self.receipt])
        overflow_proof["totals"]["logical_bytes"] = 1 << 64
        overflow_proof_payload = (
            json.dumps(overflow_proof, sort_keys=True) + "\n"
        ).encode("utf-8")
        invalid_inputs = (
            (
                first,
                captured[first].rstrip()[:-1] + b', "status": "passed"}\n',
                "duplicate JSON object key",
            ),
            (
                self.receipt,
                overflow_proof_payload,
                "logical_bytes must be a u64",
            ),
            (
                samples,
                captured[samples].rstrip(b"\n") + b"\textra\n",
                "does not match its header",
            ),
        )
        for case, (path, payload, detail) in enumerate(invalid_inputs):
            with self.subTest(invalid_input=case):
                path.write_bytes(payload)
                invalid_output = self.root / f"sample-invalid-input-{case}.tsv"
                invalid_command = list(command)
                invalid_command[invalid_command.index("--output") + 1] = str(
                    invalid_output
                )
                invalid_result = subprocess.run(
                    invalid_command, text=True, capture_output=True
                )
                self.assertNotEqual(invalid_result.returncode, 0)
                self.assertIn(detail, invalid_result.stderr)
                self.assertFalse(invalid_output.exists())
                path.write_bytes(captured[path])

        for case, malformed_counter in enumerate(("00", "01", str(1 << 64), "١")):
            with self.subTest(malformed_resource_counter=malformed_counter):
                with io.StringIO(captured[samples].decode("utf-8"), newline="") as stream:
                    resource_row = next(csv.DictReader(stream, delimiter="\t"))
                resource_row["cgroup_memory_stat_file_dirty_bytes"] = malformed_counter
                with samples.open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(
                        stream, fieldnames=fields, delimiter="\t", lineterminator="\n"
                    )
                    writer.writeheader()
                    writer.writerow(resource_row)
                invalid_output = self.root / f"sample-invalid-counter-{case}.tsv"
                invalid_command = list(command)
                invalid_command[invalid_command.index("--output") + 1] = str(
                    invalid_output
                )
                invalid_result = subprocess.run(
                    invalid_command, text=True, capture_output=True
                )
                self.assertNotEqual(invalid_result.returncode, 0)
                self.assertIn("valid resource sample", invalid_result.stderr)
                self.assertFalse(invalid_output.exists())
                samples.write_bytes(captured[samples])

        snapshot(first, first_query + 1_000_000, 120_000_000, None)
        snapshot(final, first_query + 5_000_000, 125_000_000, None)
        missing_output = self.root / "sample-missing-io.tsv"
        command[-1] = str(missing_output)
        missing_result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(missing_result.returncode, 0, missing_result.stderr)
        with missing_output.open("r", encoding="utf-8", newline="") as stream:
            missing_row = next(csv.DictReader(stream, delimiter="\t"))
        self.assertEqual(missing_row["status"], "passed")
        self.assertEqual(missing_row["io_observation_status"], "unavailable")
        self.assertEqual(missing_row["io_controller_status"], "missing")
        self.assertEqual(missing_row["io_missing_reason"], "io-controller-missing")
        self.assertEqual(missing_row["io_first_touch_status"], "unavailable")
        self.assertEqual(missing_row["io_read_bytes"], "")
        self.assertEqual(missing_row["io_read_ios"], "")

        malformed = json.loads(final.read_text(encoding="utf-8"))
        malformed["io"]["totals"] = {}
        final.write_text(json.dumps(malformed) + "\n", encoding="utf-8")
        malformed_output = self.root / "sample-malformed-missing-io.tsv"
        command[-1] = str(malformed_output)
        malformed_result = subprocess.run(command, text=True, capture_output=True)
        self.assertNotEqual(malformed_result.returncode, 0)
        self.assertIn("unavailable io totals must be null", malformed_result.stderr)

    def test_capture_parsers_reject_malformed_and_total_io(self) -> None:
        capture = load_module(CAPTURE, "capture_linux_cgroup_v2")
        devices, totals = capture.parse_io_stat(
            "8:0 rbytes=10 wbytes=20 rios=1 wios=2\n8:1 rbytes=5 wbytes=7 rios=3 wios=4"
        )
        self.assertEqual(len(devices), 2)
        self.assertEqual(totals["rbytes"], 15)
        self.assertEqual(totals["wios"], 6)
        with self.assertRaises(capture.SnapshotError):
            capture.parse_io_stat("8:0 rbytes=10 wbytes=20 rios=1")
        with self.assertRaises(capture.SnapshotError):
            capture.parse_pressure("some avg10=0.00 total=1")
        for malformed in ("00", "01", str(1 << 64), "١"):
            with self.subTest(malformed_unsigned=malformed):
                with self.assertRaises(capture.SnapshotError):
                    capture.parse_unsigned(malformed, "fixture")
        for nonfinite in ("nan", "NaN", "inf", "+inf", "-inf", "1e309"):
            with self.subTest(nonfinite_pressure=nonfinite):
                with self.assertRaisesRegex(
                    capture.SnapshotError, "finite and nonnegative"
                ):
                    capture.parse_pressure(
                        "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
                        f"full avg10={nonfinite} avg60=0.00 avg300=0.00 total=0"
                    )
        pressure = capture.parse_pressure(
            "some avg10=0.01 avg60=0.02 avg300=0.03 total=1\n"
            "full avg10=0.00 avg60=0.00 avg300=0.00 total=0"
        )
        self.assertEqual(pressure["some"]["avg300"], 0.03)
        event_root = self.root / "cgroup-fixture"
        event_root.mkdir()
        (event_root / "memory.events").write_text("high 0\n", encoding="ascii")
        (event_root / "memory.events.local").write_text("high 0\n", encoding="ascii")
        self.assertEqual(
            capture.select_memory_events_file(event_root),
            ("memory.events.local", "local-leaf"),
        )
        (event_root / "child.scope").mkdir()
        self.assertEqual(
            capture.select_memory_events_file(event_root),
            ("memory.events", "hierarchical-descendants"),
        )
        missing_io = capture.capture_io_stat(event_root, ["cpu", "memory", "pids"])
        self.assertEqual(
            missing_io,
            {
                "status": "unavailable",
                "controller_status": "missing",
                "missing_reason": "io-controller-missing",
                "source": None,
                "devices": None,
                "totals": None,
            },
        )
        selected = capture.select_file_cache_memory_stat(
            {"active_file": 4096, "pgscan": 10}
        )
        self.assertEqual(selected["status"], "partial")
        self.assertEqual(
            selected["fields"]["active_file"],
            {
                "kind": "gauge",
                "unit": "bytes",
                "status": "available",
                "value": 4096,
            },
        )
        self.assertIn("workingset_refault_file", selected["missing_keys"])

    def test_repeated_summary_reports_nearest_rank_p50_p95(self) -> None:
        validator = load_module(VALIDATOR, "validate_wasix_cold_ownership")
        inputs: list[Path] = []
        for block, latency in enumerate((10, 20, 30, 40, 50), start=1):
            sample = self.root / f"sample-{block}.tsv"
            row = {name: "1" for name in validator.HEADER}
            row.update(
                {
                    "schema_version": "oliphaunt.wasix-postmaster.cold-ownership-sample.v1",
                    "target": "wasix",
                    "status": "passed",
                    "execution_identity_sha256": "a" * 64,
                    "residency_receipt_sha256": "b" * 64,
                    "first_query_snapshot_sha256": "c" * 64,
                    "final_snapshot_sha256": "d" * 64,
                    "resource_samples_sha256": "e" * 64,
                    "validator_sha256": "f" * 64,
                    "carrier_root": str(self.carrier),
                    "pgdata_root": str(self.root / f"pgdata-{block}"),
                    "resident_after_pages": "0",
                    "spawn_to_first_query_ms": str(latency),
                    "full_valid_sample_count": "1",
                    "memory_max_bytes": "268435456",
                    "memory_high_bytes": "234881024",
                    "swap_max_bytes": "0",
                    "whole_scope_memory_peak_bytes": str(100_000_000 + block),
                    "peak_file_dirty_bytes": "4096",
                    "peak_file_writeback_bytes": "0",
                    "io_observation_status": "available",
                    "io_controller_status": "available",
                    "io_missing_reason": "none",
                    "io_first_touch_status": "attributable",
                    "io_read_bytes": "1048576",
                    "io_write_bytes": "8192",
                }
            )
            with sample.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=validator.HEADER, delimiter="\t")
                writer.writeheader()
                writer.writerow(row)
            inputs.extend([Path("--input"), sample])
        output = self.root / "summary.tsv"
        receipt = self.root / "summary.json"
        command = ["python3", str(SUMMARIZER)]
        for block in range(1, 6):
            command.extend(["--input", str(self.root / f"sample-{block}.tsv")])
        command.extend(
            [
                "--expected-blocks",
                "5",
                "--output",
                str(output),
                "--receipt",
                str(receipt),
            ]
        )
        subprocess.run(command, check=True)
        with output.open("r", encoding="utf-8", newline="") as stream:
            row = next(csv.DictReader(stream, delimiter="\t"))
        self.assertEqual(row["spawn_to_first_query_p50_ms"], "30.000000")
        self.assertEqual(row["spawn_to_first_query_p95_ms"], "50.000000")
        self.assertEqual(row["status"], "passed")
        self.assertEqual(row["io_first_touch_status"], "attributable")
        self.assertEqual(row["io_attributable_block_count"], "5")
        self.assertEqual(row["io_unavailable_block_count"], "0")
        self.assertEqual(row["total_io_read_bytes"], str(5 * 1_048_576))

        summary_bytes = output.read_bytes()
        receipt_bytes = receipt.read_bytes()
        summary_inode = output.stat().st_ino
        receipt_inode = receipt.stat().st_ino
        replay = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertEqual(output.read_bytes(), summary_bytes)
        self.assertEqual(receipt.read_bytes(), receipt_bytes)
        self.assertEqual(output.stat().st_ino, summary_inode)
        self.assertEqual(receipt.stat().st_ino, receipt_inode)

        first_sample = self.root / "sample-1.tsv"
        with first_sample.open("r", encoding="utf-8", newline="") as stream:
            finite_row = next(csv.DictReader(stream, delimiter="\t"))
        conflicting_row = dict(finite_row)
        conflicting_row["spawn_to_first_query_ms"] = "60"
        with first_sample.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream, fieldnames=validator.HEADER, delimiter="\t"
            )
            writer.writeheader()
            writer.writerow(conflicting_row)
        conflict = subprocess.run(command, text=True, capture_output=True, check=False)
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("publication set destination differs", conflict.stderr)
        self.assertEqual(output.read_bytes(), summary_bytes)
        self.assertEqual(receipt.read_bytes(), receipt_bytes)
        self.assertEqual(output.stat().st_ino, summary_inode)
        self.assertEqual(receipt.stat().st_ino, receipt_inode)
        with first_sample.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream, fieldnames=validator.HEADER, delimiter="\t"
            )
            writer.writeheader()
            writer.writerow(finite_row)

        malformed_fields = (
            ("execution_identity_sha256", "garbage"),
            ("memory_max_bytes", "nan"),
            ("memory_max_bytes", "inf"),
            ("memory_max_bytes", "-1"),
            ("memory_max_bytes", str(1 << 64)),
            ("memory_max_bytes", "0268435456"),
            ("memory_high_bytes", "268435457"),
            ("swap_max_bytes", "-1"),
        )
        for case, (field, value) in enumerate(malformed_fields):
            with self.subTest(field=field, value=value):
                malformed_row = dict(finite_row)
                malformed_row[field] = value
                with first_sample.open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(
                        stream, fieldnames=validator.HEADER, delimiter="\t"
                    )
                    writer.writeheader()
                    writer.writerow(malformed_row)
                malformed_output = self.root / f"summary-malformed-{case}.tsv"
                malformed_receipt = self.root / f"summary-malformed-{case}.json"
                malformed_command = [
                    *command[:-3],
                    str(malformed_output),
                    "--receipt",
                    str(malformed_receipt),
                ]
                result = subprocess.run(
                    malformed_command, text=True, capture_output=True, check=False
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(malformed_output.exists())
                self.assertFalse(malformed_receipt.exists())
        with first_sample.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream, fieldnames=validator.HEADER, delimiter="\t"
            )
            writer.writeheader()
            writer.writerow(finite_row)

        canonical_sample = first_sample.read_text(encoding="utf-8")
        header, record = canonical_sample.rstrip("\n").split("\n")
        malformed_tables = (
            f"{header}\textra\n{record}\textra\n",
            f"{header}\n{record}\textra\n",
            f"{header.replace('target', 'status', 1)}\n{record}\n",
            f"{header.rsplit(chr(9), 1)[0]}\n{record.rsplit(chr(9), 1)[0]}\n",
        )
        for case, malformed_table in enumerate(malformed_tables):
            with self.subTest(malformed_table=case):
                first_sample.write_text(malformed_table, encoding="utf-8")
                malformed_output = self.root / f"summary-schema-{case}.tsv"
                malformed_receipt = self.root / f"summary-schema-{case}.json"
                malformed_command = [
                    *command[:-3],
                    str(malformed_output),
                    "--receipt",
                    str(malformed_receipt),
                ]
                result = subprocess.run(
                    malformed_command, text=True, capture_output=True, check=False
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(malformed_output.exists())
                self.assertFalse(malformed_receipt.exists())
        first_sample.write_text(canonical_sample, encoding="utf-8")

        for invalid_limit in ("nan", "inf", "-inf", "0", "-1"):
            with self.subTest(invalid_limit=invalid_limit):
                invalid_output = self.root / f"summary-invalid-limit-{invalid_limit}.tsv"
                invalid_receipt = self.root / f"summary-invalid-limit-{invalid_limit}.json"
                invalid_command = [*command[:-4]]
                invalid_command.extend(
                    [
                        "--max-p95-ms",
                        invalid_limit,
                        "--output",
                        str(invalid_output),
                        "--receipt",
                        str(invalid_receipt),
                    ]
                )
                result = subprocess.run(
                    invalid_command, text=True, capture_output=True, check=False
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(invalid_output.exists())
                self.assertFalse(invalid_receipt.exists())

        for invalid_latency in ("nan", "inf", "-inf", "-0.001"):
            with self.subTest(invalid_latency=invalid_latency):
                invalid_row = dict(finite_row)
                invalid_row["spawn_to_first_query_ms"] = invalid_latency
                with first_sample.open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(
                        stream, fieldnames=validator.HEADER, delimiter="\t"
                    )
                    writer.writeheader()
                    writer.writerow(invalid_row)
                invalid_output = self.root / f"summary-invalid-sample-{invalid_latency}.tsv"
                invalid_receipt = self.root / f"summary-invalid-sample-{invalid_latency}.json"
                invalid_command = [*command[:-3], str(invalid_output), "--receipt", str(invalid_receipt)]
                result = subprocess.run(
                    invalid_command, text=True, capture_output=True, check=False
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("finite and nonnegative", result.stderr)
                self.assertFalse(invalid_output.exists())
                self.assertFalse(invalid_receipt.exists())
        with first_sample.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=validator.HEADER, delimiter="\t")
            writer.writeheader()
            writer.writerow(finite_row)

        for block in range(1, 6):
            sample = self.root / f"sample-{block}.tsv"
            with sample.open("r", encoding="utf-8", newline="") as stream:
                unavailable_row = next(csv.DictReader(stream, delimiter="\t"))
            unavailable_row.update(
                {
                    "io_observation_status": "unavailable",
                    "io_controller_status": "missing",
                    "io_missing_reason": "io-controller-missing",
                    "io_first_touch_status": "unavailable",
                    "io_read_bytes": "",
                    "io_write_bytes": "",
                    "io_read_ios": "",
                    "io_write_ios": "",
                }
            )
            with sample.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=validator.HEADER, delimiter="\t")
                writer.writeheader()
                writer.writerow(unavailable_row)
        unavailable_output = self.root / "summary-unavailable-io.tsv"
        unavailable_receipt = self.root / "summary-unavailable-io.json"
        command[-3] = str(unavailable_output)
        command[-1] = str(unavailable_receipt)
        subprocess.run(command, check=True)
        with unavailable_output.open("r", encoding="utf-8", newline="") as stream:
            unavailable_summary = next(csv.DictReader(stream, delimiter="\t"))
        self.assertEqual(unavailable_summary["status"], "passed")
        self.assertEqual(unavailable_summary["io_first_touch_status"], "unavailable")
        self.assertEqual(unavailable_summary["io_attributable_block_count"], "0")
        self.assertEqual(unavailable_summary["io_unavailable_block_count"], "5")
        self.assertEqual(unavailable_summary["total_io_read_bytes"], "")
        self.assertEqual(unavailable_summary["total_io_write_bytes"], "")

    def test_final_boundary_has_no_root_read_before_spawn(self) -> None:
        text = BENCH.read_text(encoding="utf-8")
        marker = "# FINAL COLD BOUNDARY:"
        start = text.index(marker)
        end = text.index("fresh_spawn_process_group -- launch_measured_server", start)
        boundary = text[start:end]
        forbidden = (
            "fresh_verify_sealed_headless_carrier",
            "fresh_capture_qualification_carrier_identity",
            "fresh_wasmer_bin_hash",
            "sha256sum",
            "prove-linux-cold-residency.py",
            "$sealed_carrier_root/",
            "$pgdata/",
        )
        for token in forbidden:
            self.assertNotIn(token, boundary)
        executable = [
            line.strip()
            for line in boundary.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertEqual(executable, ['cold_spawn_monotonic_ns="$(now_ns)"', "fi"])
        launcher = shell_function(BENCH, "launch_measured_server")
        self.assertIn('exec "$@"', launcher)
        self.assertNotIn("sha256", launcher)
        self.assertNotIn("sealed_carrier", launcher)
        self.assertNotIn("pgdata", launcher.lower())
        supervisor = shell_function(PROCESS_SUPERVISION, "fresh_spawn_process_group")
        self.assertIn('"$@" </dev/null &', supervisor)

    def test_actual_supervision_and_launch_wrapper_do_not_touch_payload_before_exec(self) -> None:
        strace = shutil.which("strace")
        if strace is None:
            self.skipTest("strace is required for the launch-boundary syscall proof")
        sleep = shutil.which("sleep")
        if sleep is None:
            self.skipTest("sleep executable is required for the launch-boundary proof")

        cold_root = self.root / "launch-cold-root"
        executable = cold_root / "bin" / "wasmer-headless"
        executable.parent.mkdir(parents=True)
        shutil.copy2(sleep, executable)
        executable.chmod(0o555)
        limits = self.root / "launch-limits.txt"
        trace = self.root / "launch.trace"
        script = self.root / "launch-wrapper.sh"
        script.write_text(
            "\n".join(
                [
                    "#!/usr/bin/env bash",
                    "set -euo pipefail",
                    f"source {shlex.quote(str(PROCESS_SUPERVISION))}",
                    "libpq_latency_samples=0",
                    "libpq_latency_soft_nofile=1024",
                    shell_function(BENCH, "launch_measured_server"),
                    'fresh_spawn_process_group -- launch_measured_server "$2" "$1" 2',
                    'wait "$FRESH_PROCESS_GROUP_PID"',
                    "",
                ]
            ),
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                strace,
                "-f",
                "-qq",
                "-s",
                "4096",
                "-e",
                "trace=open,openat,newfstatat,statx,access,readlink,readlinkat,execve",
                "-o",
                str(trace),
                "bash",
                str(script),
                str(executable),
                str(limits),
            ],
            text=True,
            capture_output=True,
        )
        trace_text = trace.read_text(encoding="utf-8") if trace.exists() else ""
        self.assertEqual(
            result.returncode,
            0,
            (
                f"stderr:\n{result.stderr}\nstdout:\n{result.stdout}\ntrace tail:\n"
                + "\n".join(trace_text.splitlines()[-100:])
            ),
        )
        lines = trace_text.splitlines()
        target = str(executable)
        exec_index = next(
            index
            for index, line in enumerate(lines)
            if "execve(" in line and target in line and line.find(target) < line.find("[")
        )
        observed_syscalls = (
            "open(",
            "openat(",
            "newfstatat(",
            "statx(",
            "access(",
            "readlink(",
            "readlinkat(",
        )
        premature = [
            line
            for line in lines[:exec_index]
            if str(cold_root) in line
            and any(syscall in line for syscall in observed_syscalls)
        ]
        self.assertEqual(premature, [])


if __name__ == "__main__":
    unittest.main()
