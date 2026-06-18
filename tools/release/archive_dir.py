#!/usr/bin/env python3
"""Create a deterministic tar.gz or zip archive from a directory."""

from __future__ import annotations

import gzip
import os
import stat
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import NoReturn


def fail(message: str) -> "NoReturn":
    print(f"archive_dir.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def normalized_mode(path: Path) -> int:
    mode = path.stat().st_mode
    if path.is_dir():
        return stat.S_IFDIR | 0o755
    executable = bool(mode & stat.S_IXUSR)
    return stat.S_IFREG | (0o755 if executable else 0o644)


def add_path(archive: tarfile.TarFile, root: Path, path: Path) -> None:
    relative = path.relative_to(root)
    name = "." if str(relative) == "." else relative.as_posix()
    info = tarfile.TarInfo(name)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.mode = normalized_mode(path) & 0o777
    if path.is_dir():
        info.type = tarfile.DIRTYPE
        archive.addfile(info)
        return
    if not path.is_file():
        fail(f"unsupported archive entry type: {path}")
    info.size = path.stat().st_size
    with path.open("rb") as file:
        archive.addfile(info, file)


def add_zip_path(archive: zipfile.ZipFile, root: Path, path: Path) -> None:
    relative = path.relative_to(root)
    name = "." if str(relative) == "." else relative.as_posix()
    if path.is_dir() and name != ".":
        name = f"{name}/"
    info = zipfile.ZipInfo(name)
    info.date_time = (1980, 1, 1, 0, 0, 0)
    info.create_system = 3
    info.external_attr = (normalized_mode(path) & 0o777) << 16
    if path.is_dir():
        info.external_attr |= 0x10
        archive.writestr(info, b"")
        return
    if not path.is_file():
        fail(f"unsupported archive entry type: {path}")
    info.compress_type = zipfile.ZIP_DEFLATED
    with path.open("rb") as file:
        archive.writestr(info, file.read())


def write_tar_gz(source: Path, output: Path) -> None:
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gzip_file:
            with tarfile.open(fileobj=gzip_file, mode="w") as archive:
                add_path(archive, source, source)
                for directory, dirnames, filenames in os.walk(source):
                    dirnames.sort()
                    filenames.sort()
                    for dirname in dirnames:
                        add_path(archive, source, Path(directory) / dirname)
                    for filename in filenames:
                        add_path(archive, source, Path(directory) / filename)


def write_zip(source: Path, output: Path) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        add_zip_path(archive, source, source)
        for directory, dirnames, filenames in os.walk(source):
            dirnames.sort()
            filenames.sort()
            for dirname in dirnames:
                add_zip_path(archive, source, Path(directory) / dirname)
            for filename in filenames:
                add_zip_path(archive, source, Path(directory) / filename)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        fail("usage: tools/release/archive_dir.py <source-dir> <output.tar.gz|output.zip>")
    source = Path(argv[1]).resolve()
    output = Path(argv[2]).resolve()
    if not source.is_dir():
        fail(f"source is not a directory: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.name.endswith(".tar.gz"):
        write_tar_gz(source, output)
    elif output.suffix == ".zip":
        write_zip(source, output)
    else:
        fail(f"unsupported archive extension: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
