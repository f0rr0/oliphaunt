#!/usr/bin/env python3

"""Deploy and attest an immutable sealed-carrier closure on ext filesystems."""

from __future__ import annotations

import argparse
import array
import ctypes
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable


SCHEMA = "oliphaunt.wasix-postmaster.immutable-carrier-deployment.v2"
POLICY = "linux-ext-fs-immutable-sealed-closure-v2"
PAYLOAD_SCHEMA = "oliphaunt.wasix-postmaster.payload-files.v1"
MANIFEST_SCHEMA = "oliphaunt.wasix-postmaster.sealed-aot.v5"
EXT_SUPER_MAGIC = 0xEF53
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602
FS_IMMUTABLE_FL = 0x00000010
CAP_LINUX_IMMUTABLE = 9
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
AOT_RE = re.compile(r"aot/[0-9A-F]{64}\.bin\Z")
MEMORY_RE = re.compile(r"memory/[0-9A-F]{64}\.bin\Z")
SIDE_MODULE_POLICY_PATH = (
    Path(__file__).resolve().parent.parent
    / "runtime"
    / "policies"
    / "sealed-side-modules.v1.tsv"
)


class DeploymentError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise DeploymentError(message)


def expected_aot_count() -> int:
    rows = [
        line
        for line in SIDE_MODULE_POLICY_PATH.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
    ]
    require(bool(rows), "sealed side-module policy is empty")
    require(
        all(len(line.split("\t")) == 3 for line in rows),
        "sealed side-module policy contains a malformed row",
    )
    return 2 + len(rows)


EXPECTED_AOT_COUNT = expected_aot_count()


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        + "\n"
    ).encode("ascii")


def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON field: {key}")
        result[key] = value
    return result


def decode_json(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DeploymentError(f"{label} is not UTF-8: {error}") from error
    require("\r" not in text, f"{label} contains a carriage return")
    try:
        return json.loads(text, object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, DeploymentError) as error:
        raise DeploymentError(f"invalid {label}: {error}") from error


def checked_relative(value: Any, label: str) -> str:
    require(isinstance(value, str) and value, f"{label} must be a nonempty string")
    require(
        not any(character in value for character in ("\0", "\n", "\r", "\t", "\\")),
        f"{label} contains a control character or backslash",
    )
    path = PurePosixPath(value)
    require(not path.is_absolute(), f"{label} must be relative: {value!r}")
    require(
        all(part not in ("", ".", "..") for part in path.parts),
        f"unsafe {label}: {value!r}",
    )
    require(str(path) == value, f"non-canonical {label}: {value!r}")
    return value


def sha256_fd(descriptor: int) -> str:
    digest = hashlib.sha256()
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest()


def read_fd(descriptor: int) -> bytes:
    chunks: list[bytes] = []
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return b"".join(chunks)


def open_beneath(root_fd: int, relative: str) -> int:
    checked_relative(relative, "carrier path")
    parts = PurePosixPath(relative).parts
    directory_fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            next_fd = os.open(
                part,
                os.O_RDONLY
                | os.O_DIRECTORY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=directory_fd,
            )
            os.close(directory_fd)
            directory_fd = next_fd
        descriptor = os.open(
            parts[-1],
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_fd,
        )
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode), f"carrier path is not regular: {relative}")
        return descriptor
    finally:
        os.close(directory_fd)


