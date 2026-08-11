#!/usr/bin/env python3

from __future__ import annotations

import csv
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("validate-wasix-lifecycle-plateau.py")
SPEC = importlib.util.spec_from_file_location(
    "wasix_lifecycle_stable_read_test", SCRIPT
)
assert SPEC is not None and SPEC.loader is not None
VALIDATOR_MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = VALIDATOR_MODULE
SPEC.loader.exec_module(VALIDATOR_MODULE)
BASELINE_POLICY = (
    SCRIPT.parents[1]
    / "profiles/lifecycle-baselines/relative-stabilized-idle-postmaster-exploratory-v1.tsv"
)
NONCE = "0123456789abcdef0123456789abcdef"
OBSERVER_PID = 42
WAIT_KIND = "wait-registry.epoll_wait.pending"
OTHER_WAIT_KIND = "wait-registry.futex_wait.pending"
COUNT_NAMES = (
    "registered_processes",
    "active_tasks",
    "process_topology_nodes",
    "process_child_edges",
    "process_thread_entries",
    "process_live_threads",
    "process_pending_child_publications",
    "process_execution_leases",
    "process_quiescence_wakers",
    "process_retiring_nodes",
    "runtime_state_active",
    "runtime_state_stale",
    "runtime_state_slots",
    "runtime_state_observer_registered",
    "private_futexes",
    "private_futex_waiters",
    "private_futex_wakers",
    "shared_futexes",
    "shared_futex_waiters",
    "shared_futex_wakers",
    "epoll_states",
    "epoll_subscriptions",
    "epoll_ready_items",
    "epoll_pending_subscriptions",
    "epoll_enqueued_subscriptions",
    "epoll_join_guards",
    "epoll_close_registrations",
    "shared_registry_active",
    "shared_registry_stale",
    "shared_registry_slots",
    "shared_mappings",
    "guest_fd_entries",
)
BASE_COUNTS = {
    "registered_processes": 6,
    "active_tasks": 6,
    "process_topology_nodes": 6,
    "process_child_edges": 5,
    "process_thread_entries": 6,
    "process_live_threads": 6,
    "process_pending_child_publications": 0,
    "process_execution_leases": 11,
    "process_quiescence_wakers": 0,
    "process_retiring_nodes": 0,
    "runtime_state_active": 6,
    "runtime_state_stale": 0,
    "runtime_state_slots": 6,
    "runtime_state_observer_registered": 1,
    "private_futexes": 2,
    "private_futex_waiters": 3,
    "private_futex_wakers": 2,
    "shared_futexes": 4,
    "shared_futex_waiters": 5,
    "shared_futex_wakers": 4,
    "epoll_states": 1,
    "epoll_subscriptions": 6,
    "epoll_ready_items": 0,
    "epoll_pending_subscriptions": 2,
    "epoll_enqueued_subscriptions": 1,
    "epoll_join_guards": 3,
    "epoll_close_registrations": 1,
    "shared_registry_active": 2,
    "shared_registry_stale": 0,
    "shared_registry_slots": 2,
    "shared_mappings": 3,
    "guest_fd_entries": 9,
}
COUNTS = tuple(BASE_COUNTS[name] for name in COUNT_NAMES)
EXPECTED_INTERVAL_MS = 300


def changed_counts(**overrides: int) -> tuple[int, ...]:
    values = BASE_COUNTS | overrides
    return tuple(values[name] for name in COUNT_NAMES)


COLD_COUNTS = changed_counts(guest_fd_entries=8)
OBSERVER_SET = (42, 43, 44, 45, 46, 47, 42)


def context(
    sequence: int,
    *,
    pid: int = OBSERVER_PID,
    tid: int = 1,
    wait_kind: str = WAIT_KIND,
) -> str:
    return (
        "wasix-runtime-context-v1"
        f"\tseq={sequence}\twait_kind={wait_kind}\tobserver_pid={pid}\tobserver_tid={tid}\n"
    )


def state(sequence: int, mono_ns: int, counts: tuple[int, ...] = COUNTS) -> str:
    fields = "".join(
        f"\t{name}={value}" for name, value in zip(COUNT_NAMES, counts, strict=True)
    )
    return f"wasix-runtime-state-v1\tseq={sequence}\tmono_ns={mono_ns}{fields}\n"


