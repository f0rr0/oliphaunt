#!/usr/bin/env python3

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import os
from pathlib import Path
import re
import statistics
import sys
from typing import Iterable


CHECKPOINT_SCHEMA = "oliphaunt.wasix-postmaster.lifecycle-memory-checkpoint.v1"
RESULT_SCHEMA = "oliphaunt.wasix-postmaster.lifecycle-memory-plateau.v1"
CLAIM_SCOPE = (
    "untimed-quiescent-reconnect-boundaries;baseline-and-terminal-runtime-fenced"
)
CHECKPOINT_FIELDS = (
    "schema_version",
    "nonce",
    "sequence",
    "stage",
    "completed_reconnects",
    "requested_reconnects",
    "checkpoint_every",
    "quiescence_seconds",
    "quiescence_start_ns",
    "quiescence_end_ns",
    "monotonic_before_ns",
    "monotonic_after_ns",
    "capture_elapsed_ns",
    "server_pid",
    "server_birth_identity",
    "pss_kib",
    "pss_anon_kib",
    "anonymous_kib",
    "heap_pss_kib",
    "heap_private_kib",
    "heap_mappings",
    "status",
)
METRICS = ("pss_kib", "pss_anon_kib", "heap_pss_kib")
RESULT_FIELDS = (
    "schema_version",
    "target",
    "status",
    "detail",
    "claim_scope",
    "input_path",
    "input_sha256",
    "runtime_plateau_path",
    "runtime_plateau_sha256",
    "runtime_evidence_sha256",
    "runtime_freeze_receipt_sha256",
    "validator_sha256",
    "nonce",
    "server_pid",
    "server_birth_identity",
    "checkpoint_count",
    "requested_reconnects",
    "checkpoint_every",
    "min_quiescence_seconds",
    "max_pss_growth_kib",
    "max_pss_anon_growth_kib",
    "max_heap_growth_kib",
    "max_late_pss_slope_kib_per_1000_reconnects",
    "max_late_pss_anon_slope_kib_per_1000_reconnects",
    "max_late_heap_slope_kib_per_1000_reconnects",
    "max_capture_elapsed_ns",
    "tail_start_reconnects",
    *(
        field
        for metric in METRICS
        for field in (
            f"baseline_{metric}",
            f"peak_{metric}",
            f"final_{metric}",
            f"full_peak_growth_{metric}",
            f"final_growth_{metric}",
            f"late_peak_growth_{metric}",
            f"late_theil_sen_{metric}_per_1000_reconnects",
        )
    ),
)
NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
BIRTH_IDENTITY_RE = re.compile(r"^linux-starttime:[1-9][0-9]*$")
MIN_CHECKPOINTS = 5
MAX_CHECKPOINTS = 257


class EvidenceError(ValueError):
    pass


def parse_nonnegative_int(value: str, field: str) -> int:
    if re.fullmatch(r"0|[1-9][0-9]*", value) is None:
        raise EvidenceError(f"{field} is not a canonical nonnegative integer")
    return int(value)


def parse_positive_int(value: str, field: str) -> int:
    parsed = parse_nonnegative_int(value, field)
    if parsed == 0:
        raise EvidenceError(f"{field} must be positive")
    return parsed


def parse_nonnegative_number(value: str, field: str) -> float:
    if re.fullmatch(r"(?:(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|\.[0-9]+)", value) is None:
        raise EvidenceError(f"{field} is not a canonical nonnegative number")
    return float(value)


def read_regular_bytes(path: Path) -> bytes:
    if path.is_symlink() or not path.is_file():
        raise EvidenceError(f"input is not a regular non-symlink file: {path}")
    return path.read_bytes()


def expected_schedule(requested: int, every: int) -> list[int]:
    if every >= requested:
        raise EvidenceError("checkpoint interval must be smaller than reconnect count")
    schedule = [0, *range(every, requested, every), requested]
    if len(schedule) < MIN_CHECKPOINTS:
        raise EvidenceError("checkpoint schedule needs at least five observations")
    if len(schedule) > MAX_CHECKPOINTS:
        raise EvidenceError("checkpoint schedule is too dense for nonintrusive sampling")
    return schedule


