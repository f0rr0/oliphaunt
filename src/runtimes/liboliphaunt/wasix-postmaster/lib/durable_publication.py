#!/usr/bin/env python3

"""Publish bounded evidence files with an admission-last durability contract.

The source and destination of ``publish`` must be regular files in the same
non-symlink directory.  The source is synchronized before an atomic hard-link
creates the destination without replacement.  The directory is synchronized
while both names exist, then the private source name is removed and the
directory is synchronized again.  A crash can therefore leave either no
admission name, the admitted destination, or the destination plus a harmless
private source name; it cannot replace an existing admission record.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import stat
import sys
from pathlib import Path
from typing import BinaryIO, NamedTuple, Sequence


MAX_COMPARISON_BYTES = 16 * 1024 * 1024
MAX_PUBLICATION_BYTES = 256 * 1024 * 1024
FileIdentity = tuple[int, int]
OPEN_REGULAR_FLAGS = (
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
)
OPEN_DIRECTORY_FLAGS = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)


class PublicationError(Exception):
    pass


class PublicationSource(NamedTuple):
    """Exact sealed private generation intended for public admission."""

    device: int
    inode: int
    size: int
    sha256: str

    @property
    def file_identity(self) -> FileIdentity:
        return self.device, self.inode

    def token(self) -> str:
        return f"{self.device}\t{self.inode}\t{self.size}\t{self.sha256}"


def parse_source_token(values: Sequence[str]) -> PublicationSource:
    require(len(values) == 4, "identified publication requires four source fields")
    device_text, inode_text, size_text, digest = values
    for label, value in (
        ("device", device_text),
        ("inode", inode_text),
        ("size", size_text),
    ):
        require(
            value.isascii()
            and value.isdecimal()
            and (len(value) == 1 or not value.startswith("0")),
            f"identified publication {label} is not canonical unsigned decimal",
        )
    device = int(device_text)
    inode = int(inode_text)
    size = int(size_text)
    require(device > 0, "identified publication device must be positive")
    require(inode > 0, "identified publication inode must be positive")
    require(
        0 <= size <= MAX_PUBLICATION_BYTES,
        "identified publication size is outside the supported range",
    )
    require(
        re.fullmatch(r"[0-9a-f]{64}", digest) is not None,
        "identified publication SHA-256 is malformed",
    )
    return PublicationSource(device, inode, size, digest)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PublicationError(message)


def identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


class AnchoredDirectory:
    def __init__(self, path: Path) -> None:
        self.path = Path(os.path.abspath(path))
        before = os.lstat(self.path)
        require(
            stat.S_ISDIR(before.st_mode) and not stat.S_ISLNK(before.st_mode),
            f"publication parent is not a non-symlink directory: {self.path}",
        )
        self.fd = os.open(self.path, OPEN_DIRECTORY_FLAGS)
        try:
            opened = os.fstat(self.fd)
            require(
                stat.S_ISDIR(opened.st_mode)
                and (before.st_dev, before.st_ino) == (opened.st_dev, opened.st_ino),
                f"publication parent changed while opening: {self.path}",
            )
        except BaseException:
            os.close(self.fd)
            raise

    def close(self) -> None:
        os.close(self.fd)

    def __enter__(self) -> "AnchoredDirectory":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def fsync(self) -> None:
        os.fsync(self.fd)

    def lstat(self, name: str) -> os.stat_result | None:
        try:
            return os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            return None

    def open_regular(self, name: str) -> tuple[int, os.stat_result]:
        before = self.lstat(name)
        require(before is not None, f"publication source is missing: {self.path / name}")
        require(
            stat.S_ISREG(before.st_mode),
            f"publication source is not regular: {self.path / name}",
        )
        descriptor = os.open(name, OPEN_REGULAR_FLAGS, dir_fd=self.fd)
        opened = os.fstat(descriptor)
        current = self.lstat(name)
        if not (
            stat.S_ISREG(opened.st_mode)
            and identity(before) == identity(opened)
            and current is not None
            and identity(current) == identity(opened)
        ):
            os.close(descriptor)
            raise PublicationError(
                f"publication source changed while opening: {self.path / name}"
            )
        return descriptor, opened


def split_same_parent(source: Path, destination: Path) -> tuple[Path, str, str]:
    source = Path(os.path.abspath(source))
    destination = Path(os.path.abspath(destination))
    require(source != destination, "publication source and destination must differ")
    require(
        source.parent == destination.parent,
        "publication source and destination must share one directory",
    )
    require(source.name not in {"", ".", ".."}, "invalid publication source name")
    require(
        destination.name not in {"", ".", ".."},
        "invalid publication destination name",
    )
    return source.parent, source.name, destination.name


def descriptor_sha256(descriptor: int, expected_size: int) -> str:
    require(
        expected_size <= MAX_PUBLICATION_BYTES,
        f"publication source exceeds {MAX_PUBLICATION_BYTES} bytes",
    )
    os.lseek(descriptor, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    remaining = expected_size
    while remaining:
        chunk = os.read(descriptor, min(remaining, 1024 * 1024))
        require(chunk != b"", "publication source was truncated while hashing")
        digest.update(chunk)
        remaining -= len(chunk)
    require(os.read(descriptor, 1) == b"", "publication source grew while hashing")
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest()


def publish_identified(
    source: Path,
    destination: Path,
    expected: PublicationSource,
) -> None:
    """Admit only the exact private generation described by ``expected``."""

    parent, source_name, destination_name = split_same_parent(source, destination)
    with AnchoredDirectory(parent) as directory:
        require(
            directory.lstat(destination_name) is None,
            f"publication destination already exists: {destination}",
        )
        source_descriptor, source_metadata = directory.open_regular(source_name)
        require(
            stat.S_IMODE(source_metadata.st_mode) == 0o444,
            f"publication source is not sealed read-only: {source}",
        )
        require(
            (source_metadata.st_dev, source_metadata.st_ino)
            == expected.file_identity
            and source_metadata.st_size == expected.size,
            f"publication source generation differs from intended source: {source}",
        )
        linked = False
        linked_destination_identity: tuple[int, int] | None = None
        committed = False
        try:
            source_digest = descriptor_sha256(
                source_descriptor, source_metadata.st_size
            )
            require(
                source_digest == expected.sha256,
                f"publication source contents differ from intended source: {source}",
            )
            os.fsync(source_descriptor)
            os.link(
                source_name,
                destination_name,
                src_dir_fd=directory.fd,
                dst_dir_fd=directory.fd,
                follow_symlinks=False,
            )
            linked = True
            linked_destination_metadata = directory.lstat(destination_name)
            require(
                linked_destination_metadata is not None,
                f"published destination disappeared: {destination}",
            )
            linked_destination_identity = (
                linked_destination_metadata.st_dev,
                linked_destination_metadata.st_ino,
            )
            destination_descriptor, destination_metadata = directory.open_regular(
                destination_name
            )
            try:
                require(
                    (source_metadata.st_dev, source_metadata.st_ino)
                    == (destination_metadata.st_dev, destination_metadata.st_ino),
                    f"published destination identity differs: {destination}",
                )
                current_source = os.fstat(source_descriptor)
                require(
                    (
                        current_source.st_dev,
                        current_source.st_ino,
                        current_source.st_mode,
                        current_source.st_size,
                        current_source.st_mtime_ns,
                    )
                    == (
                        source_metadata.st_dev,
                        source_metadata.st_ino,
                        source_metadata.st_mode,
                        source_metadata.st_size,
                        source_metadata.st_mtime_ns,
                    ),
                    f"publication source changed before commit: {source}",
                )
                require(
                    descriptor_sha256(source_descriptor, current_source.st_size)
                    == source_digest,
                    f"publication source contents changed before commit: {source}",
                )
                os.fsync(destination_descriptor)
            finally:
                os.close(destination_descriptor)

            # This is the commit point.  Once the directory synchronization
            # completes, the public admission name durably identifies the
            # exact fsynced inode even if cleanup is interrupted.
            directory.fsync()
            committed = True
        except FileExistsError as error:
            raise PublicationError(
                f"publication destination appeared concurrently: {destination}"
            ) from error
        finally:
            os.close(source_descriptor)
            if linked and not committed:
                current_destination = directory.lstat(destination_name)
                if (
                    current_destination is not None
                    and linked_destination_identity is not None
                    and (
                        current_destination.st_dev,
                        current_destination.st_ino,
                    )
                    == linked_destination_identity
                ):
                    os.unlink(destination_name, dir_fd=directory.fd)
                    directory.fsync()

        current_source = directory.lstat(source_name)
        require(
            current_source is not None
            and stat.S_ISREG(current_source.st_mode)
            and (current_source.st_dev, current_source.st_ino)
            == (source_metadata.st_dev, source_metadata.st_ino),
            f"private source changed after publication commit: {source}",
        )
        os.unlink(source_name, dir_fd=directory.fd)
        directory.fsync()


def publication_source(path: Path) -> PublicationSource:
    """Capture the exact current sealed source generation for admission."""

    metadata, digest = stable_regular_digest(path)
    require(
        stat.S_IMODE(metadata.st_mode) == 0o444,
        f"publication source is not sealed read-only: {path}",
    )
    return PublicationSource(
        device=metadata.st_dev,
        inode=metadata.st_ino,
        size=metadata.st_size,
        sha256=digest,
    )


def publish(source: Path, destination: Path) -> None:
    """Capture and admit the source generation current at function entry."""

    publish_identified(source, destination, publication_source(source))


def _require_existing_destination(
    destination: Path,
    expected: PublicationSource,
) -> None:
    destination = Path(os.path.abspath(destination))
    with AnchoredDirectory(destination.parent) as directory:
        descriptor, metadata = directory.open_regular(destination.name)
        try:
            require(
                stat.S_IMODE(metadata.st_mode) == 0o444,
                f"publication set destination is not sealed read-only: {destination}",
            )
            require(
                metadata.st_size == expected.size
                and descriptor_sha256(descriptor, metadata.st_size)
                == expected.sha256,
                f"publication set destination differs: {destination}",
            )
            os.fsync(descriptor)
            directory.fsync()
        finally:
            os.close(descriptor)


def publish_set(
    paths: Sequence[Path],
    expected_sources: Sequence[PublicationSource] | None = None,
) -> None:
    """Idempotently admit a same-directory set without replacing any member.

    Each destination is independently admission-last and readers must require
    the complete set.  If a process stops between members, replay with the same
    sealed sources verifies already-admitted members and completes the set;
    different content fails closed.
    """

    require(
        len(paths) >= 4 and len(paths) % 2 == 0,
        "publication set requires at least two SOURCE DESTINATION pairs",
    )
    pairs = [
        (Path(paths[index]), Path(paths[index + 1]))
        for index in range(0, len(paths), 2)
    ]
    parents: set[Path] = set()
    source_paths: set[Path] = set()
    destination_paths: set[Path] = set()
    for source, destination in pairs:
        parent, _, _ = split_same_parent(source, destination)
        absolute_source = Path(os.path.abspath(source))
        absolute_destination = Path(os.path.abspath(destination))
        parents.add(parent)
        require(
            absolute_source not in source_paths,
            f"duplicate publication source: {source}",
        )
        require(
            absolute_destination not in destination_paths,
            f"duplicate publication destination: {destination}",
        )
        source_paths.add(absolute_source)
        destination_paths.add(absolute_destination)
    require(len(parents) == 1, "publication set must share one directory")
    require(
        source_paths.isdisjoint(destination_paths),
        "publication set source and destination names must be disjoint",
    )

    if expected_sources is None:
        sources = [publication_source(source) for source, _ in pairs]
    else:
        require(
            len(expected_sources) == len(pairs),
            "identified publication set source count differs",
        )
        sources = list(expected_sources)
        for (source, _), expected in zip(pairs, sources, strict=True):
            require(
                publication_source(source) == expected,
                f"publication set source generation differs: {source}",
            )

    # Reject every conflicting existing member before admitting any missing
    # one. A bad later destination must not create a new partial set.
    for (_, destination), expected in zip(pairs, sources, strict=True):
        try:
            os.lstat(destination)
        except FileNotFoundError:
            continue
        _require_existing_destination(destination, expected)

    for (source, destination), expected in zip(pairs, sources, strict=True):
        try:
            publish_identified(source, destination, expected)
        except (OSError, PublicationError):
            # A prior replay or a concurrent identical publisher may already
            # own this admission name. Accept it only byte-for-byte, then
            # remove our private replay source before advancing the set.
            _require_existing_destination(destination, expected)
            absolute_source = Path(os.path.abspath(source))
            try:
                os.lstat(absolute_source)
            except FileNotFoundError:
                pass
            else:
                remove_private(
                    absolute_source,
                    expected,
                )


def _write_stream(path: Path, source: BinaryIO) -> PublicationSource:
    """Create one private, fsynced, read-only file without following links."""

    path = Path(os.path.abspath(path))
    with AnchoredDirectory(path.parent) as directory:
        require(
            directory.lstat(path.name) is None,
            f"private publication path already exists: {path}",
        )
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        descriptor = os.open(path.name, flags, 0o600, dir_fd=directory.fd)
        opened = os.fstat(descriptor)
        try:
            total = 0
            digest = hashlib.sha256()
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                require(
                    total <= MAX_PUBLICATION_BYTES,
                    f"private publication input exceeds {MAX_PUBLICATION_BYTES} bytes",
                )
                digest.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(descriptor, view)
                    require(written > 0, f"short write to private publication: {path}")
                    view = view[written:]
            os.fchmod(descriptor, 0o444)
            os.fsync(descriptor)
            final = os.fstat(descriptor)
            require(
                stat.S_ISREG(final.st_mode)
                and (opened.st_dev, opened.st_ino) == (final.st_dev, final.st_ino)
                and final.st_size == total,
                f"private publication changed while writing: {path}",
            )
            current = directory.lstat(path.name)
            require(
                current is not None
                and stat.S_ISREG(current.st_mode)
                and (current.st_dev, current.st_ino) == (final.st_dev, final.st_ino),
                f"private publication path changed while writing: {path}",
            )
        except BaseException:
            try:
                current = directory.lstat(path.name)
                if current is not None and (
                    current.st_dev,
                    current.st_ino,
                ) == (opened.st_dev, opened.st_ino):
                    os.unlink(path.name, dir_fd=directory.fd)
                    directory.fsync()
            finally:
                os.close(descriptor)
            raise
        os.close(descriptor)
        return PublicationSource(
            device=final.st_dev,
            inode=final.st_ino,
            size=final.st_size,
            sha256=digest.hexdigest(),
        )


def write_bytes(path: Path, payload: bytes) -> PublicationSource:
    """Create one private durable publication from bounded in-memory bytes."""

    require(
        len(payload) <= MAX_PUBLICATION_BYTES,
        f"private publication input exceeds {MAX_PUBLICATION_BYTES} bytes",
    )
    return _write_stream(path, io.BytesIO(payload))


def write_stdin(path: Path) -> PublicationSource:
    """Create one private durable publication from standard input."""

    return _write_stream(path, sys.stdin.buffer)


def stable_regular_bytes(path: Path) -> bytes:
    path = Path(os.path.abspath(path))
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode), f"comparison input is not regular: {path}")
    require(
        before.st_size <= MAX_COMPARISON_BYTES,
        f"comparison input exceeds {MAX_COMPARISON_BYTES} bytes: {path}",
    )
    descriptor = os.open(path, OPEN_REGULAR_FLAGS)
    try:
        opened = os.fstat(descriptor)
        current_after_open = os.lstat(path)
        require(
            stat.S_ISREG(opened.st_mode)
            and identity(before) == identity(opened)
            and identity(current_after_open) == identity(opened),
            f"comparison input changed while opening: {path}",
        )
        require(
            opened.st_size <= MAX_COMPARISON_BYTES,
            f"comparison input exceeds {MAX_COMPARISON_BYTES} bytes: {path}",
        )
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            require(chunk != b"", f"comparison input was truncated: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        require(os.read(descriptor, 1) == b"", f"comparison input grew: {path}")
        after = os.fstat(descriptor)
        require(identity(opened) == identity(after), f"comparison input changed: {path}")
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    require(
        stat.S_ISREG(current.st_mode)
        and identity(current) == identity(after),
        f"comparison input was replaced: {path}",
    )
    return b"".join(chunks)


def stable_regular_digest(path: Path) -> tuple[os.stat_result, str]:
    """Hash one stable regular file without retaining its contents in memory."""

    path = Path(os.path.abspath(path))
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode), f"digest input is not regular: {path}")
    require(
        before.st_size <= MAX_PUBLICATION_BYTES,
        f"digest input exceeds {MAX_PUBLICATION_BYTES} bytes: {path}",
    )
    descriptor = os.open(path, OPEN_REGULAR_FLAGS)
    try:
        opened = os.fstat(descriptor)
        current_after_open = os.lstat(path)
        require(
            stat.S_ISREG(opened.st_mode)
            and identity(before) == identity(opened)
            and identity(current_after_open) == identity(opened),
            f"digest input changed while opening: {path}",
        )
        digest = descriptor_sha256(descriptor, opened.st_size)
        after = os.fstat(descriptor)
        require(identity(opened) == identity(after), f"digest input changed: {path}")
    finally:
        os.close(descriptor)
    current = os.lstat(path)
    require(
        stat.S_ISREG(current.st_mode) and identity(current) == identity(after),
        f"digest input was replaced: {path}",
    )
    return after, digest


def require_equal(left: Path, right: Path) -> None:
    require(
        stable_regular_bytes(left) == stable_regular_bytes(right),
        f"regular files differ: {left} != {right}",
    )


def remove_private(
    path: Path,
    expected_identity: FileIdentity | PublicationSource,
) -> None:
    """Remove only the private generation identified by ``expected_identity``."""

    path = Path(os.path.abspath(path))
    with AnchoredDirectory(path.parent) as directory:
        metadata = directory.lstat(path.name)
        if metadata is None:
            return
        require(
            stat.S_ISREG(metadata.st_mode),
            f"private publication path is not regular: {path}",
        )
        wanted = (
            expected_identity.file_identity
            if isinstance(expected_identity, PublicationSource)
            else expected_identity
        )
        require(
            (metadata.st_dev, metadata.st_ino) == wanted,
            f"private publication generation changed: {path}",
        )
        os.unlink(path.name, dir_fd=directory.fd)
        directory.fsync()


def discard_private(path: Path) -> None:
    """Discard a private name in a caller-owned, exclusively held namespace."""

    path = Path(os.path.abspath(path))
    try:
        metadata = os.lstat(path)
    except FileNotFoundError:
        return
    remove_private(path, (metadata.st_dev, metadata.st_ino))


def fsync_directory(path: Path) -> None:
    with AnchoredDirectory(path) as directory:
        directory.fsync()


def main(arguments: list[str]) -> int:
    try:
        if len(arguments) == 3 and arguments[0] == "publish":
            publish(Path(arguments[1]), Path(arguments[2]))
        elif len(arguments) == 7 and arguments[0] == "publish-identified":
            publish_identified(
                Path(arguments[1]),
                Path(arguments[2]),
                parse_source_token(arguments[3:]),
            )
        elif (
            len(arguments) >= 5
            and len(arguments) % 2 == 1
            and arguments[0] == "publish-set"
        ):
            publish_set(tuple(Path(argument) for argument in arguments[1:]))
        elif (
            len(arguments) >= 13
            and (len(arguments) - 1) % 6 == 0
            and arguments[0] == "publish-set-identified"
        ):
            paths: list[Path] = []
            sources: list[PublicationSource] = []
            for index in range(1, len(arguments), 6):
                paths.extend((Path(arguments[index]), Path(arguments[index + 1])))
                sources.append(parse_source_token(arguments[index + 2 : index + 6]))
            publish_set(paths, sources)
        elif len(arguments) == 2 and arguments[0] == "write-stdin":
            write_stdin(Path(arguments[1]))
        elif len(arguments) == 2 and arguments[0] == "write-stdin-identified":
            print(write_stdin(Path(arguments[1])).token())
        elif len(arguments) == 2 and arguments[0] == "identify-source":
            print(publication_source(Path(arguments[1])).token())
        elif len(arguments) == 3 and arguments[0] == "require-equal":
            require_equal(Path(arguments[1]), Path(arguments[2]))
        elif len(arguments) == 2 and arguments[0] == "discard-private":
            discard_private(Path(arguments[1]))
        elif len(arguments) == 6 and arguments[0] == "remove-private-identified":
            remove_private(
                Path(arguments[1]), parse_source_token(arguments[2:])
            )
        elif len(arguments) == 2 and arguments[0] == "fsync-directory":
            fsync_directory(Path(arguments[1]))
        else:
            raise PublicationError(
                "usage: durable_publication.py "
                "{publish SOURCE DESTINATION|"
                "publish-identified SOURCE DESTINATION DEVICE INODE SIZE SHA256|"
                "publish-set SOURCE DESTINATION SOURCE DESTINATION [...]|"
                "publish-set-identified SOURCE DESTINATION DEVICE INODE SIZE SHA256 [...]|"
                "require-equal LEFT RIGHT|"
                "write-stdin PATH|write-stdin-identified PATH|identify-source PATH|"
                "discard-private PATH|remove-private-identified PATH DEVICE INODE SIZE SHA256|"
                "fsync-directory DIRECTORY}"
            )
        return 0
    except (OSError, PublicationError) as error:
        print(f"durable publication failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