def open_beneath_entry(root_fd: int, relative: str, entry_type: str) -> int:
    require(entry_type in {"file", "directory"}, "invalid carrier entry type")
    if relative == ".":
        require(entry_type == "directory", "carrier root receipt entry is not a directory")
        return os.dup(root_fd)
    checked_relative(relative, "carrier receipt path")
    parts = PurePosixPath(relative).parts
    directory_fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            next_fd = os.open(
                part,
                os.O_RDONLY
                | os.O_DIRECTORY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=directory_fd,
            )
            os.close(directory_fd)
            directory_fd = next_fd
        flags = (
            os.O_RDONLY
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        if entry_type == "directory":
            flags |= os.O_DIRECTORY
        descriptor = os.open(parts[-1], flags, dir_fd=directory_fd)
        info = os.fstat(descriptor)
        expected = stat.S_ISREG(info.st_mode) if entry_type == "file" else stat.S_ISDIR(info.st_mode)
        require(expected, f"carrier receipt entry type changed: {relative}")
        return descriptor
    finally:
        os.close(directory_fd)


class StatFs(ctypes.Structure):
    _fields_ = [
        ("f_type", ctypes.c_long),
        ("f_bsize", ctypes.c_long),
        ("f_blocks", ctypes.c_ulong),
        ("f_bfree", ctypes.c_ulong),
        ("f_bavail", ctypes.c_ulong),
        ("f_files", ctypes.c_ulong),
        ("f_ffree", ctypes.c_ulong),
        ("f_fsid", ctypes.c_int * 2),
        ("f_namelen", ctypes.c_long),
        ("f_frsize", ctypes.c_long),
        ("f_flags", ctypes.c_long),
        ("f_spare", ctypes.c_long * 4),
    ]


class KernelOps:
    def __init__(self) -> None:
        self._libc = ctypes.CDLL(None, use_errno=True)

    def filesystem_magic(self, descriptor: int) -> int:
        result = StatFs()
        if self._libc.fstatfs(descriptor, ctypes.byref(result)) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return int(result.f_type) & 0xFFFFFFFFFFFFFFFF

    def get_flags(self, descriptor: int) -> int:
        value = array.array("I", [0])
        fcntl.ioctl(descriptor, FS_IOC_GETFLAGS, value, True)
        return int(value[0])

    def set_flags(self, descriptor: int, flags: int) -> None:
        value = array.array("I", [flags])
        fcntl.ioctl(descriptor, FS_IOC_SETFLAGS, value, True)


@dataclass
class OpenCarrierEntry:
    path: str
    entry_type: str
    direct_loader_kind: str
    descriptor: int
    expected_sha256: str | None
    info: os.stat_result
    actual_sha256: str | None
    pre_flags: int
    post_flags: int

    def close(self) -> None:
        os.close(self.descriptor)


def require_linux() -> None:
    require(sys.platform.startswith("linux"), "immutable deployment requires Linux")


def effective_capabilities() -> int:
    try:
        lines = Path("/proc/self/status").read_text(encoding="ascii").splitlines()
    except OSError as error:
        raise DeploymentError(f"cannot read effective Linux capabilities: {error}") from error
    for line in lines:
        if line.startswith("CapEff:\t"):
            try:
                return int(line.split("\t", 1)[1], 16)
            except ValueError as error:
                raise DeploymentError("malformed CapEff in /proc/self/status") from error
    raise DeploymentError("/proc/self/status does not expose CapEff")


def require_root_immutable_capability() -> None:
    require(os.geteuid() == 0, "immutable deployment/removal requires effective UID 0")
    capabilities = effective_capabilities()
    require(
        capabilities & (1 << CAP_LINUX_IMMUTABLE) != 0,
        "immutable deployment/removal requires effective CAP_LINUX_IMMUTABLE",
    )


def parse_expected_hash(value: str, label: str) -> str:
    require(SHA256_RE.fullmatch(value) is not None, f"{label} must be a SHA-256")
    return value


def carrier_closure_identity(identity_hashes: dict[str, str]) -> str:
    digest = hashlib.sha256()
    for value in (
        "oliphaunt.wasix-postmaster.qualification-carrier.v1",
        identity_hashes["manifest.json"],
        identity_hashes["wasmer-build.receipt"],
        identity_hashes["payload.files"],
        identity_hashes["bin/wasmer-headless"],
    ):
        digest.update(value.encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def direct_loader_paths(manifest: dict[str, Any]) -> list[tuple[str, str, str]]:
    artifacts = manifest.get("artifacts")
    require(
        isinstance(artifacts, list) and len(artifacts) == EXPECTED_AOT_COUNT,
        f"manifest must contain exactly {EXPECTED_AOT_COUNT} artifacts",
    )
    selected: list[tuple[str, str, str]] = []
    for index, artifact in enumerate(artifacts):
        require(isinstance(artifact, dict), f"manifest artifact {index} is not an object")
        path = checked_relative(artifact.get("path"), f"manifest artifact {index} path")
        digest = parse_expected_hash(artifact.get("sha256"), f"manifest artifact {index} SHA-256")
        require(AOT_RE.fullmatch(path) is not None, f"non-canonical AOT path: {path}")
        selected.append((path, "aot", digest))
    selected.sort()
    paths = [item[0] for item in selected]
    require(len(paths) == len(set(paths)), "manifest direct-loader paths are not unique")
    require(
        sum(kind == "aot" for _, kind, _ in selected) == EXPECTED_AOT_COUNT,
        "immutable policy requires the complete AOT closure",
    )
    return selected


def manifest_provenance(manifest_data: bytes) -> tuple[str, str]:
    manifest = decode_json(manifest_data, "sealed carrier manifest")
    require(isinstance(manifest, dict), "sealed carrier manifest must be an object")
    require(
        manifest.get("format-version") == 6
        and manifest.get("schema") == MANIFEST_SCHEMA,
        "sealed carrier manifest provenance schema differs",
    )
    core_profile = manifest.get("core-profile")
    require(
        core_profile in {"release-o3", "safe-o2"},
        "sealed carrier core profile is not candidate/control",
    )
    guest_recipe = manifest.get("guest-build-recipe-sha256")
    parse_expected_hash(guest_recipe, "sealed carrier guest build recipe")
    return core_profile, guest_recipe


def open_carrier_root(carrier: Path) -> tuple[Path, int, os.stat_result]:
    require_linux()
    require(carrier.is_absolute(), "carrier path must be absolute")
    before = os.lstat(carrier)
    require(stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode), "carrier root must be a non-symlink directory")
    descriptor = os.open(
        carrier,
        os.O_RDONLY
        | os.O_DIRECTORY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    opened = os.fstat(descriptor)
    require(
        (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino),
        "carrier root changed while opening",
    )
    canonical = Path(os.path.realpath(carrier))
    require(canonical == carrier, "carrier path must already be canonical")
    return canonical, descriptor, opened


def identity_files(root_fd: int) -> tuple[dict[str, str], dict[str, bytes]]:
    hashes: dict[str, str] = {}
    contents: dict[str, bytes] = {}
    for relative in (
        "manifest.json",
        "wasmer-build.receipt",
        "payload.files",
        "bin/wasmer-headless",
    ):
        descriptor = open_beneath(root_fd, relative)
        try:
            data = read_fd(descriptor)
            hashes[relative] = hashlib.sha256(data).hexdigest()
            contents[relative] = data
        finally:
            os.close(descriptor)
    return hashes, contents


def require_expected_identity(hashes: dict[str, str], expected: dict[str, str]) -> None:
    for key, digest in expected.items():
        parse_expected_hash(digest, f"expected {key} identity")
        require(hashes[key] == digest, f"carrier identity changed for {key}")


def parse_inventory(data: bytes) -> dict[str, tuple[int, str]]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DeploymentError(f"payload inventory is not UTF-8: {error}") from error
    require("\r" not in text and text.endswith("\n"), "payload inventory is not canonical text")
    lines = text.splitlines()
    require(lines and lines[0] == f"schema={PAYLOAD_SCHEMA}", "payload inventory schema differs")
    inventory: dict[str, tuple[int, str]] = {}
    previous = ""
    for line_number, line in enumerate(lines[1:], 2):
        fields = line.split("\t")
        require(len(fields) == 3, f"payload inventory line {line_number} must have three fields")
        digest, size_text, relative_value = fields
        parse_expected_hash(digest, f"payload inventory line {line_number} SHA-256")
        require(
            re.fullmatch(r"0|[1-9][0-9]*", size_text) is not None,
            f"payload inventory line {line_number} has a non-canonical size",
        )
        relative = checked_relative(relative_value, f"payload inventory line {line_number} path")
        require(relative != "payload.files", "payload inventory must not inventory itself")
        require(relative > previous, "payload inventory paths must be unique and strictly sorted")
        previous = relative
        inventory[relative] = (int(size_text), digest)
    require(inventory, "payload inventory is empty")
    return inventory


def entry_order_key(item: OpenCarrierEntry) -> tuple[int, int, str]:
    if item.entry_type == "file":
        return (0, 0, item.path)
    if item.path == ".":
        return (2, 0, item.path)
    return (1, -len(PurePosixPath(item.path).parts), item.path)


def transition_order(entries: Iterable[OpenCarrierEntry]) -> list[OpenCarrierEntry]:
    # Files first; then deepest directories; carrier root last. This keeps the
    # namespace traversable until every leaf has been protected.
    return sorted(entries, key=entry_order_key)


def open_exact_carrier_closure(
    root_fd: int,
    manifest_data: bytes,
    payload_data: bytes,
    ops: KernelOps,
) -> list[OpenCarrierEntry]:
    manifest = decode_json(manifest_data, "carrier manifest")
    require(isinstance(manifest, dict), "carrier manifest must be an object")
    direct = {
        path: (kind, digest)
        for path, kind, digest in direct_loader_paths(manifest)
    }
    inventory = parse_inventory(payload_data)
    expected_files = set(inventory) | {"payload.files"}
    opened: list[OpenCarrierEntry] = []

    def capture(
        descriptor: int,
        relative: str,
        entry_type: str,
        info: os.stat_result,
    ) -> None:
        mode = stat.S_IMODE(info.st_mode)
        if entry_type == "file":
            require(mode in (0o444, 0o555), f"sealed carrier file mode differs: {relative}")
        else:
            require(mode == 0o555, f"sealed carrier directory mode differs: {relative}")
        magic = ops.filesystem_magic(descriptor)
        require(
            magic == EXT_SUPER_MAGIC,
            f"sealed carrier entry is not on an ext-family filesystem: {relative}: 0x{magic:x}",
        )
        actual_digest = sha256_fd(descriptor) if entry_type == "file" else None
        expected_digest: str | None = None
        direct_kind = "none"
        if entry_type == "file":
            require(relative in expected_files, f"carrier contains an unlisted file: {relative}")
            if relative == "payload.files":
                expected_digest = hashlib.sha256(payload_data).hexdigest()
                require(actual_digest == expected_digest, "payload inventory changed during closure scan")
            else:
                expected_size, expected_digest = inventory[relative]
                require(info.st_size == expected_size, f"payload size mismatch: {relative}")
                require(actual_digest == expected_digest, f"payload SHA-256 mismatch: {relative}")
            if relative in direct:
                direct_kind, direct_digest = direct[relative]
                require(actual_digest == direct_digest, f"direct-loader SHA-256 mismatch: {relative}")
        pre_flags = ops.get_flags(descriptor)
        opened.append(
            OpenCarrierEntry(
                path=relative,
                entry_type=entry_type,
                direct_loader_kind=direct_kind,
                descriptor=descriptor,
                expected_sha256=expected_digest,
                info=info,
                actual_sha256=actual_digest,
                pre_flags=pre_flags,
                post_flags=pre_flags | FS_IMMUTABLE_FL,
            )
        )

    def walk(directory_fd: int, prefix: str) -> None:
        try:
            names = sorted(os.listdir(directory_fd))
        except OSError as error:
            raise DeploymentError(f"cannot enumerate sealed carrier directory {prefix or '.'}: {error}") from error
        for name in names:
            require(name not in ("", ".", "..") and "/" not in name, "unsafe carrier directory entry")
            relative = f"{prefix}/{name}" if prefix else name
            checked_relative(relative, "carrier closure path")
            before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                descriptor = os.open(
                    name,
                    os.O_RDONLY
                    | os.O_DIRECTORY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=directory_fd,
                )
                after = os.fstat(descriptor)
                require(
                    (before.st_dev, before.st_ino) == (after.st_dev, after.st_ino),
                    f"carrier directory changed while opening: {relative}",
                )
                capture(descriptor, relative, "directory", after)
                walk(descriptor, relative)
            elif stat.S_ISREG(before.st_mode):
                descriptor = os.open(
                    name,
                    os.O_RDONLY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=directory_fd,
                )
                after = os.fstat(descriptor)
                require(
                    (before.st_dev, before.st_ino) == (after.st_dev, after.st_ino),
                    f"carrier file changed while opening: {relative}",
                )
                capture(descriptor, relative, "file", after)
            else:
                raise DeploymentError(f"carrier contains a symlink or special entry: {relative}")

    try:
        root_descriptor = os.dup(root_fd)
        root_info = os.fstat(root_descriptor)
        capture(root_descriptor, ".", "directory", root_info)
        walk(root_fd, "")
        actual_files = {entry.path for entry in opened if entry.entry_type == "file"}
        require(actual_files == expected_files, "carrier file closure differs from payload inventory")
        actual_direct = {
            entry.path
            for entry in opened
            if entry.direct_loader_kind != "none"
        }
        require(actual_direct == set(direct), "carrier direct-loader subset differs from manifest")
    except BaseException:
        for item in opened:
            item.close()
        raise
    return opened


def receipt_path_checks(receipt: Path, carrier: Path) -> tuple[Path, str]:
    require(receipt.is_absolute(), "receipt path must be absolute")
    parent = Path(os.path.realpath(receipt.parent))
    require(parent == receipt.parent, "receipt parent must already be canonical")
    info = os.lstat(parent)
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), "receipt parent must be a non-symlink directory")
    require(receipt.parent != carrier and carrier not in receipt.parents, "receipt must be outside the sealed carrier")
    require(receipt.name not in ("", ".", "..") and "/" not in receipt.name, "invalid receipt filename")
    return parent, receipt.name