def median(values: Iterable[float]) -> float:
    return float(statistics.median(tuple(values)))


def theil_sen_per_1000(points: list[tuple[int, int]]) -> float:
    slopes: list[float] = []
    for index, (left_x, left_y) in enumerate(points):
        for right_x, right_y in points[index + 1 :]:
            if right_x > left_x:
                slopes.append((right_y - left_y) * 1000.0 / (right_x - left_x))
    return median(slopes) if slopes else 0.0


def parse_checkpoints(
    path: Path,
    *,
    nonce: str,
    server_pid: int,
    requested: int,
    every: int,
    min_quiescence_seconds: float,
) -> tuple[list[dict[str, int | float | str]], str]:
    raw = read_regular_bytes(path)
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise EvidenceError(f"checkpoint evidence is not UTF-8: {error}") from error
    reader = csv.DictReader(text.splitlines(), delimiter="\t", strict=True)
    if tuple(reader.fieldnames or ()) != CHECKPOINT_FIELDS:
        raise EvidenceError("checkpoint evidence has an unexpected ordered schema")
    rows: list[dict[str, int | float | str]] = []
    schedule = expected_schedule(requested, every)
    previous_after_ns = -1
    birth_identity = ""
    for row_number, source in enumerate(reader, start=2):
        if None in source or any(value is None for value in source.values()):
            raise EvidenceError(f"row {row_number} has an invalid field count")
        if source["schema_version"] != CHECKPOINT_SCHEMA:
            raise EvidenceError(f"row {row_number} has an unexpected schema version")
        if source["nonce"] != nonce:
            raise EvidenceError(f"row {row_number} has a different lifecycle nonce")
        sequence = parse_nonnegative_int(source["sequence"], "sequence")
        if sequence != len(rows):
            raise EvidenceError(f"row {row_number} has a non-contiguous sequence")
        completed = parse_nonnegative_int(
            source["completed_reconnects"], "completed_reconnects"
        )
        if sequence >= len(schedule) or completed != schedule[sequence]:
            raise EvidenceError(f"row {row_number} is outside the exact checkpoint schedule")
        row_requested = parse_positive_int(
            source["requested_reconnects"], "requested_reconnects"
        )
        row_every = parse_positive_int(source["checkpoint_every"], "checkpoint_every")
        if row_requested != requested or row_every != every:
            raise EvidenceError(f"row {row_number} changes the reconnect policy")
        expected_stage = (
            "baseline-fenced"
            if sequence == 0
            else "final-fenced"
            if completed == requested
            else "wave-quiescent"
        )
        if source["stage"] != expected_stage:
            raise EvidenceError(f"row {row_number} has an invalid checkpoint stage")
        quiescence = parse_nonnegative_number(
            source["quiescence_seconds"], "quiescence_seconds"
        )
        if quiescence < min_quiescence_seconds:
            raise EvidenceError(f"row {row_number} has an insufficient quiescence window")
        quiescence_start_ns = parse_positive_int(
            source["quiescence_start_ns"], "quiescence_start_ns"
        )
        quiescence_end_ns = parse_positive_int(
            source["quiescence_end_ns"], "quiescence_end_ns"
        )
        if quiescence_end_ns <= quiescence_start_ns:
            raise EvidenceError(f"row {row_number} has invalid quiescence timing")
        if quiescence_end_ns - quiescence_start_ns < quiescence * 1_000_000_000:
            raise EvidenceError(f"row {row_number} did not observe its declared quiescence window")
        before_ns = parse_positive_int(source["monotonic_before_ns"], "monotonic_before_ns")
        after_ns = parse_positive_int(source["monotonic_after_ns"], "monotonic_after_ns")
        elapsed_ns = parse_positive_int(source["capture_elapsed_ns"], "capture_elapsed_ns")
        if after_ns < before_ns or after_ns - before_ns != elapsed_ns:
            raise EvidenceError(f"row {row_number} has inconsistent capture timing")
        if before_ns < quiescence_end_ns:
            raise EvidenceError(f"row {row_number} overlaps capture with quiescence timing")
        if previous_after_ns >= 0 and quiescence_start_ns <= previous_after_ns:
            raise EvidenceError(f"row {row_number} starts quiescence before the preceding capture")
        if before_ns <= previous_after_ns:
            raise EvidenceError(f"row {row_number} is not after the preceding capture")
        previous_after_ns = after_ns
        row_pid = parse_positive_int(source["server_pid"], "server_pid")
        if row_pid != server_pid:
            raise EvidenceError(f"row {row_number} has a different server PID")
        row_birth_identity = source["server_birth_identity"]
        if BIRTH_IDENTITY_RE.fullmatch(row_birth_identity) is None:
            raise EvidenceError(f"row {row_number} has an invalid Linux birth identity")
        if not birth_identity:
            birth_identity = row_birth_identity
        elif row_birth_identity != birth_identity:
            raise EvidenceError(f"row {row_number} changes the server birth identity")
        metrics = {
            field: parse_nonnegative_int(source[field], field)
            for field in (
                "pss_kib",
                "pss_anon_kib",
                "anonymous_kib",
                "heap_pss_kib",
                "heap_private_kib",
                "heap_mappings",
            )
        }
        if metrics["pss_anon_kib"] > metrics["pss_kib"]:
            raise EvidenceError(f"row {row_number} has PSS_Anon greater than PSS")
        if metrics["heap_pss_kib"] > metrics["pss_kib"]:
            raise EvidenceError(f"row {row_number} has heap PSS greater than total PSS")
        if source["status"] != "passed":
            raise EvidenceError(f"row {row_number} was not captured successfully")
        rows.append(
            {
                "sequence": sequence,
                "completed_reconnects": completed,
                "quiescence_start_ns": quiescence_start_ns,
                "quiescence_end_ns": quiescence_end_ns,
                "monotonic_before_ns": before_ns,
                "monotonic_after_ns": after_ns,
                "capture_elapsed_ns": elapsed_ns,
                "server_birth_identity": row_birth_identity,
                **metrics,
            }
        )
    if [int(row["completed_reconnects"]) for row in rows] != schedule:
        raise EvidenceError("checkpoint evidence is incomplete or has extra rows")
    return rows, hashlib.sha256(raw).hexdigest()


