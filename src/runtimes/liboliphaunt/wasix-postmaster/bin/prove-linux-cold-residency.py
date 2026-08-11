#!/usr/bin/env python3
"""Evict and prove cold regular-file pages for an exact set of directory roots.

This is deliberately a targeted operation.  It never uses drop_caches: every
regular file is content-addressed, synchronized, advised DONTNEED, and then
checked with mincore(2).  The caller must launch the measured process without
reading either root after this program returns.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import datetime as dt
import hashlib
import json
import os
import platform
import secrets
import stat
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import NoReturn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    PublicationSource,
    publish_identified,
    remove_private,
    write_bytes,
)


SCHEMA = "oliphaunt.wasix-postmaster.cold-residency.v1"
MAP_SHARED = 0x01
PROT_NONE = 0x0
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
DIRECTORY_OPEN_FLAGS = os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_DIRECTORY
REGULAR_OPEN_FLAGS = os.O_RDONLY | O_CLOEXEC | O_NOFOLLOW


class ProofError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise ProofError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds")


def parse_assignment(value: str, label: str) -> tuple[str, str]:
    if "=" not in value:
        fail(f"{label} requires NAME=VALUE: {value}")
    name, assigned = value.split("=", 1)
    if not name or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789_-" for character in name):
        fail(f"invalid {label} name: {name}")
    if not assigned or any(character in assigned for character in "\t\r\n\0"):
        fail(f"invalid {label} value for {name}")
    return name, assigned


@dataclass
class FileObject:
    device: int
    inode: int
    size: int
    mode: int
    mtime_ns: int
    ctime_ns: int
    link_count: int
    sha256: str = ""
    resident_before_pages: int = 0
    resident_after_pages: int = 0
    paths: list[tuple[str, str]] = field(default_factory=list)

    @property
    def page_count(self) -> int:
        if self.size == 0:
            return 0
        return (self.size + PAGE_SIZE - 1) // PAGE_SIZE


@dataclass
class RootRecord:
    role: str
    path: str
    require_read_only: bool
    fd: int
    identity: "InventoryEntry"
    inventory: tuple["InventoryEntry", ...] = ()
    inventory_by_path: dict[str, "InventoryEntry"] = field(default_factory=dict)
    directories: list[tuple[str, int]] = field(default_factory=list)
    regular_paths: list[tuple[str, FileObject]] = field(default_factory=list)


@dataclass(frozen=True, order=True)
class InventoryEntry:
    relative: str
    kind: str
    device: int
    inode: int
    mode: int
    size: int
    mtime_ns: int
    ctime_ns: int
    link_count: int

    @classmethod
    def from_stat(
        cls, relative: str, kind: str, current: os.stat_result
    ) -> "InventoryEntry":
        return cls(
            relative=relative,
            kind=kind,
            device=current.st_dev,
            inode=current.st_ino,
            mode=stat.S_IMODE(current.st_mode),
            size=current.st_size,
            mtime_ns=current.st_mtime_ns,
            ctime_ns=current.st_ctime_ns,
            link_count=current.st_nlink,
        )

    def diagnostic(self) -> dict[str, object]:
        return {
            "relative": self.relative,
            "kind": self.kind,
            "device": self.device,
            "inode": self.inode,
            "mode": f"{self.mode:o}",
            "size": self.size,
            "mtime_ns": self.mtime_ns,
            "ctime_ns": self.ctime_ns,
            "link_count": self.link_count,
        }


@dataclass
class OutputParent:
    path: str
    name: str
    fd: int
    identity: InventoryEntry
    original_entry: InventoryEntry | None


@dataclass
class ColdFileDescriptorBudget:
    """Make the proof's O(1) cold-file descriptor bound executable evidence."""

    limit: int = 1
    current: int = 0
    peak: int = 0
    total_opens: int = 0

    def acquired(self) -> None:
        if self.current >= self.limit:
            fail(
                "cold-file descriptor bound exceeded: "
                f"current={self.current + 1} limit={self.limit}"
            )
        self.current += 1
        self.total_opens += 1
        self.peak = max(self.peak, self.current)

    def released(self) -> None:
        if self.current <= 0:
            fail("cold-file descriptor accounting underflow")
        self.current -= 1


libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.argtypes = [
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_longlong,
]
libc.mmap.restype = ctypes.c_void_p
libc.mincore.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_ubyte)]
libc.mincore.restype = ctypes.c_int
libc.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
libc.munmap.restype = ctypes.c_int

PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
MAP_FAILED = ctypes.c_void_p(-1).value


def mincore_resident_pages(fd: int, size: int) -> int:
    if size == 0:
        return 0
    pages = (size + PAGE_SIZE - 1) // PAGE_SIZE
    address = libc.mmap(None, size, PROT_NONE, MAP_SHARED, fd, 0)
    if address == MAP_FAILED:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    vector = (ctypes.c_ubyte * pages)()
    try:
        if libc.mincore(address, size, vector) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return sum(1 for value in vector if value & 1)
    finally:
        if libc.munmap(address, size) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))


def stat_matches_entry(current: os.stat_result, expected: InventoryEntry) -> bool:
    kind_matches = (
        expected.kind == "directory" and stat.S_ISDIR(current.st_mode)
    ) or (expected.kind == "file" and stat.S_ISREG(current.st_mode))
    return (
        kind_matches
        and current.st_dev == expected.device
        and current.st_ino == expected.inode
        and stat.S_IMODE(current.st_mode) == expected.mode
        and current.st_size == expected.size
        and current.st_mtime_ns == expected.mtime_ns
        and current.st_ctime_ns == expected.ctime_ns
        and current.st_nlink == expected.link_count
    )


def stat_matches_object(current: os.stat_result, expected: InventoryEntry) -> bool:
    return (
        ((expected.kind == "directory" and stat.S_ISDIR(current.st_mode))
         or (expected.kind == "file" and stat.S_ISREG(current.st_mode)))
        and current.st_dev == expected.device
        and current.st_ino == expected.inode
    )


