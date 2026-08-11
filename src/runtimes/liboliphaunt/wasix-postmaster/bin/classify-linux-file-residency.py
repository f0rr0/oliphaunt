#!/usr/bin/env python3
"""Classify Linux page-cache residency for one carrier and one PGDATA tree.

This is an observation-only tool.  It opens exact, canonical roots without
following symlinks, maps regular files read-only, and queries mincore(2).  It
does not read file payloads, issue cache advice, sync files, or reclaim pages.
"""

from __future__ import annotations

import argparse
import csv
import ctypes
import io
import mmap
import os
import platform
import re
import resource
import secrets
import stat
import sys
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    PublicationSource,
    publish_set,
    remove_private,
    write_bytes,
)


SCHEMA = "oliphaunt.wasix-postmaster.linux-file-residency.v1"
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")
PROBE_CHUNK_PAGES = 65_536
MAP_FAILED = ctypes.c_void_p(-1).value
UNSAFE_NAME_CHARACTERS = "\t\r\n\0"
TEMP_RELATION = re.compile(r"^t[0-9]+_[0-9]+(?:_(?:fsm|vm|init))?(?:\.[0-9]+)?$")


@dataclass(frozen=True)
class Category:
    root: str
    name: str
    scope: str = "-"


CATEGORIES = (
    Category("carrier", "bin"),
    Category("carrier", "aot"),
    Category("carrier", "memory"),
    Category("carrier", "share"),
    Category("carrier", "metadata"),
    Category("pgdata", "relation-index-aggregate", "base"),
    Category("pgdata", "relation-index-aggregate", "global"),
    Category("pgdata", "pg_wal"),
    Category("pgdata", "temp"),
    Category("pgdata", "other"),
)
CATEGORY_RANK = {category: rank for rank, category in enumerate(CATEGORIES)}


class ClassificationError(RuntimeError):
    pass


def fail(message: str) -> NoReturn:
    raise ClassificationError(message)


@dataclass(frozen=True)
class Identity:
    device: int
    inode: int
    size: int
    file_type: int
    permissions: int
    mtime_ns: int
    ctime_ns: int

    @classmethod
    def from_stat(cls, info: os.stat_result) -> "Identity":
        return cls(
            device=info.st_dev,
            inode=info.st_ino,
            size=info.st_size,
            file_type=stat.S_IFMT(info.st_mode),
            permissions=stat.S_IMODE(info.st_mode),
            mtime_ns=info.st_mtime_ns,
            ctime_ns=info.st_ctime_ns,
        )


@dataclass
class RootHandle:
    name: str
    path: Path
    fd: int
    identity: Identity


@dataclass
class OutputHandle:
    path: Path
    parent: Path
    name: str
    fd: int
    identity: Identity


@dataclass(frozen=True)
class FileCandidate:
    root: str
    components: tuple[str, ...]
    identity: Identity
    category: Category

    @property
    def relative_path(self) -> str:
        return PurePosixPath(*self.components).as_posix()


@dataclass(frozen=True)
class TreeSnapshot:
    files: tuple[FileCandidate, ...]
    directories: tuple[tuple[tuple[str, ...], Identity], ...]

    @property
    def directory_map(self) -> dict[tuple[str, ...], Identity]:
        return dict(self.directories)


@dataclass(frozen=True)
class FileMeasurement:
    candidate: FileCandidate
    page_count: int
    resident_pages: int
    resident_bytes: int
    nonresident_pages: int
    nonresident_bytes: int


@dataclass(frozen=True)
class FaultMetrics:
    minor_before: int
    minor_after: int
    major_before: int
    major_after: int
    scan_started_monotonic_ns: int
    scan_completed_monotonic_ns: int

    @property
    def minor_delta(self) -> int:
        return self.minor_after - self.minor_before

    @property
    def major_delta(self) -> int:
        return self.major_after - self.major_before

    @property
    def scan_duration_ms(self) -> str:
        duration_ns = self.scan_completed_monotonic_ns - self.scan_started_monotonic_ns
        return f"{duration_ns / 1_000_000:.3f}"


FILES_HEADER = (
    "schema_version",
    "status",
    "root",
    "category",
    "scope",
    "relative_path",
    "device",
    "inode",
    "logical_bytes",
    "page_count",
    "resident_logical_bytes",
    "resident_page_bytes",
    "resident_pages",
    "nonresident_logical_bytes",
    "nonresident_page_bytes",
    "nonresident_pages",
    "error",
)

