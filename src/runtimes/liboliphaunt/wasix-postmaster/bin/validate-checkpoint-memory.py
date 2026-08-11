#!/usr/bin/env python3
"""Validate standalone WASIX checkpoint/recycle memory evidence."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path


HEADER = [
    "schema_version",
    "epoch",
    "epoch_origin_monotonic_ns",
    "monotonic_ns",
    "phase",
    "process_count",
    "pss_kib",
    "pss_anon_kib",
    "private_kib",
    "pagetables_kib",
    "cgroup_current_bytes",
    "cgroup_peak_bytes",
    "cgroup_swap_bytes",
    "cgroup_anon_bytes",
    "cgroup_file_bytes",
    "cgroup_kernel_bytes",
    "cgroup_pagetables_bytes",
    "cgroup_file_dirty_bytes",
    "cgroup_file_writeback_bytes",
    "event_high",
    "event_max",
    "event_oom",
    "event_oom_kill",
    "psi_some_total_usec",
    "psi_full_total_usec",
]
EPOCH_HEADER = [
    "schema_version",
    "epoch",
    "epoch_origin_monotonic_ns",
    "cgroup_path",
    "cgroup_identity",
    "memory_max_bytes",
    "memory_high_bytes",
    "memory_swap_max_bytes",
]


class EvidenceError(ValueError):
    pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--samples", type=Path, required=True)
    result.add_argument("--epochs", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--gates-output", type=Path, required=True)
    result.add_argument("--max-pss-kib", type=int, default=163840)
    result.add_argument("--max-pss-anon-kib", type=int, default=98304)
    result.add_argument("--max-pagetables-kib", type=int, default=2048)
    result.add_argument("--max-current-bytes", type=int, default=268435456)
    result.add_argument("--expected-memory-high-bytes", type=int, default=234881024)
    result.add_argument("--expected-memory-swap-max-bytes", type=int, default=0)
    result.add_argument("--max-dirty-writeback-bytes", type=int, default=100663296)
    result.add_argument("--max-high-events-per-second", type=float, default=250.0)
    result.add_argument("--max-restart-gap-seconds", type=float, default=30.0)
    result.add_argument("--max-psi-some-fraction", type=float, default=0.015)
    result.add_argument("--max-psi-full-fraction", type=float, default=0.010)
    result.add_argument("--max-quiescent-anon-growth-kib", type=int, default=8192)
    result.add_argument("--max-quiescent-private-growth-kib", type=int, default=8192)
    result.add_argument("--max-quiescent-pss-growth-kib", type=int, default=24576)
    result.add_argument("--max-last-three-anon-range-kib", type=int, default=4096)
    return result


def integer(row: dict[str, str], field: str) -> int:
    value = row[field]
    if not value.isdigit():
        raise EvidenceError(f"{field} is not a nonnegative integer: {value!r}")
    return int(value)


def write_rows(path: Path, rows: list[list[object]]) -> None:
    if path.exists() or path.is_symlink():
        raise EvidenceError(f"refusing to replace output: {path}")
    with path.open("x", newline="", encoding="utf-8") as stream:
        csv.writer(stream, delimiter="\t", lineterminator="\n").writerows(rows)


def main() -> int:
    args = parser().parse_args()
    try:
        if not args.samples.is_file() or args.samples.is_symlink():
            raise EvidenceError("samples must be a regular non-symlink file")
        with args.samples.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream, delimiter="\t")
            if reader.fieldnames != HEADER:
                raise EvidenceError(f"unexpected sample header: {reader.fieldnames!r}")
            raw_rows = list(reader)
        if not args.epochs.is_file() or args.epochs.is_symlink():
            raise EvidenceError("epochs must be a regular non-symlink file")
        with args.epochs.open(newline="", encoding="utf-8") as stream:
            epoch_reader = csv.DictReader(stream, delimiter="\t")
            if epoch_reader.fieldnames != EPOCH_HEADER:
                raise EvidenceError(
                    f"unexpected cgroup epoch header: {epoch_reader.fieldnames!r}"
                )
            raw_epoch_rows = list(epoch_reader)
        if len(raw_rows) < 6:
            raise EvidenceError("memory evidence requires at least six samples")
        rows: list[dict[str, int | str]] = []
        previous_time = -1
        previous_epoch = 0
        allowed_phases = {
            "initial-quiescent",
            "steady",
            "volume-checkpoint",
            "recycle-shutdown",
            "recycle-startup",
            "second-steady",
            "post-recycle-quiescent",
        }
        cumulative_fields = [
            "event_high",
            "event_max",
            "event_oom",
            "event_oom_kill",
            "psi_some_total_usec",
            "psi_full_total_usec",
        ]
        previous_cumulative: dict[str, int] | None = None
        epoch_bounds: dict[int, list[dict[str, int | str]]] = {}
        epoch_origins: dict[int, int] = {}
        for raw in raw_rows:
            if raw["schema_version"] != "1":
                raise EvidenceError("memory sample has an unknown schema version")
            epoch = integer(raw, "epoch")
            if epoch < 1 or epoch < previous_epoch or epoch > previous_epoch + 1:
                raise EvidenceError("memory sample epochs must be positive and contiguous")
            if epoch != previous_epoch:
                previous_cumulative = None
                previous_epoch = epoch
            converted: dict[str, int | str] = {"phase": raw["phase"], "epoch": epoch}
            if raw["phase"] not in allowed_phases:
                raise EvidenceError(f"unknown memory evidence phase: {raw['phase']!r}")
            for field in HEADER:
                if field not in ("schema_version", "phase", "epoch"):
                    converted[field] = integer(raw, field)
            now = int(converted["monotonic_ns"])
            origin = int(converted["epoch_origin_monotonic_ns"])
            if origin > now:
                raise EvidenceError("epoch origin is later than its memory sample")
            if epoch in epoch_origins and epoch_origins[epoch] != origin:
                raise EvidenceError("epoch origin changed within one cgroup epoch")
            epoch_origins[epoch] = origin
            if now <= previous_time:
                raise EvidenceError("memory sample timestamps are not strictly increasing")
            previous_time = now
            if previous_cumulative is not None:
                for field in cumulative_fields:
                    if int(converted[field]) < previous_cumulative[field]:
                        raise EvidenceError(f"cumulative counter moved backwards: {field}")
            previous_cumulative = {
                field: int(converted[field]) for field in cumulative_fields
            }
            if (
                int(converted["pss_anon_kib"]) > int(converted["pss_kib"])
                or int(converted["private_kib"]) > int(converted["pss_kib"])
                or int(converted["cgroup_peak_bytes"])
                < int(converted["cgroup_current_bytes"])
            ):
                raise EvidenceError("memory sample contains inconsistent accounting")
            rows.append(converted)
            epoch_bounds.setdefault(epoch, []).append(converted)
            if int(converted["process_count"]) <= 0:
                raise EvidenceError("memory sample contains no cgroup processes")

        expected_phase_runs = {
            1: [
                "initial-quiescent",
                "steady",
                "volume-checkpoint",
                "recycle-shutdown",
            ],
            2: [
                "recycle-startup",
                "second-steady",
                "post-recycle-quiescent",
            ],
        }
        if set(epoch_bounds) != set(expected_phase_runs):
            raise EvidenceError("memory evidence must contain exactly epochs 1 and 2")
        for epoch, expected in expected_phase_runs.items():
            observed: list[str] = []
            for row in epoch_bounds[epoch]:
                phase = str(row["phase"])
                if not observed or observed[-1] != phase:
                    observed.append(phase)
            if observed != expected:
                raise EvidenceError(
                    f"epoch {epoch} phase order is {observed!r}, expected {expected!r}"
                )
        if epoch_origins[2] <= int(epoch_bounds[1][-1]["monotonic_ns"]):
            raise EvidenceError(
                "epoch 2 must originate after the epoch 1 recycle-shutdown boundary"
            )
        if len(raw_epoch_rows) != 2:
            raise EvidenceError("cgroup epoch evidence must contain exactly two rows")
        epoch_receipts: dict[int, dict[str, str]] = {}
        for receipt in raw_epoch_rows:
            if receipt["schema_version"] != "1":
                raise EvidenceError("cgroup epoch receipt has an unknown schema version")
            epoch = integer(receipt, "epoch")
            if epoch in epoch_receipts or epoch not in (1, 2):
                raise EvidenceError("cgroup epoch receipts must uniquely cover epochs 1 and 2")
            origin = integer(receipt, "epoch_origin_monotonic_ns")
            memory_max = integer(receipt, "memory_max_bytes")
            memory_high = integer(receipt, "memory_high_bytes")
            swap_max = integer(receipt, "memory_swap_max_bytes")
            if origin != epoch_origins[epoch]:
                raise EvidenceError("sample and cgroup receipt epoch origins differ")
            if not receipt["cgroup_path"].startswith("/sys/fs/cgroup/"):
                raise EvidenceError("cgroup receipt path is outside cgroup v2")
            if not receipt["cgroup_identity"]:
                raise EvidenceError("cgroup receipt identity is empty")
            if (
                memory_max != args.max_current_bytes
                or memory_high != args.expected_memory_high_bytes
                or swap_max != args.expected_memory_swap_max_bytes
            ):
                raise EvidenceError("cgroup receipt does not match the embedded memory limits")
            epoch_receipts[epoch] = receipt
        if set(epoch_receipts) != {1, 2}:
            raise EvidenceError("cgroup epoch receipts do not cover epochs 1 and 2")
        if (
            epoch_receipts[1]["cgroup_path"] == epoch_receipts[2]["cgroup_path"]
            or epoch_receipts[1]["cgroup_identity"]
            == epoch_receipts[2]["cgroup_identity"]
        ):
            raise EvidenceError("recycle must use two distinct fresh cgroup scopes")

        initial = [row for row in rows if row["phase"] == "initial-quiescent"]
        post = [row for row in rows if row["phase"] == "post-recycle-quiescent"]
        steady = [row for row in rows if row["phase"] == "steady"]
        volume = [row for row in rows if row["phase"] == "volume-checkpoint"]
        second_steady = [row for row in rows if row["phase"] == "second-steady"]
        if (
            len(initial) < 2
            or len(post) < 3
            or not steady
            or not volume
            or not second_steady
            or len(epoch_bounds[1]) < 6
            or len(epoch_bounds[2]) < 4
            or int(epoch_bounds[1][-1]["monotonic_ns"])
            - int(epoch_bounds[1][0]["monotonic_ns"]) < 2_000_000_000
            or int(epoch_bounds[2][-1]["monotonic_ns"])
            - int(epoch_bounds[2][0]["monotonic_ns"]) < 2_000_000_000
        ):
            raise EvidenceError(
                "required phases are initial-quiescent, steady, volume-checkpoint, "
                "second-steady, and at least three post-recycle-quiescent samples "
                "across two sufficiently sampled epochs"
            )
        wall_elapsed_seconds = (
            int(rows[-1]["monotonic_ns"]) - int(rows[0]["monotonic_ns"])
        ) / 1_000_000_000
        epoch_seconds = {
            epoch: (
                int(epoch_rows[-1]["monotonic_ns"]) - epoch_origins[epoch]
            )
            / 1_000_000_000
            for epoch, epoch_rows in epoch_bounds.items()
        }
        observed_epoch_seconds = sum(epoch_seconds.values())
        restart_gap_seconds = (
            epoch_origins[2] - int(epoch_bounds[1][-1]["monotonic_ns"])
        ) / 1_000_000_000
        if wall_elapsed_seconds <= 0 or any(value <= 0 for value in epoch_seconds.values()):
            raise EvidenceError("memory evidence has no elapsed time")
        # Every qualification epoch uses a newly-created cgroup. Its cumulative
        # counters therefore begin at zero at epoch_origin_monotonic_ns. Counting
        # the absolute final value includes startup pressure that subtracting the
        # first process sample would silently omit.
        high_delta = sum(
            int(epoch_rows[-1]["event_high"])
            for epoch_rows in epoch_bounds.values()
        )
        psi_some_delta = sum(
            int(epoch_rows[-1]["psi_some_total_usec"])
            for epoch_rows in epoch_bounds.values()
        )
        psi_full_delta = sum(
            int(epoch_rows[-1]["psi_full_total_usec"])
            for epoch_rows in epoch_bounds.values()
        )
        high_rate = high_delta / observed_epoch_seconds
        psi_some = psi_some_delta / (observed_epoch_seconds * 1_000_000)
        psi_full = psi_full_delta / (observed_epoch_seconds * 1_000_000)
        restart_first = epoch_bounds[2][0]
        restart_observed_seconds = (
            int(restart_first["monotonic_ns"]) - epoch_origins[2]
        ) / 1_000_000_000
        if restart_observed_seconds <= 0:
            raise EvidenceError("restart startup boundary has no observed duration")
        restart_high_rate = (
            int(restart_first["event_high"]) / restart_observed_seconds
        )
        restart_psi_some = int(restart_first["psi_some_total_usec"]) / (
            restart_observed_seconds * 1_000_000
        )
        restart_psi_full = int(restart_first["psi_full_total_usec"]) / (
            restart_observed_seconds * 1_000_000
        )
        first = initial[-1]
        final = post[-1]
        last_three = post[-3:]
        maxima = {
            field: max(int(row[field]) for row in rows)
            for field in (
                "pss_kib",
                "pss_anon_kib",
                "pagetables_kib",
                "cgroup_current_bytes",
                "cgroup_peak_bytes",
                "cgroup_swap_bytes",
            )
        }
        max_dirty_writeback = max(
            int(row["cgroup_file_dirty_bytes"])
            + int(row["cgroup_file_writeback_bytes"])
            for row in rows
        )
        deltas = {
            field: sum(int(epoch_rows[-1][field]) for epoch_rows in epoch_bounds.values())
            for field in ("event_max", "event_oom", "event_oom_kill")
        }
        gates: list[tuple[str, str, str, bool]] = []

        def gate(name: str, expected: str, observed: object, passed: bool) -> None:
            gates.append((name, expected, str(observed), passed))

        gate("peak_pss_kib", f"<={args.max_pss_kib}", maxima["pss_kib"], maxima["pss_kib"] <= args.max_pss_kib)
        gate("peak_pss_anon_kib", f"<={args.max_pss_anon_kib}", maxima["pss_anon_kib"], maxima["pss_anon_kib"] <= args.max_pss_anon_kib)
        gate("peak_pagetables_kib", f"<={args.max_pagetables_kib}", maxima["pagetables_kib"], maxima["pagetables_kib"] <= args.max_pagetables_kib)
        gate("peak_cgroup_current_bytes", f"<={args.max_current_bytes}", maxima["cgroup_current_bytes"], maxima["cgroup_current_bytes"] <= args.max_current_bytes)
        gate("cgroup_memory_peak_bytes", f"<={args.max_current_bytes}", maxima["cgroup_peak_bytes"], maxima["cgroup_peak_bytes"] <= args.max_current_bytes)
        gate("swap_current_bytes", "0", maxima["cgroup_swap_bytes"], maxima["cgroup_swap_bytes"] == 0)
        gate("max_events", "0", deltas["event_max"], deltas["event_max"] == 0)
        gate("oom_events", "0", deltas["event_oom"], deltas["event_oom"] == 0)
        gate("oom_kill_events", "0", deltas["event_oom_kill"], deltas["event_oom_kill"] == 0)
        gate("high_events_per_second", f"<={args.max_high_events_per_second}", f"{high_rate:.9f}", high_rate <= args.max_high_events_per_second)
        gate("psi_some_fraction", f"<={args.max_psi_some_fraction}", f"{psi_some:.9f}", psi_some <= args.max_psi_some_fraction)
        gate("psi_full_fraction", f"<={args.max_psi_full_fraction}", f"{psi_full:.9f}", psi_full <= args.max_psi_full_fraction)
        gate("restart_max_events", "0", restart_first["event_max"], int(restart_first["event_max"]) == 0)
        gate("restart_oom_events", "0", restart_first["event_oom"], int(restart_first["event_oom"]) == 0)
        gate("restart_oom_kill_events", "0", restart_first["event_oom_kill"], int(restart_first["event_oom_kill"]) == 0)
        gate("restart_high_events_per_second", f"<={args.max_high_events_per_second}", f"{restart_high_rate:.9f}", restart_high_rate <= args.max_high_events_per_second)
        gate("restart_psi_some_fraction", f"<={args.max_psi_some_fraction}", f"{restart_psi_some:.9f}", restart_psi_some <= args.max_psi_some_fraction)
        gate("restart_psi_full_fraction", f"<={args.max_psi_full_fraction}", f"{restart_psi_full:.9f}", restart_psi_full <= args.max_psi_full_fraction)
        gate("restart_gap_seconds", f"<={args.max_restart_gap_seconds}", f"{restart_gap_seconds:.9f}", restart_gap_seconds <= args.max_restart_gap_seconds)
        gate("dirty_plus_writeback_bytes", f"<={args.max_dirty_writeback_bytes}", max_dirty_writeback, max_dirty_writeback <= args.max_dirty_writeback_bytes)
        anon_growth = int(final["pss_anon_kib"]) - int(first["pss_anon_kib"])
        private_growth = int(final["private_kib"]) - int(first["private_kib"])
        pss_growth = int(final["pss_kib"]) - int(first["pss_kib"])
        anon_range = max(int(row["pss_anon_kib"]) for row in last_three) - min(
            int(row["pss_anon_kib"]) for row in last_three
        )
        gate("quiescent_anon_growth_kib", f"<={args.max_quiescent_anon_growth_kib}", anon_growth, anon_growth <= args.max_quiescent_anon_growth_kib)
        gate("quiescent_private_growth_kib", f"<={args.max_quiescent_private_growth_kib}", private_growth, private_growth <= args.max_quiescent_private_growth_kib)
        gate("quiescent_pss_growth_kib", f"<={args.max_quiescent_pss_growth_kib}", pss_growth, pss_growth <= args.max_quiescent_pss_growth_kib)
        gate("last_three_anon_range_kib", f"<={args.max_last_three_anon_range_kib}", anon_range, anon_range <= args.max_last_three_anon_range_kib)
        passed = all(item[3] for item in gates)
        write_rows(
            args.gates_output,
            [["gate", "expected", "observed", "status"]]
            + [[name, expected, observed, "passed" if ok else "failed"] for name, expected, observed, ok in gates],
        )
        write_rows(
            args.output,
            [[
                "schema_version", "status", "sample_count",
                "wall_elapsed_seconds", "observed_epoch_seconds",
                "epoch_1_seconds", "epoch_2_seconds", "restart_gap_seconds",
                "restart_observed_seconds",
                "peak_pss_kib", "peak_pss_anon_kib", "peak_pagetables_kib",
                "peak_cgroup_current_bytes", "cgroup_memory_peak_bytes",
                "high_events_per_second",
                "psi_some_fraction", "psi_full_fraction",
                "max_dirty_writeback_bytes", "quiescent_anon_growth_kib",
                "quiescent_private_growth_kib", "quiescent_pss_growth_kib",
                "last_three_anon_range_kib", "gates",
                "epochs",
            ], [
                "oliphaunt.wasix-postmaster.checkpoint-memory.v1",
                "passed" if passed else "failed", len(rows),
                f"{wall_elapsed_seconds:.6f}",
                f"{observed_epoch_seconds:.6f}",
                f"{epoch_seconds[1]:.6f}", f"{epoch_seconds[2]:.6f}",
                f"{restart_gap_seconds:.6f}", f"{restart_observed_seconds:.6f}",
                maxima["pss_kib"],
                maxima["pss_anon_kib"], maxima["pagetables_kib"],
                maxima["cgroup_current_bytes"], maxima["cgroup_peak_bytes"],
                f"{high_rate:.9f}",
                f"{psi_some:.9f}", f"{psi_full:.9f}", max_dirty_writeback,
                anon_growth, private_growth, pss_growth, anon_range,
                args.gates_output, args.epochs,
            ]],
        )
        return 0 if passed else 1
    except (EvidenceError, OSError, csv.Error) as error:
        print(f"checkpoint memory validation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
