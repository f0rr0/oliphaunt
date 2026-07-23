#!/usr/bin/env python3
"""Validate and safely extract a pinned .tar.gz source archive.

The standard tar CLI intentionally accepts archive features that are unsafe for
an unattended source bootstrap.  This helper implements the much smaller
archive format Oliphaunt needs: one explicitly pinned root containing regular
files, directories, and links that remain inside that root.
"""

from __future__ import annotations

import argparse
import os
import posixpath
import shutil
import stat
import sys
import tarfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


MAX_MEMBERS = 200_000
MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
MAX_EXPANSION_RATIO = 200
MIN_EXPANSION_ALLOWANCE = 64 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024
RESERVED_ROOT_ENTRIES = {".git", ".oliphaunt-source-pin"}
WINDOWS_RESERVED_NAMES = {
    "con",
    "prn",
    "aux",
    "nul",
    *(f"com{index}" for index in range(1, 10)),
    *(f"lpt{index}" for index in range(1, 10)),
}


class UnsafeArchive(ValueError):
    pass


@dataclass(frozen=True)
class CheckedMember:
    info: tarfile.TarInfo
    relative: str
    link_target: str | None = None


def _reject_control_characters(value: str, label: str) -> None:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise UnsafeArchive(f"{label} contains a control character")


def _validate_prefix(prefix: str) -> None:
    _validate_member_name(prefix, "strip prefix")
    if "/" in prefix:
        raise UnsafeArchive("strip prefix must be one portable top-level directory name")


def _validate_member_name(name: str, label: str) -> tuple[str, ...]:
    if not name:
        raise UnsafeArchive(f"{label} is empty")
    _reject_control_characters(name, label)
    if "\\" in name:
        raise UnsafeArchive(f"{label} contains a backslash")
    if name.startswith("/") or (len(name) >= 2 and name[1] == ":"):
        raise UnsafeArchive(f"{label} is absolute")

    normalized = name[:-1] if name.endswith("/") else name
    parts = tuple(normalized.split("/"))
    if not normalized or any(part in {"", ".", ".."} for part in parts):
        raise UnsafeArchive(f"{label} contains an empty, dot, or traversal component")
    if len(normalized.encode("utf-8")) > 4096:
        raise UnsafeArchive(f"{label} exceeds the portable path-length limit")
    for part in parts:
        if len(part.encode("utf-8")) > 255:
            raise UnsafeArchive(f"{label} has an oversized path component")
        if ":" in part or part.endswith((" ", ".")):
            raise UnsafeArchive(f"{label} is not portable to Windows filesystems")
        if part.split(".", 1)[0].casefold() in WINDOWS_RESERVED_NAMES:
            raise UnsafeArchive(f"{label} uses a reserved Windows device name")
    return parts


def _member_relative_path(name: str, prefix: str) -> str:
    parts = _validate_member_name(name, f"archive member {name!r}")
    if parts[0] != prefix:
        raise UnsafeArchive(
            f"archive member {name!r} is outside required root {prefix!r}"
        )
    return "/".join(parts[1:])


def _resolve_link_target(info: tarfile.TarInfo, prefix: str) -> str:
    target = info.linkname
    if not target:
        raise UnsafeArchive(f"archive link {info.name!r} has an empty target")
    _reject_control_characters(target, f"archive link target for {info.name!r}")
    if "\\" in target:
        raise UnsafeArchive(f"archive link {info.name!r} has a backslash target")
    if target.startswith("/") or (len(target) >= 2 and target[1] == ":"):
        raise UnsafeArchive(f"archive link {info.name!r} has an absolute target")

    if info.issym():
        combined = posixpath.join(posixpath.dirname(info.name), target)
    else:
        combined = target
    normalized = posixpath.normpath(combined)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise UnsafeArchive(f"archive link {info.name!r} escapes the archive root")
    relative = _member_relative_path(normalized, prefix)
    if relative == "":
        raise UnsafeArchive(f"archive link {info.name!r} targets the archive root")
    return relative