SUMMARY_HEADER = (
    "schema_version",
    "status",
    "root",
    "category",
    "scope",
    "file_count",
    "logical_bytes",
    "page_count",
    "resident_logical_bytes",
    "resident_page_bytes",
    "resident_pages",
    "nonresident_logical_bytes",
    "nonresident_page_bytes",
    "nonresident_pages",
    "error_count",
    "errors",
    "page_size",
    "probe_minor_faults_before",
    "probe_minor_faults_after",
    "probe_minor_faults_delta",
    "probe_major_faults_before",
    "probe_major_faults_after",
    "probe_major_faults_delta",
    "probe_snapshot_scope",
    "probe_consecutive_vectors_stable",
    "probe_scan_started_monotonic_ns",
    "probe_scan_completed_monotonic_ns",
    "probe_scan_duration_ms",
    "probe_payload_bytes_read",
)


libc = ctypes.CDLL(None, use_errno=True)
libc.mmap.argtypes = (
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_int,
    ctypes.c_longlong,
)
libc.mmap.restype = ctypes.c_void_p
libc.mincore.argtypes = (
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_ubyte),
)
libc.mincore.restype = ctypes.c_int
libc.munmap.argtypes = (ctypes.c_void_p, ctypes.c_size_t)
libc.munmap.restype = ctypes.c_int


def safe_error(error: BaseException) -> str:
    return " ".join(str(error).replace("\0", "\\0").splitlines())


def require_safe_name(name: str, display_path: str) -> None:
    if not name or name in (".", ".."):
        fail(f"unsafe empty or relative entry name below {display_path}")
    if any(character in name for character in UNSAFE_NAME_CHARACTERS):
        fail(f"unsafe TSV/control character in path below {display_path}")
    if any(0xD800 <= ord(character) <= 0xDFFF for character in name):
        fail(f"non-UTF-8 path entry below {display_path}")


def require_identity(actual: os.stat_result, expected: Identity, display_path: str) -> None:
    observed = Identity.from_stat(actual)
    if observed != expected:
        fail(
            "path identity changed while classifying residency: "
            f"{display_path}; expected={expected} observed={observed}"
        )


def require_output_parent_identity(
    actual: os.stat_result, expected: Identity, display_path: str
) -> None:
    observed = Identity.from_stat(actual)
    expected_stable = (
        expected.device,
        expected.inode,
        expected.file_type,
        expected.permissions,
    )
    observed_stable = (
        observed.device,
        observed.inode,
        observed.file_type,
        observed.permissions,
    )
    if observed_stable != expected_stable:
        fail(
            "report output parent identity changed while publishing: "
            f"{display_path}; expected={expected_stable} observed={observed_stable}"
        )


def classify_path(root: str, components: tuple[str, ...]) -> Category:
    first = components[0]
    if root == "carrier":
        if first in {"bin", "aot", "memory", "share"}:
            return Category("carrier", first)
        return Category("carrier", "metadata")

    basename = components[-1]
    if (
        first == "pg_stat_tmp"
        or "pgsql_tmp" in components
        or basename.startswith("pgsql_tmp")
        or TEMP_RELATION.fullmatch(basename) is not None
    ):
        return Category("pgdata", "temp")
    if first in {"base", "global"}:
        return Category("pgdata", "relation-index-aggregate", first)
    if first == "pg_wal":
        return Category("pgdata", "pg_wal")
    return Category("pgdata", "other")


def open_root(name: str, supplied: Path) -> RootHandle:
    if not supplied.is_absolute():
        fail(f"--{name}-root must be absolute: {supplied}")
    before = os.lstat(supplied)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        fail(f"--{name}-root must be a non-symlink directory: {supplied}")
    canonical = Path(os.path.realpath(supplied))
    if canonical != supplied:
        fail(f"--{name}-root must already be canonical: supplied={supplied} canonical={canonical}")
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    fd = os.open(supplied, flags)
    identity = Identity.from_stat(before)
    try:
        require_identity(os.fstat(fd), identity, str(supplied))
    except BaseException:
        os.close(fd)
        raise
    return RootHandle(name=name, path=supplied, fd=fd, identity=identity)


def display(root: RootHandle, components: Sequence[str]) -> str:
    if not components:
        return str(root.path)
    return f"{root.path}/{PurePosixPath(*components).as_posix()}"