def write_atomic_new(
    path: Path,
    data: bytes,
    ops: KernelOps,
    *,
    expected_owner_uid: int = 0,
) -> tuple[int, int, str]:
    parent, name = receipt_path_checks(path, Path("/nonexistent-carrier-placeholder"))
    directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0))
    temporary = f".{name}.pending.{os.getpid()}.{time.monotonic_ns()}"
    descriptor = -1
    published = False
    info: os.stat_result | None = None
    try:
        descriptor = os.open(
            temporary,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0),
            0o600,
            dir_fd=directory_fd,
        )
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            require(written > 0, "short write while creating immutable deployment receipt")
            view = view[written:]
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o444)
        info = os.fstat(descriptor)
        require(info.st_uid == expected_owner_uid, "deployment receipt is not owned by the required root identity")
        # linkat is the portable no-replace publication primitive available
        # through Python. The fully written inode becomes visible in one step,
        # and an existing receipt can never be overwritten.
        os.link(
            temporary,
            name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )
        published = True
        os.unlink(temporary, dir_fd=directory_fd)
        os.fsync(directory_fd)
        receipt_flags = ops.get_flags(descriptor)
        require(
            receipt_flags & FS_IMMUTABLE_FL == 0,
            "new deployment receipt unexpectedly begins immutable",
        )
        ops.set_flags(descriptor, receipt_flags | FS_IMMUTABLE_FL)
        require(
            ops.get_flags(descriptor) == receipt_flags | FS_IMMUTABLE_FL,
            "deployment receipt immutable flag did not stick",
        )
        os.fsync(descriptor)
        os.fsync(directory_fd)
        os.close(descriptor)
        descriptor = -1
        return info.st_dev, info.st_ino, hashlib.sha256(data).hexdigest()
    except BaseException:
        if published and info is not None and descriptor >= 0:
            try:
                current_flags = ops.get_flags(descriptor)
                if current_flags & FS_IMMUTABLE_FL:
                    ops.set_flags(descriptor, current_flags & ~FS_IMMUTABLE_FL)
                current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
                    os.unlink(name, dir_fd=directory_fd)
                    os.fsync(directory_fd)
            except OSError:
                pass
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_fd)
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(directory_fd)