def open_canonical_directory(path: Path) -> int:
    """Open every canonical absolute component with O_NOFOLLOW."""

    if not path.is_absolute():
        fail(f"directory path must be absolute: {path}")
    canonical = Path(os.path.realpath(path))
    if canonical != path:
        fail(f"directory path must already be canonical: supplied={path} canonical={canonical}")
    current_fd = os.open("/", DIRECTORY_OPEN_FLAGS)
    try:
        for component in path.parts[1:]:
            if component in ("", ".", "..") or "/" in component:
                fail(f"invalid canonical directory component in {path}: {component}")
            next_fd = os.open(component, DIRECTORY_OPEN_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except BaseException:
        os.close(current_fd)
        raise


def pin_root(root: Path, role: str, require_read_only: bool) -> RootRecord:
    if not root.is_absolute():
        fail(f"root must be absolute: {root}")
    before = os.lstat(root)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        fail(f"root must be a non-symlink directory: {root}")
    fd = open_canonical_directory(root)
    opened = os.fstat(fd)
    identity = InventoryEntry.from_stat(".", "directory", opened)
    if not stat_matches_entry(before, identity):
        os.close(fd)
        fail(f"root changed while it was pinned: {root}")
    if require_read_only and identity.mode != 0o555:
        os.close(fd)
        fail(f"read-only root mode must be 0555: {root}")
    return RootRecord(
        role=role,
        path=str(root),
        require_read_only=require_read_only,
        fd=fd,
        identity=identity,
    )


def pin_output_parent(output: Path) -> OutputParent:
    if not output.is_absolute():
        fail(f"receipt output must be absolute: {output}")
    if output.name in ("", ".", ".."):
        fail(f"invalid receipt output name: {output}")
    parent = output.parent
    fd = open_canonical_directory(parent)
    identity = InventoryEntry.from_stat(".", "directory", os.fstat(fd))
    try:
        current = os.stat(output.name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        original_entry = None
    else:
        if stat.S_ISLNK(current.st_mode):
            os.close(fd)
            fail(f"receipt output must not be a symlink: {output}")
        if not stat.S_ISREG(current.st_mode):
            os.close(fd)
            fail(f"existing receipt output must be a regular file: {output}")
        os.close(fd)
        fail(f"receipt output must not already exist: {output}")
    return OutputParent(
        path=str(parent),
        name=output.name,
        fd=fd,
        identity=identity,
        original_entry=original_entry,
    )


def require_pinned_directory(
    path: str,
    fd: int,
    expected: InventoryEntry,
    label: str,
    *,
    exact_metadata: bool = True,
) -> None:
    comparator = stat_matches_entry if exact_metadata else stat_matches_object
    if not comparator(os.fstat(fd), expected):
        fail(f"pinned {label} descriptor changed identity: {path}")
    reopened = open_canonical_directory(Path(path))
    try:
        if not comparator(os.fstat(reopened), expected):
            fail(f"{label} pathname no longer resolves to its pinned identity: {path}")
    finally:
        os.close(reopened)


def require_output_entry_stable(output_parent: OutputParent) -> None:
    try:
        current = os.stat(
            output_parent.name,
            dir_fd=output_parent.fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        if output_parent.original_entry is not None:
            fail("existing receipt output disappeared before publication")
        return
    if output_parent.original_entry is None:
        fail("receipt output appeared concurrently before publication")
    if not stat_matches_entry(current, output_parent.original_entry):
        fail("existing receipt output changed before publication")


@contextlib.contextmanager
def open_cold_file(
    name: str,
    parent_fd: int,
    descriptor_budget: ColdFileDescriptorBudget,
) -> Iterator[int]:
    descriptor_budget.acquired()
    try:
        fd = os.open(name, REGULAR_OPEN_FLAGS, dir_fd=parent_fd)
    except BaseException:
        descriptor_budget.released()
        raise
    try:
        yield fd
    finally:
        try:
            os.close(fd)
        finally:
            descriptor_budget.released()


def metadata_matches(file_object: FileObject, current: os.stat_result) -> bool:
    return (
        stat.S_ISREG(current.st_mode)
        and current.st_dev == file_object.device
        and current.st_ino == file_object.inode
        and current.st_size == file_object.size
        and stat.S_IMODE(current.st_mode) == file_object.mode
        and current.st_mtime_ns == file_object.mtime_ns
        and current.st_ctime_ns == file_object.ctime_ns
        and current.st_nlink == file_object.link_count
    )


@contextlib.contextmanager
def open_parent_beneath(
    root: RootRecord, relative: str
) -> Iterator[tuple[int, str]]:
    components = relative.split("/")
    if (
        relative.startswith("/")
        or len(components) == 0
        or any(component in ("", ".", "..") or "/" in component for component in components)
    ):
        fail(f"invalid recorded relative path below {root.path}: {relative}")
    current_fd = root.fd
    owned_fd = False
    traversed: list[str] = []
    try:
        for component in components[:-1]:
            traversed.append(component)
            directory_relative = "/".join(traversed)
            expected = root.inventory_by_path.get(directory_relative)
            if expected is None or expected.kind != "directory":
                fail(f"recorded parent directory disappeared: {root.path}/{directory_relative}")
            next_fd = os.open(component, DIRECTORY_OPEN_FLAGS, dir_fd=current_fd)
            if not stat_matches_entry(os.fstat(next_fd), expected):
                os.close(next_fd)
                fail(f"parent directory changed while resolving: {root.path}/{directory_relative}")
            if owned_fd:
                os.close(current_fd)
            current_fd = next_fd
            owned_fd = True
        yield current_fd, components[-1]
    finally:
        if owned_fd:
            os.close(current_fd)


def require_path_matches(
    root: RootRecord,
    relative: str,
    file_object: FileObject,
    phase: str,
) -> None:
    with open_parent_beneath(root, relative) as (parent_fd, name):
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(current.st_mode) or not metadata_matches(file_object, current):
        fail(f"file path changed during {phase}: {root.path}/{relative}")


@contextlib.contextmanager
def reopen_stable_file(
    file_object: FileObject,
    roots_by_role: dict[str, RootRecord],
    descriptor_budget: ColdFileDescriptorBudget,
    phase: str,
) -> Iterator[int]:
    """Reopen one recorded inode and reject pathname or in-operation races."""

    if not file_object.paths:
        fail(
            "recorded file object has no path: "
            f"dev={file_object.device} ino={file_object.inode}"
        )
    role, relative = min(file_object.paths)
    root = roots_by_role[role]
    require_path_matches(root, relative, file_object, phase)
    with open_parent_beneath(root, relative) as (parent_fd, name):
        with open_cold_file(name, parent_fd, descriptor_budget) as fd:
            if not metadata_matches(file_object, os.fstat(fd)):
                fail(f"file changed while reopening for {phase}: {root.path}/{relative}")
            yield fd
            if not metadata_matches(file_object, os.fstat(fd)):
                fail(f"file changed during {phase}: {root.path}/{relative}")
    require_path_matches(root, relative, file_object, phase)


def scan_directory(
    root: RootRecord,
    directory_fd: int,
    relative_directory: str,
    objects: dict[tuple[int, int], FileObject] | None,
    descriptor_budget: ColdFileDescriptorBudget,
    inventory: list[InventoryEntry],
) -> None:
    directory_before = os.fstat(directory_fd)
    directory_entry = InventoryEntry.from_stat(
        relative_directory, "directory", directory_before
    )
    if root.require_read_only and directory_entry.mode != 0o555:
        fail(
            "carrier directory mode must remain 0555: "
            f"{root.path}/{relative_directory}"
        )
    inventory.append(directory_entry)
    if objects is not None:
        root.directories.append((relative_directory, directory_entry.mode))

    names = sorted(os.listdir(directory_fd))
    for name in names:
        if name in ("", ".", "..") or "/" in name:
            fail(f"invalid directory entry below {root.path}: {name}")
        relative = name if relative_directory == "." else f"{relative_directory}/{name}"
        before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(before.st_mode):
            child_fd = os.open(name, DIRECTORY_OPEN_FLAGS, dir_fd=directory_fd)
            try:
                child_opened = os.fstat(child_fd)
                child_entry = InventoryEntry.from_stat(relative, "directory", child_opened)
                if not stat_matches_entry(before, child_entry):
                    fail(f"directory changed while it was opened: {root.path}/{relative}")
                scan_directory(
                    root,
                    child_fd,
                    relative,
                    objects,
                    descriptor_budget,
                    inventory,
                )
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(before.st_mode):
            mode = stat.S_IMODE(before.st_mode)
            if root.require_read_only and mode not in (0o444, 0o555):
                fail(f"carrier file mode must remain 0444 or 0555: {root.path}/{relative}")
            with open_cold_file(name, directory_fd, descriptor_budget) as fd:
                opened = os.fstat(fd)
                file_entry = InventoryEntry.from_stat(relative, "file", opened)
                if not stat_matches_entry(before, file_entry):
                    fail(f"file changed while it was opened: {root.path}/{relative}")
            inventory.append(file_entry)
            if objects is not None:
                identity = (opened.st_dev, opened.st_ino)
                existing = objects.get(identity)
                if existing is None:
                    existing = FileObject(
                        device=opened.st_dev,
                        inode=opened.st_ino,
                        size=opened.st_size,
                        mode=mode,
                        mtime_ns=opened.st_mtime_ns,
                        ctime_ns=opened.st_ctime_ns,
                        link_count=opened.st_nlink,
                    )
                    objects[identity] = existing
                elif not metadata_matches(existing, opened):
                    fail(f"hard-linked file metadata is inconsistent: {root.path}/{relative}")
                existing.paths.append((root.role, relative))
                root.regular_paths.append((relative, existing))
        else:
            fail(f"tree contains a symlink or special entry: {root.path}/{relative}")

    directory_after = os.fstat(directory_fd)
    if not stat_matches_entry(directory_after, directory_entry):
        fail(f"directory changed while inventorying: {root.path}/{relative_directory}")


def capture_root_inventory(
    root: RootRecord,
    objects: dict[tuple[int, int], FileObject] | None,
    descriptor_budget: ColdFileDescriptorBudget,
) -> tuple[InventoryEntry, ...]:
    require_pinned_directory(root.path, root.fd, root.identity, f"root {root.role}")
    if objects is not None:
        root.directories.clear()
        root.regular_paths.clear()
    inventory: list[InventoryEntry] = []
    scan_directory(root, root.fd, ".", objects, descriptor_budget, inventory)
    require_pinned_directory(root.path, root.fd, root.identity, f"root {root.role}")
    return tuple(sorted(inventory))


def inventory_difference(
    expected: tuple[InventoryEntry, ...], actual: tuple[InventoryEntry, ...]
) -> dict[str, object]:
    for index in range(max(len(expected), len(actual))):
        left = expected[index] if index < len(expected) else None
        right = actual[index] if index < len(actual) else None
        if left != right:
            return {
                "index": index,
                "expected": left.diagnostic() if left is not None else None,
                "actual": right.diagnostic() if right is not None else None,
            }
    return {"index": -1, "expected": None, "actual": None}


def require_exact_inventories(
    roots: list[RootRecord], descriptor_budget: ColdFileDescriptorBudget, phase: str
) -> None:
    for root in roots:
        actual = capture_root_inventory(root, None, descriptor_budget)
        if actual != root.inventory:
            fail(
                f"exact root inventory changed during {phase}: role={root.role} "
                + json.dumps(inventory_difference(root.inventory, actual), sort_keys=True)
            )


def require_output_isolated(
    output: Path,
    output_parent: OutputParent,
    roots: list[RootRecord],
    objects: dict[tuple[int, int], FileObject],
) -> None:
    parent_identity = (output_parent.identity.device, output_parent.identity.inode)
    for root in roots:
        root_path = Path(root.path)
        if output == root_path or root_path in output.parents:
            fail(f"receipt output must be outside every cold root: {output}")
        directory_identities = {
            (entry.device, entry.inode)
            for entry in root.inventory
            if entry.kind == "directory"
        }
        if parent_identity in directory_identities:
            fail(
                "receipt output parent aliases a directory inside a cold root: "
                f"output_parent={output_parent.path} role={root.role}"
            )
    if output_parent.original_entry is not None:
        output_identity = (
            output_parent.original_entry.device,
            output_parent.original_entry.inode,
        )
        if output_identity in objects:
            fail("existing receipt output hard-links a cold-root file")


def require_root_isolation(roots: list[RootRecord]) -> None:
    for left_index, left in enumerate(roots):
        left_path = Path(left.path)
        left_identity = (left.identity.device, left.identity.inode)
        for right in roots[left_index + 1 :]:
            right_path = Path(right.path)
            if (
                left_path == right_path
                or left_path in right_path.parents
                or right_path in left_path.parents
            ):
                fail(f"cold roots must be disjoint: {left_path} and {right_path}")
            right_directory_identities = {
                (entry.device, entry.inode)
                for entry in right.inventory
                if entry.kind == "directory"
            }
            left_directory_identities = {
                (entry.device, entry.inode)
                for entry in left.inventory
                if entry.kind == "directory"
            }
            right_identity = (right.identity.device, right.identity.inode)
            if (
                left_identity in right_directory_identities
                or right_identity in left_directory_identities
            ):
                fail(
                    "cold roots alias or overlap by directory identity: "
                    f"{left_path} and {right_path}"
                )


def require_complete_hardlink_topology(
    unique_objects: list[FileObject],
) -> list[dict[str, object]]:
    internal_hardlinks: list[dict[str, object]] = []
    for file_object in unique_objects:
        roles = {role for role, _ in file_object.paths}
        if len(roles) != 1:
            fail(
                "cold roots share one hard-linked inode, violating immutable/mutable isolation: "
                + json.dumps(file_object.paths, sort_keys=True)
            )
        observed_aliases = len(file_object.paths)
        if file_object.link_count != observed_aliases:
            fail(
                "cold file has external or otherwise unobserved hard-link aliases: "
                + json.dumps(
                    {
                        "device": file_object.device,
                        "inode": file_object.inode,
                        "st_nlink": file_object.link_count,
                        "observed_aliases": observed_aliases,
                        "paths": file_object.paths,
                    },
                    sort_keys=True,
                )
            )
        if observed_aliases > 1:
            internal_hardlinks.append(
                {
                    "device": file_object.device,
                    "inode": file_object.inode,
                    "link_count": file_object.link_count,
                    "paths": sorted(file_object.paths),
                }
            )
    return internal_hardlinks


def publish_receipt(receipt: dict[str, object], output_parent: OutputParent) -> None:
    require_pinned_directory(
        output_parent.path,
        output_parent.fd,
        output_parent.identity,
        "receipt output parent",
        exact_metadata=False,
    )
    require_output_entry_stable(output_parent)
    output = Path(output_parent.path) / output_parent.name
    pending = output.with_name(
        f".{output.name}.pending.{os.getpid()}.{secrets.token_hex(16)}"
    )
    payload = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8")
    pending_identity: PublicationSource | None = None
    try:
        pending_identity = write_bytes(pending, payload)
        require_output_entry_stable(output_parent)
        publish_identified(pending, output, pending_identity)
        published = os.stat(
            output_parent.name,
            dir_fd=output_parent.fd,
            follow_symlinks=False,
        )
        if (
            (published.st_dev, published.st_ino) != pending_identity.file_identity
            or stat.S_IMODE(published.st_mode) != 0o444
            or published.st_size != len(payload)
            or published.st_nlink != 1
        ):
            fail("published receipt identity differs from the fsynced pending file")
        require_pinned_directory(
            output_parent.path,
            output_parent.fd,
            output_parent.identity,
            "receipt output parent",
            exact_metadata=False,
        )
    finally:
        if pending_identity is not None:
            remove_private(pending, pending_identity)


def hash_open_file(fd: int, file_object: FileObject) -> str:
    digest = hashlib.sha256()
    offset = 0
    while offset < file_object.size:
        chunk = os.pread(fd, min(1024 * 1024, file_object.size - offset), offset)
        if not chunk:
            fail(f"short read while hashing dev={file_object.device} ino={file_object.inode}")
        digest.update(chunk)
        offset += len(chunk)
    return digest.hexdigest()


def root_receipt(root: RootRecord) -> dict[str, object]:
    content_digest = hashlib.sha256()
    metadata_digest = hashlib.sha256()
    inventory_digest = hashlib.sha256()
    object_keys: set[tuple[int, int]] = set()
    for relative, mode in sorted(root.directories):
        content_digest.update(f"d\0{relative}\0{mode:o}\0".encode())
        metadata_digest.update(f"d\0{relative}\0{mode:o}\0".encode())
    for relative, file_object in sorted(root.regular_paths, key=lambda item: item[0]):
        object_keys.add((file_object.device, file_object.inode))
        content_digest.update(
            f"f\0{relative}\0{file_object.mode:o}\0{file_object.size}\0{file_object.sha256}\0".encode()
        )
        metadata_digest.update(
            (
                f"f\0{relative}\0{file_object.device}\0{file_object.inode}\0"
                f"{file_object.mode:o}\0{file_object.size}\0{file_object.mtime_ns}\0"
                f"{file_object.ctime_ns}\0{file_object.link_count}\0{file_object.sha256}\0"
            ).encode()
        )
    for entry in root.inventory:
        inventory_digest.update(
            (
                f"{entry.kind}\0{entry.relative}\0{entry.device}\0{entry.inode}\0"
                f"{entry.mode:o}\0{entry.size}\0{entry.mtime_ns}\0{entry.ctime_ns}\0"
                f"{entry.link_count}\0"
            ).encode()
        )
    root_objects = {
        (entry.device, entry.inode): entry for _, entry in root.regular_paths
    }
    unique = [entry for _, entry in sorted(root_objects.items())]
    return {
        "role": root.role,
        "path": root.path,
        "require_read_only": root.require_read_only,
        "directory_count": len(root.directories),
        "regular_path_count": len(root.regular_paths),
        "unique_file_count": len(object_keys),
        "root_device": root.identity.device,
        "root_inode": root.identity.inode,
        "hard_link_alias_count": sum(
            max(0, file_object.link_count - 1) for file_object in unique
        ),
        "hard_linked_unique_file_count": sum(
            1 for file_object in unique if file_object.link_count > 1
        ),
        "logical_bytes": sum(file_object.size for file_object in unique),
        "page_count": sum(file_object.page_count for file_object in unique),
        "resident_before_pages": sum(file_object.resident_before_pages for file_object in unique),
        "resident_after_pages": sum(file_object.resident_after_pages for file_object in unique),
        "content_sha256": content_digest.hexdigest(),
        "metadata_sha256": metadata_digest.hexdigest(),
        "exact_inventory_sha256": inventory_digest.hexdigest(),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        action="append",
        required=True,
        metavar="ROLE=ABSOLUTE_PATH",
        help="directory root to hash, evict, and prove; may repeat",
    )
    parser.add_argument(
        "--read-only-root",
        action="append",
        default=[],
        metavar="ROLE",
        help="role whose complete mode surface must be immutable (0555/0444)",
    )
    parser.add_argument(
        "--binding",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="precomputed evidence identity to bind into the receipt",
    )
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def execute_proof(
    roots: list[RootRecord],
    output: Path,
    output_parent: OutputParent,
    bindings: dict[str, str],
    started_utc: str,
    started_monotonic_ns: int,
) -> int:
    tool_sha256 = sha256_file(Path(__file__).resolve())
    objects: dict[tuple[int, int], FileObject] = {}
    descriptor_budget = ColdFileDescriptorBudget()
    roots_by_role = {root.role: root for root in roots}

    inventory_started_monotonic_ns = time.monotonic_ns()
    for root in roots:
        root.inventory = capture_root_inventory(root, objects, descriptor_budget)
        root.inventory_by_path = {entry.relative: entry for entry in root.inventory}
    inventory_completed_monotonic_ns = time.monotonic_ns()
    if not objects:
        fail("cold-residency proof requires at least one regular file")
    unique_objects = [objects[identity] for identity in sorted(objects)]
    require_root_isolation(roots)
    require_output_isolated(output, output_parent, roots, objects)
    internal_hardlinks = require_complete_hardlink_topology(unique_objects)

    for file_object in unique_objects:
        with reopen_stable_file(
            file_object, roots_by_role, descriptor_budget, "content hashing"
        ) as fd:
            file_object.sha256 = hash_open_file(fd, file_object)

    for file_object in unique_objects:
        with reopen_stable_file(
            file_object, roots_by_role, descriptor_budget, "data synchronization"
        ) as fd:
            os.fdatasync(fd)
    synchronized_monotonic_ns = time.monotonic_ns()

    for file_object in unique_objects:
        with reopen_stable_file(
            file_object, roots_by_role, descriptor_budget, "pre-eviction mincore"
        ) as fd:
            file_object.resident_before_pages = mincore_resident_pages(fd, file_object.size)
    resident_before_pages = sum(
        file_object.resident_before_pages for file_object in unique_objects
    )

    require_exact_inventories(roots, descriptor_budget, "pre-eviction boundary")
    pre_eviction_inventory_verified_monotonic_ns = time.monotonic_ns()
    eviction_started_monotonic_ns = time.monotonic_ns()
    for file_object in unique_objects:
        with reopen_stable_file(
            file_object, roots_by_role, descriptor_budget, "targeted eviction"
        ) as fd:
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
    eviction_completed_monotonic_ns = time.monotonic_ns()

    proof_started_monotonic_ns = time.monotonic_ns()
    proof_pass_resident_pages: list[int] = []
    for proof_pass in range(1, 3):
        for file_object in unique_objects:
            with reopen_stable_file(
                file_object,
                roots_by_role,
                descriptor_budget,
                f"mincore proof pass {proof_pass}",
            ) as fd:
                file_object.resident_after_pages = mincore_resident_pages(
                    fd, file_object.size
                )
        resident_after_pages = sum(
            file_object.resident_after_pages for file_object in unique_objects
        )
        proof_pass_resident_pages.append(resident_after_pages)
        if resident_after_pages != 0:
            resident_paths = [
                {
                    "paths": file_object.paths,
                    "resident_pages": file_object.resident_after_pages,
                    "page_count": file_object.page_count,
                }
                for file_object in unique_objects
                if file_object.resident_after_pages
            ]
            fail(
                f"targeted eviction proof pass {proof_pass} found resident pages; "
                "a process may still map or read the file(s): "
                + json.dumps(resident_paths, sort_keys=True)
            )
    require_exact_inventories(roots, descriptor_budget, "post-proof boundary")
    post_proof_inventory_verified_monotonic_ns = time.monotonic_ns()
    proof_completed_monotonic_ns = time.monotonic_ns()
    if descriptor_budget.current != 0:
        fail(
            "cold-file descriptors remain open after proof: "
            f"current={descriptor_budget.current}"
        )

    root_records = [root_receipt(root) for root in roots]
    page_count = sum(file_object.page_count for file_object in unique_objects)
    logical_bytes = sum(file_object.size for file_object in unique_objects)
    receipt = {
        "schema_version": SCHEMA,
        "status": "passed",
        "method": (
            "pinned-fd-relative-exact-inventory+content-sha256+fdatasync+"
            "posix-fadvise-dontneed+bounded-streaming-reopen+"
            "two-consecutive-sequential-point-in-time-mincore-sweeps"
        ),
        "claim": (
            "under caller-enforced root quiescence beginning before inventory, every "
            "unique regular file was observed nonresident at its sequential point in "
            "each of two final sweeps"
        ),
        "host": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "page_size": PAGE_SIZE,
            "pid": os.getpid(),
        },
        "resource_bounds": {
            "cold_file_descriptor_strategy": "bounded-streaming-reopen",
            "cold_file_descriptor_limit": descriptor_budget.limit,
            "cold_file_descriptor_peak": descriptor_budget.peak,
            "cold_file_descriptor_total_opens": descriptor_budget.total_opens,
            "persistent_cold_file_descriptors": 0,
            "pinned_root_descriptors": len(roots),
            "pinned_output_parent_descriptors": 1,
            "final_mincore_sweeps": len(proof_pass_resident_pages),
            "final_mincore_resident_pages": proof_pass_resident_pages,
        },
        "proof_scope": {
            "root_activity_requirement": (
                "quiescent before initial inventory through measured spawn"
            ),
            "quiescence_required_from_monotonic_ns": started_monotonic_ns,
            "path_resolution": "pinned-directory-fd-relative-o_nofollow",
            "inventory_revalidation": "exact-before-eviction-and-after-mincore",
            "observation_semantics": "sequential-point-in-time",
            "payload_reads_after_eviction_started": 0,
        },
        "hard_links": {
            "policy": "all st_nlink aliases must be inventoried in exactly one root",
            "external_alias_count": 0,
            "internal_hard_link_object_count": len(internal_hardlinks),
            "internal_hard_links": internal_hardlinks,
        },
        "tool_sha256": tool_sha256,
        "bindings": dict(sorted(bindings.items())),
        "roots": root_records,
        "totals": {
            "root_count": len(roots),
            "directory_count": sum(len(root.directories) for root in roots),
            "regular_path_count": sum(len(root.regular_paths) for root in roots),
            "unique_file_count": len(unique_objects),
            "logical_bytes": logical_bytes,
            "page_count": page_count,
            "resident_before_pages": resident_before_pages,
            "resident_after_pages": resident_after_pages,
            "resident_after_bytes_upper_bound": resident_after_pages * PAGE_SIZE,
        },
        "timestamps": {
            "started_utc": started_utc,
            "completed_utc": utc_now(),
            "started_monotonic_ns": started_monotonic_ns,
            "inventory_started_monotonic_ns": inventory_started_monotonic_ns,
            "inventory_completed_monotonic_ns": inventory_completed_monotonic_ns,
            "synchronized_monotonic_ns": synchronized_monotonic_ns,
            "pre_eviction_inventory_verified_monotonic_ns": (
                pre_eviction_inventory_verified_monotonic_ns
            ),
            "eviction_started_monotonic_ns": eviction_started_monotonic_ns,
            "eviction_completed_monotonic_ns": eviction_completed_monotonic_ns,
            "proof_started_monotonic_ns": proof_started_monotonic_ns,
            "post_proof_inventory_verified_monotonic_ns": (
                post_proof_inventory_verified_monotonic_ns
            ),
            "proof_completed_monotonic_ns": proof_completed_monotonic_ns,
        },
    }
    publish_receipt(receipt, output_parent)
    return 0


def main() -> int:
    started_utc = utc_now()
    started_monotonic_ns = time.monotonic_ns()
    args = parse_args()
    if platform.system() != "Linux":
        fail("cold-residency proof requires Linux mincore and POSIX_FADV_DONTNEED")
    if not hasattr(os, "posix_fadvise") or not hasattr(os, "POSIX_FADV_DONTNEED"):
        fail("Python runtime lacks posix_fadvise(POSIX_FADV_DONTNEED)")
    if PAGE_SIZE <= 0:
        fail(f"invalid host page size: {PAGE_SIZE}")

    role_paths: dict[str, str] = {}
    for item in args.root:
        role, path = parse_assignment(item, "--root")
        if role in role_paths:
            fail(f"duplicate root role: {role}")
        role_paths[role] = path
    read_only_roles = set(args.read_only_root)
    if read_only_roles - set(role_paths):
        fail(f"unknown --read-only-root roles: {sorted(read_only_roles - set(role_paths))}")
    bindings: dict[str, str] = {}
    for item in args.binding:
        name, value = parse_assignment(item, "--binding")
        if name in bindings:
            fail(f"duplicate binding: {name}")
        bindings[name] = value
    if not bindings:
        fail("at least one --binding is required")

    output = args.output.absolute()
    with contextlib.ExitStack() as descriptors:
        roots: list[RootRecord] = []
        for role, path in sorted(role_paths.items()):
            root = pin_root(Path(path), role, role in read_only_roles)
            descriptors.callback(os.close, root.fd)
            roots.append(root)
        output_parent = pin_output_parent(output)
        descriptors.callback(os.close, output_parent.fd)
        return execute_proof(
            roots,
            output,
            output_parent,
            bindings,
            started_utc,
            started_monotonic_ns,
        )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProofError, PublicationError, OSError, ValueError) as error:
        print(f"cold-residency proof failed: {error}", file=sys.stderr)
        raise SystemExit(1)
