#!/usr/bin/env python3

"""Compute the exact installed guest closure identity used by a carrier."""

from __future__ import annotations

import hashlib
import os
import re
import stat
import sys
from pathlib import Path
from typing import TypeAlias


SCHEMA = "oliphaunt.wasix-postmaster.guest-installed-closure.v1"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


def load_side_module_policy() -> tuple[tuple[str, tuple[str, ...]], ...]:
    def policy_require(condition: bool, message: str) -> None:
        if not condition:
            raise RuntimeError(message)

    policy = (
        Path(__file__).resolve().parent.parent
        / "runtime"
        / "policies"
        / "sealed-side-modules.v1.tsv"
    )
    rows: list[tuple[str, tuple[str, ...]]] = []
    occupied: set[str] = set()
    for line_number, line in enumerate(
        policy.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line or line.startswith("#"):
            continue
        fields = line.split("\t")
        policy_require(len(fields) == 3, f"invalid side-module policy row {line_number}")
        relative, raw_aliases, abi_policy = fields
        policy_require(
            relative.startswith("lib/") and relative.endswith((".so", ".so.5.18")),
            f"invalid side-module policy path: {relative}",
        )
        policy_require(bool(abi_policy), f"empty side-module ABI policy: {relative}")
        aliases = () if raw_aliases == "-" else tuple(raw_aliases.split(","))
        for candidate in (relative, *aliases):
            policy_require(
                candidate.startswith("lib/") and candidate not in occupied,
                f"duplicate or invalid side-module path: {candidate}",
            )
            occupied.add(candidate)
        rows.append((relative, aliases))
    policy_require(bool(rows), "sealed side-module policy is empty")
    return tuple(rows)


SIDE_MODULE_POLICY = load_side_module_policy()
REQUIRED_MODULES = (
    "bin/initdb",
    "bin/postgres",
    *(relative for relative, _aliases in SIDE_MODULE_POLICY),
)
REGULAR_OPEN_FLAGS = (
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)
DIRECTORY_OPEN_FLAGS = (
    REGULAR_OPEN_FLAGS | getattr(os, "O_DIRECTORY", 0)
)
FileIdentity: TypeAlias = tuple[int, int, int, int, int, int]
FileRecord: TypeAlias = tuple[str, int, str, FileIdentity]


class ProvenanceError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ProvenanceError(message)


def file_identity(metadata: os.stat_result) -> FileIdentity:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def read_regular(path: Path, *, synchronize: bool = False) -> tuple[int, str, FileIdentity]:
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode), f"guest closure entry is not regular: {path}")
    descriptor = os.open(path, REGULAR_OPEN_FLAGS)
    try:
        opened = os.fstat(descriptor)
        require(
            stat.S_ISREG(opened.st_mode)
            and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino),
            f"guest closure entry changed while opening: {path}",
        )
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
        if synchronize:
            os.fsync(descriptor)
        after = os.fstat(descriptor)
        require(
            file_identity(opened) == file_identity(after)
            and size == opened.st_size,
            f"guest closure entry changed while hashing: {path}",
        )
        current = os.lstat(path)
        require(
            stat.S_ISREG(current.st_mode)
            and file_identity(current) == file_identity(after),
            f"guest closure entry was replaced while hashing: {path}",
        )
        return size, digest.hexdigest(), file_identity(after)
    finally:
        os.close(descriptor)


def closure_files(root: Path) -> list[str]:
    info = os.lstat(root)
    require(
        stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
        f"guest install root is not a non-symlink directory: {root}",
    )
    files = list(REQUIRED_MODULES)
    for relative in REQUIRED_MODULES:
        require(
            relative.encode("utf-8").decode("utf-8") == relative,
            f"guest module path is not canonical UTF-8: {relative!r}",
        )
        module_info = os.lstat(root / relative)
        require(
            stat.S_ISREG(module_info.st_mode),
            f"required guest module is not regular: {root / relative}",
        )

    share_root = root / "share/postgresql"
    share_info = os.lstat(share_root)
    require(
        stat.S_ISDIR(share_info.st_mode) and not stat.S_ISLNK(share_info.st_mode),
        f"PostgreSQL share root is not a non-symlink directory: {share_root}",
    )
    share_files = 0
    for current, directories, names in os.walk(share_root, followlinks=False):
        directories.sort()
        names.sort()
        for name in directories:
            path = Path(current, name)
            entry = os.lstat(path)
            require(
                stat.S_ISDIR(entry.st_mode) and not stat.S_ISLNK(entry.st_mode),
                f"PostgreSQL share closure contains a non-directory: {path}",
            )
        for name in names:
            path = Path(current, name)
            entry = os.lstat(path)
            require(
                stat.S_ISREG(entry.st_mode),
                f"PostgreSQL share closure contains a non-regular file: {path}",
            )
            files.append(path.relative_to(root).as_posix())
            share_files += 1
    require(share_files > 0, "PostgreSQL share closure is empty")
    require(len(files) == len(set(files)), "guest closure contains duplicate paths")
    return sorted(files)


def frame(digest: "hashlib._Hash", value: str) -> None:
    encoded = value.encode("utf-8")
    digest.update(len(encoded).to_bytes(8, "big"))
    digest.update(encoded)


def installed_closure_identity_from_records(
    records: list[tuple[str, int, str]],
) -> str:
    require(records, "guest installed closure records are empty")
    paths = [relative for relative, _, _ in records]
    require(paths == sorted(paths), "guest installed closure records are not sorted")
    require(len(paths) == len(set(paths)), "guest installed closure records are duplicated")
    require(
        all(type(size) is int and size >= 0 for _, size, _ in records),
        "guest installed closure record has an invalid size",
    )
    require(
        all(SHA256_RE.fullmatch(file_digest) is not None for _, _, file_digest in records),
        "guest installed closure record has an invalid SHA-256",
    )
    digest = hashlib.sha256()
    frame(digest, SCHEMA)
    for relative, size, file_digest in records:
        for value in (relative, str(size), file_digest):
            frame(digest, value)
    return digest.hexdigest()