def unlink_exact_receipt(
    path: Path,
    expected_dev: int,
    expected_ino: int,
    expected_sha: str,
    ops: KernelOps,
) -> None:
    parent, name = receipt_path_checks(path, Path("/nonexistent-carrier-placeholder"))
    directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0))
    descriptor = -1
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=directory_fd,
        )
        info = os.fstat(descriptor)
        require(
            stat.S_ISREG(info.st_mode)
            and (info.st_dev, info.st_ino) == (expected_dev, expected_ino),
            "deployment receipt identity changed before removal",
        )
        require(sha256_fd(descriptor) == expected_sha, "deployment receipt content changed before removal")
        current_flags = ops.get_flags(descriptor)
        if current_flags & FS_IMMUTABLE_FL:
            ops.set_flags(descriptor, current_flags & ~FS_IMMUTABLE_FL)
        require(
            ops.get_flags(descriptor) == current_flags & ~FS_IMMUTABLE_FL,
            "deployment receipt immutable flag could not be cleared",
        )
        current = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        require(
            (current.st_dev, current.st_ino) == (expected_dev, expected_ino),
            "deployment receipt path changed after clearing its immutable flag",
        )
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(directory_fd)


def make_receipt(
    carrier: Path,
    root_info: os.stat_result,
    identity_hashes: dict[str, str],
    manifest_data: bytes,
    entries: Iterable[OpenCarrierEntry],
) -> dict[str, Any]:
    ordered = sorted(entries, key=lambda item: (item.path != ".", item.path))
    core_profile, guest_build_recipe_sha256 = manifest_provenance(manifest_data)
    return {
        "carrier": {
            "closure-identity": carrier_closure_identity(identity_hashes),
            "device": root_info.st_dev,
            "headless-sha256": identity_hashes["bin/wasmer-headless"],
            "inode": root_info.st_ino,
            "manifest-sha256": identity_hashes["manifest.json"],
            "path": str(carrier),
            "payload-inventory-sha256": identity_hashes["payload.files"],
            "wasmer-build-receipt-sha256": identity_hashes["wasmer-build.receipt"],
        },
        "filesystem": {"magic": f"0x{EXT_SUPER_MAGIC:x}", "type": "ext-family"},
        "direct-loader-paths": [
            item.path
            for item in ordered
            if item.direct_loader_kind != "none"
        ],
        "core_profile": core_profile,
        "entries": [
            {
                "device": item.info.st_dev,
                "direct-loader-kind": item.direct_loader_kind,
                "entry-type": item.entry_type,
                "gid": item.info.st_gid,
                "inode": item.info.st_ino,
                "mode": f"{stat.S_IMODE(item.info.st_mode):04o}",
                "path": item.path,
                "post-flags": f"0x{item.post_flags:08x}",
                "pre-flags": f"0x{item.pre_flags:08x}",
                "sha256": item.actual_sha256,
                "size": item.info.st_size,
                "uid": item.info.st_uid,
            }
            for item in ordered
        ],
        "guest_build_recipe_sha256": guest_build_recipe_sha256,
        "policy": POLICY,
        "schema": SCHEMA,
    }