def parse_runtime_plateau(
    path: Path, *, nonce: str, requested: int
) -> tuple[dict[str, int | str], str]:
    raw = read_regular_bytes(path)
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeError as error:
        raise EvidenceError(f"runtime plateau is not UTF-8: {error}") from error
    reader = csv.DictReader(text.splitlines(), delimiter="\t", strict=True)
    required = {
        "schema_version",
        "target",
        "status",
        "nonce",
        "evidence_sha256",
        "freeze_receipt_sha256",
        "reconnect_requested",
        "reconnect_completed",
        "reconnect_start_mono_ns",
        "reconnect_end_mono_ns",
        "readiness_fence_mono_ns",
        "post_quiescence_fence_mono_ns",
    }
    fieldnames = tuple(reader.fieldnames or ())
    if len(fieldnames) != len(set(fieldnames)) or not required.issubset(fieldnames):
        raise EvidenceError("runtime plateau is missing required receipt fields")
    rows = list(reader)
    if len(rows) != 1 or None in rows[0] or any(value is None for value in rows[0].values()):
        raise EvidenceError("runtime plateau must contain exactly one well-formed row")
    source = rows[0]
    if (
        source["schema_version"] != "6"
        or source["target"] != "wasix"
        or source["status"] != "passed"
        or source["nonce"] != nonce
    ):
        raise EvidenceError("runtime plateau did not pass for this WASIX lifecycle nonce")
    for field in ("evidence_sha256", "freeze_receipt_sha256"):
        if re.fullmatch(r"[0-9a-f]{64}", source[field]) is None:
            raise EvidenceError(f"runtime plateau has an invalid {field}")
    reconnect_requested = parse_positive_int(
        source["reconnect_requested"], "reconnect_requested"
    )
    reconnect_completed = parse_positive_int(
        source["reconnect_completed"], "reconnect_completed"
    )
    if reconnect_requested != requested or reconnect_completed != requested:
        raise EvidenceError("runtime plateau does not bind the complete reconnect wave")
    parsed: dict[str, int | str] = {
        "evidence_sha256": source["evidence_sha256"],
        "freeze_receipt_sha256": source["freeze_receipt_sha256"],
        "reconnect_start_mono_ns": parse_positive_int(
            source["reconnect_start_mono_ns"], "reconnect_start_mono_ns"
        ),
        "reconnect_end_mono_ns": parse_positive_int(
            source["reconnect_end_mono_ns"], "reconnect_end_mono_ns"
        ),
        "readiness_fence_mono_ns": parse_positive_int(
            source["readiness_fence_mono_ns"], "readiness_fence_mono_ns"
        ),
        "post_quiescence_fence_mono_ns": parse_positive_int(
            source["post_quiescence_fence_mono_ns"],
            "post_quiescence_fence_mono_ns",
        ),
    }
    return parsed, hashlib.sha256(raw).hexdigest()


