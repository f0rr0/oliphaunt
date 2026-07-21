#!/usr/bin/env python3
"""Offline verifier for a managed archive source checkout."""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import sys
import tomllib
from pathlib import Path


SAFETY_VERSION = "source-archive-v2"
MARKER_NAME = ".oliphaunt-source-pin"
MAX_MARKER_BYTES = 64 * 1024
MAX_ENTRIES = 500_000
MAX_BYTES = 8 * 1024 * 1024 * 1024


class VerificationError(ValueError):
    pass


def parse_marker(path: Path) -> dict[str, str]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise VerificationError(f"source marker is not a regular file: {path}")
    if metadata.st_size > MAX_MARKER_BYTES:
        raise VerificationError(f"source marker is oversized: {path}")
    fields: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        key, separator, value = line.partition("=")
        if not separator or not key or key in fields:
            raise VerificationError(f"source marker contains a malformed or duplicate field: {path}")
        fields[key] = value
    required = {
        "safety",
        "name",
        "kind",
        "url",
        "branch",
        "commit",
        "sha256",
        "strip-prefix",
        "tree-sha256",
    }
    if set(fields) != required:
        raise VerificationError(f"source marker does not carry complete integrity state: {path}")
    if fields["safety"] != SAFETY_VERSION:
        raise VerificationError(
            f"source marker uses {fields['safety']!r}, expected {SAFETY_VERSION!r}"
        )
    if len(fields["tree-sha256"]) != 64 or any(
        character not in "0123456789abcdef" for character in fields["tree-sha256"]
    ):
        raise VerificationError("source marker has an invalid tree-sha256")
    return fields


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def source_tree_digest(root: Path) -> str:
    root_metadata = root.lstat()
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise VerificationError(f"source checkout is not a real directory: {root}")

    entries: list[tuple[bytes, str, str]] = []
    pending = [root]
    total_bytes = 0
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as scan:
            children = sorted(scan, key=lambda entry: os.fsencode(entry.name))
        for child in children:
            path = Path(child.path)
            relative = path.relative_to(root).as_posix()
            if relative == MARKER_NAME:
                continue
            metadata = path.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                kind = "directory"
                detail = ""
                pending.append(path)
            elif stat.S_ISREG(metadata.st_mode):
                kind = "file"
                total_bytes += metadata.st_size
                if total_bytes > MAX_BYTES:
                    raise VerificationError(f"source checkout exceeds {MAX_BYTES} bytes")
                detail = f"{metadata.st_size}:{file_sha256(path)}"
            elif stat.S_ISLNK(metadata.st_mode):
                kind = "symlink"
                detail = os.readlink(path)
            else:
                raise VerificationError(f"unsupported filesystem object in source checkout: {path}")
            entries.append((relative.encode("utf-8"), kind, detail))
            if len(entries) > MAX_ENTRIES:
                raise VerificationError(f"source checkout exceeds {MAX_ENTRIES} entries")

    digest = hashlib.sha256()
    for relative, kind, detail in sorted(entries, key=lambda entry: entry[0]):
        for field in (kind.encode("utf-8"), relative, detail.encode("utf-8")):
            digest.update(field)
            digest.update(b"\0")
    return digest.hexdigest()


def expected_fields(manifest_path: Path) -> dict[str, str]:
    with manifest_path.open("rb") as source:
        manifest = tomllib.load(source)
    required = ("name", "url", "branch", "commit", "sha256", "strip_prefix")
    for field in required:
        if not isinstance(manifest.get(field), str) or not manifest[field]:
            raise VerificationError(f"source manifest {manifest_path} has invalid {field}")
    if manifest.get("kind") != "archive":
        raise VerificationError(f"source manifest {manifest_path} is not an archive source")
    return {
        "name": manifest["name"],
        "kind": "archive",
        "url": manifest["url"],
        "branch": manifest["branch"],
        "commit": manifest["commit"],
        "sha256": manifest["sha256"],
        "strip-prefix": manifest["strip_prefix"],
    }


def verify(checkout: Path, manifest_path: Path) -> str:
    marker = parse_marker(checkout / MARKER_NAME)
    expected = expected_fields(manifest_path)
    for key, value in expected.items():
        if marker[key] != value:
            raise VerificationError(
                f"source checkout marker {key} is {marker[key]!r}, expected {value!r}"
            )
    actual = source_tree_digest(checkout)
    if actual != marker["tree-sha256"]:
        raise VerificationError(
            f"source checkout was modified: expected tree {marker['tree-sha256']}, got {actual}"
        )
    return actual


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(verify(args.checkout, args.manifest))
    except (OSError, UnicodeError, VerificationError, tomllib.TOMLDecodeError) as error:
        print(f"source checkout verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
