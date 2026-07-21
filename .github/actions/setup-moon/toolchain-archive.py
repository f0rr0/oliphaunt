#!/usr/bin/env python3
"""Safely extract and fingerprint the pinned bootstrap tool archives."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import lzma
import os
import shutil
import stat
import sys
import tarfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Iterable


COPY_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 250 * 1024 * 1024
MAX_EXPANDED_BYTES = 750 * 1024 * 1024
MAX_ENTRY_BYTES = 250 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_TARGET_SCAN_ENTRIES = 8192
MAX_TARGET_SCAN_BYTES = 500 * 1024 * 1024
MAX_PATH_BYTES = 4096
MAX_COMPONENT_BYTES = 255
WINDOWS_RESERVED_NAMES = {
    "aux",
    "con",
    "nul",
    "prn",
    *(f"com{number}" for number in range(1, 10)),
    *(f"lpt{number}" for number in range(1, 10)),
    "com¹",
    "com²",
    "com³",
    "conin$",
    "conout$",
    "clock$",
    "lpt¹",
    "lpt²",
    "lpt³",
}


class UnsafeArchive(ValueError):
    pass


@dataclass(frozen=True)
class Entry:
    name: str
    relative: str
    size: int
    directory: bool
    executable: bool
    source: object


def portable_path(value: str, label: str, *, allow_root: bool = False) -> str:
    if not value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise UnsafeArchive(f"{label} is empty or contains control characters")
    if "\\" in value or value.startswith("/") or (len(value) > 1 and value[1] == ":"):
        raise UnsafeArchive(f"{label} is absolute or non-portable: {value!r}")
    normalized = value.rstrip("/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if normalized in {"", "."}:
        if allow_root:
            return ""
        raise UnsafeArchive(f"{label} resolves to the archive root")
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise UnsafeArchive(f"{label} contains an empty, dot, or traversal component")
    for part in parts:
        encoded = part.encode("utf-8")
        if len(encoded) > MAX_COMPONENT_BYTES:
            raise UnsafeArchive(f"{label} contains an oversized path component")
        if part.endswith((" ", ".")) or any(character in part for character in '<>:"|?*'):
            raise UnsafeArchive(f"{label} is ambiguous on Windows")
        if part.split(".", 1)[0].casefold() in WINDOWS_RESERVED_NAMES:
            raise UnsafeArchive(f"{label} contains a reserved Windows name")
    result = "/".join(parts)
    if len(result.encode("utf-8")) > MAX_PATH_BYTES:
        raise UnsafeArchive(f"{label} exceeds the portable path-length limit")
    return result


def relative_path(name: str, prefix: str, *, directory: bool) -> str:
    normalized = portable_path(name, f"archive member {name!r}", allow_root=directory)
    if prefix == ".":
        return normalized
    if normalized == prefix:
        if not directory:
            raise UnsafeArchive(f"archive root {prefix!r} is not a directory")
        return ""
    expected = f"{prefix}/"
    if not normalized.startswith(expected):
        raise UnsafeArchive(f"archive member {name!r} is outside required root {prefix!r}")
    return normalized[len(expected) :]


def validate_entries(
    entries: Iterable[Entry],
    *,
    expected_count: int,
    expected_expanded_bytes: int,
    required: set[str],
    executables: set[str],
) -> list[Entry]:
    checked = list(entries)
    if len(checked) != expected_count:
        raise UnsafeArchive(
            f"archive entry count mismatch: expected {expected_count}, got {len(checked)}"
        )
    paths: dict[str, Entry] = {}
    portable: dict[str, str] = {}
    expanded_bytes = 0
    for entry in checked:
        if entry.relative == "":
            continue
        if entry.relative in paths:
            raise UnsafeArchive(f"archive contains duplicate path {entry.relative!r}")
        parts = entry.relative.split("/")
        for depth in range(1, len(parts) + 1):
            candidate = "/".join(parts[:depth])
            key = unicodedata.normalize("NFC", candidate).casefold()
            prior = portable.get(key)
            if prior is not None and prior != candidate:
                raise UnsafeArchive(
                    f"archive paths {prior!r} and {candidate!r} collide on a portable filesystem"
                )
            portable[key] = candidate
        paths[entry.relative] = entry
        if not entry.directory:
            if entry.size < 0 or entry.size > MAX_ENTRY_BYTES:
                raise UnsafeArchive(f"archive member {entry.relative!r} exceeds its file-size bound")
            expanded_bytes += entry.size
            if expanded_bytes > MAX_EXPANDED_BYTES:
                raise UnsafeArchive("archive exceeds its expanded-size safety bound")
    if expanded_bytes != expected_expanded_bytes:
        raise UnsafeArchive(
            f"archive expanded byte-size mismatch: expected {expected_expanded_bytes}, got {expanded_bytes}"
        )
    missing = sorted(required - set(paths))
    if missing:
        raise UnsafeArchive(f"archive is missing required files: {', '.join(missing)}")
    for path in required:
        entry = paths[path]
        if entry.directory or entry.size == 0:
            raise UnsafeArchive(f"required archive path is not a non-empty regular file: {path}")
    actual_executables = {
        path for path, entry in paths.items() if not entry.directory and entry.executable
    }
    if actual_executables != executables:
        raise UnsafeArchive(
            "archive executable paths mismatch: expected "
            f"{sorted(executables)!r}, got {sorted(actual_executables)!r}"
        )
    for entry in checked:
        if entry.relative == "":
            continue
        parts = PurePosixPath(entry.relative).parts
        for depth in range(1, len(parts)):
            ancestor = paths.get("/".join(parts[:depth]))
            if ancestor is not None and not ancestor.directory:
                raise UnsafeArchive(
                    f"archive path {entry.relative!r} descends through a regular file"
                )
    return checked


def tar_entries(archive: tarfile.TarFile, prefix: str, entry_limit: int) -> list[Entry]:
    result: list[Entry] = []
    for member in archive:
        if len(result) >= entry_limit:
            raise UnsafeArchive("tar archive exceeds its entry-count bound")
        if member.mode & (stat.S_ISUID | stat.S_ISGID):
            raise UnsafeArchive(f"archive member {member.name!r} has set-id mode bits")
        if not (member.isdir() or member.isreg()):
            raise UnsafeArchive(f"archive member {member.name!r} is not a regular file or directory")
        if member.isdir() and member.size != 0:
            raise UnsafeArchive(f"archive directory {member.name!r} has a non-zero payload")
        relative = relative_path(member.name, prefix, directory=member.isdir())
        result.append(
            Entry(
                member.name,
                relative,
                member.size if member.isreg() else 0,
                member.isdir(),
                bool(member.mode & 0o111),
                member,
            )
        )
    return result


def zip_entries(archive: zipfile.ZipFile, prefix: str, entry_limit: int) -> list[Entry]:
    result: list[Entry] = []
    members = archive.infolist()
    if len(members) > entry_limit:
        raise UnsafeArchive("ZIP archive exceeds its entry-count bound")
    for member in members:
        mode = (member.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(mode)
        directory = member.is_dir() or file_type == stat.S_IFDIR
        if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise UnsafeArchive(f"archive member {member.filename!r} is not a regular file or directory")
        if bool(member.is_dir()) != directory:
            raise UnsafeArchive(f"archive member {member.filename!r} has inconsistent directory metadata")
        if directory and (member.file_size != 0 or member.compress_size != 0):
            raise UnsafeArchive(f"archive directory {member.filename!r} has a non-zero payload")
        if member.flag_bits & 0x1:
            raise UnsafeArchive(f"archive member {member.filename!r} is encrypted")
        if member.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
            raise UnsafeArchive(f"archive member {member.filename!r} uses unsupported compression")
        relative = relative_path(member.filename, prefix, directory=directory)
        result.append(
            Entry(
                member.filename,
                relative,
                member.file_size if not directory else 0,
                directory,
                bool(mode & 0o111),
                member,
            )
        )
    return result


def safe_parent(destination: Path, relative: str) -> Path:
    parent = destination.joinpath(*PurePosixPath(relative).parts).parent
    current = destination
    for part in parent.relative_to(destination).parts:
        current /= part
        if current.exists() or current.is_symlink():
            mode = current.lstat().st_mode
            if not stat.S_ISDIR(mode) or stat.S_ISLNK(mode):
                raise UnsafeArchive(f"extraction ancestor is not a real directory: {current}")
        else:
            current.mkdir(mode=0o755)
    return parent


def copy_regular(source: BinaryIO, output: Path, expected_bytes: int, executable: bool) -> None:
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    copied = 0
    try:
        with source, os.fdopen(descriptor, "wb") as sink:
            descriptor = -1
            while True:
                block = source.read(COPY_BYTES)
                if not block:
                    break
                copied += len(block)
                if copied > expected_bytes:
                    raise UnsafeArchive(f"archive member {output.name!r} exceeded its declared size")
                sink.write(block)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if copied != expected_bytes:
        raise UnsafeArchive(f"archive member {output.name!r} was truncated")
    os.chmod(output, 0o755 if executable else 0o644)


def read_exact(stream: BinaryIO, size: int, label: str) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise UnsafeArchive(f"truncated {label}")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def tar_octal(field: bytes, label: str) -> int:
    if field and field[0] & 0x80:
        raise UnsafeArchive(f"{label} uses unsupported base-256 encoding")
    value = field.strip(b" \0")
    if not value:
        return 0
    if any(character not in b"01234567" for character in value):
        raise UnsafeArchive(f"{label} is not a canonical octal value")
    return int(value, 8)


def checked_tar_header(header: bytes) -> tuple[str, int, bytes]:
    if len(header) != 512:
        raise UnsafeArchive("truncated tar header")
    stored_checksum = tar_octal(header[148:156], "tar header checksum")
    checksum_header = bytearray(header)
    checksum_header[148:156] = b"        "
    if sum(checksum_header) != stored_checksum:
        raise UnsafeArchive("tar header checksum mismatch")
    name_bytes = header[0:100].split(b"\0", 1)[0]
    prefix_bytes = header[345:500].split(b"\0", 1)[0]
    try:
        name = name_bytes.decode("utf-8")
        prefix = prefix_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise UnsafeArchive("tar header path is not UTF-8") from error
    if prefix:
        name = f"{prefix}/{name}"
    size = tar_octal(header[124:136], f"tar member {name!r} size")
    typeflag = header[156:157] or b"\0"
    return name, size, typeflag


def open_raw_tar(archive_path: Path, archive_format: str) -> BinaryIO:
    if archive_format == "tar.xz":
        return lzma.open(archive_path, "rb")
    return gzip.open(archive_path, "rb")


def skip_exact(stream: BinaryIO, size: int, label: str) -> None:
    remaining = size
    while remaining:
        block = stream.read(min(COPY_BYTES, remaining))
        if not block:
            raise UnsafeArchive(f"truncated {label}")
        remaining -= len(block)


def scan_simple_tar(
    archive_path: Path,
    archive_format: str,
    *,
    expected_count: int,
    expected_expanded_bytes: int,
) -> None:
    count = 0
    expanded_bytes = 0
    with open_raw_tar(archive_path, archive_format) as stream:
        while True:
            header = read_exact(stream, 512, "tar header")
            if not any(header):
                second = read_exact(stream, 512, "tar end marker")
                if any(second):
                    raise UnsafeArchive("tar archive has only one zero end marker")
                break
            name, size, typeflag = checked_tar_header(header)
            count += 1
            if count > expected_count or count > MAX_ENTRIES:
                raise UnsafeArchive("tar archive exceeds its entry-count bound")
            if typeflag in {b"x", b"g", b"L", b"K", b"S"}:
                raise UnsafeArchive(f"tar member {name!r} uses unsupported extended metadata")
            expanded_bytes += size
            if size > MAX_ENTRY_BYTES or expanded_bytes > MAX_EXPANDED_BYTES:
                raise UnsafeArchive("tar archive exceeds its raw payload bound")
            skip_exact(stream, ((size + 511) // 512) * 512, f"tar member {name!r}")
    if count != expected_count:
        raise UnsafeArchive(f"archive entry count mismatch: expected {expected_count}, got {count}")
    if expanded_bytes != expected_expanded_bytes:
        raise UnsafeArchive(
            "archive expanded byte-size mismatch: "
            f"expected {expected_expanded_bytes}, got {expanded_bytes}"
        )


def validate_archive_file(archive_path: Path, expected_bytes: int) -> None:
    if not archive_path.is_file() or archive_path.is_symlink():
        raise UnsafeArchive(f"archive is not a regular file: {archive_path}")
    actual_bytes = archive_path.stat().st_size
    if actual_bytes != expected_bytes:
        raise UnsafeArchive(f"archive byte-size mismatch: expected {expected_bytes}, got {actual_bytes}")
    if actual_bytes < 1 or actual_bytes > MAX_ARCHIVE_BYTES:
        raise UnsafeArchive("archive exceeds its compressed-size safety bound")


def extract(arguments: argparse.Namespace) -> None:
    archive_path = arguments.archive
    validate_archive_file(archive_path, arguments.expected_bytes)
    if arguments.entry_count < 1 or arguments.entry_count > MAX_ENTRIES:
        raise UnsafeArchive(f"entry count must be between 1 and {MAX_ENTRIES}")
    if arguments.expanded_bytes < 1 or arguments.expanded_bytes > MAX_EXPANDED_BYTES:
        raise UnsafeArchive("expanded byte count exceeds its safety bound")
    prefix = "." if arguments.prefix == "." else portable_path(arguments.prefix, "strip prefix")
    required = {portable_path(value, "required archive path") for value in arguments.required}
    executables = {portable_path(value, "executable archive path") for value in arguments.executable}
    if not executables.issubset(required):
        raise UnsafeArchive("every executable archive path must also be required")
    destination = arguments.destination
    if destination.exists() or destination.is_symlink():
        raise UnsafeArchive(f"private extraction destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir(mode=0o700)
    try:
        if arguments.format == "zip":
            with zipfile.ZipFile(archive_path) as stream:
                entries = validate_entries(
                    zip_entries(stream, prefix, arguments.entry_count),
                    expected_count=arguments.entry_count,
                    expected_expanded_bytes=arguments.expanded_bytes,
                    required=required,
                    executables=executables,
                )
                for entry in entries:
                    if entry.relative == "":
                        continue
                    output = destination.joinpath(*PurePosixPath(entry.relative).parts)
                    safe_parent(destination, entry.relative)
                    if entry.directory:
                        if output.exists() or output.is_symlink():
                            if not output.is_dir() or output.is_symlink():
                                raise UnsafeArchive(f"cannot create archive directory {entry.relative!r}")
                        else:
                            output.mkdir(mode=0o755)
                    else:
                        copy_regular(stream.open(entry.source, "r"), output, entry.size, entry.executable)
        else:
            scan_simple_tar(
                archive_path,
                arguments.format,
                expected_count=arguments.entry_count,
                expected_expanded_bytes=arguments.expanded_bytes,
            )
            mode = "r:xz" if arguments.format == "tar.xz" else "r:gz"
            with tarfile.open(archive_path, mode=mode) as stream:
                entries = validate_entries(
                    tar_entries(stream, prefix, arguments.entry_count),
                    expected_count=arguments.entry_count,
                    expected_expanded_bytes=arguments.expanded_bytes,
                    required=required,
                    executables=executables,
                )
            with tarfile.open(archive_path, mode=mode) as stream:
                by_name = {member.name: member for member in stream}
                for entry in entries:
                    if entry.relative == "":
                        continue
                    output = destination.joinpath(*PurePosixPath(entry.relative).parts)
                    safe_parent(destination, entry.relative)
                    if entry.directory:
                        if output.exists() or output.is_symlink():
                            if not output.is_dir() or output.is_symlink():
                                raise UnsafeArchive(f"cannot create archive directory {entry.relative!r}")
                        else:
                            output.mkdir(mode=0o755)
                    else:
                        source = stream.extractfile(by_name[entry.name])
                        if source is None:
                            raise UnsafeArchive(f"cannot read archive member {entry.name!r}")
                        copy_regular(source, output, entry.size, entry.executable)
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def extract_one(arguments: argparse.Namespace) -> None:
    archive_path = arguments.archive
    validate_archive_file(archive_path, arguments.expected_bytes)
    member = portable_path(arguments.member, "target archive member")
    output = arguments.destination
    if output.exists() or output.is_symlink():
        raise UnsafeArchive(f"target extraction path already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.parent.is_symlink():
        raise UnsafeArchive(f"target extraction parent is a symbolic link: {output.parent}")
    try:
        if arguments.format == "zip":
            with zipfile.ZipFile(archive_path) as archive:
                infos = archive.infolist()
                if len(infos) > MAX_ENTRIES:
                    raise UnsafeArchive("ZIP archive exceeds its entry-count bound")
                matches = [info for info in infos if info.filename.rstrip("/") == member]
                if len(matches) != 1:
                    raise UnsafeArchive(f"ZIP archive must contain target member exactly once: {member}")
                info = matches[0]
                mode = (info.external_attr >> 16) & 0xFFFF
                if info.is_dir() or stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                    raise UnsafeArchive(f"target ZIP member is not a regular file: {member}")
                if info.flag_bits & 0x1 or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    raise UnsafeArchive(f"target ZIP member uses unsafe encoding: {member}")
                if info.file_size != arguments.member_bytes:
                    raise UnsafeArchive(f"target ZIP member has unexpected size: {member}")
                copy_regular(
                    archive.open(info, "r"), output, arguments.member_bytes, arguments.executable
                )
        else:
            scanned_entries = 0
            scanned_bytes = 0
            with open_raw_tar(archive_path, arguments.format) as stream:
                while True:
                    header = read_exact(stream, 512, "tar header")
                    if not any(header):
                        raise UnsafeArchive(f"tar archive does not contain target member: {member}")
                    name, size, typeflag = checked_tar_header(header)
                    scanned_entries += 1
                    scanned_bytes += size
                    if scanned_entries > MAX_TARGET_SCAN_ENTRIES or scanned_bytes > MAX_TARGET_SCAN_BYTES:
                        raise UnsafeArchive("target tar scan exceeds its bounded search envelope")
                    padded_size = ((size + 511) // 512) * 512
                    if name == member:
                        if typeflag not in {b"0", b"\0"} or size != arguments.member_bytes:
                            raise UnsafeArchive(f"target tar member is not the expected regular file: {member}")
                        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                        try:
                            with os.fdopen(descriptor, "wb") as sink:
                                descriptor = -1
                                remaining = size
                                digest = hashlib.sha256()
                                while remaining:
                                    block = stream.read(min(COPY_BYTES, remaining))
                                    if not block:
                                        raise UnsafeArchive(f"target tar member is truncated: {member}")
                                    sink.write(block)
                                    digest.update(block)
                                    remaining -= len(block)
                        finally:
                            if descriptor >= 0:
                                os.close(descriptor)
                        if digest.hexdigest() != arguments.member_sha256:
                            raise UnsafeArchive(f"target tar member checksum mismatch: {member}")
                        os.chmod(output, 0o755 if arguments.executable else 0o644)
                        return
                    skip_exact(stream, padded_size, f"tar member {name!r}")
        if hashlib.sha256(output.read_bytes()).hexdigest() != arguments.member_sha256:
            raise UnsafeArchive(f"target archive member checksum mismatch: {member}")
    except BaseException:
        output.unlink(missing_ok=True)
        raise


def tree_digest(root: Path, expected_executables: set[str]) -> tuple[int, str]:
    if not root.is_dir() or root.is_symlink():
        raise UnsafeArchive(f"tree root is not a real directory: {root}")
    files: list[tuple[str, Path]] = []
    portable: dict[str, str] = {}
    for current, directories, names in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in directories:
            candidate = current_path / name
            if candidate.is_symlink():
                raise UnsafeArchive(f"tree contains symbolic link: {candidate}")
        for name in names:
            candidate = current_path / name
            mode = candidate.lstat().st_mode
            if not stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                raise UnsafeArchive(f"tree contains non-regular file: {candidate}")
            relative = candidate.relative_to(root).as_posix()
            portable_path(relative, "tree path")
            key = unicodedata.normalize("NFC", relative).casefold()
            prior = portable.get(key)
            if prior is not None and prior != relative:
                raise UnsafeArchive(f"tree paths {prior!r} and {relative!r} collide")
            portable[key] = relative
            files.append((relative, candidate))
    files.sort(key=lambda item: item[0].encode("utf-8"))
    actual_paths = {relative for relative, _ in files}
    missing_executables = sorted(expected_executables - actual_paths)
    if missing_executables:
        raise UnsafeArchive(
            f"tree is missing expected executable files: {', '.join(missing_executables)}"
        )
    if os.name != "nt":
        actual_executables = {
            relative for relative, candidate in files if candidate.stat().st_mode & 0o111
        }
        if actual_executables != expected_executables:
            raise UnsafeArchive(
                "tree executable paths mismatch: expected "
                f"{sorted(expected_executables)!r}, got {sorted(actual_executables)!r}"
            )
    digest = hashlib.sha256(b"oliphaunt-bootstrap-tree-v2\0")
    for relative, candidate in files:
        size = candidate.stat().st_size
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(b"x" if relative in expected_executables else b"-")
        digest.update(b"\0")
        with candidate.open("rb") as stream:
            while block := stream.read(COPY_BYTES):
                digest.update(block)
        digest.update(b"\0")
    return len(files), digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--archive", type=Path, required=True)
    extract_parser.add_argument("--format", choices=("zip", "tar.xz", "tar.gz"), required=True)
    extract_parser.add_argument("--prefix", required=True)
    extract_parser.add_argument("--entry-count", type=int, required=True)
    extract_parser.add_argument("--expected-bytes", type=int, required=True)
    extract_parser.add_argument("--expanded-bytes", type=int, required=True)
    extract_parser.add_argument("--destination", type=Path, required=True)
    extract_parser.add_argument("--required", action="append", default=[], required=True)
    extract_parser.add_argument("--executable", action="append", default=[])
    one_parser = subparsers.add_parser("extract-file")
    one_parser.add_argument("--archive", type=Path, required=True)
    one_parser.add_argument("--format", choices=("zip", "tar.xz", "tar.gz"), required=True)
    one_parser.add_argument("--expected-bytes", type=int, required=True)
    one_parser.add_argument("--member", required=True)
    one_parser.add_argument("--member-bytes", type=int, required=True)
    one_parser.add_argument("--member-sha256", required=True)
    one_parser.add_argument("--destination", type=Path, required=True)
    one_parser.add_argument("--executable", action="store_true")
    digest_parser = subparsers.add_parser("tree-digest")
    digest_parser.add_argument("--root", type=Path, required=True)
    digest_parser.add_argument("--executable", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "extract":
            extract(arguments)
        elif arguments.command == "extract-file":
            if len(arguments.member_sha256) != 64 or any(
                character not in "0123456789abcdef" for character in arguments.member_sha256
            ):
                raise UnsafeArchive("target member SHA-256 is not lowercase hexadecimal")
            if arguments.member_bytes < 1 or arguments.member_bytes > MAX_ENTRY_BYTES:
                raise UnsafeArchive("target member byte count exceeds its safety bound")
            extract_one(arguments)
        else:
            executables = {
                portable_path(value, "expected executable tree path")
                for value in arguments.executable
            }
            count, digest = tree_digest(arguments.root, executables)
            print(f"{count} {digest}")
    except (OSError, UnsafeArchive, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"pinned bootstrap archive rejected: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