def validate(
    *,
    input_path: Path,
    runtime_plateau_path: Path,
    target: str,
    nonce: str,
    server_pid: int,
    requested: int,
    every: int,
    min_quiescence_seconds: float,
    max_growth: dict[str, int],
    max_late_slope: dict[str, float],
) -> dict[str, str | int | float]:
    runtime, runtime_plateau_sha256 = parse_runtime_plateau(
        runtime_plateau_path, nonce=nonce, requested=requested
    )
    rows, input_sha256 = parse_checkpoints(
        input_path,
        nonce=nonce,
        server_pid=server_pid,
        requested=requested,
        every=every,
        min_quiescence_seconds=min_quiescence_seconds,
    )
    if int(rows[0]["monotonic_before_ns"]) < int(runtime["readiness_fence_mono_ns"]):
        raise EvidenceError("baseline memory capture precedes the readiness runtime fence")
    if int(rows[0]["monotonic_after_ns"]) > int(runtime["reconnect_start_mono_ns"]):
        raise EvidenceError("baseline memory capture overlaps the reconnect wave")
    if int(rows[-1]["quiescence_start_ns"]) < int(runtime["reconnect_end_mono_ns"]):
        raise EvidenceError("terminal quiescence overlaps the reconnect wave")
    if int(rows[-1]["monotonic_before_ns"]) < int(
        runtime["post_quiescence_fence_mono_ns"]
    ):
        raise EvidenceError("terminal memory capture precedes the post-quiescence fence")
    tail_start_index = next(
        index
        for index, row in enumerate(rows)
        if int(row["completed_reconnects"]) * 2 >= requested
    )
    tail = rows[tail_start_index:]
    if len(tail) < 3:
        raise EvidenceError("late-tail slope requires at least three checkpoints")
    result: dict[str, str | int | float] = {
        "schema_version": RESULT_SCHEMA,
        "target": target,
        "status": "passed",
        "detail": "bounded-full-run-and-late-tail-quiescent-memory-growth",
        "claim_scope": CLAIM_SCOPE,
        "input_path": str(input_path),
        "input_sha256": input_sha256,
        "runtime_plateau_path": str(runtime_plateau_path),
        "runtime_plateau_sha256": runtime_plateau_sha256,
        "runtime_evidence_sha256": runtime["evidence_sha256"],
        "runtime_freeze_receipt_sha256": runtime["freeze_receipt_sha256"],
        "validator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "nonce": nonce,
        "server_pid": server_pid,
        "server_birth_identity": rows[0]["server_birth_identity"],
        "checkpoint_count": len(rows),
        "requested_reconnects": requested,
        "checkpoint_every": every,
        "min_quiescence_seconds": f"{min_quiescence_seconds:g}",
        "max_pss_growth_kib": max_growth["pss_kib"],
        "max_pss_anon_growth_kib": max_growth["pss_anon_kib"],
        "max_heap_growth_kib": max_growth["heap_pss_kib"],
        "max_late_pss_slope_kib_per_1000_reconnects": f"{max_late_slope['pss_kib']:g}",
        "max_late_pss_anon_slope_kib_per_1000_reconnects": f"{max_late_slope['pss_anon_kib']:g}",
        "max_late_heap_slope_kib_per_1000_reconnects": f"{max_late_slope['heap_pss_kib']:g}",
        "max_capture_elapsed_ns": max(int(row["capture_elapsed_ns"]) for row in rows),
        "tail_start_reconnects": tail[0]["completed_reconnects"],
    }
    failures: list[str] = []
    for metric in METRICS:
        baseline = int(rows[0][metric])
        final = int(rows[-1][metric])
        peak = max(int(row[metric]) for row in rows)
        tail_baseline = int(tail[0][metric])
        tail_peak = max(int(row[metric]) for row in tail)
        full_peak_growth = max(0, peak - baseline)
        final_growth = max(0, final - baseline)
        late_peak_growth = max(0, tail_peak - tail_baseline)
        slope = theil_sen_per_1000(
            [
                (int(row["completed_reconnects"]), int(row[metric]))
                for row in tail
            ]
        )
        result.update(
            {
                f"baseline_{metric}": baseline,
                f"peak_{metric}": peak,
                f"final_{metric}": final,
                f"full_peak_growth_{metric}": full_peak_growth,
                f"final_growth_{metric}": final_growth,
                f"late_peak_growth_{metric}": late_peak_growth,
                f"late_theil_sen_{metric}_per_1000_reconnects": f"{slope:.6f}",
            }
        )
        budget = max_growth[metric]
        if max(full_peak_growth, final_growth, late_peak_growth) > budget:
            failures.append(
                f"{metric} growth exceeds {budget} KiB "
                f"(peak={full_peak_growth},final={final_growth},late={late_peak_growth})"
            )
        slope_budget = max_late_slope[metric]
        if slope > slope_budget:
            failures.append(
                f"{metric} late Theil-Sen slope {slope:.6f} KiB/1000 "
                f"exceeds {slope_budget:g}"
            )
    if failures:
        result["status"] = "failed"
        result["detail"] = "; ".join(failures)
    return result


