#!/usr/bin/env python3
"""Shared helpers for small release-shaped fixture assets."""

from __future__ import annotations

import hashlib
import io
import tarfile
import zipfile
from pathlib import Path
from tarfile import TarInfo


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def add_tar_file(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    archive.addfile(info, io.BytesIO(data))


def write_tar_gz(path: Path, entries: dict[str, bytes], modes: dict[str, int] | None = None) -> None:
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(entries.items()):
            add_tar_file(archive, name, data, mode=(modes or {}).get(name, 0o644))


def write_zip(path: Path, entries: dict[str, bytes], modes: dict[str, int] | None = None) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name)
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.external_attr = (modes or {}).get(name, 0o644) << 16
            archive.writestr(info, data)


def write_checksum_manifest(asset_dir: Path, name: str) -> None:
    checksum_asset = asset_dir / name
    lines = []
    for asset in sorted(path for path in asset_dir.iterdir() if path.is_file() and path != checksum_asset):
        lines.append(f"{sha256(asset)}  ./{asset.name}")
    checksum_asset.write_text("\n".join(lines) + "\n", encoding="utf-8")