def snapshot_tree(root: RootHandle) -> TreeSnapshot:
    files: list[FileCandidate] = []
    directories: dict[tuple[str, ...], Identity] = {}

    def visit(directory_fd: int, components: tuple[str, ...], expected: Identity) -> None:
        path_display = display(root, components)
        require_identity(os.fstat(directory_fd), expected, path_display)
        directories[components] = expected
        try:
            names = sorted(os.listdir(directory_fd))
        except OSError as error:
            fail(f"unable to list exact directory {path_display}: {error}")
        for name in names:
            require_safe_name(name, path_display)

        for name in names:
            child_components = (*components, name)
            child_display = display(root, child_components)
            try:
                before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError as error:
                fail(f"entry changed while scanning {child_display}: {error}")
            if stat.S_ISLNK(before.st_mode):
                fail(f"tree contains a symlink: {child_display}")
            child_identity = Identity.from_stat(before)
            if stat.S_ISDIR(before.st_mode):
                flags = (
                    os.O_RDONLY
                    | getattr(os, "O_CLOEXEC", 0)
                    | getattr(os, "O_DIRECTORY", 0)
                    | getattr(os, "O_NOFOLLOW", 0)
                )
                try:
                    child_fd = os.open(name, flags, dir_fd=directory_fd)
                except OSError as error:
                    fail(f"directory changed while opening {child_display}: {error}")
                try:
                    require_identity(os.fstat(child_fd), child_identity, child_display)
                    visit(child_fd, child_components, child_identity)
                    require_identity(os.fstat(child_fd), child_identity, child_display)
                    require_identity(
                        os.stat(name, dir_fd=directory_fd, follow_symlinks=False),
                        child_identity,
                        child_display,
                    )
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(before.st_mode):
                flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
                try:
                    file_fd = os.open(name, flags, dir_fd=directory_fd)
                except OSError as error:
                    fail(f"file changed while opening {child_display}: {error}")
                try:
                    require_identity(os.fstat(file_fd), child_identity, child_display)
                    require_identity(
                        os.stat(name, dir_fd=directory_fd, follow_symlinks=False),
                        child_identity,
                        child_display,
                    )
                finally:
                    os.close(file_fd)
                files.append(
                    FileCandidate(
                        root=root.name,
                        components=child_components,
                        identity=child_identity,
                        category=classify_path(root.name, child_components),
                    )
                )
            else:
                fail(f"tree contains a non-regular, non-directory entry: {child_display}")

        try:
            names_after = sorted(os.listdir(directory_fd))
        except OSError as error:
            fail(f"unable to re-list exact directory {path_display}: {error}")
        if names_after != names:
            fail(f"directory entries changed while scanning: {path_display}")
        require_identity(os.fstat(directory_fd), expected, path_display)

    visit(root.fd, (), root.identity)
    files.sort(key=lambda item: (CATEGORY_RANK[item.category], item.relative_path))
    return TreeSnapshot(files=tuple(files), directories=tuple(sorted(directories.items())))


def verify_root_path(root: RootHandle) -> None:
    require_identity(os.fstat(root.fd), root.identity, str(root.path))
    require_identity(os.lstat(root.path), root.identity, str(root.path))


