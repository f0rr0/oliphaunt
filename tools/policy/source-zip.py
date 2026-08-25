#!/usr/bin/env python3
"""Validate and safely extract a pinned ZIP source archive.

This is the ZIP counterpart to source-archive.py.  It intentionally accepts
only the small portable subset needed by pinned upstream binary/data releases:
real directories and regular files, with no links or platform-special entries.
"""

from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
import unicodedata
import zipfile
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
    info: zipfile.ZipInfo
    relative: str
    directory: bool


def _reject_control_characters(value: str, label: str) -> None:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise UnsafeArchive(f"{label} contains a control character")


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
    if prefix == ".":
        return "/".join(parts)
    if parts[0] != prefix:
        raise UnsafeArchive(
            f"archive member {name!r} is outside required root {prefix!r}"
        )
    return "/".join(parts[1:])


def _member_kind(info: zipfile.ZipInfo) -> bool:
    directory = info.is_dir()
    unix_mode = info.external_attr >> 16
    file_type = stat.S_IFMT(unix_mode)
    if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
        raise UnsafeArchive(f"archive member {info.filename!r} has unsupported type")
    if directory and file_type == stat.S_IFREG:
        raise UnsafeArchive(f"archive directory {info.filename!r} has a regular-file mode")
    if not directory and file_type == stat.S_IFDIR:
        raise UnsafeArchive(f"archive file {info.filename!r} has a directory mode")
    return directory


def checked_members(archive: Path, prefix: str) -> list[CheckedMember]:
    if prefix != ".":
        prefix_parts = _validate_member_name(prefix, "strip prefix")
        if len(prefix_parts) != 1:
            raise UnsafeArchive("strip prefix must be one portable top-level directory name")
    if not archive.is_file():
        raise UnsafeArchive(f"archive does not exist: {archive}")

    compressed_bytes = archive.stat().st_size
    expanded_limit = min(
        MAX_EXPANDED_BYTES,
        max(MIN_EXPANSION_ALLOWANCE, compressed_bytes * MAX_EXPANSION_RATIO),
    )
    checked: list[CheckedMember] = []
    by_path: dict[str, CheckedMember] = {}
    portable_paths: dict[str, str] = {}
    expanded_bytes = 0

    try:
        stream = zipfile.ZipFile(archive, mode="r")
    except (OSError, zipfile.BadZipFile) as error:
        raise UnsafeArchive(f"cannot open ZIP archive: {error}") from error

    with stream:
        for index, info in enumerate(stream.infolist(), start=1):
            if index > MAX_MEMBERS:
                raise UnsafeArchive(f"archive contains more than {MAX_MEMBERS} members")
            if info.flag_bits & 0x1:
                raise UnsafeArchive(f"archive member {info.filename!r} is encrypted")
            if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise UnsafeArchive(
                    f"archive member {info.filename!r} uses unsupported compression"
                )
            relative = _member_relative_path(info.filename, prefix)
            if relative == "":
                continue
            if relative.split("/", 1)[0] in RESERVED_ROOT_ENTRIES:
                raise UnsafeArchive(
                    f"archive member {info.filename!r} uses a reserved source-spine path"
                )
            if relative in by_path:
                raise UnsafeArchive(f"archive contains duplicate path {info.filename!r}")
            portable_key = unicodedata.normalize("NFC", relative).casefold()
            if portable_key in portable_paths:
                raise UnsafeArchive(
                    f"archive paths {portable_paths[portable_key]!r} and {info.filename!r} collide on a portable filesystem"
                )
            portable_paths[portable_key] = info.filename
            directory = _member_kind(info)
            if not directory:
                if info.file_size < 0 or info.file_size > MAX_MEMBER_BYTES:
                    raise UnsafeArchive(
                        f"archive member {info.filename!r} exceeds the per-file size limit"
                    )
                expanded_bytes += info.file_size
                if expanded_bytes > expanded_limit:
                    raise UnsafeArchive(
                        "archive exceeds the bounded expanded-size allowance "
                        f"({expanded_limit} bytes)"
                    )
            member = CheckedMember(info, relative, directory)
            by_path[relative] = member
            checked.append(member)

    if not checked:
        raise UnsafeArchive("archive is empty")
    for member in checked:
        parts = PurePosixPath(member.relative).parts
        for depth in range(1, len(parts)):
            ancestor = by_path.get("/".join(parts[:depth]))
            if ancestor is not None and not ancestor.directory:
                raise UnsafeArchive(
                    f"archive path {member.info.filename!r} descends through a file"
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
        with zipfile.ZipFile(archive, mode="r") as stream:
            for member in members:
                output = destination.joinpath(*PurePosixPath(member.relative).parts)
                _safe_parent(destination, member.relative)
                if member.directory:
                    if output.exists() or output.is_symlink():
                        if not output.is_dir() or output.is_symlink():
                            raise UnsafeArchive(
                                f"cannot create archive directory {member.relative!r}"
                            )
                    else:
                        output.mkdir(mode=0o755)
                    continue
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                descriptor = os.open(output, flags, 0o600)
                try:
                    with os.fdopen(descriptor, "wb") as target:
                        descriptor = -1
                        with stream.open(member.info, mode="r") as source:
                            shutil.copyfileobj(source, target, COPY_CHUNK_BYTES)
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                if output.stat().st_size != member.info.file_size:
                    raise UnsafeArchive(
                        f"archive member {member.info.filename!r} extracted with the wrong size"
                    )
                output.chmod(0o644)
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "extract"))
    parser.add_argument("archive", type=Path)
    parser.add_argument("strip_prefix")
    parser.add_argument("destination", type=Path, nargs="?")
    args = parser.parse_args()
    if args.command == "validate":
        if args.destination is not None:
            parser.error("validate does not accept a destination")
        checked_members(args.archive, args.strip_prefix)
    else:
        if args.destination is None:
            parser.error("extract requires a destination")
        extract_archive(args.archive, args.destination, args.strip_prefix)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnsafeArchive, zipfile.BadZipFile) as error:
        print(f"source-zip.py: {error}", file=sys.stderr)
        raise SystemExit(1) from error