def close_all(entries: Iterable[OpenCarrierEntry]) -> None:
    for item in entries:
        item.close()


def transition_flags(
    entries: Iterable[OpenCarrierEntry],
    ops: KernelOps,
    target: Callable[[OpenCarrierEntry], int],
) -> None:
    errors: list[str] = []
    for item in entries:
        try:
            current = ops.get_flags(item.descriptor)
            desired = target(item)
            require(
                current in (item.pre_flags, item.post_flags),
                f"inode flags diverged from the deployment transition: {item.path}",
            )
            if current != desired:
                ops.set_flags(item.descriptor, desired)
            require(ops.get_flags(item.descriptor) == desired, f"flag restore did not stick: {item.path}")
        except (OSError, DeploymentError) as error:
            errors.append(f"{item.path}: {error}")
    require(not errors, "failed to restore inode flags: " + "; ".join(errors))


def deploy(
    carrier: Path,
    receipt_path: Path,
    expected_identity: dict[str, str],
    ops: KernelOps,
    *,
    check_capability: Callable[[], None] = require_root_immutable_capability,
    receipt_owner_uid: int = 0,
) -> dict[str, Any]:
    check_capability()
    receipt_path_checks(receipt_path, carrier)
    require(not os.path.lexists(receipt_path), f"deployment receipt already exists: {receipt_path}")
    canonical, root_fd, root_info = open_carrier_root(carrier)
    entries: list[OpenCarrierEntry] = []
    receipt_dev = receipt_ino = -1
    receipt_sha = ""
    receipt_written = False
    try:
        identity_hashes, identity_contents = identity_files(root_fd)
        require_expected_identity(identity_hashes, expected_identity)
        entries = open_exact_carrier_closure(
            root_fd,
            identity_contents["manifest.json"],
            identity_contents["payload.files"],
            ops,
        )
        receipt = make_receipt(
            canonical,
            root_info,
            identity_hashes,
            identity_contents["manifest.json"],
            entries,
        )
        receipt_data = canonical_json(receipt)
        receipt_dev, receipt_ino, receipt_sha = write_atomic_new(
            receipt_path,
            receipt_data,
            ops,
            expected_owner_uid=receipt_owner_uid,
        )
        receipt_written = True
        try:
            transition_flags(
                transition_order(entries),
                ops,
                lambda item: item.post_flags,
            )
            after_hashes, _ = identity_files(root_fd)
            require(after_hashes == identity_hashes, "carrier identity changed during immutable deployment")
        except BaseException:
            transition_flags(
                reversed(transition_order(entries)),
                ops,
                lambda item: item.pre_flags,
            )
            unlink_exact_receipt(
                receipt_path,
                receipt_dev,
                receipt_ino,
                receipt_sha,
                ops,
            )
            receipt_written = False
            raise
        return receipt
    finally:
        close_all(entries)
        os.close(root_fd)
        if receipt_written:
            # Retained intentionally: it is the recovery journal and active policy receipt.
            pass