def open_candidate(
    root: RootHandle,
    candidate: FileCandidate,
    directories: dict[tuple[str, ...], Identity],
) -> tuple[int, int]:
    parent_fd = os.dup(root.fd)
    prefix: tuple[str, ...] = ()
    try:
        for component in candidate.components[:-1]:
            next_prefix = (*prefix, component)
            expected = directories.get(next_prefix)
            if expected is None:
                fail(f"missing directory identity for {display(root, next_prefix)}")
            before = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
            require_identity(before, expected, display(root, next_prefix))
            flags = (
                os.O_RDONLY
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            child_fd = os.open(component, flags, dir_fd=parent_fd)
            try:
                require_identity(os.fstat(child_fd), expected, display(root, next_prefix))
            except BaseException:
                os.close(child_fd)
                raise
            os.close(parent_fd)
            parent_fd = child_fd
            prefix = next_prefix

        name = candidate.components[-1]
        path_display = display(root, candidate.components)
        require_identity(
            os.stat(name, dir_fd=parent_fd, follow_symlinks=False),
            candidate.identity,
            path_display,
        )
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        file_fd = os.open(name, flags, dir_fd=parent_fd)
        try:
            require_identity(os.fstat(file_fd), candidate.identity, path_display)
        except BaseException:
            os.close(file_fd)
            raise
        return parent_fd, file_fd
    except BaseException:
        os.close(parent_fd)
        raise


def verify_open_candidate(
    root: RootHandle, candidate: FileCandidate, parent_fd: int, file_fd: int
) -> None:
    path_display = display(root, candidate.components)
    require_identity(os.fstat(file_fd), candidate.identity, path_display)
    require_identity(
        os.stat(candidate.components[-1], dir_fd=parent_fd, follow_symlinks=False),
        candidate.identity,
        path_display,
    )


def mincore_vector(
    address: int, length: int, vector: ctypes.Array[ctypes.c_ubyte]
) -> None:
    if libc.mincore(address, length, vector) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def probe_chunk(
    fd: int,
    file_size: int,
    offset: int,
    length: int,
    first: ctypes.Array[ctypes.c_ubyte],
    second: ctypes.Array[ctypes.c_ubyte],
    display_path: str,
) -> tuple[int, int, int, int]:
    address = libc.mmap(None, length, mmap.PROT_READ, mmap.MAP_SHARED, fd, offset)
    if address == MAP_FAILED:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    pages = (length + PAGE_SIZE - 1) // PAGE_SIZE
    try:
        mincore_vector(address, length, first)
        mincore_vector(address, length, second)
        resident_pages = 0
        resident_bytes = 0
        nonresident_pages = 0
        nonresident_bytes = 0
        for page in range(pages):
            before = first[page] & 1
            after = second[page] & 1
            if before != after:
                fail(
                    "residency changed between consecutive mincore probes: "
                    f"{display_path} offset={offset} page={page} before={before} after={after}"
                )
            logical_bytes = min(PAGE_SIZE, file_size - offset - page * PAGE_SIZE)
            if after:
                resident_pages += 1
                resident_bytes += logical_bytes
            else:
                nonresident_pages += 1
                nonresident_bytes += logical_bytes
        return resident_pages, resident_bytes, nonresident_pages, nonresident_bytes
    finally:
        if libc.munmap(address, length) != 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))


def probe_file(
    fd: int,
    size: int,
    first: ctypes.Array[ctypes.c_ubyte],
    second: ctypes.Array[ctypes.c_ubyte],
    display_path: str,
    first_chunk_only: bool = False,
) -> tuple[int, int, int, int]:
    resident_pages = resident_bytes = nonresident_pages = nonresident_bytes = 0
    chunk_bytes = PROBE_CHUNK_PAGES * PAGE_SIZE
    offset = 0
    while offset < size:
        length = min(chunk_bytes, size - offset)
        values = probe_chunk(fd, size, offset, length, first, second, display_path)
        resident_pages += values[0]
        resident_bytes += values[1]
        nonresident_pages += values[2]
        nonresident_bytes += values[3]
        offset += length
        if first_chunk_only:
            break
    return resident_pages, resident_bytes, nonresident_pages, nonresident_bytes


def prepare_vectors() -> tuple[ctypes.Array[ctypes.c_ubyte], ctypes.Array[ctypes.c_ubyte]]:
    vector_type = ctypes.c_ubyte * PROBE_CHUNK_PAGES
    first = vector_type()
    second = vector_type()
    # Pre-fault the small result buffers outside the observed probe window.
    for index in range(0, PROBE_CHUNK_PAGES, PAGE_SIZE):
        first[index] = 0
        second[index] = 0
    first[-1] = 0
    second[-1] = 0
    return first, second


