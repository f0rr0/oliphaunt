#!/usr/bin/env python3
"""Fail-closed structural validation for a pinned Wasmer LLVM .tar.xz."""

from __future__ import annotations

import argparse
import posixpath
import stat
import tarfile
import unicodedata
from pathlib import Path


MAX_MEMBERS = 500_000
MAX_MEMBER_BYTES = 4 * 1024 * 1024 * 1024
MAX_EXPANDED_BYTES = 12 * 1024 * 1024 * 1024
MIN_EXPANDED_ALLOWANCE = 1024 * 1024 * 1024
MAX_EXPANSION_RATIO = 20
MAX_PATH_BYTES = 4096
MAX_COMPONENT_BYTES = 255
WINDOWS_RESERVED_NAMES = {
    "aux",
    "con",
    "nul",
    "prn",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
}


class UnsafeArchive(ValueError):
    pass


def normalized_path(value: str, label: str, *, allow_root: bool = False) -> str:
    if not value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise UnsafeArchive(f"{label} is empty or contains control characters")
    if "\\" in value or ":" in value or value.startswith("/"):
        raise UnsafeArchive(f"{label} is absolute or non-portable: {value!r}")
    while value.startswith("./"):
        value = value[2:]
    value = value.rstrip("/")
    if value in {"", "."}:
        if allow_root:
            return ""
        raise UnsafeArchive(f"{label} resolves to the archive root")
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise UnsafeArchive(f"{label} contains an empty, dot, or traversal component: {value!r}")
    for part in parts:
        encoded = part.encode("utf-8")
        if len(encoded) > MAX_COMPONENT_BYTES:
            raise UnsafeArchive(f"{label} contains a component longer than {MAX_COMPONENT_BYTES} UTF-8 bytes")
        if part.endswith((" ", ".")):
            raise UnsafeArchive(f"{label} contains a Windows-ambiguous trailing space or dot: {value!r}")
        windows_stem = part.split(".", 1)[0].casefold()
        if windows_stem in WINDOWS_RESERVED_NAMES:
            raise UnsafeArchive(f"{label} contains reserved Windows name {part!r}")
    normalized = "/".join(parts)
    if len(normalized.encode("utf-8")) > MAX_PATH_BYTES:
        raise UnsafeArchive(f"{label} is longer than {MAX_PATH_BYTES} UTF-8 bytes")
    return normalized


def portable_key(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def link_target(member: tarfile.TarInfo, member_path: str) -> str:
    target = member.linkname
    if not target or "\\" in target or target.startswith("/") or (len(target) > 1 and target[1] == ":"):
        raise UnsafeArchive(f"archive link {member.name!r} has an unsafe target {target!r}")
    if any(ord(character) < 32 or ord(character) == 127 for character in target):
        raise UnsafeArchive(f"archive link {member.name!r} has control characters in its target")
    combined = posixpath.join(posixpath.dirname(member_path), target) if member.issym() else target
    normalized = posixpath.normpath(combined)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise UnsafeArchive(f"archive link {member.name!r} escapes the extraction root")
    return normalized_path(normalized, f"archive link target for {member.name!r}")


def validate(archive: Path, expected_bytes: int) -> None:
    if not archive.is_file() or archive.stat().st_size != expected_bytes:
        actual = archive.stat().st_size if archive.exists() else "missing"
        raise UnsafeArchive(f"archive byte size is {actual}; expected exactly {expected_bytes}")
    expanded_limit = min(
        MAX_EXPANDED_BYTES,
        max(MIN_EXPANDED_ALLOWANCE, expected_bytes * MAX_EXPANSION_RATIO),
    )
    members: dict[str, tarfile.TarInfo] = {}
    portable_paths: dict[str, str] = {}
    links: list[tuple[tarfile.TarInfo, str, str]] = []
    link_targets: dict[str, str] = {}
    expanded_bytes = 0
    root_seen = False
    try:
        stream = tarfile.open(archive, mode="r:xz")
    except (OSError, tarfile.TarError) as error:
        raise UnsafeArchive(f"cannot open xz tar archive: {error}") from error
    with stream:
        try:
            for index, member in enumerate(stream, start=1):
                if index > MAX_MEMBERS:
                    raise UnsafeArchive(f"archive contains more than {MAX_MEMBERS} members")
                path = normalized_path(member.name, f"archive member {member.name!r}", allow_root=True)
                if path == "":
                    if not member.isdir():
                        raise UnsafeArchive("the archive root entry must be a directory")
                    if root_seen:
                        raise UnsafeArchive("archive contains duplicate root directory entries")
                    root_seen = True
                    continue
                if path in members:
                    raise UnsafeArchive(f"archive contains duplicate path {path!r}")
                parts = path.split("/")
                for depth in range(1, len(parts) + 1):
                    prefix = "/".join(parts[:depth])
                    key = portable_key(prefix)
                    prior = portable_paths.get(key)
                    if prior is not None and prior != prefix:
                        raise UnsafeArchive(
                            f"archive contains Unicode/case-colliding paths {prior!r} and {prefix!r}"
                        )
                    portable_paths[key] = prefix
                if member.mode & (stat.S_ISUID | stat.S_ISGID):
                    raise UnsafeArchive(f"archive member {path!r} has set-id mode bits")
                if not (member.isdir() or member.isreg() or member.issym() or member.islnk()):
                    raise UnsafeArchive(f"archive member {path!r} has unsupported type {member.type!r}")
                if member.isreg():
                    if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                        raise UnsafeArchive(f"archive member {path!r} exceeds the per-file size limit")
                    expanded_bytes += member.size
                    if expanded_bytes > expanded_limit:
                        raise UnsafeArchive(f"archive expands beyond the {expanded_limit}-byte allowance")
                members[path] = member
                if member.issym() or member.islnk():
                    target = link_target(member, path)
                    links.append((member, path, target))
                    link_targets[path] = target
        except (OSError, tarfile.TarError) as error:
            raise UnsafeArchive(f"cannot read xz tar archive: {error}") from error
    if not members:
        raise UnsafeArchive("archive contains no installable members")
    for path, member in members.items():
        parts = path.split("/")
        for depth in range(1, len(parts)):
            ancestor = members.get("/".join(parts[:depth]))
            if ancestor is not None and not ancestor.isdir():
                raise UnsafeArchive(f"archive member {path!r} descends through a non-directory")
    for member, path, target in links:
        target_member = members.get(target)
        if target_member is None:
            raise UnsafeArchive(f"archive link {path!r} targets missing member {target!r}")
        if member.islnk() and not target_member.isreg():
            raise UnsafeArchive(f"archive hard link {path!r} does not target a regular file")
    for _, path, _ in links:
        current = path
        visited: set[str] = set()
        while current in link_targets:
            if current in visited:
                raise UnsafeArchive(f"archive link {path!r} participates in a link cycle")
            visited.add(current)
            current = link_targets[current]
        resolved = members.get(current)
        if resolved is None or not (resolved.isreg() or resolved.isdir()):
            raise UnsafeArchive(f"archive link {path!r} does not resolve to a regular file or directory")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("expected_bytes", type=int)
    arguments = parser.parse_args()
    if arguments.expected_bytes < 1 or arguments.expected_bytes > 2 * 1024 * 1024 * 1024:
        raise UnsafeArchive("expected archive bytes must be between 1 and 2 GiB")
    validate(arguments.archive, arguments.expected_bytes)


if __name__ == "__main__":
    try:
        main()
    except (OSError, UnsafeArchive, tarfile.TarError) as error:
        raise SystemExit(f"unsafe Wasmer LLVM archive: {error}") from error