def load_receipt(
    path: Path,
    carrier: Path,
    ops: KernelOps,
    *,
    expected_owner_uid: int = 0,
    require_immutable: bool = True,
) -> tuple[dict[str, Any], os.stat_result, str]:
    receipt_path_checks(path, carrier)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode), "deployment receipt must be a regular non-symlink file")
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        require((before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino), "deployment receipt changed while opening")
        data = read_fd(descriptor)
        after = os.fstat(descriptor)
        require(
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
            "deployment receipt changed while reading",
        )
        require(opened.st_uid == expected_owner_uid, "deployment receipt is not root-owned")
        require(stat.S_IMODE(opened.st_mode) == 0o444, "deployment receipt mode must be 0444")
        require(
            ops.filesystem_magic(descriptor) == EXT_SUPER_MAGIC,
            "deployment receipt must reside on an ext-family filesystem",
        )
        if require_immutable:
            require(
                ops.get_flags(descriptor) & FS_IMMUTABLE_FL != 0,
                "deployment receipt inode is not immutable",
            )
    finally:
        os.close(descriptor)
    receipt = decode_json(data, "immutable deployment receipt")
    require(isinstance(receipt, dict), "immutable deployment receipt must be an object")
    require(canonical_json(receipt) == data, "immutable deployment receipt is not canonical JSON")
    require(
        set(receipt)
        == {
            "carrier",
            "core_profile",
            "direct-loader-paths",
            "entries",
            "filesystem",
            "guest_build_recipe_sha256",
            "policy",
            "schema",
        },
        "immutable deployment receipt fields differ",
    )
    require(receipt["schema"] == SCHEMA and receipt["policy"] == POLICY, "immutable deployment receipt policy differs")
    require(
        receipt["core_profile"] in {"release-o3", "safe-o2"},
        "immutable deployment receipt core profile differs",
    )
    parse_expected_hash(
        receipt["guest_build_recipe_sha256"],
        "immutable deployment receipt guest build recipe",
    )
    return receipt, opened, hashlib.sha256(data).hexdigest()


def receipt_identity(
    receipt: dict[str, Any],
    carrier: Path,
    root_info: os.stat_result,
    hashes: dict[str, str],
    manifest_data: bytes,
) -> None:
    expected_carrier = {
        "closure-identity": carrier_closure_identity(hashes),
        "device": root_info.st_dev,
        "headless-sha256": hashes["bin/wasmer-headless"],
        "inode": root_info.st_ino,
        "manifest-sha256": hashes["manifest.json"],
        "path": str(carrier),
        "payload-inventory-sha256": hashes["payload.files"],
        "wasmer-build-receipt-sha256": hashes["wasmer-build.receipt"],
    }
    require(receipt["carrier"] == expected_carrier, "deployment receipt carrier identity differs")
    require(receipt["filesystem"] == {"magic": f"0x{EXT_SUPER_MAGIC:x}", "type": "ext-family"}, "deployment receipt filesystem differs")
    core_profile, guest_build_recipe_sha256 = manifest_provenance(manifest_data)
    require(
        receipt["core_profile"] == core_profile
        and receipt["guest_build_recipe_sha256"] == guest_build_recipe_sha256,
        "deployment receipt guest build provenance differs",
    )


def parse_receipt_entries(
    receipt: dict[str, Any], *, allow_legacy_ownership_for_remove: bool = False
) -> list[dict[str, Any]]:
    entries = receipt["entries"]
    require(isinstance(entries, list) and entries, "deployment receipt closure is empty")
    previous: str | None = None
    result: list[dict[str, Any]] = []
    for entry in entries:
        require(isinstance(entry, dict), "deployment receipt entry must be an object")
        current_fields = {
            "device",
            "direct-loader-kind",
            "entry-type",
            "gid",
            "inode",
            "mode",
            "path",
            "post-flags",
            "pre-flags",
            "sha256",
            "size",
            "uid",
        }
        legacy_fields = current_fields - {"gid", "uid"}
        require(
            set(entry) == current_fields
            or (
                allow_legacy_ownership_for_remove
                and set(entry) == legacy_fields
            ),
            "deployment receipt entry fields differ",
        )
        if entry["path"] == ".":
            path = "."
        else:
            path = checked_relative(entry["path"], "deployment receipt entry path")
        require(
            previous is None
            or (previous == "." and path != ".")
            or (previous != "." and path > previous),
            "deployment receipt entries must be strictly sorted with root first",
        )
        previous = path
        require(entry["entry-type"] in ("file", "directory"), f"invalid entry type: {path}")
        require(
            entry["direct-loader-kind"] in ("none", "aot"),
            f"invalid direct-loader kind: {path}",
        )
        if entry["direct-loader-kind"] != "none":
            require(entry["entry-type"] == "file", f"direct-loader entry is not a file: {path}")
        require(type(entry["device"]) is int and entry["device"] >= 0, f"invalid device: {path}")
        require(type(entry["inode"]) is int and entry["inode"] > 0, f"invalid inode: {path}")
        require(type(entry["size"]) is int and entry["size"] >= 0, f"invalid size: {path}")
        if "uid" in entry:
            require(type(entry["uid"]) is int and entry["uid"] >= 0, f"invalid uid: {path}")
            require(type(entry["gid"]) is int and entry["gid"] >= 0, f"invalid gid: {path}")
        if entry["entry-type"] == "file":
            parse_expected_hash(entry["sha256"], f"deployment receipt SHA-256: {path}")
            require(entry["mode"] in ("0444", "0555"), f"sealed carrier file mode differs: {path}")
        else:
            require(entry["sha256"] is None, f"directory receipt must not contain a SHA-256: {path}")
            require(entry["mode"] == "0555", f"sealed carrier directory mode must be 0555: {path}")
        for field in ("pre-flags", "post-flags"):
            require(re.fullmatch(r"0x[0-9a-f]{8}", entry[field]) is not None, f"invalid {field}: {path}")
        pre = int(entry["pre-flags"], 16)
        post = int(entry["post-flags"], 16)
        require(post == pre | FS_IMMUTABLE_FL, f"invalid immutable flag transition: {path}")
        result.append(entry)
    require(result[0]["path"] == "." and result[0]["entry-type"] == "directory", "receipt does not begin with carrier root")
    direct_paths = [
        entry["path"]
        for entry in result
        if entry["direct-loader-kind"] != "none"
    ]
    require(receipt["direct-loader-paths"] == direct_paths, "receipt direct-loader subset differs")
    require(
        sum(entry["direct-loader-kind"] == "aot" for entry in result)
        == EXPECTED_AOT_COUNT,
        "receipt AOT file count differs",
    )
    return result