def measure_files(
    roots: dict[str, RootHandle], snapshots: dict[str, TreeSnapshot]
) -> tuple[list[FileMeasurement], FaultMetrics]:
    candidates = [candidate for root in ("carrier", "pgdata") for candidate in snapshots[root].files]
    first, second = prepare_vectors()

    # Resolve libc/mmap/mincore code and ctypes call paths before fault accounting.
    warm = next((candidate for candidate in candidates if candidate.identity.size > 0), None)
    if warm is not None:
        root = roots[warm.root]
        parent_fd, file_fd = open_candidate(root, warm, snapshots[warm.root].directory_map)
        try:
            probe_file(
                file_fd,
                warm.identity.size,
                first,
                second,
                display(root, warm.components),
                first_chunk_only=True,
            )
            verify_open_candidate(root, warm, parent_fd, file_fd)
        finally:
            os.close(file_fd)
            os.close(parent_fd)

    scan_started_monotonic_ns = time.monotonic_ns()
    before = resource.getrusage(resource.RUSAGE_SELF)
    measurements: list[FileMeasurement] = []
    for candidate in candidates:
        root = roots[candidate.root]
        parent_fd, file_fd = open_candidate(root, candidate, snapshots[candidate.root].directory_map)
        try:
            resident_pages, resident_bytes, nonresident_pages, nonresident_bytes = probe_file(
                file_fd,
                candidate.identity.size,
                first,
                second,
                display(root, candidate.components),
            )
            verify_open_candidate(root, candidate, parent_fd, file_fd)
        finally:
            os.close(file_fd)
            os.close(parent_fd)
        page_count = (candidate.identity.size + PAGE_SIZE - 1) // PAGE_SIZE
        if resident_pages + nonresident_pages != page_count:
            fail(f"internal page accounting mismatch for {display(root, candidate.components)}")
        if resident_bytes + nonresident_bytes != candidate.identity.size:
            fail(f"internal byte accounting mismatch for {display(root, candidate.components)}")
        measurements.append(
            FileMeasurement(
                candidate=candidate,
                page_count=page_count,
                resident_pages=resident_pages,
                resident_bytes=resident_bytes,
                nonresident_pages=nonresident_pages,
                nonresident_bytes=nonresident_bytes,
            )
        )
    after = resource.getrusage(resource.RUSAGE_SELF)
    scan_completed_monotonic_ns = time.monotonic_ns()
    faults = FaultMetrics(
        minor_before=before.ru_minflt,
        minor_after=after.ru_minflt,
        major_before=before.ru_majflt,
        major_after=after.ru_majflt,
        scan_started_monotonic_ns=scan_started_monotonic_ns,
        scan_completed_monotonic_ns=scan_completed_monotonic_ns,
    )
    return measurements, faults


def open_output(path: Path) -> OutputHandle:
    parent = path.parent
    name = path.name
    require_safe_name(name, str(parent))
    try:
        before = os.lstat(parent)
    except OSError as error:
        fail(f"report output parent must already exist: {parent}: {error}")
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
        fail(f"report output parent must be a non-symlink directory: {parent}")
    canonical_parent = Path(os.path.realpath(parent))
    if canonical_parent != parent:
        fail(
            "report output parent must already be canonical: "
            f"supplied={parent} canonical={canonical_parent}"
        )
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    fd = os.open(parent, flags)
    identity = Identity.from_stat(before)
    try:
        require_output_parent_identity(os.fstat(fd), identity, str(parent))
        try:
            existing = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            existing = None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            fail(f"report output must be absent or a regular non-symlink file: {path}")
    except BaseException:
        os.close(fd)
        raise
    return OutputHandle(path=path, parent=parent, name=name, fd=fd, identity=identity)


def verify_output_parent(output: OutputHandle) -> None:
    require_output_parent_identity(os.fstat(output.fd), output.identity, str(output.parent))
    require_output_parent_identity(os.lstat(output.parent), output.identity, str(output.parent))


def validate_outputs(
    files_output: Path, summary_output: Path, roots: Sequence[Path]
) -> tuple[OutputHandle, OutputHandle]:
    outputs = (files_output, summary_output)
    resolved_outputs = tuple(Path(os.path.realpath(output)) for output in outputs)
    if files_output == summary_output or resolved_outputs[0] == resolved_outputs[1]:
        fail("--files-output and --summary-output must be different paths")
    for output, resolved in zip(outputs, resolved_outputs, strict=True):
        for root in roots:
            if resolved == root or root in resolved.parents:
                fail(f"report output must be outside measured roots: {output}")
    opened: list[OutputHandle] = []
    try:
        for output in outputs:
            opened.append(open_output(output))
        if (
            opened[0].parent != opened[1].parent
            or opened[0].identity.device != opened[1].identity.device
            or opened[0].identity.inode != opened[1].identity.inode
        ):
            fail("--files-output and --summary-output must share one exact parent")
    except BaseException:
        for handle in opened:
            os.close(handle.fd)
        raise
    return opened[0], opened[1]