def fence(
    sequence: int,
    mono_ns: int,
    name: str,
    request_sequence: int,
    *,
    pid: int = OBSERVER_PID,
    tid: int = 1,
) -> str:
    return (
        "wasix-runtime-fence-v1"
        f"\tnonce={NONCE}\tseq={sequence}\tmono_ns={mono_ns}\tphase={name}"
        f"\tobserver_pid={pid}\tobserver_tid={tid}\trequest_seq={request_sequence}\n"
    )


def phase(sequence: int, mono_ns: int, name: str) -> str:
    return (
        "wasix-runtime-phase-v1"
        f"\tnonce={NONCE}\tseq={sequence}\tmono_ns={mono_ns}"
        f"\tphase={name}\tobserver_pid={OBSERVER_PID}\n"
    )


def stabilization(**overrides: str | int) -> str:
    values: dict[str, str | int] = {
        "nonce": NONCE,
        "method": "pg_log_standby_snapshot",
        "before_writes": 10,
        "after_writes": 12,
        "before_write_bytes": 81_920,
        "after_write_bytes": 147_456,
        "before_stats_reset": 1_786_320_000_000_000,
        "after_stats_reset": 1_786_320_000_000_000,
        "target_lsn": "0/1000000",
        "observed_flush_lsn": "0/1008000",
        "wal_writer_delay_ms": 200,
        "start_mono_ns": 25,
        "end_mono_ns": 35,
        "status": "passed",
        "observer_pid": OBSERVER_PID,
    }
    values.update(overrides)
    return "wasix-runtime-stabilization-v1" + "".join(
        f"\t{field}={values[field]}" for field in (
            "nonce",
            "method",
            "before_writes",
            "after_writes",
            "before_write_bytes",
            "after_write_bytes",
            "before_stats_reset",
            "after_stats_reset",
            "target_lsn",
            "observed_flush_lsn",
            "wal_writer_delay_ms",
            "start_mono_ns",
            "end_mono_ns",
            "status",
            "observer_pid",
        )
    ) + "\n"


def reconnect_churn(**overrides: str | int) -> str:
    values: dict[str, str | int] = {
        "nonce": NONCE,
        "requested": 2000,
        "completed": 2000,
        "command_sha256": VALIDATOR_MODULE.RECONNECT_COMMAND_SHA256,
        "client_sha256": "1" * 64,
        "connection_sha256": "2" * 64,
        "start_mono_ns": 61,
        "end_mono_ns": 69,
        "status": "passed",
        "observer_pid": OBSERVER_PID,
    }
    values.update(overrides)
    return "wasix-runtime-reconnect-churn-v1" + "".join(
        f"\t{field}={values[field]}" for field in (
            "nonce",
            "requested",
            "completed",
            "command_sha256",
            "client_sha256",
            "connection_sha256",
            "start_mono_ns",
            "end_mono_ns",
            "status",
            "observer_pid",
        )
    ) + "\n"