def installed_closure_identity(root: Path) -> str:
    root = Path(os.path.realpath(root))
    records: list[tuple[str, int, str]] = []
    for relative in closure_files(root):
        size, file_digest, _ = read_regular(root / relative)
        records.append((relative, size, file_digest))
    return installed_closure_identity_from_records(records)


def directory_closure(files: list[str]) -> list[str]:
    directories = {"."}
    for relative in files:
        parent = Path(relative).parent
        while parent != Path("."):
            directories.add(parent.as_posix())
            parent = parent.parent
    return sorted(directories, key=lambda value: (-len(Path(value).parts), value))


def synchronize_directories(root: Path, directories: list[str]) -> dict[str, FileIdentity]:
    synchronized: dict[str, FileIdentity] = {}
    for relative in directories:
        path = root if relative == "." else root / relative
        before = os.lstat(path)
        require(
            stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode),
            f"guest closure parent is not a non-symlink directory: {path}",
        )
        descriptor = os.open(path, DIRECTORY_OPEN_FLAGS)
        try:
            opened = os.fstat(descriptor)
            require(
                stat.S_ISDIR(opened.st_mode)
                and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino),
                f"guest closure parent changed while opening: {path}",
            )
            os.fsync(descriptor)
            after = os.fstat(descriptor)
            require(
                file_identity(opened) == file_identity(after),
                f"guest closure parent changed while synchronizing: {path}",
            )
            current = os.lstat(path)
            require(
                stat.S_ISDIR(current.st_mode)
                and file_identity(current) == file_identity(after),
                f"guest closure parent was replaced while synchronizing: {path}",
            )
            synchronized[relative] = file_identity(after)
        finally:
            os.close(descriptor)
    return synchronized


def synchronize_root_entry(root: Path, expected_root: FileIdentity) -> None:
    """Make a freshly recreated install-root entry durable in its parent."""

    parent = root.parent
    before_parent = os.lstat(parent)
    require(
        stat.S_ISDIR(before_parent.st_mode) and not stat.S_ISLNK(before_parent.st_mode),
        f"guest install parent is not a non-symlink directory: {parent}",
    )
    descriptor = os.open(parent, DIRECTORY_OPEN_FLAGS)
    try:
        opened_parent = os.fstat(descriptor)
        require(
            stat.S_ISDIR(opened_parent.st_mode)
            and (before_parent.st_dev, before_parent.st_ino)
            == (opened_parent.st_dev, opened_parent.st_ino),
            f"guest install parent changed while opening: {parent}",
        )
        current_root = os.lstat(root)
        require(
            stat.S_ISDIR(current_root.st_mode)
            and file_identity(current_root) == expected_root,
            f"guest install root changed before parent synchronization: {root}",
        )
        os.fsync(descriptor)
        after_parent = os.fstat(descriptor)
        require(
            file_identity(opened_parent) == file_identity(after_parent),
            f"guest install parent changed while synchronizing: {parent}",
        )
        current_root = os.lstat(root)
        require(
            stat.S_ISDIR(current_root.st_mode)
            and file_identity(current_root) == expected_root,
            f"guest install root changed during parent synchronization: {root}",
        )
    finally:
        os.close(descriptor)


def seal_installed_closure(root: Path) -> str:
    """Synchronize and replay the exact closure before its receipt is admitted."""

    root = Path(os.path.realpath(root))
    files = closure_files(root)
    directories = directory_closure(files)
    sealed_records: list[FileRecord] = []
    for relative in files:
        size, file_digest, entry_identity = read_regular(
            root / relative, synchronize=True
        )
        sealed_records.append((relative, size, file_digest, entry_identity))

    directory_identities = synchronize_directories(root, directories)
    synchronize_root_entry(root, directory_identities["."])

    # Replay both namespace and inode/content identity after the durability
    # barriers.  This rejects a file replacement that happens to preserve the
    # same bytes but whose new directory entry was never synchronized.
    require(
        closure_files(root) == files,
        "guest installed closure inventory changed while synchronizing",
    )
    replayed_records: list[FileRecord] = []
    for relative in files:
        size, file_digest, entry_identity = read_regular(root / relative)
        replayed_records.append((relative, size, file_digest, entry_identity))
    require(
        replayed_records == sealed_records,
        "guest installed closure changed after synchronization",
    )
    for relative, expected_identity in directory_identities.items():
        path = root if relative == "." else root / relative
        current = os.lstat(path)
        require(
            stat.S_ISDIR(current.st_mode)
            and file_identity(current) == expected_identity,
            f"guest closure parent changed after synchronization: {path}",
        )

    identity_records = [
        (relative, size, file_digest)
        for relative, size, file_digest, _ in sealed_records
    ]
    return installed_closure_identity_from_records(identity_records)


def main(arguments: list[str]) -> int:
    try:
        if len(arguments) != 2 or arguments[0] not in {"identity", "seal-identity"}:
            raise ProvenanceError(
                "usage: guest-build-provenance.py {identity|seal-identity} INSTALL_ROOT"
            )
        root = Path(arguments[1])
        if arguments[0] == "seal-identity":
            print(seal_installed_closure(root))
        else:
            print(installed_closure_identity(root))
        return 0
    except (OSError, ProvenanceError) as error:
        print(f"guest build provenance failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