def fast_receipt_identity(
    receipt: dict[str, Any], carrier: Path, root_info: os.stat_result
) -> None:
    identity = receipt["carrier"]
    require(isinstance(identity, dict), "deployment receipt carrier identity is not an object")
    require(
        set(identity)
        == {
            "closure-identity",
            "device",
            "headless-sha256",
            "inode",
            "manifest-sha256",
            "path",
            "payload-inventory-sha256",
            "wasmer-build-receipt-sha256",
        },
        "deployment receipt carrier identity fields differ",
    )
    hashes = {
        "manifest.json": identity["manifest-sha256"],
        "wasmer-build.receipt": identity["wasmer-build-receipt-sha256"],
        "payload.files": identity["payload-inventory-sha256"],
        "bin/wasmer-headless": identity["headless-sha256"],
    }
    for relative, digest in hashes.items():
        parse_expected_hash(digest, f"deployment receipt {relative} identity")
    parse_expected_hash(identity["closure-identity"], "deployment receipt closure identity")
    require(
        identity["closure-identity"] == carrier_closure_identity(hashes),
        "deployment receipt closure identity is internally inconsistent",
    )
    require(
        identity["path"] == str(carrier)
        and identity["device"] == root_info.st_dev
        and identity["inode"] == root_info.st_ino,
        "deployment receipt carrier root identity differs",
    )
    require(
        receipt["filesystem"]
        == {"magic": f"0x{EXT_SUPER_MAGIC:x}", "type": "ext-family"},
        "deployment receipt filesystem differs",
    )


def verify_fast(
    carrier: Path,
    receipt_path: Path,
    ops: KernelOps,
    *,
    expected_identity: dict[str, str] | None = None,
    receipt_owner_uid: int = 0,
) -> dict[str, Any]:
    """Verify immutable inode identity without rereading payload contents."""

    receipt, _, _ = load_receipt(
        receipt_path,
        carrier,
        ops,
        expected_owner_uid=receipt_owner_uid,
        require_immutable=True,
    )
    canonical, root_fd, root_info = open_carrier_root(carrier)
    descriptors: list[int] = []
    try:
        require(
            ops.filesystem_magic(root_fd) == EXT_SUPER_MAGIC,
            "carrier root must reside on an ext-family filesystem",
        )
        fast_receipt_identity(receipt, canonical, root_info)
        if expected_identity is not None:
            identity = receipt["carrier"]
            actual_identity = {
                "manifest.json": identity["manifest-sha256"],
                "wasmer-build.receipt": identity["wasmer-build-receipt-sha256"],
                "payload.files": identity["payload-inventory-sha256"],
                "bin/wasmer-headless": identity["headless-sha256"],
            }
            require_expected_identity(actual_identity, expected_identity)
        for entry in parse_receipt_entries(receipt):
            descriptor = open_beneath_entry(
                root_fd, entry["path"], entry["entry-type"]
            )
            descriptors.append(descriptor)
            info = os.fstat(descriptor)
            require(
                (info.st_dev, info.st_ino, info.st_size)
                == (entry["device"], entry["inode"], entry["size"]),
                f"deployment inode identity differs: {entry['path']}",
            )
            require(
                stat.S_IMODE(info.st_mode) == int(entry["mode"], 8),
                f"deployment entry mode differs: {entry['path']}",
            )
            require(
                (info.st_uid, info.st_gid) == (entry["uid"], entry["gid"]),
                f"deployment entry ownership differs: {entry['path']}",
            )
            post_flags = int(entry["post-flags"], 16)
            current_flags = ops.get_flags(descriptor)
            require(
                current_flags == post_flags
                and current_flags & FS_IMMUTABLE_FL != 0,
                f"deployment inode is not immutable: {entry['path']}",
            )
        return receipt
    finally:
        for descriptor in descriptors:
            os.close(descriptor)
        os.close(root_fd)