def checked_members(archive: Path, prefix: str) -> list[CheckedMember]:
    _validate_prefix(prefix)
    if not archive.is_file():
        raise UnsafeArchive(f"archive does not exist: {archive}")

    compressed_bytes = archive.stat().st_size
    expanded_limit = min(
        MAX_EXPANDED_BYTES,
        max(MIN_EXPANSION_ALLOWANCE, compressed_bytes * MAX_EXPANSION_RATIO),
    )
    checked: list[CheckedMember] = []
    by_path: dict[str, tarfile.TarInfo] = {}
    portable_paths: dict[str, str] = {}
    expanded_bytes = 0

    try:
        stream = tarfile.open(archive, mode="r:gz")
    except (OSError, tarfile.TarError) as error:
        raise UnsafeArchive(f"cannot open gzip tar archive: {error}") from error

    with stream:
        try:
            for index, info in enumerate(stream, start=1):
                if index > MAX_MEMBERS:
                    raise UnsafeArchive(
                        f"archive contains more than {MAX_MEMBERS} members"
                    )
                relative = _member_relative_path(info.name, prefix)
                if relative.split("/", 1)[0] in RESERVED_ROOT_ENTRIES:
                    raise UnsafeArchive(
                        f"archive member {info.name!r} uses a reserved source-spine path"
                    )
                if relative in by_path:
                    raise UnsafeArchive(f"archive contains duplicate path {info.name!r}")
                portable_key = unicodedata.normalize("NFC", relative).casefold()
                if portable_key in portable_paths:
                    raise UnsafeArchive(
                        f"archive paths {portable_paths[portable_key]!r} and {info.name!r} collide on a portable filesystem"
                    )
                portable_paths[portable_key] = info.name
                if info.mode & (stat.S_ISUID | stat.S_ISGID):
                    raise UnsafeArchive(f"archive member {info.name!r} has set-id mode bits")
                if not (info.isdir() or info.isreg() or info.issym() or info.islnk()):
                    raise UnsafeArchive(
                        f"archive member {info.name!r} has unsupported type {info.type!r}"
                    )
                if info.isreg():
                    if info.size < 0 or info.size > MAX_MEMBER_BYTES:
                        raise UnsafeArchive(
                            f"archive member {info.name!r} exceeds the per-file size limit"
                        )
                    expanded_bytes += info.size
                    if expanded_bytes > expanded_limit:
                        raise UnsafeArchive(
                            "archive exceeds the bounded expanded-size allowance "
                            f"({expanded_limit} bytes)"
                        )

                link_target = (
                    _resolve_link_target(info, prefix)
                    if info.issym() or info.islnk()
                    else None
                )
                by_path[relative] = info
                checked.append(CheckedMember(info, relative, link_target))
        except (OSError, tarfile.TarError) as error:
            raise UnsafeArchive(f"cannot read gzip tar archive: {error}") from error

    if not checked:
        raise UnsafeArchive("archive is empty")

    for member in checked:
        relative = member.relative
        if relative:
            parts = PurePosixPath(relative).parts
            for depth in range(1, len(parts)):
                ancestor = "/".join(parts[:depth])
                ancestor_info = by_path.get(ancestor)
                if ancestor_info is not None and not ancestor_info.isdir():
                    raise UnsafeArchive(
                        f"archive path {member.info.name!r} descends through non-directory {ancestor!r}"
                    )
        if member.link_target is not None:
            target = by_path.get(member.link_target)
            if target is None:
                raise UnsafeArchive(
                    f"archive link {member.info.name!r} has missing target {member.info.linkname!r}"
                )
            if member.info.islnk() and not target.isreg():
                raise UnsafeArchive(
                    f"archive hard link {member.info.name!r} does not target a regular file"
                )

    return checked


def _safe_parent(destination: Path, relative: str) -> Path:
    parent = destination.joinpath(*PurePosixPath(relative).parts).parent
    current = destination
    for part in parent.relative_to(destination).parts:
        current = current / part
        if current.exists() or current.is_symlink():
            mode = current.lstat().st_mode
            if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
                raise UnsafeArchive(f"extraction ancestor is not a real directory: {current}")
        else:
            current.mkdir(mode=0o755)
    return parent


def extract_archive(archive: Path, destination: Path, prefix: str) -> None:
    members = checked_members(archive, prefix)
    if destination.exists() or destination.is_symlink():
        raise UnsafeArchive(f"extraction destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir(mode=0o755)

    try:
        with tarfile.open(archive, mode="r:gz") as stream:
            by_name = {member.info.name: member.info for member in members}
            for member in members:
                relative = member.relative
                if relative == "" or member.info.issym() or member.info.islnk():
                    continue
                output = destination.joinpath(*PurePosixPath(relative).parts)
                _safe_parent(destination, relative)
                if member.info.isdir():
                    if output.exists() or output.is_symlink():
                        if not output.is_dir() or output.is_symlink():
                            raise UnsafeArchive(f"cannot create archive directory {relative!r}")
                    else:
                        output.mkdir(mode=(member.info.mode & 0o755) | 0o700)
                    continue

                source_info = by_name[member.info.name]
                source = stream.extractfile(source_info)
                if source is None:
                    raise UnsafeArchive(f"cannot read archive file {member.info.name!r}")
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(output, flags, (member.info.mode & 0o755) | 0o600)
                copied = 0
                try:
                    with source, os.fdopen(descriptor, "wb") as sink:
                        descriptor = -1
                        while True:
                            block = source.read(COPY_CHUNK_BYTES)
                            if not block:
                                break
                            copied += len(block)
                            if copied > member.info.size:
                                raise UnsafeArchive(
                                    f"archive file {member.info.name!r} exceeded declared size"
                                )
                            sink.write(block)
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                if copied != member.info.size:
                    raise UnsafeArchive(
                        f"archive file {member.info.name!r} was truncated during extraction"
                    )

            # Hard links first, then symlinks. Validation guarantees that link
            # targets are members and no later member can descend through them.
            for member in members:
                if not member.info.islnk():
                    continue
                output = destination.joinpath(*PurePosixPath(member.relative).parts)
                target = destination.joinpath(*PurePosixPath(member.link_target or "").parts)
                _safe_parent(destination, member.relative)
                os.link(target, output, follow_symlinks=False)
            for member in members:
                if not member.info.issym():
                    continue
                output = destination.joinpath(*PurePosixPath(member.relative).parts)
                _safe_parent(destination, member.relative)
                # Use the validated original relative spelling so symlink
                # semantics are preserved without ever dereferencing it here.
                os.symlink(member.info.linkname, output)
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("validate", "extract"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("prefix")
    parser.add_argument("destination", type=Path, nargs="?")
    args = parser.parse_args()
    if args.mode == "extract" and args.destination is None:
        parser.error("extract requires a destination")
    if args.mode == "validate" and args.destination is not None:
        parser.error("validate does not accept a destination")
    return args


def main() -> int:
    args = parse_args()
    try:
        if args.mode == "validate":
            checked_members(args.archive, args.prefix)
        else:
            extract_archive(args.archive, args.destination, args.prefix)
    except (OSError, UnsafeArchive, tarfile.TarError) as error:
        print(f"unsafe source archive: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