def rows_for_files(measurements: Sequence[FileMeasurement], status: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for measurement in sorted(
        measurements,
        key=lambda item: (
            CATEGORY_RANK[item.candidate.category],
            item.candidate.relative_path,
        ),
    ):
        candidate = measurement.candidate
        rows.append(
            {
                "schema_version": SCHEMA,
                "status": status,
                "root": candidate.root,
                "category": candidate.category.name,
                "scope": candidate.category.scope,
                "relative_path": candidate.relative_path,
                "device": candidate.identity.device,
                "inode": candidate.identity.inode,
                "logical_bytes": candidate.identity.size,
                "page_count": measurement.page_count,
                "resident_logical_bytes": measurement.resident_bytes,
                "resident_page_bytes": measurement.resident_pages * PAGE_SIZE,
                "resident_pages": measurement.resident_pages,
                "nonresident_logical_bytes": measurement.nonresident_bytes,
                "nonresident_page_bytes": measurement.nonresident_pages * PAGE_SIZE,
                "nonresident_pages": measurement.nonresident_pages,
                "error": "",
            }
        )
    return rows


def rows_for_summary(
    measurements: Sequence[FileMeasurement],
    status: str,
    faults: FaultMetrics | None,
    errors: Sequence[str],
) -> list[dict[str, object]]:
    grouped: dict[Category, list[FileMeasurement]] = {category: [] for category in CATEGORIES}
    for measurement in measurements:
        grouped[measurement.candidate.category].append(measurement)

    def make_row(
        root: str, category: str, scope: str, values: Sequence[FileMeasurement], total: bool = False
    ) -> dict[str, object]:
        return {
            "schema_version": SCHEMA,
            "status": status,
            "root": root,
            "category": category,
            "scope": scope,
            "file_count": len(values),
            "logical_bytes": sum(item.candidate.identity.size for item in values),
            "page_count": sum(item.page_count for item in values),
            "resident_logical_bytes": sum(item.resident_bytes for item in values),
            "resident_page_bytes": sum(item.resident_pages for item in values) * PAGE_SIZE,
            "resident_pages": sum(item.resident_pages for item in values),
            "nonresident_logical_bytes": sum(item.nonresident_bytes for item in values),
            "nonresident_page_bytes": sum(item.nonresident_pages for item in values) * PAGE_SIZE,
            "nonresident_pages": sum(item.nonresident_pages for item in values),
            "error_count": len(errors) if total else 0,
            "errors": " | ".join(errors) if total else "",
            "page_size": PAGE_SIZE,
            "probe_minor_faults_before": "" if faults is None else faults.minor_before,
            "probe_minor_faults_after": "" if faults is None else faults.minor_after,
            "probe_minor_faults_delta": "" if faults is None else faults.minor_delta,
            "probe_major_faults_before": "" if faults is None else faults.major_before,
            "probe_major_faults_after": "" if faults is None else faults.major_after,
            "probe_major_faults_delta": "" if faults is None else faults.major_delta,
            "probe_snapshot_scope": "sequential-point-in-time",
            "probe_consecutive_vectors_stable": "yes" if status == "passed" else "no",
            "probe_scan_started_monotonic_ns": (
                "" if faults is None else faults.scan_started_monotonic_ns
            ),
            "probe_scan_completed_monotonic_ns": (
                "" if faults is None else faults.scan_completed_monotonic_ns
            ),
            "probe_scan_duration_ms": "" if faults is None else faults.scan_duration_ms,
            "probe_payload_bytes_read": 0,
        }

    rows = [
        make_row(category.root, category.name, category.scope, grouped[category])
        for category in CATEGORIES
    ]
    rows.append(make_row("all", "total", "-", measurements, total=True))
    return rows


def render_tsv(
    header: Sequence[str], rows: Sequence[dict[str, object]]
) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=header,
        delimiter="\t",
        lineterminator="\n",
        extrasaction="raise",
    )
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def publish_tsv_pair(
    outputs: tuple[OutputHandle, OutputHandle],
    files_rows: Sequence[dict[str, object]],
    summary_rows: Sequence[dict[str, object]],
) -> None:
    payloads = (
        render_tsv(FILES_HEADER, files_rows),
        render_tsv(SUMMARY_HEADER, summary_rows),
    )
    private: list[tuple[Path, PublicationSource]] = []
    try:
        for output, payload in zip(outputs, payloads, strict=True):
            verify_output_parent(output)
            source = output.path.with_name(
                f".{output.name}.pending.{os.getpid()}.{secrets.token_hex(16)}"
            )
            private.append((source, write_bytes(source, payload)))
        publish_set(
            (
                private[0][0],
                outputs[0].path,
                private[1][0],
                outputs[1].path,
            ),
            (private[0][1], private[1][1]),
        )
        for output in outputs:
            verify_output_parent(output)
            published = os.stat(
                output.name, dir_fd=output.fd, follow_symlinks=False
            )
            if not stat.S_ISREG(published.st_mode) or stat.S_IMODE(
                published.st_mode
            ) != 0o444:
                fail(f"published report is not sealed read-only: {output.path}")
    finally:
        for source, source_identity in private:
            remove_private(source, source_identity)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--carrier-root", required=True, type=Path)
    parser.add_argument("--pgdata-root", required=True, type=Path)
    parser.add_argument("--files-output", "--output", dest="files_output", required=True, type=Path)
    parser.add_argument("--summary-output", "--summary", dest="summary_output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    files_output = args.files_output.absolute()
    summary_output = args.summary_output.absolute()
    measurements: list[FileMeasurement] = []
    faults: FaultMetrics | None = None
    outputs_valid = False
    output_handles: tuple[OutputHandle, OutputHandle] | None = None
    roots: dict[str, RootHandle] = {}
    try:
        if platform.system() != "Linux":
            fail("file residency classification requires Linux mincore(2)")
        if PAGE_SIZE <= 0:
            fail(f"invalid host page size: {PAGE_SIZE}")
        if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
            fail("safe traversal requires O_NOFOLLOW and O_DIRECTORY")

        supplied_roots = (args.carrier_root, args.pgdata_root)
        output_boundaries = tuple(Path(os.path.realpath(path)) for path in supplied_roots)
        output_handles = validate_outputs(files_output, summary_output, output_boundaries)
        outputs_valid = True
        roots["carrier"] = open_root("carrier", args.carrier_root)
        roots["pgdata"] = open_root("pgdata", args.pgdata_root)
        carrier_path = roots["carrier"].path
        pgdata_path = roots["pgdata"].path
        if (
            carrier_path == pgdata_path
            or carrier_path in pgdata_path.parents
            or pgdata_path in carrier_path.parents
            or (
                roots["carrier"].identity.device == roots["pgdata"].identity.device
                and roots["carrier"].identity.inode == roots["pgdata"].identity.inode
            )
        ):
            fail(f"carrier and PGDATA roots must be disjoint: {carrier_path} and {pgdata_path}")

        snapshots = {name: snapshot_tree(roots[name]) for name in ("carrier", "pgdata")}
        inode_paths: dict[tuple[int, int], str] = {}
        for name in ("carrier", "pgdata"):
            for candidate in snapshots[name].files:
                key = (candidate.identity.device, candidate.identity.inode)
                previous = inode_paths.get(key)
                if previous is not None:
                    fail(
                        "hard-linked paths make physical residency attribution ambiguous: "
                        f"{previous} and {display(roots[name], candidate.components)}"
                    )
                inode_paths[key] = display(roots[name], candidate.components)

        measurements, faults = measure_files(roots, snapshots)
        if faults.major_delta != 0:
            fail(
                "probe incurred major faults and cannot prove payload-neutral observation: "
                f"before={faults.major_before} after={faults.major_after} "
                f"delta={faults.major_delta}"
            )

        for name in ("carrier", "pgdata"):
            verify_root_path(roots[name])
            final_snapshot = snapshot_tree(roots[name])
            if final_snapshot != snapshots[name]:
                fail(f"{name} tree changed between residency snapshot boundaries: {roots[name].path}")

        publish_tsv_pair(
            output_handles,
            rows_for_files(measurements, "passed"),
            rows_for_summary(measurements, "passed", faults, ()),
        )
        return 0
    except (ClassificationError, OSError, PublicationError, ValueError) as error:
        message = safe_error(error)
        if outputs_valid:
            try:
                assert output_handles is not None
                publish_tsv_pair(
                    output_handles,
                    rows_for_files(measurements, "failed"),
                    rows_for_summary(measurements, "failed", faults, (message,)),
                )
            except (
                ClassificationError,
                OSError,
                PublicationError,
                ValueError,
            ) as output_error:
                message += f"; unable to write failure evidence: {safe_error(output_error)}"
        print(f"file residency classification failed: {message}", file=sys.stderr)
        return 1
    finally:
        for root in roots.values():
            try:
                os.close(root.fd)
            except OSError:
                pass
        if output_handles is not None:
            for output in output_handles:
                try:
                    os.close(output.fd)
                except OSError:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
