#!/usr/bin/env python3
"""Capture one strict, hashable cgroup-v2 resource-accounting snapshot."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import platform
import re
import stat
import sys
import time
from pathlib import Path
from typing import NoReturn


SCHEMA = "oliphaunt.wasix-postmaster.cgroup-v2-snapshot.v1"
UNSIGNED = re.compile(r"^(?:0|[1-9][0-9]*)$")
DEVICE = re.compile(r"^[0-9]+:[0-9]+$")
U64_MAX = (1 << 64) - 1
REQUIRED_IO_METRICS = {"rbytes", "wbytes", "rios", "wios"}
FILE_CACHE_MEMORY_STAT_FIELDS = {
    "active_file": ("gauge", "bytes"),
    "inactive_file": ("gauge", "bytes"),
    "file_mapped": ("gauge", "bytes"),
    "workingset_refault_file": ("cumulative_counter", "pages"),
    "workingset_activate_file": ("cumulative_counter", "pages"),
    "workingset_restore_file": ("cumulative_counter", "pages"),
    "pgscan": ("cumulative_counter", "pages"),
    "pgsteal": ("cumulative_counter", "pages"),
}


class SnapshotError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise SnapshotError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_text(root: Path, name: str) -> str:
    path = root / name
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail(f"cgroup field is not a regular non-symlink file: {path}")
    value = path.read_text(encoding="ascii")
    if "\0" in value:
        fail(f"cgroup field contains NUL: {path}")
    return value.strip()


def parse_unsigned(value: str, label: str) -> int:
    if not UNSIGNED.fullmatch(value):
        fail(f"{label} must be a canonical unsigned decimal: {value!r}")
    parsed = int(value)
    if parsed > U64_MAX:
        fail(f"{label} exceeds unsigned 64-bit range: {value!r}")
    return parsed


def parse_limit(value: str, label: str) -> int | str:
    if value == "max":
        return value
    return parse_unsigned(value, label)


def parse_flat_map(value: str, label: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for line in value.splitlines():
        fields = line.split()
        if len(fields) != 2 or not fields[0] or fields[0] in result:
            fail(f"malformed or duplicate {label} row: {line!r}")
        result[fields[0]] = parse_unsigned(fields[1], f"{label}.{fields[0]}")
    if not result:
        fail(f"{label} is empty")
    return result


def select_memory_events_file(root: Path) -> tuple[str, str]:
    """Select local events only when the captured cgroup is currently a leaf."""
    with os.scandir(root) as entries:
        has_child_cgroup = any(entry.is_dir(follow_symlinks=False) for entry in entries)
    local_name = "memory.events.local"
    if not has_child_cgroup and os.path.lexists(root / local_name):
        return local_name, "local-leaf"
    if has_child_cgroup:
        return "memory.events", "hierarchical-descendants"
    return "memory.events", "hierarchical-local-unavailable"


def select_file_cache_memory_stat(memory_stat: dict[str, int]) -> dict[str, object]:
    fields: dict[str, dict[str, object]] = {}
    missing: list[str] = []
    for name, (kind, unit) in FILE_CACHE_MEMORY_STAT_FIELDS.items():
        value = memory_stat.get(name)
        if value is None:
            missing.append(name)
        fields[name] = {
            "kind": kind,
            "unit": unit,
            "status": "available" if value is not None else "missing",
            "value": value,
        }
    return {
        "status": "complete" if not missing else "partial",
        "missing_keys": missing,
        "fields": fields,
    }


def parse_pressure(value: str) -> dict[str, dict[str, int | float]]:
    result: dict[str, dict[str, int | float]] = {}
    for line in value.splitlines():
        fields = line.split()
        if len(fields) != 5 or fields[0] not in {"some", "full"} or fields[0] in result:
            fail(f"malformed or duplicate memory.pressure row: {line!r}")
        metrics: dict[str, int | float] = {}
        for field in fields[1:]:
            if "=" not in field:
                fail(f"malformed memory.pressure metric: {field!r}")
            name, assigned = field.split("=", 1)
            if name == "total":
                metrics[name] = parse_unsigned(assigned, f"memory.pressure.{fields[0]}.total")
            elif name in {"avg10", "avg60", "avg300"}:
                try:
                    number = float(assigned)
                except ValueError as error:
                    raise SnapshotError(f"invalid memory.pressure value: {field!r}") from error
                if not math.isfinite(number) or number < 0:
                    fail(f"memory.pressure value must be finite and nonnegative: {field!r}")
                metrics[name] = number
            else:
                fail(f"unknown memory.pressure metric: {name}")
        if set(metrics) != {"avg10", "avg60", "avg300", "total"}:
            fail(f"incomplete memory.pressure row: {line!r}")
        result[fields[0]] = metrics
    if set(result) != {"some", "full"}:
        fail("memory.pressure must contain exactly some and full rows")
    return result


def parse_io_stat(value: str) -> tuple[list[dict[str, object]], dict[str, int]]:
    devices: list[dict[str, object]] = []
    totals: dict[str, int] = {}
    seen: set[str] = set()
    for line in value.splitlines():
        fields = line.split()
        if len(fields) < 2 or not DEVICE.fullmatch(fields[0]) or fields[0] in seen:
            fail(f"malformed or duplicate io.stat row: {line!r}")
        seen.add(fields[0])
        metrics: dict[str, int] = {}
        for field in fields[1:]:
            if "=" not in field:
                fail(f"malformed io.stat metric: {field!r}")
            name, assigned = field.split("=", 1)
            if not name or name in metrics:
                fail(f"duplicate or empty io.stat metric: {field!r}")
            metrics[name] = parse_unsigned(assigned, f"io.stat.{fields[0]}.{name}")
            totals[name] = totals.get(name, 0) + metrics[name]
        missing = REQUIRED_IO_METRICS - set(metrics)
        if missing:
            fail(f"io.stat.{fields[0]} lacks required metrics: {sorted(missing)}")
        devices.append({"device": fields[0], "metrics": dict(sorted(metrics.items()))})
    for name in REQUIRED_IO_METRICS:
        totals.setdefault(name, 0)
    return devices, dict(sorted(totals.items()))


def capture_io_stat(root: Path, controllers: list[str]) -> dict[str, object]:
    controller_status = "available" if "io" in controllers else "missing"
    path = root / "io.stat"
    if not os.path.lexists(path):
        return {
            "status": "unavailable",
            "controller_status": controller_status,
            "missing_reason": (
                "io-controller-missing"
                if controller_status == "missing"
                else "io-stat-missing"
            ),
            "source": None,
            "devices": None,
            "totals": None,
        }
    devices, totals = parse_io_stat(read_text(root, "io.stat"))
    return {
        "status": "available",
        "controller_status": controller_status,
        "missing_reason": None,
        "source": "io.stat",
        "devices": devices,
        "totals": totals,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cgroup-dir", required=True, type=Path)
    parser.add_argument("--cgroup-identity", required=True)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if platform.system() != "Linux":
        fail("cgroup-v2 resource capture requires Linux")
    root = args.cgroup_dir.absolute()
    info = os.lstat(root)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail(f"cgroup root must be a non-symlink directory: {root}")
    try:
        relative = root.relative_to(Path("/sys/fs/cgroup"))
    except ValueError as error:
        raise SnapshotError(f"cgroup must be below /sys/fs/cgroup: {root}") from error
    cgroup_path = "/" + str(relative)
    if any(character in args.cgroup_identity for character in "\t\r\n\0"):
        fail("cgroup identity contains control separators")

    memory_stat = parse_flat_map(read_text(root, "memory.stat"), "memory.stat")
    memory_events_name, memory_events_scope = select_memory_events_file(root)
    memory_events = parse_flat_map(
        read_text(root, memory_events_name), memory_events_name
    )
    pressure = parse_pressure(read_text(root, "memory.pressure"))
    controllers = sorted(read_text(root, "cgroup.controllers").split())
    io = capture_io_stat(root, controllers)
    required_stat = {
        "anon",
        "file",
        "kernel",
        "pagetables",
        "file_dirty",
        "file_writeback",
    }
    required_events = {"high", "max", "oom", "oom_kill"}
    if required_stat - set(memory_stat):
        fail(f"memory.stat lacks required fields: {sorted(required_stat - set(memory_stat))}")
    if required_events - set(memory_events):
        fail(f"memory.events lacks required fields: {sorted(required_events - set(memory_events))}")

    output = args.output.absolute()
    if output == root or root in output.parents:
        fail(f"snapshot output must be outside the cgroup filesystem: {output}")
    captured_monotonic_ns = time.monotonic_ns()
    snapshot = {
        "schema_version": SCHEMA,
        "status": "passed",
        "captured_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds"),
        "captured_monotonic_ns": captured_monotonic_ns,
        "tool_sha256": sha256_file(Path(__file__)),
        "host": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "cgroup": {
            "path": cgroup_path,
            "identity": args.cgroup_identity,
            "type": read_text(root, "cgroup.type"),
            "controllers": controllers,
            "pids_current": parse_unsigned(read_text(root, "pids.current"), "pids.current"),
        },
        "memory": {
            "current": parse_unsigned(read_text(root, "memory.current"), "memory.current"),
            "peak": parse_unsigned(read_text(root, "memory.peak"), "memory.peak"),
            "max": parse_limit(read_text(root, "memory.max"), "memory.max"),
            "high": parse_limit(read_text(root, "memory.high"), "memory.high"),
            "swap_current": parse_unsigned(
                read_text(root, "memory.swap.current"), "memory.swap.current"
            ),
            "swap_peak": parse_unsigned(read_text(root, "memory.swap.peak"), "memory.swap.peak"),
            "swap_max": parse_limit(read_text(root, "memory.swap.max"), "memory.swap.max"),
            "stat": dict(sorted(memory_stat.items())),
            "file_cache": select_file_cache_memory_stat(memory_stat),
            "events": dict(sorted(memory_events.items())),
            "events_source": {
                "file": memory_events_name,
                "scope": memory_events_scope,
            },
            "pressure": pressure,
        },
        "io": io,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_name(f".{output.name}.pending.{os.getpid()}")
    with pending.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(snapshot, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, output)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SnapshotError, OSError, ValueError) as error:
        print(f"cgroup-v2 snapshot failed: {error}", file=sys.stderr)
        raise SystemExit(1)