def failed_result(args: argparse.Namespace, detail: str) -> dict[str, str | int]:
    result: dict[str, str | int] = {field: "" for field in RESULT_FIELDS}
    result.update(
        schema_version=RESULT_SCHEMA,
        target=args.target,
        status="failed",
        detail=detail.replace("\t", " ").replace("\r", " ").replace("\n", " "),
        claim_scope=CLAIM_SCOPE,
        input_path=str(args.input),
        runtime_plateau_path=str(args.runtime_plateau),
        validator_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        nonce=args.nonce,
        server_pid=args.server_pid,
        requested_reconnects=args.requested_reconnects,
        checkpoint_every=args.checkpoint_every,
        min_quiescence_seconds=args.min_quiescence_seconds,
        max_pss_growth_kib=args.max_pss_growth_kib,
        max_pss_anon_growth_kib=args.max_pss_anon_growth_kib,
        max_heap_growth_kib=args.max_heap_growth_kib,
        max_late_pss_slope_kib_per_1000_reconnects=(
            args.max_late_pss_slope_kib_per_1000_reconnects
        ),
        max_late_pss_anon_slope_kib_per_1000_reconnects=(
            args.max_late_pss_anon_slope_kib_per_1000_reconnects
        ),
        max_late_heap_slope_kib_per_1000_reconnects=(
            args.max_late_heap_slope_kib_per_1000_reconnects
        ),
    )
    return result


