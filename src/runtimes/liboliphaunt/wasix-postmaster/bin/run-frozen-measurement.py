#!/usr/bin/env python3

"""Run a qualification tool from a content-addressed, read-only source closure."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile


SCHEMA = "oliphaunt.wasix-postmaster.measurement-tool-closure.v1"
MANIFEST_NAME = ".measurement-tool-closure.tsv"
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


class ClosureError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ClosureError(message)


def frame(digest: "hashlib._Hash", value: str) -> None:
    encoded = value.encode("utf-8")
    digest.update(len(encoded).to_bytes(8, "big"))
    digest.update(encoded)


def checked_relative(value: str) -> PurePosixPath:
    relative = PurePosixPath(value)
    require(
        value == relative.as_posix()
        and not relative.is_absolute()
        and all(part not in ("", ".", "..") for part in relative.parts),
        f"unsafe measurement-tool path: {value!r}",
    )
    return relative


def read_regular_stable(path: Path) -> tuple[bytes, bool]:
    before = os.lstat(path)
    require(
        stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode),
        f"measurement-tool entry is not a regular file: {path}",
    )
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        require(
            stat.S_ISREG(opened.st_mode)
            and (opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino),
            f"measurement-tool entry changed while opening: {path}",
        )
        chunks: list[bytes] = []
        remaining = opened.st_size
        while remaining:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            require(bool(chunk), f"measurement-tool entry was truncated: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        require(
            (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            )
            == (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_ctime_ns,
            ),
            f"measurement-tool entry changed while reading: {path}",
        )
        return b"".join(chunks), bool(opened.st_mode & 0o111)
    finally:
        os.close(descriptor)


def source_records(
    root: Path, *, ignore_generated: bool = False
) -> list[tuple[str, bytes, bool]]:
    root_info = os.lstat(root)
    require(
        stat.S_ISDIR(root_info.st_mode) and not stat.S_ISLNK(root_info.st_mode),
        f"measurement-tool source is not a non-symlink directory: {root}",
    )
    records: list[tuple[str, bytes, bool]] = []
    for current, directories, files in os.walk(root, followlinks=False):
        if ignore_generated:
            directories[:] = sorted(
                name for name in directories if name != "__pycache__"
            )
        else:
            directories.sort()
        files.sort()
        for name in directories:
            directory = Path(current, name)
            info = os.lstat(directory)
            require(
                stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
                f"measurement-tool source contains a non-directory: {directory}",
            )
        for name in files:
            if name == MANIFEST_NAME or (ignore_generated and name.endswith(".pyc")):
                continue
            path = Path(current, name)
            relative = path.relative_to(root).as_posix()
            checked_relative(relative)
            payload, executable = read_regular_stable(path)
            records.append((relative, payload, executable))
    records.sort(key=lambda record: record[0])
    require(records, "measurement-tool source closure is empty")
    require(
        len({relative for relative, _, _ in records}) == len(records),
        "measurement-tool source traversal contains duplicate paths",
    )
    return records


def record_metadata(
    records: list[tuple[str, bytes, bool]],
) -> list[tuple[str, int, str, bool]]:
    return [
        (relative, len(payload), hashlib.sha256(payload).hexdigest(), executable)
        for relative, payload, executable in records
    ]


def closure_identity(records: list[tuple[str, int, str, bool]]) -> str:
    digest = hashlib.sha256()
    frame(digest, SCHEMA)
    for relative, size, file_sha256, executable in records:
        for value in (
            relative,
            str(size),
            file_sha256,
            "executable" if executable else "data",
        ):
            frame(digest, value)
    return digest.hexdigest()


def canonical_manifest(records: list[tuple[str, int, str, bool]]) -> bytes:
    lines = ["schema\tpath\tbytes\tsha256\tmode\n"]
    for relative, size, file_sha256, executable in records:
        require("\t" not in relative and "\r" not in relative, "unsafe manifest path")
        lines.append(
            f"{SCHEMA}\t{relative}\t{size}\t{file_sha256}\t"
            f"{'executable' if executable else 'data'}\n"
        )
    return "".join(lines).encode("utf-8")


def parse_manifest(path: Path) -> tuple[list[tuple[str, int, str, bool]], str]:
    payload, executable = read_regular_stable(path)
    require(not executable, "measurement-tool manifest must not be executable")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ClosureError(f"measurement-tool manifest is not UTF-8: {error}") from error
    lines = text.splitlines()
    require(
        "\r" not in text
        and text.endswith("\n")
        and bool(lines)
        and lines[0] == "schema\tpath\tbytes\tsha256\tmode",
        "measurement-tool manifest is not canonical TSV",
    )
    records: list[tuple[str, int, str, bool]] = []
    for line in lines[1:]:
        fields = line.split("\t")
        require(len(fields) == 5 and fields[0] == SCHEMA, "invalid manifest row")
        _, relative, size_text, file_sha256, mode = fields
        checked_relative(relative)
        require(
            size_text.isascii()
            and size_text.isdecimal()
            and (len(size_text) == 1 or size_text[0] != "0"),
            f"invalid manifest byte count: {relative}",
        )
        require(SHA256_RE.fullmatch(file_sha256) is not None, "invalid file SHA-256")
        require(mode in ("data", "executable"), f"invalid manifest mode: {relative}")
        records.append((relative, int(size_text), file_sha256, mode == "executable"))
    require(records and records == sorted(records), "manifest records are not sorted")
    require(
        len({relative for relative, *_ in records}) == len(records),
        "manifest contains duplicate paths",
    )
    return records, hashlib.sha256(payload).hexdigest()


def verify_closure(
    root: Path,
    manifest_path: Path,
    expected_identity: str,
    expected_manifest_sha256: str | None = None,
) -> str:
    require(SHA256_RE.fullmatch(expected_identity) is not None, "invalid closure identity")
    expected, manifest_sha256 = parse_manifest(manifest_path)
    if expected_manifest_sha256 is not None:
        require(
            manifest_sha256 == expected_manifest_sha256,
            "measurement-tool manifest SHA-256 differs",
        )
    actual_payloads = source_records(root)
    actual = record_metadata(actual_payloads)
    require(actual == expected, "measurement-tool closure bytes or modes differ")
    require(
        closure_identity(actual) == expected_identity,
        "measurement-tool closure identity differs",
    )
    require(
        os.lstat(root).st_mode & 0o222 == 0,
        f"measurement-tool root is writable: {root}",
    )
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            require(
                os.lstat(Path(current, name)).st_mode & 0o222 == 0,
                f"measurement-tool directory is writable: {Path(current, name)}",
            )
        for name in files:
            require(
                os.lstat(Path(current, name)).st_mode & 0o222 == 0,
                f"measurement-tool file is writable: {Path(current, name)}",
            )
    return manifest_sha256


def remove_staging(path: Path) -> None:
    if not path.exists():
        return
    for current, directories, _ in os.walk(path, topdown=False):
        for name in directories:
            os.chmod(Path(current, name), 0o700)
    os.chmod(path, 0o700)
    shutil.rmtree(path)


def freeze(source_root: Path, work_root: Path) -> tuple[Path, str, str]:
    first = source_records(source_root, ignore_generated=True)
    metadata = record_metadata(first)
    identity = closure_identity(metadata)
    parent = work_root / "measurement-tool-closures"
    parent.mkdir(parents=True, exist_ok=True)
    destination = parent / identity
    manifest_path = destination / MANIFEST_NAME
    if destination.exists():
        manifest_sha256 = verify_closure(destination, manifest_path, identity)
        return destination, identity, manifest_sha256

    staging = Path(tempfile.mkdtemp(prefix=".pending-", dir=parent))
    try:
        for relative, payload, executable in first:
            output = staging.joinpath(*checked_relative(relative).parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(output, 0o555 if executable else 0o444)

        second = source_records(source_root, ignore_generated=True)
        require(
            record_metadata(second) == metadata,
            "measurement-tool source changed while freezing",
        )
        manifest_payload = canonical_manifest(metadata)
        with (staging / MANIFEST_NAME).open("xb") as stream:
            stream.write(manifest_payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(staging / MANIFEST_NAME, 0o444)
        for current, directories, _ in os.walk(staging, topdown=False):
            for name in directories:
                os.chmod(Path(current, name), 0o555)
        os.chmod(staging, 0o555)
        try:
            os.rename(staging, destination)
        except FileExistsError:
            remove_staging(staging)
        manifest_sha256 = verify_closure(destination, manifest_path, identity)
        return destination, identity, manifest_sha256
    finally:
        remove_staging(staging)


def run_tool(options: argparse.Namespace) -> None:
    source_root = Path(__file__).resolve().parent.parent
    repo_root = (
        options.repo_root.resolve()
        if options.repo_root is not None
        else source_root.parents[3]
    )
    work_root = (
        options.work_root.resolve()
        if options.work_root is not None
        else repo_root / "target/oliphaunt-wasix-postmaster"
    )
    closure, identity, manifest_sha256 = freeze(source_root, work_root)
    tool_relative = checked_relative(options.tool)
    tool = closure.joinpath(*tool_relative.parts)
    info = os.lstat(tool)
    require(
        stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_mode & 0o111,
        f"frozen measurement tool is not executable: {tool}",
    )
    environment = os.environ.copy()
    environment.update(
        {
            "FRESH_ROOT": str(closure),
            "REPO_ROOT": str(repo_root),
            "FRESH_MEASUREMENT_TOOL_CLOSURE_ID": identity,
            "FRESH_MEASUREMENT_TOOL_CLOSURE_MANIFEST": str(closure / MANIFEST_NAME),
            "FRESH_MEASUREMENT_TOOL_CLOSURE_MANIFEST_SHA256": manifest_sha256,
            "FRESH_REQUIRE_FROZEN_MEASUREMENT_TOOLS": "1",
        }
    )
    os.execve(tool, [str(tool), *options.arguments], environment)


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--work-root", type=Path)
    run_parser.add_argument("--repo-root", type=Path)
    run_parser.add_argument("tool")
    run_parser.add_argument("arguments", nargs=argparse.REMAINDER)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--root", type=Path, required=True)
    verify_parser.add_argument("--manifest", type=Path, required=True)
    verify_parser.add_argument("--identity", required=True)
    verify_parser.add_argument("--manifest-sha256")
    options = parser.parse_args(arguments)
    try:
        if options.command == "run":
            run_tool(options)
        else:
            manifest_sha256 = verify_closure(
                options.root,
                options.manifest,
                options.identity,
                options.manifest_sha256,
            )
            print(
                f"verified measurement-tool closure: identity={options.identity} "
                f"manifest_sha256={manifest_sha256}"
            )
        return 0
    except (ClosureError, OSError) as error:
        print(f"frozen measurement tool failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