def verify_or_remove(
    carrier: Path,
    receipt_path: Path,
    expected_identity: dict[str, str],
    ops: KernelOps,
    *,
    remove: bool,
    check_capability: Callable[[], None] = require_root_immutable_capability,
    receipt_owner_uid: int = 0,
) -> dict[str, Any]:
    if remove:
        check_capability()
    receipt, receipt_info, receipt_sha = load_receipt(
        receipt_path,
        carrier,
        ops,
        expected_owner_uid=receipt_owner_uid,
        require_immutable=not remove,
    )
    canonical, root_fd, root_info = open_carrier_root(carrier)
    opened: list[OpenCarrierEntry] = []
    live_entries: list[OpenCarrierEntry] = []
    try:
        hashes, contents = identity_files(root_fd)
        require_expected_identity(hashes, expected_identity)
        receipt_identity(
            receipt,
            canonical,
            root_info,
            hashes,
            contents["manifest.json"],
        )
        live_entries = open_exact_carrier_closure(
            root_fd,
            contents["manifest.json"],
            contents["payload.files"],
            ops,
        )
        receipt_entries = parse_receipt_entries(
            receipt, allow_legacy_ownership_for_remove=remove
        )
        require(
            [entry.path for entry in sorted(live_entries, key=lambda item: (item.path != ".", item.path))]
            == [entry["path"] for entry in receipt_entries],
            "deployment receipt carrier closure differs",
        )
        live_by_path = {entry.path: entry for entry in live_entries}
        for entry in receipt_entries:
            live = live_by_path[entry["path"]]
            info = live.info
            actual_digest = live.actual_sha256
            require(
                (info.st_dev, info.st_ino, info.st_size)
                == (entry["device"], entry["inode"], entry["size"]),
                f"deployment inode identity differs: {entry['path']}",
            )
            require(stat.S_IMODE(info.st_mode) == int(entry["mode"], 8), f"deployment entry mode differs: {entry['path']}")
            if "uid" in entry:
                require(
                    (info.st_uid, info.st_gid) == (entry["uid"], entry["gid"]),
                    f"deployment entry ownership differs: {entry['path']}",
                )
            else:
                require(
                    remove,
                    f"deployment entry ownership is not receipt-bound: {entry['path']}",
                )
            require(live.entry_type == entry["entry-type"], f"deployment entry type differs: {entry['path']}")
            require(live.direct_loader_kind == entry["direct-loader-kind"], f"deployment direct-loader kind differs: {entry['path']}")
            require(actual_digest == entry["sha256"], f"deployment entry content differs: {entry['path']}")
            pre_flags = int(entry["pre-flags"], 16)
            post_flags = int(entry["post-flags"], 16)
            current = ops.get_flags(live.descriptor)
            if remove:
                require(current in (pre_flags, post_flags), f"deployment inode flags differ from receipt: {entry['path']}")
            else:
                require(current == post_flags and current & FS_IMMUTABLE_FL, f"deployment inode is not immutable: {entry['path']}")
            live.expected_sha256 = entry["sha256"]
            live.pre_flags = pre_flags
            live.post_flags = post_flags
        # Ownership of every live descriptor moves to opened for one close path.
        opened = live_entries
        live_entries = []
        if not remove:
            return receipt
        try:
            transition_flags(
                reversed(transition_order(opened)),
                ops,
                lambda item: item.pre_flags,
            )
        except BaseException:
            # Preserve an active, receipt-verifiable deployment if removal fails.
            transition_flags(
                transition_order(opened),
                ops,
                lambda item: item.post_flags,
            )
            raise
        unlink_exact_receipt(
            receipt_path,
            receipt_info.st_dev,
            receipt_info.st_ino,
            receipt_sha,
            ops,
        )
        return receipt
    finally:
        close_all(opened)
        close_all(live_entries)
        os.close(root_fd)


def expected_identity_from_args(arguments: argparse.Namespace) -> dict[str, str]:
    require(
        all(
            value is not None
            for value in (
                arguments.manifest_sha256,
                arguments.wasmer_build_receipt_sha256,
                arguments.payload_inventory_sha256,
                arguments.headless_sha256,
            )
        ),
        "full immutable deployment operations require all carrier identity hashes",
    )
    return {
        "manifest.json": arguments.manifest_sha256,
        "wasmer-build.receipt": arguments.wasmer_build_receipt_sha256,
        "payload.files": arguments.payload_inventory_sha256,
        "bin/wasmer-headless": arguments.headless_sha256,
    }


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--deploy", action="store_true")
    action.add_argument("--verify", action="store_true")
    action.add_argument("--verify-fast", action="store_true")
    action.add_argument("--remove", action="store_true")
    parser.add_argument("--carrier", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--wasmer-build-receipt-sha256")
    parser.add_argument("--payload-inventory-sha256")
    parser.add_argument("--headless-sha256")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        arguments = parse_arguments(argv)
        ops = KernelOps()
        if arguments.verify_fast:
            optional_identity = (
                arguments.manifest_sha256,
                arguments.wasmer_build_receipt_sha256,
                arguments.payload_inventory_sha256,
                arguments.headless_sha256,
            )
            require(
                all(value is None for value in optional_identity)
                or all(value is not None for value in optional_identity),
                "fast immutable verification identity hashes must be all present or all absent",
            )
            expected = (
                None
                if all(value is None for value in optional_identity)
                else expected_identity_from_args(arguments)
            )
            verify_fast(
                arguments.carrier,
                arguments.receipt,
                ops,
                expected_identity=expected,
            )
            print(f"fast-verified immutable sealed carrier closure: {arguments.carrier}")
            return 0
        expected = expected_identity_from_args(arguments)
        if arguments.deploy:
            deploy(arguments.carrier, arguments.receipt, expected, ops)
            print(f"deployed immutable sealed carrier closure: {arguments.carrier}")
        elif arguments.verify:
            verify_or_remove(
                arguments.carrier,
                arguments.receipt,
                expected,
                ops,
                remove=False,
            )
            print(f"verified immutable sealed carrier closure: {arguments.carrier}")
        else:
            verify_or_remove(
                arguments.carrier,
                arguments.receipt,
                expected,
                ops,
                remove=True,
            )
            print(f"removed immutable sealed carrier closure deployment: {arguments.carrier}")
        return 0
    except (DeploymentError, OSError) as error:
        print(f"immutable carrier deployment failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