def write_result(path: Path, result: dict[str, str | int | float]) -> None:
    if path.exists() and (path.is_symlink() or not path.is_file()):
        raise EvidenceError(f"output is not a regular non-symlink file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        with temporary.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(
                stream,
                fieldnames=RESULT_FIELDS,
                delimiter="\t",
                lineterminator="\n",
                extrasaction="raise",
            )
            writer.writeheader()
            writer.writerow({field: result.get(field, "") for field in RESULT_FIELDS})
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate quiescent WASIX reconnect memory checkpoints."
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--runtime-plateau", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target", default="wasix")
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--server-pid", type=int, required=True)
    parser.add_argument("--requested-reconnects", type=int, required=True)
    parser.add_argument("--checkpoint-every", type=int, required=True)
    parser.add_argument("--min-quiescence-seconds", type=float, required=True)
    parser.add_argument("--max-pss-growth-kib", type=int, required=True)
    parser.add_argument("--max-pss-anon-growth-kib", type=int, required=True)
    parser.add_argument("--max-heap-growth-kib", type=int, required=True)
    parser.add_argument(
        "--max-late-pss-slope-kib-per-1000-reconnects", type=float, required=True
    )
    parser.add_argument(
        "--max-late-pss-anon-slope-kib-per-1000-reconnects",
        type=float,
        required=True,
    )
    parser.add_argument(
        "--max-late-heap-slope-kib-per-1000-reconnects", type=float, required=True
    )
    args = parser.parse_args()
    if args.target != "wasix":
        parser.error("--target must be wasix")
    if NONCE_RE.fullmatch(args.nonce) is None:
        parser.error("--nonce must contain exactly 32 lowercase hexadecimal digits")
    if args.server_pid <= 0 or args.requested_reconnects <= 0:
        parser.error("server PID and reconnect count must be positive")
    if args.checkpoint_every <= 0 or args.checkpoint_every >= args.requested_reconnects:
        parser.error("checkpoint interval must be positive and smaller than reconnect count")
    if not math.isfinite(args.min_quiescence_seconds) or args.min_quiescence_seconds <= 0:
        parser.error("minimum quiescence must be positive")
    if min(
        args.max_pss_growth_kib,
        args.max_pss_anon_growth_kib,
        args.max_heap_growth_kib,
    ) < 0:
        parser.error("growth budgets must be nonnegative")
    slope_budgets = (
        args.max_late_pss_slope_kib_per_1000_reconnects,
        args.max_late_pss_anon_slope_kib_per_1000_reconnects,
        args.max_late_heap_slope_kib_per_1000_reconnects,
    )
    if any(not math.isfinite(value) or value < 0 for value in slope_budgets):
        parser.error("late-tail slope budgets must be nonnegative")
    return args


def main() -> int:
    args = parse_args()
    try:
        result = validate(
            input_path=args.input,
            runtime_plateau_path=args.runtime_plateau,
            target=args.target,
            nonce=args.nonce,
            server_pid=args.server_pid,
            requested=args.requested_reconnects,
            every=args.checkpoint_every,
            min_quiescence_seconds=args.min_quiescence_seconds,
            max_growth={
                "pss_kib": args.max_pss_growth_kib,
                "pss_anon_kib": args.max_pss_anon_growth_kib,
                "heap_pss_kib": args.max_heap_growth_kib,
            },
            max_late_slope={
                "pss_kib": args.max_late_pss_slope_kib_per_1000_reconnects,
                "pss_anon_kib": (
                    args.max_late_pss_anon_slope_kib_per_1000_reconnects
                ),
                "heap_pss_kib": (
                    args.max_late_heap_slope_kib_per_1000_reconnects
                ),
            },
        )
    except (EvidenceError, OSError, csv.Error) as error:
        result = failed_result(args, str(error))
    try:
        write_result(args.output, result)
    except (EvidenceError, OSError) as error:
        print(error, file=sys.stderr)
        return 1
    if result["status"] != "passed":
        print(result["detail"], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
