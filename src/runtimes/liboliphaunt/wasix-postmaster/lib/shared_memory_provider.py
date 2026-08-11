#!/usr/bin/env python3
"""Prepare, prove, and safely remove host backing for guest ``/dev/shm``.

The benchmark deliberately keeps this policy outside Wasmer.  A provider is
selected explicitly, creates one private directory, and emits a receipt that
binds the directory inode, ownership, and backing filesystem.  Verification
and cleanup require both the receipt and the caller's expected provider/path;
the receipt is evidence, never deletion authority by itself.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import sys
import tempfile
import time
from typing import Any

from durable_publication import (
    PublicationError,
    PublicationSource,
    publish_identified,
    remove_private,
    write_bytes,
)


PROVIDER_SCHEMA = "oliphaunt.wasix-postmaster.shared-memory-provider.v2"
IDENTIFIABLE_PROVIDER_SCHEMAS = (
    "oliphaunt.wasix-postmaster.shared-memory-provider.v1",
    PROVIDER_SCHEMA,
)
CLEANUP_SCHEMA = "oliphaunt.wasix-postmaster.shared-memory-cleanup.v2"
OBJECTS_SCHEMA = "oliphaunt.wasix-postmaster.shared-memory-objects.v2"
RELEASE_SCHEMA = "oliphaunt.wasix-postmaster.shared-memory-release.v2"
CLEANUP_POLICY = "anchored-parent-exact-inode-empty-rmdir-v2"
PORTABLE_FILE_PROVIDER = "portable-file-v1"
LINUX_TMPFS_PROVIDER = "linux-tmpfs-v1"
PROVIDERS = (PORTABLE_FILE_PROVIDER, LINUX_TMPFS_PROVIDER)
TMPFS_PREFIX = "oliphaunt-wasix-postmaster"
MAX_RECEIPT_BYTES = 256 * 1024
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
SHA256 = re.compile(r"[0-9a-f]{64}")
MAIN_OBJECT = re.compile(r"postgresql-wasix-[0-9a-f]{8}-[0-9a-f]{8}")
TMPFS_MAGIC = 0x01021994
CLEAN_RELEASE = "clean-postgresql-shutdown-v1"
PROCESS_DRAIN_RELEASE = "post-process-drain-v1"
RELEASE_KINDS = (CLEAN_RELEASE, PROCESS_DRAIN_RELEASE)
LIFECYCLE_KEYS = (
    "pid",
    "pgid",
    "birth_identity",
    "wait_status",
    "forced",
    "clean_shutdown_marker",
    "process_group_residue",
    "cgroup_residue",
    "port_residue",
    "status",
)


class ProviderError(ValueError):
    """A provider contract or evidence invariant was not satisfied."""


class ProviderSignal(Exception):
    """A catchable termination signal interrupted provider preparation."""

    def __init__(self, signum: int) -> None:
        super().__init__(f"preparation interrupted by signal {signum}")
        self.signum = signum


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ProviderError(message)


def _reject_control_characters(value: str, label: str) -> None:
    _require(
        CONTROL_CHARACTERS.search(value) is None,
        f"{label} contains a control character",
    )


def _canonical_existing_directory(path: Path, label: str) -> Path:
    _reject_control_characters(str(path), label)
    _require(path.is_absolute(), f"{label} must be absolute: {path}")
    try:
        observed = os.lstat(path)
    except FileNotFoundError as error:
        raise ProviderError(f"{label} does not exist: {path}") from error
    _require(not stat.S_ISLNK(observed.st_mode), f"{label} is a symlink: {path}")
    _require(stat.S_ISDIR(observed.st_mode), f"{label} is not a directory: {path}")
    canonical = Path(os.path.realpath(path))
    canonical_observed = os.lstat(canonical)
    _require(
        (canonical_observed.st_dev, canonical_observed.st_ino)
        == (observed.st_dev, observed.st_ino),
        f"{label} changed during canonicalization: {path}",
    )
    return canonical


def _decode_mountinfo(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        return chr(int(match.group(1), 8))

    return re.sub(r"\\([0-7]{3})", replace, value)


def _linux_mount_for(path: Path) -> dict[str, Any]:
    selected: dict[str, Any] | None = None
    selected_length = -1
    try:
        lines = Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise ProviderError(f"could not read Linux mountinfo: {error}") from error

    path_text = str(path)
    for line in lines:
        before, separator, after = line.partition(" - ")
        _require(bool(separator), "Linux mountinfo contains a malformed record")
        left = before.split()
        right = after.split()
        _require(
            len(left) >= 6 and len(right) >= 3,
            "Linux mountinfo contains a short record",
        )
        mount_point = _decode_mountinfo(left[4])
        if mount_point == "/":
            contains = path_text.startswith("/")
        else:
            contains = path_text == mount_point or path_text.startswith(
                mount_point.rstrip("/") + "/"
            )
        if not contains or len(mount_point) <= selected_length:
            continue
        try:
            mount_id = int(left[0])
            parent_mount_id = int(left[1])
        except ValueError as error:
            raise ProviderError("Linux mountinfo contains a nonnumeric mount ID") from error
        selected = {
            "mount_id": mount_id,
            "parent_mount_id": parent_mount_id,
            "major_minor": left[2],
            "mount_root": _decode_mountinfo(left[3]),
            "mount_point": mount_point,
            "mount_options": left[5].split(","),
            "optional_fields": left[6:],
            "filesystem_type": right[0],
            "mount_source": _decode_mountinfo(right[1]),
            "super_options": right[2].split(","),
        }
        selected_length = len(mount_point)
    _require(selected is not None, f"no Linux mountinfo record contains {path}")
    return selected


def _linux_statfs_magic(path: Path) -> int:
    # statfs starts with a native long f_type on every supported Linux ABI. A
    # generously sized opaque buffer avoids mirroring libc's remaining
    # architecture-dependent struct layout merely to obtain that field.
    libc = ctypes.CDLL(None, use_errno=True)
    buffer = ctypes.create_string_buffer(256)
    statfs = libc.statfs
    statfs.argtypes = (ctypes.c_char_p, ctypes.c_void_p)
    statfs.restype = ctypes.c_int
    if statfs(os.fsencode(path), ctypes.byref(buffer)) != 0:
        error = ctypes.get_errno()
        raise ProviderError(f"Linux statfs failed for {path}: {os.strerror(error)}")
    return ctypes.c_ulong.from_buffer(buffer).value


def _filesystem_evidence(
    path: Path, *, require_linux_mount: bool = False
) -> dict[str, Any]:
    observed = os.stat(path, follow_symlinks=False)
    stats = os.statvfs(path)
    fragment_size = stats.f_frsize or stats.f_bsize
    evidence: dict[str, Any] = {
        "proof_source": "os.statvfs+st_dev",
        "root_device": observed.st_dev,
        "root_device_major_minor": f"{os.major(observed.st_dev)}:{os.minor(observed.st_dev)}",
        "block_size": stats.f_bsize,
        "fragment_size": fragment_size,
        "capacity_bytes": stats.f_blocks * fragment_size,
        "free_bytes": stats.f_bfree * fragment_size,
        "available_bytes": stats.f_bavail * fragment_size,
        "filesystem_type": "portable-unspecified",
        "filesystem_magic": "unsupported",
        "statfs_proof_status": "not-applicable",
        "statfs_proof_error": None,
        "mount_proof_status": "not-applicable",
        "mount_proof_error": None,
        "mount": None,
    }
    if platform.system() == "Linux":
        try:
            filesystem_magic = _linux_statfs_magic(path)
        except ProviderError as error:
            if require_linux_mount:
                raise
            evidence.update(
                statfs_proof_status="unavailable",
                statfs_proof_error=str(error),
                mount_proof_status="unavailable",
            )
        else:
            evidence.update(
                proof_source="linux-statfs+os.statvfs+st_dev",
                filesystem_magic=f"0x{filesystem_magic:08x}",
                statfs_proof_status="passed",
                mount_proof_status="unavailable",
            )
        try:
            mount = _linux_mount_for(path)
        except ProviderError as error:
            if require_linux_mount:
                raise
            evidence["mount_proof_error"] = str(error)
        else:
            _require(
                mount["major_minor"] == evidence["root_device_major_minor"],
                "Linux mountinfo device differs from st_dev",
            )
            if evidence["statfs_proof_status"] == "passed":
                proof_source = (
                    "linux-proc-self-mountinfo+statfs+os.statvfs+st_dev"
                )
            else:
                proof_source = "linux-proc-self-mountinfo+os.statvfs+st_dev"
            evidence.update(
                proof_source=proof_source,
                filesystem_type=mount["filesystem_type"],
                mount_proof_status="passed",
                mount=mount,
            )
    return evidence


def _directory_evidence(path: Path) -> dict[str, Any]:
    observed = os.lstat(path)
    _require(not stat.S_ISLNK(observed.st_mode), f"provider root is a symlink: {path}")
    _require(stat.S_ISDIR(observed.st_mode), f"provider root is not a directory: {path}")
    return {
        "path": str(path),
        "parent_path": str(path.parent),
        "basename": path.name,
        "device": observed.st_dev,
        "inode": observed.st_ino,
        "uid": observed.st_uid,
        "gid": observed.st_gid,
        "mode": f"{stat.S_IMODE(observed.st_mode):04o}",
        "symlink": False,
        "ownership_status": (
            "passed"
            if (observed.st_uid, observed.st_gid) == (os.geteuid(), os.getegid())
            else "failed"
        ),
        "mode_status": "passed" if stat.S_IMODE(observed.st_mode) == 0o700 else "failed",
    }


def _parent_evidence(path: Path) -> dict[str, Any]:
    observed = os.lstat(path)
    _require(not stat.S_ISLNK(observed.st_mode), f"provider parent is a symlink: {path}")
    _require(stat.S_ISDIR(observed.st_mode), f"provider parent is not a directory: {path}")
    return {
        "path": str(path),
        "device": observed.st_dev,
        "inode": observed.st_ino,
        "uid": observed.st_uid,
        "gid": observed.st_gid,
        "mode": f"{stat.S_IMODE(observed.st_mode):04o}",
        "symlink": False,
    }


def _validate_created_root(path: Path) -> None:
    evidence = _directory_evidence(path)
    _require(
        evidence["ownership_status"] == "passed",
        "provider root is not owned by the effective user/group",
    )
    _require(evidence["mode_status"] == "passed", "provider root mode is not 0700")


def _evidence_destination(path: Path) -> Path:
    _reject_control_characters(str(path), "evidence path")
    _require(path.is_absolute(), f"evidence path must be absolute: {path}")
    parent = _canonical_existing_directory(path.parent, "evidence parent")
    return parent / path.name


def _new_evidence_destination(path: Path) -> Path:
    destination = _evidence_destination(path)
    _require(not os.path.lexists(destination), f"evidence path already exists: {destination}")
    return destination


def _require_destination_outside_root(
    destination: Path, root: Path, label: str
) -> None:
    _require(
        destination != root and not destination.is_relative_to(root),
        f"{label} must be outside the provider root",
    )


def _json_payload(value: dict[str, Any]) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    destination = _new_evidence_destination(path)
    parent = destination.parent
    payload = _json_payload(value)
    temporary = parent / f".{destination.name}.pending.{os.getpid()}.{time.time_ns()}"
    temporary_identity: PublicationSource | None = None
    try:
        temporary_identity = write_bytes(temporary, payload)
        publish_identified(temporary, destination, temporary_identity)
    except (OSError, PublicationError) as error:
        raise ProviderError(str(error)) from error
    finally:
        try:
            if temporary_identity is not None:
                remove_private(temporary, temporary_identity)
        except (OSError, PublicationError) as error:
            raise ProviderError(str(error)) from error


def _read_regular_payload(path: Path, label: str) -> bytes:
    _reject_control_characters(str(path), label)
    _require(path.is_absolute(), f"{label} must be absolute: {path}")
    before = os.lstat(path)
    _require(
        not stat.S_ISLNK(before.st_mode) and stat.S_ISREG(before.st_mode),
        f"{label} is not a regular non-symlink file: {path}",
    )
    _require(before.st_size <= MAX_RECEIPT_BYTES, f"{label} exceeds parser limit")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        _require(
            (opened.st_dev, opened.st_ino, opened.st_size)
            == (before.st_dev, before.st_ino, before.st_size),
            f"{label} changed while opening",
        )
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 64 * 1024))
            _require(bool(chunk), f"{label} was truncated while reading")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        _require(
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
            f"{label} changed while reading",
        )
    finally:
        os.close(descriptor)
    return b"".join(chunks)


def _read_receipt(path: Path) -> tuple[dict[str, Any], bytes]:
    payload = _read_regular_payload(path, "provider evidence")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            _require(key not in result, f"duplicate provider evidence field: {key}")
            result[key] = value
        return result

    try:
        value = json.loads(payload.decode("utf-8"), object_pairs_hook=reject_duplicates)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ProviderError(f"invalid provider evidence JSON: {error}") from error
    _require(isinstance(value, dict), "provider evidence must be a JSON object")
    return value, payload


def _require_recorded_integer(value: Any, label: str) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool), f"invalid {label}")
    _require(value >= 0, f"invalid negative {label}")
    return value


def _verified_lifecycle_evidence(path: Path, expected_sha256: str) -> dict[str, str]:
    _require(
        SHA256.fullmatch(expected_sha256) is not None,
        "expected lifecycle evidence SHA-256 is invalid",
    )
    payload = _read_regular_payload(path, "server lifecycle evidence")
    _require(
        hashlib.sha256(payload).hexdigest() == expected_sha256,
        "server lifecycle evidence SHA-256 differs",
    )
    try:
        text = payload.decode("utf-8")
    except UnicodeError as error:
        raise ProviderError(f"server lifecycle evidence is not UTF-8: {error}") from error
    _require(text.endswith("\n") and "\r" not in text, "lifecycle evidence is not canonical")
    lines = text.splitlines()
    _require(
        len(lines) == len(LIFECYCLE_KEYS),
        "server lifecycle evidence field count differs",
    )
    result: dict[str, str] = {}
    for expected_key, line in zip(LIFECYCLE_KEYS, lines, strict=True):
        _require(line.count("=") == 1, "server lifecycle evidence field is ambiguous")
        key, separator, value = line.partition("=")
        _require(
            bool(separator) and key == expected_key and bool(value),
            f"server lifecycle evidence field differs: {expected_key}",
        )
        _reject_control_characters(value, f"server lifecycle {key}")
        result[key] = value
    expected_clean = {
        "wait_status": "0",
        "forced": "none",
        "clean_shutdown_marker": "1",
        "process_group_residue": "0",
        "cgroup_residue": "0",
        "port_residue": "0",
        "status": "passed",
    }
    for key, expected in expected_clean.items():
        _require(result[key] == expected, f"server lifecycle is not clean: {key}")
    for key in ("pid", "pgid"):
        _require(result[key].isdigit() and int(result[key]) > 0, f"invalid lifecycle {key}")
    _require(result["pid"] == result["pgid"], "server lifecycle process group differs")
    return result


def _receipt_root_identity(receipt: dict[str, Any]) -> tuple[int, int]:
    directory = receipt.get("directory")
    _require(isinstance(directory, dict), "provider evidence directory is not an object")
    assert isinstance(directory, dict)
    return (
        _require_recorded_integer(directory.get("device"), "provider device"),
        _require_recorded_integer(directory.get("inode"), "provider inode"),
    )


def _receipt_parent_identity(receipt: dict[str, Any]) -> tuple[int, int]:
    parent = receipt.get("parent")
    _require(isinstance(parent, dict), "provider evidence parent is not an object")
    assert isinstance(parent, dict)
    return (
        _require_recorded_integer(parent.get("device"), "provider parent device"),
        _require_recorded_integer(parent.get("inode"), "provider parent inode"),
    )


def _open_receipt_root(root: Path, device: int, inode: int) -> int:
    descriptor = _open_directory(root)
    try:
        opened = os.fstat(descriptor)
        _require(
            stat.S_ISDIR(opened.st_mode)
            and (opened.st_dev, opened.st_ino) == (device, inode),
            "opened provider root device/inode differs from receipt",
        )
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _assert_root_still_named(root: Path, device: int, inode: int) -> None:
    observed = os.lstat(root)
    _require(
        stat.S_ISDIR(observed.st_mode)
        and not stat.S_ISLNK(observed.st_mode)
        and (observed.st_dev, observed.st_ino) == (device, inode),
        "provider root path no longer names the receipt inode",
    )


def _chmod_exact_root(root: Path, device: int, inode: int, mode: int) -> None:
    descriptor = _open_receipt_root(root, device, inode)
    try:
        os.fchmod(descriptor, mode)
        observed = os.fstat(descriptor)
        _require(
            stat.S_IMODE(observed.st_mode) == mode,
            f"provider root mode is not {mode:04o}",
        )
        _assert_root_still_named(root, device, inode)
    finally:
        os.close(descriptor)


def _verified_receipt(
    evidence_path: Path,
    expected_evidence_sha256: str,
    expected_provider: str,
    expected_root: Path,
) -> tuple[dict[str, Any], bytes, Path]:
    receipt, payload = _read_receipt(evidence_path)
    _require(
        SHA256.fullmatch(expected_evidence_sha256) is not None,
        "expected provider evidence SHA-256 is invalid",
    )
    _require(
        hashlib.sha256(payload).hexdigest() == expected_evidence_sha256,
        "provider evidence SHA-256 differs",
    )
    _require(receipt.get("schema") == PROVIDER_SCHEMA, "provider evidence schema differs")
    _require(expected_provider in PROVIDERS, f"unknown provider: {expected_provider}")
    _require(receipt.get("provider") == expected_provider, "provider evidence ID differs")
    _reject_control_characters(str(expected_root), "expected provider root")
    _require(expected_root.is_absolute(), "expected provider root must be absolute")
    directory = receipt.get("directory")
    parent_record = receipt.get("parent")
    filesystem = receipt.get("filesystem")
    contract = receipt.get("contract")
    host = receipt.get("host")
    helper = receipt.get("helper")
    context = receipt.get("context")
    initial_state = receipt.get("initial_state")
    for value, label in (
        (directory, "directory"),
        (parent_record, "parent"),
        (filesystem, "filesystem"),
        (contract, "contract"),
        (host, "host"),
        (helper, "helper"),
        (context, "context"),
        (initial_state, "initial_state"),
    ):
        _require(isinstance(value, dict), f"provider evidence {label} is not an object")
    assert isinstance(directory, dict)
    assert isinstance(parent_record, dict)
    assert isinstance(filesystem, dict)
    assert isinstance(contract, dict)
    assert isinstance(host, dict)
    assert isinstance(helper, dict)
    assert isinstance(context, dict)
    assert isinstance(initial_state, dict)

    recorded_root = directory.get("path")
    _require(isinstance(recorded_root, str), "provider evidence root path is invalid")
    _require(recorded_root == str(expected_root), "provider evidence root differs from caller")
    root = Path(recorded_root)
    recorded_parent = directory.get("parent_path")
    _require(
        isinstance(recorded_parent, str),
        "provider evidence parent path is invalid",
    )
    _reject_control_characters(recorded_parent, "provider evidence parent path")
    _require(root.parent == Path(recorded_parent), "recorded parent differs")
    _require(root.name == directory.get("basename"), "recorded basename differs")
    _require(contract.get("guest_mountpoint") == "/dev/shm", "guest mountpoint differs")
    _require(contract.get("cleanup_policy") == CLEANUP_POLICY, "cleanup policy differs")
    _require(host.get("platform") == platform.system(), "host platform differs")
    _require(host.get("effective_uid") == os.geteuid(), "effective UID differs")
    _require(host.get("effective_gid") == os.getegid(), "effective GID differs")
    helper_path = Path(__file__).resolve()
    recorded_helper_path = helper.get("path")
    _require(
        isinstance(recorded_helper_path, str)
        and Path(recorded_helper_path).is_absolute(),
        "provider helper path is invalid",
    )
    _reject_control_characters(recorded_helper_path, "provider helper path")
    _require(
        helper.get("sha256") == hashlib.sha256(helper_path.read_bytes()).hexdigest(),
        "provider helper SHA-256 differs",
    )
    _require(context.get("target") == "wasix", "provider target context differs")
    _require(
        isinstance(context.get("measurement_id"), str)
        and bool(context["measurement_id"]),
        "provider measurement context is empty",
    )
    _reject_control_characters(context["measurement_id"], "provider measurement context")
    _require(
        initial_state == {"entry_count": 0, "status": "empty"},
        "provider initial-state evidence differs",
    )

    parent = _canonical_existing_directory(root.parent, "provider parent")
    _require(parent == root.parent, "provider parent is no longer canonical")
    parent_now = _parent_evidence(parent)
    for field in ("path", "device", "inode", "uid", "gid", "mode", "symlink"):
        _require(parent_record.get(field) == parent_now[field], f"provider parent {field} differs")

    now = _directory_evidence(root)
    for field in (
        "path",
        "parent_path",
        "basename",
        "device",
        "inode",
        "uid",
        "gid",
        "mode",
        "symlink",
        "ownership_status",
        "mode_status",
    ):
        _require(directory.get(field) == now[field], f"provider root {field} differs")
    _require(now["ownership_status"] == "passed", "provider root ownership is not exact")
    _require(now["mode_status"] == "passed", "provider root mode is not 0700")
    _require_recorded_integer(directory.get("device"), "provider device")
    _require_recorded_integer(directory.get("inode"), "provider inode")

    current_filesystem = _filesystem_evidence(
        root, require_linux_mount=expected_provider == LINUX_TMPFS_PROVIDER
    )
    _require(
        filesystem.get("root_device") == current_filesystem["root_device"],
        "filesystem root_device differs",
    )
    for field in ("statfs_proof_status", "mount_proof_status"):
        _require(
            filesystem.get(field) in ("passed", "unavailable", "not-applicable"),
            f"recorded filesystem {field} is invalid",
        )
    _require(
        isinstance(filesystem.get("proof_source"), str)
        and bool(filesystem["proof_source"]),
        "recorded filesystem proof source is invalid",
    )
    if filesystem.get("statfs_proof_status") == "passed":
        _require(
            isinstance(filesystem.get("filesystem_magic"), str)
            and filesystem["filesystem_magic"].startswith("0x"),
            "recorded filesystem magic is invalid",
        )
    if expected_provider == LINUX_TMPFS_PROVIDER:
        for field in (
            "proof_source",
            "filesystem_type",
            "filesystem_magic",
            "statfs_proof_status",
            "mount_proof_status",
        ):
            _require(
                filesystem.get(field) == current_filesystem[field],
                f"filesystem {field} differs",
            )
    elif (
        filesystem.get("statfs_proof_status") == "passed"
        and current_filesystem["statfs_proof_status"] == "passed"
    ):
        _require(
            filesystem.get("filesystem_magic")
            == current_filesystem["filesystem_magic"],
            "filesystem magic differs",
        )
    recorded_mount = filesystem.get("mount")
    current_mount = current_filesystem.get("mount")
    if filesystem.get("mount_proof_status") == "passed":
        _require(isinstance(recorded_mount, dict), "Linux mount evidence is missing")
    else:
        _require(recorded_mount is None, "unexpected recorded Linux mount evidence")
    if expected_provider == LINUX_TMPFS_PROVIDER:
        _require(isinstance(recorded_mount, dict), "Linux mount evidence is missing")
        _require(isinstance(current_mount, dict), "current Linux mount evidence is missing")
    if isinstance(recorded_mount, dict) and isinstance(current_mount, dict):
        assert isinstance(recorded_mount, dict)
        assert isinstance(current_mount, dict)
        for field in (
            "mount_id",
            "parent_mount_id",
            "major_minor",
            "mount_root",
            "mount_point",
            "mount_options",
            "optional_fields",
            "filesystem_type",
            "mount_source",
            "super_options",
        ):
            _require(recorded_mount.get(field) == current_mount[field], f"mount {field} differs")

    if expected_provider == PORTABLE_FILE_PROVIDER:
        _require(contract.get("allocation") == "caller-exact", "portable allocation differs")
        _require(
            contract.get("expected_filesystem") == "any",
            "portable filesystem policy differs",
        )
        _require(root.name == "dev-shm", "portable provider basename differs")
    else:
        _require(platform.system() == "Linux", "linux-tmpfs-v1 requires Linux")
        _require(contract.get("allocation") == "private-mkdtemp", "tmpfs allocation differs")
        _require(contract.get("expected_filesystem") == "tmpfs", "tmpfs policy differs")
        _require(current_filesystem["filesystem_type"] == "tmpfs", "provider is not on tmpfs")
        _require(
            current_filesystem["mount_proof_status"] == "passed",
            "provider tmpfs mount proof is unavailable",
        )
        _require(
            current_filesystem["statfs_proof_status"] == "passed",
            "provider tmpfs statfs proof is unavailable",
        )
        _require(
            current_filesystem["filesystem_magic"] == f"0x{TMPFS_MAGIC:08x}",
            "provider statfs magic is not TMPFS_MAGIC",
        )
        expected_prefix = f"{TMPFS_PREFIX}.{os.geteuid()}."
        _require(root.name.startswith(expected_prefix), "tmpfs provider basename prefix differs")
        _require(len(root.name) > len(expected_prefix), "tmpfs provider basename has no nonce")
    return receipt, payload, root


def verify(
    evidence_path: Path,
    expected_evidence_sha256: str,
    expected_provider: str,
    expected_root: Path,
) -> None:
    _verified_receipt(
        evidence_path, expected_evidence_sha256, expected_provider, expected_root
    )


def capture_objects(
    evidence_path: Path,
    expected_evidence_sha256: str,
    expected_provider: str,
    expected_root: Path,
    output_path: Path,
    *,
    require_main: bool,
    cgroup_identity: str,
) -> None:
    provider_receipt, _, root = _verified_receipt(
        evidence_path, expected_evidence_sha256, expected_provider, expected_root
    )
    _reject_control_characters(cgroup_identity, "cgroup identity")
    root_device, root_inode = _receipt_root_identity(provider_receipt)
    output_destination = _new_evidence_destination(output_path)
    _require_destination_outside_root(
        output_destination, root, "shared-object evidence"
    )
    filesystem_type = _filesystem_evidence(
        root, require_linux_mount=expected_provider == LINUX_TMPFS_PROVIDER
    )["filesystem_type"]
    root_fd = _open_receipt_root(root, root_device, root_inode)
    objects: list[dict[str, Any]] = []
    try:
        opened = os.fstat(root_fd)
        for name in sorted(os.listdir(root_fd)):
            _reject_control_characters(name, "shared-memory object name")
            observed = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
            _require(
                stat.S_ISREG(observed.st_mode),
                f"shared-memory object is not a regular non-symlink file: {name}",
            )
            _require(
                observed.st_dev == opened.st_dev,
                f"shared-memory object is on another device: {name}",
            )
            descriptor = os.open(
                name,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=root_fd,
            )
            try:
                exact = os.fstat(descriptor)
                _require(
                    (exact.st_dev, exact.st_ino)
                    == (observed.st_dev, observed.st_ino),
                    f"shared-memory object changed while opening: {name}",
                )
            finally:
                os.close(descriptor)
            objects.append(
                {
                    "name": name,
                    "path": str(root / name),
                    "role": "postgresql-main" if MAIN_OBJECT.fullmatch(name) else "other",
                    "device": exact.st_dev,
                    "inode": exact.st_ino,
                    "size_bytes": exact.st_size,
                    "allocated_bytes": exact.st_blocks * 512,
                    "uid": exact.st_uid,
                    "gid": exact.st_gid,
                    "mode": f"{stat.S_IMODE(exact.st_mode):04o}",
                    "link_count": exact.st_nlink,
                    "filesystem_type": filesystem_type,
                }
            )
        _assert_root_still_named(root, root_device, root_inode)
    finally:
        os.close(root_fd)
    main_objects = [item for item in objects if item["role"] == "postgresql-main"]
    if require_main:
        _require(
            len(main_objects) == 1,
            f"expected exactly one live PostgreSQL main shared object, found {len(main_objects)}",
        )
        _require(
            main_objects[0]["size_bytes"] > 0,
            "PostgreSQL main shared object has zero length",
        )
    receipt = {
        "schema": OBJECTS_SCHEMA,
        "provider": expected_provider,
        "provider_evidence_sha256": expected_evidence_sha256,
        "root": str(root),
        "root_device": root_device,
        "root_inode": root_inode,
        "captured_at_unix_ns": time.time_ns(),
        "captured_at_monotonic_ns": time.monotonic_ns(),
        "cgroup_identity": cgroup_identity,
        "require_main": require_main,
        "main_object_count": len(main_objects),
        "object_count": len(objects),
        "objects": objects,
        "status": "passed",
    }
    _atomic_write_json(output_path, receipt)


def assert_empty(
    evidence_path: Path,
    expected_evidence_sha256: str,
    expected_provider: str,
    expected_root: Path,
    output_path: Path,
    *,
    release_kind: str,
    lifecycle_evidence_path: Path | None = None,
    lifecycle_evidence_sha256: str | None = None,
) -> None:
    _require(release_kind in RELEASE_KINDS, f"unknown release kind: {release_kind}")
    lifecycle_binding: dict[str, Any] | None = None
    if release_kind == CLEAN_RELEASE:
        _require(
            lifecycle_evidence_path is not None
            and lifecycle_evidence_sha256 is not None,
            "clean release requires server lifecycle evidence and SHA-256",
        )
        assert lifecycle_evidence_path is not None
        assert lifecycle_evidence_sha256 is not None
        lifecycle = _verified_lifecycle_evidence(
            lifecycle_evidence_path, lifecycle_evidence_sha256
        )
        lifecycle_binding = {
            "path": str(lifecycle_evidence_path),
            "sha256": lifecycle_evidence_sha256,
            "pid": lifecycle["pid"],
            "pgid": lifecycle["pgid"],
            "birth_identity": lifecycle["birth_identity"],
            "status": lifecycle["status"],
        }
        release_status = "empty-after-clean-postgresql-shutdown"
    else:
        _require(
            lifecycle_evidence_path is None and lifecycle_evidence_sha256 is None,
            "process-drain release rejects lifecycle evidence",
        )
        release_status = "empty-after-owned-process-drain"

    provider_receipt, _, root = _verified_receipt(
        evidence_path, expected_evidence_sha256, expected_provider, expected_root
    )
    root_device, root_inode = _receipt_root_identity(provider_receipt)
    output_destination = _evidence_destination(output_path)
    _require_destination_outside_root(
        output_destination, root, "release evidence"
    )
    root_fd = _open_receipt_root(root, root_device, root_inode)
    try:
        entries = sorted(os.listdir(root_fd))
        _assert_root_still_named(root, root_device, root_inode)
    finally:
        os.close(root_fd)
    _require(not entries, f"shared-memory objects survived shutdown: {', '.join(entries)}")
    if os.path.lexists(output_path):
        # A cleanup attempt may fail after this immutable receipt was written.
        # Retrying must re-prove current emptiness without overwriting evidence.
        release, _ = _read_receipt(output_path)
        expected_fields = {
            "schema": RELEASE_SCHEMA,
            "provider": expected_provider,
            "provider_evidence_sha256": expected_evidence_sha256,
            "root": str(root),
            "root_device": root_device,
            "root_inode": root_inode,
            "release_kind": release_kind,
            "lifecycle_evidence": lifecycle_binding,
            "object_count": 0,
            "status": release_status,
        }
        for field, expected in expected_fields.items():
            _require(release.get(field) == expected, f"release evidence {field} differs")
        _require(
            _require_recorded_integer(
                release.get("observed_at_unix_ns"), "release wall-clock timestamp"
            )
            > 0,
            "release wall-clock timestamp is zero",
        )
        _require(
            _require_recorded_integer(
                release.get("observed_at_monotonic_ns"),
                "release monotonic timestamp",
            )
            > 0,
            "release monotonic timestamp is zero",
        )
        return
    _atomic_write_json(
        output_path,
        {
            "schema": RELEASE_SCHEMA,
            "provider": expected_provider,
            "provider_evidence_sha256": expected_evidence_sha256,
            "root": str(root),
            "root_device": root_device,
            "root_inode": root_inode,
            "release_kind": release_kind,
            "lifecycle_evidence": lifecycle_binding,
            "observed_at_unix_ns": time.time_ns(),
            "observed_at_monotonic_ns": time.monotonic_ns(),
            "object_count": 0,
            "status": release_status,
        },
    )


def _open_directory(path: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    return os.open(path, flags)


def _remove_exact_root(
    root: Path,
    expected_device: int,
    expected_inode: int,
    expected_parent_device: int,
    expected_parent_inode: int,
) -> None:
    parent_fd = _open_directory(root.parent)
    try:
        parent_opened = os.fstat(parent_fd)
        parent_now = os.lstat(root.parent)
        _require(
            (parent_opened.st_dev, parent_opened.st_ino)
            == (parent_now.st_dev, parent_now.st_ino),
            "cleanup parent changed while opening",
        )
        _require(
            (parent_opened.st_dev, parent_opened.st_ino)
            == (expected_parent_device, expected_parent_inode),
            "cleanup parent device/inode differs from receipt",
        )
        root_before = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
        _require(stat.S_ISDIR(root_before.st_mode), "cleanup root is not a directory")
        _require(
            (root_before.st_dev, root_before.st_ino) == (expected_device, expected_inode),
            "cleanup root device/inode differs",
        )
        root_fd = os.open(
            root.name,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        try:
            opened = os.fstat(root_fd)
            _require(
                (opened.st_dev, opened.st_ino) == (expected_device, expected_inode),
                "cleanup root changed while opening",
            )
            entries = sorted(os.listdir(root_fd))
            _require(
                not entries,
                "cleanup refuses nonempty provider root: " + ", ".join(entries),
            )
            root_named = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
            _require(
                stat.S_ISDIR(root_named.st_mode)
                and (root_named.st_dev, root_named.st_ino)
                == (expected_device, expected_inode),
                "cleanup root was replaced before removal",
            )
        finally:
            os.close(root_fd)
        os.rmdir(root.name, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)


def _termination_signals() -> tuple[int, ...]:
    return tuple(
        candidate
        for name in ("SIGHUP", "SIGINT", "SIGTERM")
        if (candidate := getattr(signal, name, None)) is not None
    )


def prepare(
    provider: str,
    evidence_path: Path,
    *,
    measurement_id: str,
    target: str,
    portable_root: Path | None = None,
    linux_tmpfs_parent: Path = Path("/dev/shm"),
) -> Path:
    _require(provider in PROVIDERS, f"unknown provider: {provider}")
    _reject_control_characters(measurement_id, "measurement ID")
    _require(bool(measurement_id), "measurement ID is empty")
    _require(target == "wasix", "shared-memory provider target must be wasix")
    created: Path | None = None
    created_identity: tuple[int, int] | None = None
    created_parent_identity: tuple[int, int] | None = None
    evidence_destination: Path | None = None
    receipt_payload: bytes | None = None
    committed = False
    try:
        if provider == PORTABLE_FILE_PROVIDER:
            _require(
                portable_root is not None,
                "portable-file-v1 requires --portable-root",
            )
            assert portable_root is not None
            _reject_control_characters(str(portable_root), "portable provider root")
            _require(
                portable_root.is_absolute(),
                "portable provider root must be absolute",
            )
            parent = _canonical_existing_directory(
                portable_root.parent, "portable provider parent"
            )
            _require(
                portable_root.name not in ("", ".", ".."),
                "portable root basename is unsafe",
            )
            _require(
                portable_root.name == "dev-shm",
                "portable-file-v1 requires the historical dev-shm basename",
            )
            root = parent / portable_root.name
            parent_observed = os.lstat(parent)
            created_parent_identity = (
                parent_observed.st_dev,
                parent_observed.st_ino,
            )
            _require(
                not os.path.lexists(root),
                f"portable provider root already exists: {root}",
            )
            # Block catchable termination while mkdir and ownership
            # registration become one logical operation.  Crucially, do not
            # mark the path as ours before mkdir succeeds: a concurrent
            # creator that wins the exact name must never enter our rollback.
            watched = _termination_signals()
            previous_mask = None
            if hasattr(signal, "pthread_sigmask"):
                previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, watched)
            try:
                os.mkdir(root, 0o700)
                created = root
                created_observed = os.lstat(root)
                _require(
                    stat.S_ISDIR(created_observed.st_mode)
                    and not stat.S_ISLNK(created_observed.st_mode),
                    "new portable provider root changed during allocation",
                )
                created_identity = (
                    created_observed.st_dev,
                    created_observed.st_ino,
                )
            finally:
                if previous_mask is not None:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            assert created_identity is not None
            _chmod_exact_root(root, *created_identity, 0o700)
            allocation = "caller-exact"
            expected_filesystem = "any"
        else:
            _require(platform.system() == "Linux", "linux-tmpfs-v1 requires Linux")
            _require(portable_root is None, "linux-tmpfs-v1 rejects --portable-root")
            parent = _canonical_existing_directory(
                linux_tmpfs_parent, "Linux tmpfs parent"
            )
            parent_observed = os.lstat(parent)
            created_parent_identity = (
                parent_observed.st_dev,
                parent_observed.st_ino,
            )
            parent_filesystem = _filesystem_evidence(
                parent, require_linux_mount=True
            )
            _require(
                parent_filesystem["filesystem_type"] == "tmpfs",
                f"linux-tmpfs-v1 parent is not tmpfs: {parent}",
            )
            _require(
                hasattr(signal, "pthread_sigmask"),
                "linux-tmpfs-v1 requires pthread_sigmask for exact rollback",
            )
            watched = _termination_signals()
            previous_mask = None
            if hasattr(signal, "pthread_sigmask"):
                previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, watched)
            try:
                root = Path(
                    tempfile.mkdtemp(
                        prefix=f"{TMPFS_PREFIX}.{os.geteuid()}.", dir=parent
                    )
                )
                created = root
                created_observed = os.lstat(root)
                _require(
                    stat.S_ISDIR(created_observed.st_mode)
                    and not stat.S_ISLNK(created_observed.st_mode),
                    "new tmpfs provider root changed during allocation",
                )
                created_identity = (
                    created_observed.st_dev,
                    created_observed.st_ino,
                )
            finally:
                if previous_mask is not None:
                    signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            assert created_identity is not None
            _chmod_exact_root(root, *created_identity, 0o700)
            allocation = "private-mkdtemp"
            expected_filesystem = "tmpfs"

        evidence_destination = _new_evidence_destination(evidence_path)
        _require_destination_outside_root(
            evidence_destination, root, "provider evidence"
        )
        _validate_created_root(root)
        _require(not os.listdir(root), "new provider root is not empty")
        assert created_identity is not None
        _assert_root_still_named(root, *created_identity)
        filesystem = _filesystem_evidence(
            root, require_linux_mount=provider == LINUX_TMPFS_PROVIDER
        )
        _assert_root_still_named(root, *created_identity)
        if provider == LINUX_TMPFS_PROVIDER:
            _require(filesystem["filesystem_type"] == "tmpfs", "created root is not on tmpfs")
        directory = _directory_evidence(root)
        _require(
            (directory["device"], directory["inode"]) == created_identity,
            "provider root changed before evidence emission",
        )
        parent_directory = _parent_evidence(parent)
        assert created_parent_identity is not None
        _require(
            (parent_directory["device"], parent_directory["inode"])
            == created_parent_identity,
            "provider parent changed before evidence emission",
        )
        receipt: dict[str, Any] = {
            "schema": PROVIDER_SCHEMA,
            "provider": provider,
            "prepared_at_unix_ns": time.time_ns(),
            "contract": {
                "guest_mountpoint": "/dev/shm",
                "allocation": allocation,
                "expected_filesystem": expected_filesystem,
                "cleanup_policy": CLEANUP_POLICY,
            },
            "host": {
                "platform": platform.system(),
                "effective_uid": os.geteuid(),
                "effective_gid": os.getegid(),
            },
            "context": {"measurement_id": measurement_id, "target": target},
            "helper": {
                "path": str(Path(__file__).resolve()),
                "sha256": hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest(),
            },
            "initial_state": {"entry_count": 0, "status": "empty"},
            "directory": directory,
            "parent": parent_directory,
            "filesystem": filesystem,
        }
        receipt_payload = _json_payload(receipt)
        watched = _termination_signals()
        previous_mask = None
        if hasattr(signal, "pthread_sigmask"):
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, watched)
        try:
            _atomic_write_json(evidence_path, receipt)
            # The durable public receipt is the allocation commit point. Set
            # this before restoring catchable signals so a pending signal can
            # never make rollback invalidate the receipt it just admitted.
            committed = True
        finally:
            if previous_mask is not None:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        _, receipt_payload = _read_receipt(evidence_path)
        verify(
            evidence_path,
            hashlib.sha256(receipt_payload).hexdigest(),
            provider,
            root,
        )
        _assert_root_still_named(root, *created_identity)
        return root
    except BaseException as error:
        if (
            not committed
            and evidence_destination is not None
            and receipt_payload is not None
        ):
            # On platforms without pthread_sigmask, a signal can be raised by
            # the caller immediately after durable publication but before the
            # assignment above. Recover that committed state from the sealed,
            # exact public payload instead of orphaning the receipt.
            try:
                evidence_metadata = os.lstat(evidence_destination)
                committed = (
                    stat.S_ISREG(evidence_metadata.st_mode)
                    and stat.S_IMODE(evidence_metadata.st_mode) == 0o444
                    and _read_regular_payload(
                        evidence_destination, "provider evidence"
                    )
                    == receipt_payload
                )
            except (OSError, ProviderError):
                committed = False
        if not committed and created is not None and os.path.lexists(created):
            try:
                if created_identity is not None and created_parent_identity is not None:
                    _remove_exact_root(
                        created,
                        *created_identity,
                        *created_parent_identity,
                    )
            except BaseException as rollback_error:
                if hasattr(error, "add_note"):
                    error.add_note(f"provider-root rollback also failed: {rollback_error}")
        raise


def prepare_with_signal_rollback(*args: Any, **kwargs: Any) -> Path:
    watched = _termination_signals()
    previous: dict[int, Any] = {}

    def interrupt(signum: int, _frame: Any) -> None:
        raise ProviderSignal(signum)

    for signum in watched:
        previous[signum] = signal.signal(signum, interrupt)
    try:
        return prepare(*args, **kwargs)
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def cleanup(
    evidence_path: Path,
    expected_evidence_sha256: str,
    expected_provider: str,
    expected_root: Path,
    cleanup_evidence_path: Path,
    reason: str,
) -> None:
    _reject_control_characters(reason, "cleanup reason")
    _require(bool(reason), "cleanup reason is empty")
    receipt, _, root = _verified_receipt(
        evidence_path,
        expected_evidence_sha256,
        expected_provider,
        expected_root,
    )
    cleanup_destination = _new_evidence_destination(cleanup_evidence_path)
    _require_destination_outside_root(
        cleanup_destination, root, "cleanup evidence"
    )
    device, inode = _receipt_root_identity(receipt)
    parent_device, parent_inode = _receipt_parent_identity(receipt)
    _remove_exact_root(
        root,
        device,
        inode,
        parent_device,
        parent_inode,
    )
    _require(not os.path.lexists(root), "provider root still exists after cleanup")
    cleanup_receipt = {
        "schema": CLEANUP_SCHEMA,
        "provider": expected_provider,
        "provider_evidence_sha256": expected_evidence_sha256,
        "cleanup_policy": CLEANUP_POLICY,
        "reason": reason,
        "root": str(root),
        "device": device,
        "inode": inode,
        "result": "removed",
        "removed_at_unix_ns": time.time_ns(),
    }
    _atomic_write_json(cleanup_evidence_path, cleanup_receipt)


def identify(evidence_path: Path) -> tuple[str, Path, str]:
    receipt, payload = _read_receipt(evidence_path)
    _require(
        receipt.get("schema") in IDENTIFIABLE_PROVIDER_SCHEMAS,
        "provider evidence schema differs",
    )
    selected = receipt.get("provider")
    _require(selected in PROVIDERS, "provider evidence ID differs")
    directory = receipt.get("directory")
    _require(isinstance(directory, dict), "provider evidence directory is not an object")
    assert isinstance(directory, dict)
    root = directory.get("path")
    _require(isinstance(root, str), "provider evidence root path is invalid")
    _reject_control_characters(root, "provider evidence root path")
    root_path = Path(root)
    _require(root_path.is_absolute(), "provider evidence root is not absolute")
    return selected, root_path, hashlib.sha256(payload).hexdigest()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--provider", required=True, choices=PROVIDERS)
    prepare_parser.add_argument("--evidence", required=True, type=Path)
    prepare_parser.add_argument("--measurement-id", required=True)
    prepare_parser.add_argument("--target", required=True, choices=("wasix",))
    prepare_parser.add_argument("--portable-root", type=Path)
    prepare_parser.add_argument(
        "--linux-tmpfs-parent", type=Path, default=Path("/dev/shm")
    )
    prepare_parser.add_argument(
        "--output-format", choices=("path", "path-sha256-tsv"), default="path"
    )

    identify_parser = subparsers.add_parser("identify")
    identify_parser.add_argument("--evidence", required=True, type=Path)

    for command in ("verify", "capture-objects", "assert-empty", "cleanup"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("--provider", required=True, choices=PROVIDERS)
        command_parser.add_argument("--root", required=True, type=Path)
        command_parser.add_argument("--evidence", required=True, type=Path)
        command_parser.add_argument("--evidence-sha256", required=True)
        if command == "capture-objects":
            command_parser.add_argument("--output", required=True, type=Path)
            command_parser.add_argument(
                "--require-main", required=True, choices=("yes", "no")
            )
            command_parser.add_argument("--cgroup-identity", default="none")
        if command == "assert-empty":
            command_parser.add_argument("--output", required=True, type=Path)
            command_parser.add_argument(
                "--release-kind", required=True, choices=RELEASE_KINDS
            )
            command_parser.add_argument("--lifecycle-evidence", type=Path)
            command_parser.add_argument("--lifecycle-evidence-sha256")
        if command == "cleanup":
            command_parser.add_argument("--cleanup-evidence", required=True, type=Path)
            command_parser.add_argument("--reason", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    options = _parser().parse_args(argv)
    try:
        if options.command == "prepare":
            root = prepare_with_signal_rollback(
                options.provider,
                options.evidence,
                measurement_id=options.measurement_id,
                target=options.target,
                portable_root=options.portable_root,
                linux_tmpfs_parent=options.linux_tmpfs_parent,
            )
            if options.output_format == "path-sha256-tsv":
                _, payload = _read_receipt(options.evidence)
                print(root, hashlib.sha256(payload).hexdigest(), sep="\t")
            else:
                print(root)
        elif options.command == "identify":
            selected, root, evidence_sha256 = identify(options.evidence)
            print(selected, root, evidence_sha256, sep="\t")
        elif options.command == "verify":
            verify(
                options.evidence,
                options.evidence_sha256,
                options.provider,
                options.root,
            )
        elif options.command == "capture-objects":
            capture_objects(
                options.evidence,
                options.evidence_sha256,
                options.provider,
                options.root,
                options.output,
                require_main=options.require_main == "yes",
                cgroup_identity=options.cgroup_identity,
            )
        elif options.command == "assert-empty":
            assert_empty(
                options.evidence,
                options.evidence_sha256,
                options.provider,
                options.root,
                options.output,
                release_kind=options.release_kind,
                lifecycle_evidence_path=options.lifecycle_evidence,
                lifecycle_evidence_sha256=options.lifecycle_evidence_sha256,
            )
        else:
            cleanup(
                options.evidence,
                options.evidence_sha256,
                options.provider,
                options.root,
                options.cleanup_evidence,
                options.reason,
            )
    except ProviderSignal as error:
        print(f"shared-memory provider: {error}", file=sys.stderr)
        return 128 + error.signum
    except (ProviderError, OSError) as error:
        print(f"shared-memory provider: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