def valid_log(
    *,
    cold_counts: tuple[int, ...] = COLD_COUNTS,
    readiness_counts: tuple[int, ...] = COUNTS,
    final_counts: tuple[int, ...] = COUNTS,
    readiness_kind: str = WAIT_KIND,
    final_kind: str = WAIT_KIND,
    readiness_observers: tuple[int, ...] = OBSERVER_SET,
    final_observers: tuple[int, ...] = OBSERVER_SET,
    stabilization_record: str | None = None,
    reconnect_record: str | None = None,
    final_times: tuple[int, ...] = (
        3_000_000_000,
        3_200_000_000,
        3_400_000_000,
        3_600_000_000,
        3_800_000_000,
        4_000_000_000,
        4_200_000_000,
    ),
) -> str:
    if len(readiness_observers) != 7 or len(final_observers) != len(final_times):
        raise ValueError("test fixture observer/time cardinality mismatch")
    lines = [phase(1, 10, "cold-readiness")]
    runtime_sequence = 1
    for mono_ns in (100_000_000, 500_000_000, 900_000_000, 1_300_000_000):
        lines.extend(
            (
                context(runtime_sequence),
                state(runtime_sequence, mono_ns, cold_counts),
            )
        )
        runtime_sequence += 1
    lines.extend(
        (
            phase(2, 20, "maintenance-stabilization"),
            stabilization_record if stabilization_record is not None else stabilization(),
            phase(3, 50, "readiness"),
            # A readiness probe may still be retiring before the stable
            # coverage window begins. It cannot contribute to or contradict
            # the terminal stable tail.
            context(runtime_sequence, pid=99),
            state(runtime_sequence, 1_400_000_000, tuple(80 for _ in COUNT_NAMES)),
        )
    )
    runtime_sequence += 1
    readiness_times = (
        1_500_000_000,
        1_700_000_000,
        1_900_000_000,
        2_100_000_000,
        2_300_000_000,
        2_500_000_000,
        2_700_000_000,
    )
    for index, (mono_ns, pid) in enumerate(zip(readiness_times, readiness_observers, strict=True)):
        lines.extend(
            (
                context(runtime_sequence, pid=pid, wait_kind=readiness_kind),
                state(runtime_sequence, mono_ns, readiness_counts),
            )
        )
        if index == len(readiness_times) - 1:
            lines.append(
                fence(runtime_sequence, mono_ns, "readiness", 1)
            )
        runtime_sequence += 1
    lines.extend(
        (
            phase(4, 60, "reconnect-churn"),
            context(runtime_sequence, pid=99),
            state(
                runtime_sequence,
                2_800_000_000,
                tuple(999 for _ in COUNT_NAMES),
            ),
            reconnect_record if reconnect_record is not None else reconnect_churn(),
            phase(5, 70, "post-quiescence"),
        )
    )
    runtime_sequence += 1
    for index, (mono_ns, pid) in enumerate(zip(final_times, final_observers, strict=True)):
        lines.extend(
            (
                context(runtime_sequence, pid=pid, wait_kind=final_kind),
                state(runtime_sequence, mono_ns, final_counts),
            )
        )
        if index == len(final_times) - 1:
            lines.append(
                fence(runtime_sequence, mono_ns, "post-quiescence", 2)
            )
        runtime_sequence += 1
    lines.append(phase(6, 80, "complete"))
    return "".join(lines)


def strict_policy_payload() -> bytes:
    source = csv.DictReader(
        BASELINE_POLICY.read_text(encoding="utf-8").splitlines(), delimiter="\t"
    )
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream, fieldnames=source.fieldnames, delimiter="\t", lineterminator="\n"
    )
    writer.writeheader()
    for row in source:
        row["policy_id"] = "pg18-idle-postmaster-stabilized-qualified-v1"
        row["policy_status"] = "qualification-bounded"
        row["rule"] = "exact"
        row["minimum"] = str(BASE_COUNTS[row["field"]])
        row["maximum"] = str(BASE_COUNTS[row["field"]])
        writer.writerow(row)
    return stream.getvalue().encode("utf-8")


class LifecyclePlateauTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_validator(
        self,
        contents: str | bytes,
        *,
        tamper_receipt: bool = False,
        tamper_ack: bool = False,
        tamper_policy_after_binding: bool = False,
        policy_payload_override: bytes | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], dict[str, str]]:
        log = self.root / "runtime.log"
        raw_log = self.root / "runtime.raw.log"
        ack = self.root / "runtime-fence.ack"
        receipt = self.root / "runtime.freeze.tsv"
        baseline_binding = self.root / "baseline-binding.tsv"
        baseline_policy = self.root / "baseline-policy.tsv"
        output = self.root / "plateau.tsv"
        if isinstance(contents, bytes):
            log.write_bytes(contents)
        else:
            log.write_text(contents, encoding="utf-8")
        frozen = log.read_bytes()
        fence_pattern = re.compile(
            rb"wasix-runtime-fence-v1\tnonce=" + NONCE.encode("ascii")
            + rb"\tseq=([1-9][0-9]*)\tmono_ns=([1-9][0-9]*)"
            + rb"\tphase=post-quiescence\tobserver_pid="
            + str(OBSERVER_PID).encode("ascii")
            + rb"\tobserver_tid=([1-9][0-9]*)\trequest_seq=2\n"
        )
        matches = list(fence_pattern.finditer(frozen))
        self.assertTrue(matches, "test fixture must retain a parseable final fence")
        final_match = matches[-1]
        fence_sequence, fence_mono_ns, observer_tid = (
            value.decode("ascii") for value in final_match.groups()
        )
        fence_end_offset = final_match.end()
        ack_payload = (
            "wasix-runtime-fence-commit-v1"
            f"\tnonce={NONCE}\tseq={fence_sequence}\tmono_ns={fence_mono_ns}"
            f"\tphase=post-quiescence\tobserver_pid={OBSERVER_PID}"
            f"\tobserver_tid={observer_tid}\trequest_seq=2"
            f"\tfence_end_offset={fence_end_offset}\n"
        ).encode("ascii")
        ack.write_bytes(ack_payload)
        raw_log.write_bytes(frozen[:fence_end_offset])
        receipt_payload = (
            "schema_version\traw_log\traw_observed_size\tcommit_ack"
            "\tcommit_ack_sha256\tfence_end_offset\tfrozen_log\tfrozen_size"
            "\tsha256\tnonce\tobserver_pid\tfence_sequence\tfence_mono_ns"
            "\tcomplete_phase_sequence\tcomplete_phase_mono_ns\n"
            "oliphaunt.wasix-postmaster.lifecycle-freeze.v2"
            f"\t{raw_log}\t{fence_end_offset}\t{ack}"
            f"\t{hashlib.sha256(ack_payload).hexdigest()}\t{fence_end_offset}"
            f"\t{log}\t{len(frozen)}\t{hashlib.sha256(frozen).hexdigest()}"
            f"\t{NONCE}\t{OBSERVER_PID}\t{fence_sequence}\t{fence_mono_ns}"
            "\t6\t80\n"
        )
        receipt.write_text(receipt_payload, encoding="utf-8")
        policy_payload = policy_payload_override or BASELINE_POLICY.read_bytes()
        baseline_policy.write_bytes(policy_payload)
        policy_sha256 = hashlib.sha256(policy_payload).hexdigest()
        policy_reader = csv.DictReader(
            policy_payload.decode("utf-8").splitlines(), delimiter="\t"
        )
        policy_metadata = next(policy_reader)
        baseline_binding.write_text(
            "schema_version\tpolicy_id\tpolicy_sha256\tpolicy_status\tclaim_scope"
            "\tbaseline_assumption\tpostgres_major\truntime_footprint"
            "\truntime_footprint_sha256\tdurability_profile"
            "\tdurability_profile_sha256\tpostgres_profile_resolution_identity"
            "\truntime_mode\twasmer_bin_sha256\tpostgres_module_sha256"
            "\tcarrier_manifest_sha256\tcarrier_receipt_sha256"
            "\tcarrier_payload_inventory_sha256\n"
            "oliphaunt.wasix-postmaster.lifecycle-baseline-binding.v1"
            f"\t{policy_metadata['policy_id']}\t{policy_sha256}"
            f"\t{policy_metadata['policy_status']}\t{policy_metadata['claim_scope']}"
            f"\t{policy_metadata['baseline_assumption']}"
            "\t18\tnone\tnone\tnone\tnone\tnone\tcompiler"
            f"\t{'1' * 64}\t{'2' * 64}\tnone\tnone\tnone\n",
            encoding="utf-8",
        )
        if tamper_receipt:
            receipt.write_text(
                receipt_payload.replace(hashlib.sha256(frozen).hexdigest(), "0" * 64),
                encoding="utf-8",
            )
        if tamper_ack:
            ack.write_bytes(ack_payload.replace(b"request_seq=2", b"request_seq=3"))
        if tamper_policy_after_binding:
            tampered = policy_payload.replace(
                b"\tpg18-idle-postmaster-stabilized-exploratory-v1\t",
                b"\tpg18-idle-postmaster-stabilized-exploratory-v2\t",
            )
            self.assertNotEqual(tampered, policy_payload)
            baseline_policy.write_bytes(tampered)
        result = subprocess.run(
            [
                str(SCRIPT),
                "--log", str(log),
                "--freeze-receipt", str(receipt),
                "--baseline-policy", str(baseline_policy),
                "--baseline-binding", str(baseline_binding),
                "--output", str(output),
                "--nonce", NONCE,
                "--observer-pid", str(OBSERVER_PID),
                "--min-samples", "3",
                "--min-span-ms", "1000",
                "--expected-interval-ms", str(EXPECTED_INTERVAL_MS),
            ],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        with output.open(encoding="utf-8", newline="") as handle:
            row = next(csv.DictReader(handle, delimiter="\t"))
        return result, row

    def assert_fails(self, contents: str, detail: str = "") -> dict[str, str]:
        result, row = self.run_validator(contents)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(row["status"], "failed")
        if detail:
            self.assertIn(detail, row["detail"])
        return row

    def test_regular_file_reader_rejects_same_size_mutation(self) -> None:
        path = self.root / "stable-input.tsv"
        original = b"a" * 4096
        replacement = b"b" * len(original)
        path.write_bytes(original)
        real_read = os.read
        mutated = False

        def mutate_after_first_read(fd: int, size: int) -> bytes:
            nonlocal mutated
            chunk = real_read(fd, size)
            if chunk and not mutated:
                mutated = True
                path.write_bytes(replacement)
            return chunk

        with mock.patch.object(
            VALIDATOR_MODULE.os, "read", side_effect=mutate_after_first_read
        ):
            with self.assertRaisesRegex(
                VALIDATOR_MODULE.EvidenceError,
                r"changed while (reading|confirming read)",
            ):
                VALIDATOR_MODULE.read_regular_file(path)

    def test_exact_fenced_plateau_passes(self) -> None:
        result, row = self.run_validator(valid_log())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(row["schema_version"], "6")
        self.assertEqual(row["status"], "passed")
        self.assertEqual(row["claim_scope"], "relative-to-stabilized-baseline")
        self.assertEqual(row["baseline_policy_status"], "exploratory-unbounded")
        self.assertEqual(row["baseline_policy_sha256"], hashlib.sha256(BASELINE_POLICY.read_bytes()).hexdigest())
        self.assertIn("readiness-is-stabilized-idle-postmaster-state", row["baseline_assumption"])
        self.assertEqual(row["evidence_sha256"], hashlib.sha256(valid_log().encode()).hexdigest())
        self.assertEqual(row["wait_kind"], WAIT_KIND)
        self.assertEqual(row["cold_readiness_samples"], "4")
        self.assertEqual(row["readiness_samples"], "7")
        self.assertEqual(row["post_quiescence_samples"], "7")
        self.assertEqual(row["readiness_fence_sequence"], "12")
        self.assertEqual(row["post_quiescence_fence_sequence"], "20")
        self.assertEqual(row["stabilization_method"], "pg_log_standby_snapshot")
        self.assertEqual(row["stabilization_target_lsn"], "0/1000000")
        self.assertEqual(row["stabilization_elapsed_ns"], "10")
        self.assertEqual(row["reconnect_requested"], "2000")
        self.assertEqual(row["reconnect_completed"], "2000")
        self.assertEqual(
            row["reconnect_command_sha256"],
            VALIDATOR_MODULE.RECONNECT_COMMAND_SHA256,
        )
        self.assertEqual(row["reconnect_elapsed_ns"], "8")
        self.assertEqual(row["cold_readiness_guest_fd_entries"], "8")
        self.assertEqual(row["readiness_observer_pids"], "42,43,44,45,46,47")
        self.assertEqual(row["post_quiescence_observer_pids"], "42,43,44,45,46,47")
        self.assertEqual(row["readiness_registered_processes"], "6")
        self.assertEqual(row["readiness_private_futex_waiters"], "3")
        self.assertEqual(row["post_quiescence_epoll_subscriptions"], "6")
        self.assertEqual(row["post_quiescence_guest_fd_entries"], "9")

    def test_count_drift_fails_closed(self) -> None:
        self.assert_fails(
            valid_log(final_counts=changed_counts(registered_processes=2)), "tuples differ"
        )

    def test_wal_writer_event_stabilization_fails_closed(self) -> None:
        cases = (
            (stabilization(after_writes=10), "write count did not increase"),
            (stabilization(after_write_bytes=81_920), "byte count did not increase"),
            (
                stabilization(after_stats_reset=1_786_320_001_000_000),
                "stats_reset changed",
            ),
            (stabilization(target_lsn="0/1009000"), "behind the target LSN"),
            (stabilization(target_lsn="0/0"), "target LSN is zero"),
            (stabilization(end_mono_ns=25), "timestamps are not increasing"),
            (stabilization(start_mono_ns=5), "outside the maintenance phase"),
            (stabilization(status="not-applicable"), "status is not passed"),
        )
        for record, detail in cases:
            with self.subTest(detail=detail):
                self.assert_fails(
                    valid_log(stabilization_record=record),
                    detail,
                )

    def test_missing_or_duplicate_stabilization_record_fails_closed(self) -> None:
        self.assert_fails(
            valid_log(stabilization_record=""),
            "missing WAL-writer stabilization record",
        )
        self.assert_fails(
            valid_log(stabilization_record=stabilization() + stabilization()),
            "duplicate stabilization record",
        )

    def test_reconnect_churn_is_receipt_bound_and_fails_closed(self) -> None:
        cases = (
            ("", "missing reconnect churn record"),
            (
                reconnect_churn(completed=1999),
                "completion count differs from requested",
            ),
            (
                reconnect_churn(command_sha256="0" * 64),
                "command contract is not canonical",
            ),
            (reconnect_churn(status="failed"), "status is not passed"),
            (
                reconnect_churn(start_mono_ns=59),
                "outside the reconnect phase",
            ),
            (
                reconnect_churn() + reconnect_churn(),
                "duplicate reconnect record",
            ),
        )
        for record, detail in cases:
            with self.subTest(detail=detail):
                self.assert_fails(valid_log(reconnect_record=record), detail)

    def test_stale_or_unbalanced_registry_fails_closed(self) -> None:
        self.assert_fails(
            valid_log(
                readiness_counts=changed_counts(runtime_state_stale=1),
                final_counts=changed_counts(runtime_state_stale=1),
            ),
            "runtime-state registry stale count",
        )
        self.assert_fails(
            valid_log(
                readiness_counts=changed_counts(shared_registry_stale=1, shared_registry_slots=3),
                final_counts=changed_counts(shared_registry_stale=1, shared_registry_slots=3),
            ),
            "stale count",
        )

    def test_observer_and_inner_occupancy_invariants_fail_closed(self) -> None:
        self.assert_fails(
            valid_log(
                readiness_counts=changed_counts(runtime_state_observer_registered=0),
                final_counts=changed_counts(runtime_state_observer_registered=0),
            ),
            "runtime snapshot observer is not registered",
        )
        self.assert_fails(
            valid_log(
                readiness_counts=changed_counts(private_futex_wakers=4),
                final_counts=changed_counts(private_futex_wakers=4),
            ),
            "private_futex waker count exceeds waiter count",
        )
        self.assert_fails(
            valid_log(
                readiness_counts=changed_counts(shared_futex_wakers=6),
                final_counts=changed_counts(shared_futex_wakers=6),
            ),
            "shared_futex waker count exceeds waiter count",
        )
        self.assert_fails(
            valid_log(
                readiness_counts=changed_counts(epoll_close_registrations=7),
                final_counts=changed_counts(epoll_close_registrations=7),
            ),
            "epoll close registrations exceed subscriptions",
        )

    def test_each_inner_waiter_and_epoll_count_drift_fails_closed(self) -> None:
        inner_fields = (
            "private_futexes",
            "private_futex_waiters",
            "private_futex_wakers",
            "shared_futexes",
            "shared_futex_waiters",
            "shared_futex_wakers",
            "epoll_states",
            "epoll_subscriptions",
            "epoll_ready_items",
            "epoll_pending_subscriptions",
            "epoll_enqueued_subscriptions",
            "epoll_join_guards",
            "epoll_close_registrations",
        )
        for field in inner_fields:
            with self.subTest(field=field):
                self.assert_fails(
                    valid_log(
                        final_counts=changed_counts(**{field: BASE_COUNTS[field] + 1})
                    ),
                    "tuples differ",
                )

    def test_idle_postmaster_relational_ownership_fails_closed(self) -> None:
        for field in (
            "active_tasks",
            "process_topology_nodes",
            "process_thread_entries",
            "process_live_threads",
            "runtime_state_active",
            "runtime_state_slots",
        ):
            with self.subTest(field=field):
                inconsistent = changed_counts(**{field: BASE_COUNTS[field] + 1})
                self.assert_fails(
                    valid_log(
                        readiness_counts=inconsistent,
                        final_counts=inconsistent,
                    ),
                    f"requires {field}=registered_processes",
                )
        invalid_leases = changed_counts(process_execution_leases=10)
        self.assert_fails(
            valid_log(
                readiness_counts=invalid_leases,
                final_counts=invalid_leases,
            ),
            "process_execution_leases=active_tasks+process_child_edges",
        )
        no_process = changed_counts(registered_processes=0)
        self.assert_fails(
            valid_log(readiness_counts=no_process, final_counts=no_process),
            "has no registered processes",
        )
        malformed_tree = changed_counts(process_child_edges=4)
        self.assert_fails(
            valid_log(readiness_counts=malformed_tree, final_counts=malformed_tree),
            "not one rooted tree",
        )
        for field in (
            "process_pending_child_publications",
            "process_quiescence_wakers",
            "process_retiring_nodes",
        ):
            with self.subTest(field=field):
                elevated = changed_counts(**{field: 1})
                self.assert_fails(
                    valid_log(readiness_counts=elevated, final_counts=elevated),
                    f"requires {field}=0",
                )

    def test_each_process_topology_count_drift_fails_closed(self) -> None:
        for field in (
            "process_topology_nodes",
            "process_child_edges",
            "process_thread_entries",
            "process_live_threads",
            "process_pending_child_publications",
            "process_execution_leases",
            "process_quiescence_wakers",
            "process_retiring_nodes",
        ):
            with self.subTest(field=field):
                self.assert_fails(
                    valid_log(
                        final_counts=changed_counts(**{field: BASE_COUNTS[field] + 1})
                    ),
                    "tuples differ",
                )

    def test_freeze_receipt_and_committed_ack_are_verified(self) -> None:
        result, row = self.run_validator(valid_log(), tamper_receipt=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("SHA-256 does not match the frozen", row["detail"])
        result, row = self.run_validator(valid_log(), tamper_ack=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("SHA-256 does not match the committed ACK", row["detail"])

    def test_pre_run_hashed_baseline_policy_binding_fails_on_mutation(self) -> None:
        result, row = self.run_validator(
            valid_log(), tamper_policy_after_binding=True
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("policy_id does not match its policy", row["detail"])

    def test_exact_qualification_policy_passes(self) -> None:
        result, row = self.run_validator(
            valid_log(), policy_payload_override=strict_policy_payload()
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(row["baseline_policy_status"], "qualification-bounded")

    def test_relabelled_broad_policy_cannot_be_promoted(self) -> None:
        exploratory = BASELINE_POLICY.read_bytes()
        relabelled = exploratory.replace(
            b"\tpg18-idle-postmaster-stabilized-exploratory-v1\texploratory-unbounded\t",
            b"\tpg18-idle-postmaster-stabilized-qualified-v1\tqualification-bounded\t",
        )
        self.assertNotEqual(relabelled, exploratory)
        result, row = self.run_validator(
            valid_log(), policy_payload_override=relabelled
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("must freeze the exact exploratory observation", row["detail"])

    def test_near_u64_policy_cannot_masquerade_as_bounded(self) -> None:
        broad = strict_policy_payload().replace(
            b"\tprivate_futexes\texact\t2\t2\n",
            b"\tprivate_futexes\trelative-equal\t0\t18446744073709551614\n",
        )
        self.assertNotEqual(broad, strict_policy_payload())
        result, row = self.run_validator(valid_log(), policy_payload_override=broad)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("must freeze the exact exploratory observation", row["detail"])

    def test_different_fence_wait_kinds_fail_closed(self) -> None:
        self.assert_fails(valid_log(final_kind=OTHER_WAIT_KIND), "different wait kinds")

    def test_short_or_gapped_coverage_fails_closed(self) -> None:
        self.assert_fails(
            valid_log(
                final_times=(
                    3_000_000_000,
                    3_100_000_000,
                    3_200_000_000,
                    3_300_000_000,
                    3_400_000_000,
                    3_500_000_000,
                    3_600_000_000,
                )
            ),
            "need 1000000000ns",
        )
        self.assert_fails(
            valid_log(
                final_times=(
                    3_000_000_000,
                    3_200_000_000,
                    3_400_000_000,
                    3_600_000_000,
                    3_800_000_000,
                    4_000_000_000,
                    5_000_000_000,
                )
            ),
            "sample gap",
        )

    def test_runtime_sequence_must_start_at_one_and_remain_gapless_to_fence(self) -> None:
        self.assert_fails(
            valid_log().replace(
                "wasix-runtime-context-v1\tseq=1\t",
                "wasix-runtime-context-v1\tseq=12\t",
                1,
            ),
            "start at 1",
        )
        self.assert_fails(
            valid_log().replace("wasix-runtime-context-v1\tseq=4", "wasix-runtime-context-v1\tseq=40", 1),
            "consecutive",
        )

    def test_fence_must_be_immediate_and_reference_the_terminal_sample(self) -> None:
        log = valid_log().replace(
            "wasix-runtime-fence-v1\tnonce=",
            "unrelated-line\nwasix-runtime-fence-v1\tnonce=",
            1,
        )
        self.assert_fails(log, "immediately follow")
        self.assert_fails(
            valid_log().replace(
                "\tseq=12\tmono_ns=2700000000\tphase=readiness",
                "\tseq=11\tmono_ns=2700000000\tphase=readiness",
                1,
            ),
            "does not reference",
        )

    def test_missing_writer_fence_cannot_be_repaired_by_phase_markers(self) -> None:
        log = valid_log().replace(
            fence(12, 2_700_000_000, "readiness", 1), "", 1
        )
        self.assert_fails(log, "no writer fence")

    def test_each_registered_observer_strengthens_global_plateau(self) -> None:
        result, row = self.run_validator(valid_log())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(row["readiness_observer_pids"], "42,43,44,45,46,47")

    def test_foreign_observer_before_terminal_tail_is_allowed_to_retire(self) -> None:
        result, row = self.run_validator(valid_log())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(row["status"], "passed")

    def test_terminal_observer_coverage_and_identity_are_exact(self) -> None:
        self.assert_fails(
            valid_log(final_observers=(42, 43, 44, 45, 46, 42, 42)),
            "observer cardinality",
        )
        self.assert_fails(
            valid_log(final_observers=(42, 43, 44, 45, 46, 48, 42)),
            "observer PID sets differ",
        )

    def test_foreign_wait_kind_inside_terminal_tail_fails_even_when_counts_match(self) -> None:
        log = valid_log().replace(
            "wasix-runtime-context-v1\tseq=16\twait_kind=" + WAIT_KIND,
            "wasix-runtime-context-v1\tseq=16\twait_kind=" + OTHER_WAIT_KIND,
            1,
        )
        self.assert_fails(log, "foreign wait kind")

    def test_other_wait_kind_cannot_hide_contradictory_global_state(self) -> None:
        original = context(8, pid=44) + state(8, 1_900_000_000, COUNTS)
        contradictory = context(8, pid=44, wait_kind=OTHER_WAIT_KIND) + state(
            8, 1_900_000_000, tuple(7 for _ in COUNT_NAMES)
        )
        self.assert_fails(
            valid_log().replace(original, contradictory, 1), "foreign wait kind"
        )

    def test_final_fence_is_a_cutoff_for_append_races(self) -> None:
        contents = valid_log().encode("utf-8") + b"\xff\xfe"
        result, row = self.run_validator(contents)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(row["status"], "failed")
        self.assertIn("receipt-bound complete marker", row["detail"])


if __name__ == "__main__":
    unittest.main()
