#!/usr/bin/env python3
"""Validate one cold carrier/PGDATA launch and emit its canonical sample row."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import secrets
import sys
from pathlib import Path
from typing import Any, NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from cold_ownership_schema import SAMPLE_HEADER  # noqa: E402
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_identified,
    remove_private,
    stable_regular_bytes,
    write_bytes,
)


SCHEMA = "oliphaunt.wasix-postmaster.cold-ownership-sample.v1"
PROOF_SCHEMA = "oliphaunt.wasix-postmaster.cold-residency.v1"
SNAPSHOT_SCHEMA = "oliphaunt.wasix-postmaster.cgroup-v2-snapshot.v1"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
DEVICE = re.compile(r"^[0-9]+:[0-9]+$")
IO_METRICS = ("rbytes", "wbytes", "rios", "wios")
U64_MAX = (1 << 64) - 1
RESOURCE_REQUIRED_FIELDS = (
    "target",
    "smaps_status",
    "cgroup_status",
    "cgroup_path",
    "cgroup_scope_memory_peak_bytes",
    "cgroup_scope_swap_peak_bytes",
    "cgroup_memory_stat_file_dirty_bytes",
    "cgroup_memory_stat_file_writeback_bytes",
)

HEADER = list(SAMPLE_HEADER)


class ValidationError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise ValidationError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, member in pairs:
        require(key not in value, f"duplicate JSON object key: {key}")
        value[key] = member
    return value


def load_json(data: bytes, path: Path, schema: str) -> dict[str, Any]:
    value = json.loads(
        data.decode("utf-8", errors="strict"), object_pairs_hook=unique_json_object
    )
    require(isinstance(value, dict), f"JSON evidence root must be an object: {path}")
    require(value.get("schema_version") == schema, f"unexpected evidence schema in {path}")
    require(value.get("status") == "passed", f"evidence is not passed: {path}")
    return value


def integer(value: Any, label: str) -> int:
    require(
        isinstance(value, int)
        and not isinstance(value, bool)
        and 0 <= value <= U64_MAX,
        f"{label} must be a u64",
    )
    return value


def canonical_u64(value: str, label: str) -> int:
    require(
        re.fullmatch(r"0|[1-9][0-9]*", value) is not None,
        f"{label} must be a canonical unsigned decimal",
    )
    parsed = int(value)
    require(parsed <= U64_MAX, f"{label} exceeds unsigned 64-bit range")
    return parsed


def size_bytes(value: str) -> int:
    match = re.fullmatch(r"(0|[1-9][0-9]*)([KMGTPE]?)(?:i?B)?", value)
    if not match:
        fail(f"invalid cgroup size: {value}")
    number = int(match.group(1))
    exponent = "KMGTPE".find(match.group(2)) + 1 if match.group(2) else 0
    parsed = number * (1024**exponent)
    require(parsed <= U64_MAX, f"cgroup size exceeds u64: {value}")
    return parsed


def u64_argument(value: str, *, positive: bool = False) -> int:
    if re.fullmatch(r"0|[1-9][0-9]*", value) is None:
        raise argparse.ArgumentTypeError("must be canonical unsigned decimal")
    parsed = int(value)
    if parsed > U64_MAX or (positive and parsed == 0):
        qualifier = "positive " if positive else ""
        raise argparse.ArgumentTypeError(f"must be a {qualifier}u64")
    return parsed


def positive_u64_argument(value: str) -> int:
    return u64_argument(value, positive=True)


def nonnegative_u64_argument(value: str) -> int:
    return u64_argument(value)


def io_observation(
    snapshot: dict[str, Any], label: str
) -> tuple[str, str, str, dict[str, int] | None]:
    io = snapshot.get("io")
    require(isinstance(io, dict), f"{label} snapshot io evidence must be an object")
    status = io.get("status")
    controller_status = io.get("controller_status")
    missing_reason = io.get("missing_reason")
    require(
        controller_status in {"available", "missing"},
        f"{label} snapshot has invalid io controller status",
    )
    if status == "unavailable":
        expected_reason = (
            "io-controller-missing"
            if controller_status == "missing"
            else "io-stat-missing"
        )
        require(
            missing_reason == expected_reason,
            f"{label} snapshot has incoherent unavailable io reason",
        )
        require(io.get("source") is None, f"{label} unavailable io source must be null")
        require(io.get("devices") is None, f"{label} unavailable io devices must be null")
        require(io.get("totals") is None, f"{label} unavailable io totals must be null")
        return status, controller_status, expected_reason, None
    require(status == "available", f"{label} snapshot has invalid io status")
    require(missing_reason is None, f"{label} available io reason must be null")
    require(io.get("source") == "io.stat", f"{label} available io source is not io.stat")
    devices = io.get("devices")
    require(isinstance(devices, list), f"{label} available io devices must be a list")
    totals = io.get("totals")
    require(isinstance(totals, dict), f"{label} available io totals must be an object")
    expected_totals: dict[str, int] = {name: 0 for name in IO_METRICS}
    seen_devices: set[str] = set()
    for index, device in enumerate(devices):
        require(isinstance(device, dict), f"{label} io device {index} must be an object")
        device_name = device.get("device")
        require(
            isinstance(device_name, str)
            and DEVICE.fullmatch(device_name) is not None
            and device_name not in seen_devices,
            f"{label} io device {index} has invalid or duplicate identity",
        )
        seen_devices.add(device_name)
        device_metrics = device.get("metrics")
        require(
            isinstance(device_metrics, dict),
            f"{label} io device {device_name} metrics must be an object",
        )
        require(
            set(IO_METRICS) <= set(device_metrics),
            f"{label} io device {device_name} lacks required metrics",
        )
        for name, value in device_metrics.items():
            require(
                isinstance(name, str)
                and name != ""
                and not any(character.isspace() for character in name),
                f"{label} io device {device_name} has invalid metric name",
            )
            expected_totals[name] = expected_totals.get(name, 0) + integer(
                value, f"{label}.io.devices.{device_name}.{name}"
            )
    require(set(totals) == set(expected_totals), f"{label} io totals keys do not match devices")
    for name, expected in expected_totals.items():
        require(
            integer(totals.get(name), f"{label}.io.totals.{name}") == expected,
            f"{label} io total {name} does not match devices",
        )
    metrics = {
        name: integer(totals.get(name), f"{label}.io.totals.{name}")
        for name in IO_METRICS
    }
    return status, controller_status, "none", metrics


def memory_value(snapshot: dict[str, Any], name: str) -> int:
    return integer(snapshot.get("memory", {}).get(name), f"memory.{name}")


def memory_stat(snapshot: dict[str, Any], name: str) -> int:
    return integer(snapshot.get("memory", {}).get("stat", {}).get(name), f"memory.stat.{name}")


def validate_resource_samples(
    data: bytes, path: Path, cgroup_path: str
) -> tuple[int, int, int, int, int, int]:
    stream = io.StringIO(data.decode("utf-8", errors="strict"), newline="")
    require(
        data.endswith(b"\n") and b"\r" not in data and b"\0" not in data,
        f"resource sampler is not canonical newline-terminated TSV: {path}",
    )
    reader = csv.DictReader(stream, delimiter="\t")
    fieldnames = reader.fieldnames
    require(
        fieldnames is not None
        and len(fieldnames) == len(set(fieldnames))
        and set(RESOURCE_REQUIRED_FIELDS) <= set(fieldnames),
        f"resource sampler has an invalid header: {path}",
    )
    rows = list(reader)
    require(rows, f"resource sampler produced no rows: {path}")
    valid = 0
    memory_peak = 0
    swap_peak = 0
    dirty_peak = 0
    writeback_peak = 0
    for row in rows:
        require(
            None not in row and all(value is not None for value in row.values()),
            f"resource sampler row does not match its header: {path}",
        )
        require(row.get("target") == "wasix", "cold resource sample contains another target")
        if row.get("smaps_status") == "ok" and row.get("cgroup_status") == "ok":
            require(row.get("cgroup_path") == cgroup_path, "resource sample cgroup path changed")
            valid += 1
            for key, destination in (
                ("cgroup_scope_memory_peak_bytes", "memory"),
                ("cgroup_scope_swap_peak_bytes", "swap"),
                ("cgroup_memory_stat_file_dirty_bytes", "dirty"),
                ("cgroup_memory_stat_file_writeback_bytes", "writeback"),
            ):
                assigned = row.get(key, "")
                number = canonical_u64(assigned, f"valid resource sample {key}")
                if destination == "memory":
                    memory_peak = max(memory_peak, number)
                elif destination == "swap":
                    swap_peak = max(swap_peak, number)
                elif destination == "dirty":
                    dirty_peak = max(dirty_peak, number)
                else:
                    writeback_peak = max(writeback_peak, number)
    require(valid > 0, "full sampler produced no exact smaps+cgroup sample")
    return len(rows), valid, memory_peak, swap_peak, dirty_peak, writeback_peak


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--residency-receipt", required=True, type=Path)
    parser.add_argument("--first-query-snapshot", required=True, type=Path)
    parser.add_argument("--final-snapshot", required=True, type=Path)
    parser.add_argument("--resource-samples", required=True, type=Path)
    parser.add_argument("--execution-identity", required=True, type=Path)
    parser.add_argument("--carrier-root", required=True)
    parser.add_argument("--pgdata-root", required=True)
    parser.add_argument("--spawn-monotonic-ns", required=True, type=positive_u64_argument)
    parser.add_argument(
        "--first-query-monotonic-ns", required=True, type=positive_u64_argument
    )
    parser.add_argument("--readiness-attempts", required=True, type=positive_u64_argument)
    parser.add_argument("--memory-max", required=True)
    parser.add_argument("--memory-high", required=True)
    parser.add_argument("--swap-max", required=True)
    parser.add_argument(
        "--max-boundary-to-spawn-ms", default=1000, type=nonnegative_u64_argument
    )
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    proof_data = stable_regular_bytes(args.residency_receipt)
    first_data = stable_regular_bytes(args.first_query_snapshot)
    final_data = stable_regular_bytes(args.final_snapshot)
    resource_samples_data = stable_regular_bytes(args.resource_samples)
    execution_identity_data = stable_regular_bytes(args.execution_identity)
    validator_data = stable_regular_bytes(Path(__file__))
    proof = load_json(proof_data, args.residency_receipt, PROOF_SCHEMA)
    first = load_json(first_data, args.first_query_snapshot, SNAPSHOT_SCHEMA)
    final = load_json(final_data, args.final_snapshot, SNAPSHOT_SCHEMA)
    execution_sha = hashlib.sha256(execution_identity_data).hexdigest()
    require(SHA256.fullmatch(execution_sha) is not None, "invalid execution identity SHA-256")
    require(
        proof.get("bindings", {}).get("execution_identity_sha256") == execution_sha,
        "residency proof is not bound to this execution identity",
    )
    roots = proof.get("roots")
    require(isinstance(roots, list) and len(roots) == 2, "proof must contain exactly carrier and PGDATA roots")
    by_role = {root.get("role"): root for root in roots if isinstance(root, dict)}
    require(set(by_role) == {"carrier", "pgdata"}, "proof root roles are not exact")
    require(by_role["carrier"].get("path") == args.carrier_root, "carrier root changed")
    require(by_role["carrier"].get("require_read_only") is True, "carrier was not mode-gated read-only")
    require(by_role["pgdata"].get("path") == args.pgdata_root, "PGDATA root changed")
    totals = proof.get("totals", {})
    resident_after = integer(totals.get("resident_after_pages"), "resident_after_pages")
    require(resident_after == 0, "cold boundary retained regular-file pages")
    page_count = integer(totals.get("page_count"), "page_count")
    require(page_count > 0, "cold boundary covered no file pages")
    proof_end = integer(
        proof.get("timestamps", {}).get("proof_completed_monotonic_ns"),
        "proof_completed_monotonic_ns",
    )
    require(args.spawn_monotonic_ns >= proof_end, "spawn predates cold boundary")
    require(args.first_query_monotonic_ns >= args.spawn_monotonic_ns, "first query predates spawn")
    boundary_ms = (args.spawn_monotonic_ns - proof_end) / 1_000_000.0
    startup_ms = (args.first_query_monotonic_ns - args.spawn_monotonic_ns) / 1_000_000.0
    require(boundary_ms <= args.max_boundary_to_spawn_ms, "cold proof was not immediately followed by launch")
    require(args.readiness_attempts > 0, "readiness attempt count must be positive")

    first_cgroup = first.get("cgroup", {})
    final_cgroup = final.get("cgroup", {})
    cgroup_path = first_cgroup.get("path")
    cgroup_identity = first_cgroup.get("identity")
    require(isinstance(cgroup_path, str) and cgroup_path.startswith("/"), "invalid cgroup path")
    require(isinstance(cgroup_identity, str) and cgroup_identity, "invalid cgroup identity")
    require(final_cgroup.get("path") == cgroup_path, "final snapshot moved cgroups")
    require(final_cgroup.get("identity") == cgroup_identity, "final snapshot cgroup identity changed")
    require(
        integer(first.get("captured_monotonic_ns"), "first snapshot time") >= args.first_query_monotonic_ns,
        "first-query snapshot predates first query",
    )
    require(
        integer(final.get("captured_monotonic_ns"), "final snapshot time")
        >= integer(first.get("captured_monotonic_ns"), "first snapshot time"),
        "final snapshot predates first snapshot",
    )
    max_bytes = size_bytes(args.memory_max)
    high_bytes = size_bytes(args.memory_high)
    swap_bytes = size_bytes(args.swap_max)
    require(max_bytes > 0, "memory hard limit must be positive")
    require(high_bytes > 0, "memory high limit must be positive")
    require(high_bytes <= max_bytes, "memory high limit exceeds hard limit")
    for label, expected in (("max", max_bytes), ("high", high_bytes), ("swap_max", swap_bytes)):
        require(first.get("memory", {}).get(label) == expected, f"first snapshot memory.{label} limit mismatch")
        require(final.get("memory", {}).get(label) == expected, f"final snapshot memory.{label} limit mismatch")

    sample_count, full_count, sample_memory_peak, sample_swap_peak, sample_dirty, sample_writeback = (
        validate_resource_samples(
            resource_samples_data, args.resource_samples, cgroup_path
        )
    )
    whole_memory_peak = max(memory_value(first, "peak"), memory_value(final, "peak"), sample_memory_peak)
    whole_swap_peak = max(memory_value(first, "swap_peak"), memory_value(final, "swap_peak"), sample_swap_peak)
    dirty_peak = max(memory_stat(first, "file_dirty"), memory_stat(final, "file_dirty"), sample_dirty)
    writeback_peak = max(
        memory_stat(first, "file_writeback"), memory_stat(final, "file_writeback"), sample_writeback
    )
    require(whole_memory_peak > 0 and whole_memory_peak <= max_bytes, "whole-scope memory peak violates hard limit")
    require(whole_swap_peak <= swap_bytes, "whole-scope swap peak violates hard limit")
    require(memory_stat(first, "file") > 0, "first query charged no file pages to measured scope")
    first_io_status, first_io_controller, first_io_reason, first_io = io_observation(
        first, "first"
    )
    io_status, io_controller, io_missing_reason, final_io = io_observation(final, "final")
    require(io_status == first_io_status, "io observation status changed between snapshots")
    require(io_controller == first_io_controller, "io controller status changed between snapshots")
    require(io_missing_reason == first_io_reason, "io missing reason changed between snapshots")
    if final_io is None:
        require(first_io is None, "unavailable final io has available first snapshot")
        io_first_touch_status = "unavailable"
        io_read_bytes: int | str = ""
        io_write_bytes: int | str = ""
        io_read_ios: int | str = ""
        io_write_ios: int | str = ""
    else:
        require(first_io is not None, "available final io has unavailable first snapshot")
        io_read_bytes = final_io["rbytes"]
        io_write_bytes = final_io["wbytes"]
        io_read_ios = final_io["rios"]
        io_write_ios = final_io["wios"]
        require(
            io_read_bytes > 0 and io_read_ios > 0,
            "cold scope has no attributable storage reads",
        )
        require(io_read_bytes >= first_io["rbytes"], "cgroup read bytes regressed")
        require(io_write_bytes >= first_io["wbytes"], "cgroup write bytes regressed")
        require(io_read_ios >= first_io["rios"], "cgroup read I/Os regressed")
        require(io_write_ios >= first_io["wios"], "cgroup write I/Os regressed")
        io_first_touch_status = "attributable"

    values: list[str | int] = [
        SCHEMA,
        "wasix",
        "passed",
        execution_sha,
        hashlib.sha256(proof_data).hexdigest(),
        args.carrier_root,
        args.pgdata_root,
        integer(totals.get("regular_path_count"), "regular_path_count"),
        integer(totals.get("unique_file_count"), "unique_file_count"),
        integer(totals.get("logical_bytes"), "logical_bytes"),
        page_count,
        integer(totals.get("resident_before_pages"), "resident_before_pages"),
        resident_after,
        proof_end,
        args.spawn_monotonic_ns,
        f"{boundary_ms:.6f}",
        args.first_query_monotonic_ns,
        f"{startup_ms:.6f}",
        args.readiness_attempts,
        hashlib.sha256(first_data).hexdigest(),
        hashlib.sha256(final_data).hexdigest(),
        cgroup_path,
        cgroup_identity,
        max_bytes,
        high_bytes,
        swap_bytes,
        whole_memory_peak,
        whole_swap_peak,
        dirty_peak,
        writeback_peak,
        io_status,
        io_controller,
        io_missing_reason,
        io_first_touch_status,
        io_read_bytes,
        io_write_bytes,
        io_read_ios,
        io_write_ios,
        sample_count,
        full_count,
        hashlib.sha256(resource_samples_data).hexdigest(),
        hashlib.sha256(validator_data).hexdigest(),
    ]
    require(len(values) == len(HEADER), "internal cold sample schema mismatch")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
    writer.writerow(HEADER)
    writer.writerow(values)
    payload = stream.getvalue().encode("utf-8")

    output = Path(os.path.abspath(args.output))
    output.parent.mkdir(parents=True, exist_ok=True)
    token = f"{os.getpid()}.{secrets.token_hex(16)}"
    private = output.with_name(f".{output.name}.pending.{token}")
    private_identity = write_bytes(private, payload)
    try:
        publish_identified(private, output, private_identity)
    finally:
        remove_private(private, private_identity)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (
        PublicationError,
        ValidationError,
        OSError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ) as error:
        print(f"cold-ownership validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
