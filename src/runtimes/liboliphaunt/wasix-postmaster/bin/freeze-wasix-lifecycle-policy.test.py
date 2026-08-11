#!/usr/bin/env python3

from __future__ import annotations

import csv
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent
FREEZER_PATH = ROOT / "freeze-wasix-lifecycle-policy.py"
EVIDENCE_FREEZER = ROOT / "freeze-wasix-lifecycle-evidence.py"
VALIDATOR_PATH = ROOT / "validate-wasix-lifecycle-plateau.py"
BASELINE_POLICY = (
    ROOT.parent
    / "profiles/lifecycle-baselines/relative-stabilized-idle-postmaster-exploratory-v1.tsv"
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_module("wasix_lifecycle_policy_test_validator", VALIDATOR_PATH)
FREEZER = load_module("wasix_lifecycle_policy_test_freezer", FREEZER_PATH)
NONCE = "0123456789abcdef0123456789abcdef"
OBSERVER_PID = 42
WAIT_KIND = VALIDATOR.WAIT_KINDS[0]
EXPECTED_INTERVAL_MS = 300
COUNTS = {field: 0 for field in VALIDATOR.COUNT_FIELDS}
COUNTS.update(
    registered_processes=6,
    active_tasks=6,
    process_topology_nodes=6,
    process_child_edges=5,
    process_thread_entries=6,
    process_live_threads=6,
    process_execution_leases=11,
    runtime_state_active=6,
    runtime_state_slots=6,
    runtime_state_observer_registered=1,
    private_futexes=3,
    private_futex_waiters=3,
    private_futex_wakers=2,
    shared_futexes=4,
    shared_futex_waiters=2,
    shared_futex_wakers=2,
    epoll_states=6,
    epoll_subscriptions=6,
    epoll_join_guards=6,
    epoll_close_registrations=6,
    shared_registry_active=2,
    shared_registry_slots=2,
    shared_mappings=8,
    guest_fd_entries=71,
)
COUNT_TUPLE = tuple(COUNTS[field] for field in VALIDATOR.COUNT_FIELDS)
COLD_COUNTS = COUNTS | {"guest_fd_entries": 70}
COLD_COUNT_TUPLE = tuple(COLD_COUNTS[field] for field in VALIDATOR.COUNT_FIELDS)
OBSERVER_SET = (42, 43, 44, 45, 46, 47, 42)


def context(sequence: int, pid: int = OBSERVER_PID) -> str:
    return (
        "wasix-runtime-context-v1"
        f"\tseq={sequence}\twait_kind={WAIT_KIND}"
        f"\tobserver_pid={pid}\tobserver_tid=1\n"
    )


def state(
    sequence: int, mono_ns: int, counts: tuple[int, ...] = COUNT_TUPLE
) -> str:
    fields = "".join(
        f"\t{field}={value}"
        for field, value in zip(VALIDATOR.COUNT_FIELDS, counts, strict=True)
    )
    return f"wasix-runtime-state-v1\tseq={sequence}\tmono_ns={mono_ns}{fields}\n"


def fence(sequence: int, mono_ns: int, phase: str, request_sequence: int) -> str:
    return (
        "wasix-runtime-fence-v1"
        f"\tnonce={NONCE}\tseq={sequence}\tmono_ns={mono_ns}\tphase={phase}"
        f"\tobserver_pid={OBSERVER_PID}\tobserver_tid=1"
        f"\trequest_seq={request_sequence}\n"
    )


def phase(sequence: int, mono_ns: int, name: str) -> str:
    return (
        "wasix-runtime-phase-v1"
        f"\tnonce={NONCE}\tseq={sequence}\tmono_ns={mono_ns}"
        f"\tphase={name}\tobserver_pid={OBSERVER_PID}\n"
    )


def stabilization() -> str:
    return (
        "wasix-runtime-stabilization-v1"
        f"\tnonce={NONCE}\tmethod=pg_log_standby_snapshot"
        "\tbefore_writes=10\tafter_writes=12"
        "\tbefore_write_bytes=81920\tafter_write_bytes=147456"
        "\tbefore_stats_reset=1786320000000000"
        "\tafter_stats_reset=1786320000000000"
        "\ttarget_lsn=0/1000000\tobserved_flush_lsn=0/1008000"
        "\twal_writer_delay_ms=200\tstart_mono_ns=25\tend_mono_ns=35"
        f"\tstatus=passed\tobserver_pid={OBSERVER_PID}\n"
    )


def reconnect_churn() -> str:
    return (
        "wasix-runtime-reconnect-churn-v1"
        f"\tnonce={NONCE}\trequested=2000\tcompleted=2000"
        f"\tcommand_sha256={VALIDATOR.RECONNECT_COMMAND_SHA256}"
        f"\tclient_sha256={'1' * 64}\tconnection_sha256={'2' * 64}"
        "\tstart_mono_ns=61\tend_mono_ns=69\tstatus=passed"
        f"\tobserver_pid={OBSERVER_PID}\n"
    )


def raw_lifecycle_log() -> bytes:
    lines = [phase(1, 10, "cold-readiness")]
    for sequence, mono_ns in enumerate(
        (100_000_000, 500_000_000, 900_000_000, 1_300_000_000), 1
    ):
        lines.extend((context(sequence), state(sequence, mono_ns, COLD_COUNT_TUPLE)))
    lines.extend(
        (
            phase(2, 20, "maintenance-stabilization"),
            stabilization(),
            phase(3, 50, "readiness"),
        )
    )
    for sequence, (mono_ns, pid) in enumerate(
        zip(
            (
                1_500_000_000,
                1_700_000_000,
                1_900_000_000,
                2_100_000_000,
                2_300_000_000,
                2_500_000_000,
                2_700_000_000,
            ),
            OBSERVER_SET,
            strict=True,
        ),
        5,
    ):
        lines.extend((context(sequence, pid), state(sequence, mono_ns)))
    lines.extend(
        (
            fence(11, 2_700_000_000, "readiness", 1),
            phase(4, 60, "reconnect-churn"),
            context(12, 99),
            state(12, 2_800_000_000),
            reconnect_churn(),
            phase(5, 70, "post-quiescence"),
        )
    )
    for sequence, (mono_ns, pid) in enumerate(
        zip(
            (
                3_000_000_000,
                3_200_000_000,
                3_400_000_000,
                3_600_000_000,
                3_800_000_000,
                4_000_000_000,
                4_200_000_000,
            ),
            OBSERVER_SET,
            strict=True,
        ),
        13,
    ):
        lines.extend((context(sequence, pid), state(sequence, mono_ns)))
    lines.append(fence(19, 4_200_000_000, "post-quiescence", 2))
    return "".join(lines).encode("ascii")


def write_tsv(path: Path, row: dict[str, str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            delimiter="\t",
            fieldnames=VALIDATOR.OUTPUT_FIELDS,
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerow(row)


class FreezeLifecyclePolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.raw_log = self.root / "runtime.raw.log"
        self.ack = self.root / "runtime-fence.ack"
        self.log = self.root / "runtime.log"
        self.receipt = self.root / "runtime.freeze.tsv"
        self.baseline_policy = self.root / "baseline-policy.tsv"
        self.baseline_binding = self.root / "baseline-binding.tsv"
        self.result = self.root / "plateau.tsv"
        self.output = self.root / "qualified.tsv"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def prepare_real_bundle(self) -> dict[str, str]:
        raw = raw_lifecycle_log()
        self.raw_log.write_bytes(raw)
        ack = (
            "wasix-runtime-fence-commit-v1"
            f"\tnonce={NONCE}\tseq=19\tmono_ns=4200000000"
            f"\tphase=post-quiescence\tobserver_pid={OBSERVER_PID}"
            "\tobserver_tid=1\trequest_seq=2"
            f"\tfence_end_offset={len(raw)}\n"
        ).encode("ascii")
        self.ack.write_bytes(ack)
        frozen = subprocess.run(
            [
                sys.executable,
                str(EVIDENCE_FREEZER),
                "--raw-log",
                str(self.raw_log),
                "--commit-ack",
                str(self.ack),
                "--output",
                str(self.log),
                "--receipt",
                str(self.receipt),
                "--nonce",
                NONCE,
                "--observer-pid",
                str(OBSERVER_PID),
                "--complete-phase-sequence",
                "6",
                "--complete-phase-mono-ns",
                "80",
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(frozen.returncode, 0, frozen.stderr)

        policy_payload = BASELINE_POLICY.read_bytes()
        self.baseline_policy.write_bytes(policy_payload)
        with self.baseline_policy.open(encoding="utf-8", newline="") as handle:
            policy = next(csv.DictReader(handle, delimiter="\t"))
        self.baseline_binding.write_text(
            "schema_version\tpolicy_id\tpolicy_sha256\tpolicy_status\tclaim_scope"
            "\tbaseline_assumption\tpostgres_major\truntime_footprint"
            "\truntime_footprint_sha256\tdurability_profile"
            "\tdurability_profile_sha256\tpostgres_profile_resolution_identity"
            "\truntime_mode\twasmer_bin_sha256\tpostgres_module_sha256"
            "\tcarrier_manifest_sha256\tcarrier_receipt_sha256"
            "\tcarrier_payload_inventory_sha256\n"
            "oliphaunt.wasix-postmaster.lifecycle-baseline-binding.v1"
            f"\t{policy['policy_id']}\t{hashlib.sha256(policy_payload).hexdigest()}"
            f"\t{policy['policy_status']}\t{policy['claim_scope']}"
            f"\t{policy['baseline_assumption']}"
            "\t18\tnone\tnone\tnone\tnone\tnone\tcompiler"
            f"\t{'1' * 64}\t{'2' * 64}\tnone\tnone\tnone\n",
            encoding="utf-8",
        )
        validated = subprocess.run(
            [
                sys.executable,
                str(VALIDATOR_PATH),
                "--log",
                str(self.log),
                "--freeze-receipt",
                str(self.receipt),
                "--baseline-policy",
                str(self.baseline_policy),
                "--baseline-binding",
                str(self.baseline_binding),
                "--output",
                str(self.result),
                "--target",
                "wasix",
                "--nonce",
                NONCE,
                "--observer-pid",
                str(OBSERVER_PID),
                "--min-samples",
                "3",
                "--min-span-ms",
                "1000",
                "--expected-interval-ms",
                str(EXPECTED_INTERVAL_MS),
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(validated.returncode, 0, validated.stderr)
        with self.result.open(encoding="utf-8", newline="") as handle:
            return next(csv.DictReader(handle, delimiter="\t"))

    def run_freezer(
        self, *, policy_id: str = "pg18-idle-postmaster-stabilized-qualified-v1"
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(FREEZER_PATH),
                "--exploratory-result",
                str(self.result),
                "--log",
                str(self.log),
                "--freeze-receipt",
                str(self.receipt),
                "--baseline-policy",
                str(self.baseline_policy),
                "--baseline-binding",
                str(self.baseline_binding),
                "--output",
                str(self.output),
                "--policy-id",
                policy_id,
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_real_passed_bundle_becomes_exact_policy(self) -> None:
        self.prepare_real_bundle()
        result = self.run_freezer()
        self.assertEqual(result.returncode, 0, result.stderr)
        policy = VALIDATOR.parse_baseline_policy(self.output)
        self.assertEqual(policy.policy_status, "qualification-bounded")
        self.assertEqual(policy.policy_id, "pg18-idle-postmaster-stabilized-qualified-v1")
        observed = {constraint.field: constraint.minimum for constraint in policy.constraints}
        self.assertEqual(observed, COUNTS)
        self.assertTrue(all(constraint.rule == "exact" for constraint in policy.constraints))

    def test_result_must_equal_revalidated_bundle(self) -> None:
        row = self.prepare_real_bundle()
        row["readiness_guest_fd_entries"] = "72"
        row["post_quiescence_guest_fd_entries"] = "72"
        write_tsv(self.result, row)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "does not match revalidated bundle field readiness_guest_fd_entries",
            result.stderr,
        )
        self.assertFalse(self.output.exists())

    def test_mutated_bundle_is_rejected_even_when_result_claims_passed(self) -> None:
        self.prepare_real_bundle()
        original = self.log.read_bytes()
        mutated = original.replace(b"guest_fd_entries=70", b"guest_fd_entries=71", 1)
        self.assertEqual(len(mutated), len(original))
        self.assertNotEqual(mutated, original)
        self.log.chmod(0o644)
        self.log.write_bytes(mutated)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("exploratory bundle failed revalidation", result.stderr)
        self.assertFalse(self.output.exists())

    def test_failed_or_already_qualified_source_is_rejected(self) -> None:
        row = self.prepare_real_bundle()
        row["status"] = "failed"
        write_tsv(self.result, row)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("status must be passed", result.stderr)

        row["status"] = "passed"
        row["baseline_policy_status"] = "qualification-bounded"
        write_tsv(self.result, row)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("must be exploratory-unbounded", result.stderr)

    def test_existing_output_and_symlink_are_never_replaced(self) -> None:
        self.prepare_real_bundle()
        self.output.write_text("owned\n", encoding="utf-8")
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.output.read_text(encoding="utf-8"), "owned\n")

        self.output.unlink()
        target = self.root / "target"
        target.write_text("owned\n", encoding="utf-8")
        self.output.symlink_to(target)
        result = self.run_freezer()
        self.assertEqual(result.returncode, 1)
        self.assertIn("publication destination already exists", result.stderr)
        self.assertEqual(target.read_text(encoding="utf-8"), "owned\n")

    def test_link_race_preserves_competing_output(self) -> None:
        payload = FREEZER.render_policy(
            "pg18-idle-postmaster-stabilized-qualified-v1", COUNTS
        )
        real_publish = FREEZER.publish_identified

        def create_competitor_then_publish(source, destination, expected):
            Path(destination).write_text("competitor\n", encoding="utf-8")
            return real_publish(source, destination, expected)

        with mock.patch.object(
            FREEZER,
            "publish_identified",
            side_effect=create_competitor_then_publish,
        ):
            with self.assertRaises(FREEZER.FreezeError):
                FREEZER.publish_new_regular(self.output, payload)
        self.assertEqual(self.output.read_text(encoding="utf-8"), "competitor\n")
        self.assertEqual(list(self.root.glob(".qualified.tsv.pending.*")), [])

    def test_policy_id_must_use_distinct_qualified_namespace(self) -> None:
        self.prepare_real_bundle()
        result = self.run_freezer(
            policy_id="pg18-idle-postmaster-stabilized-exploratory-v2"
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be pg18-idle-postmaster-stabilized-qualified-vN", result.stderr)


if __name__ == "__main__":
    unittest.main()
