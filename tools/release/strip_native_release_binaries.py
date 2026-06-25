#!/usr/bin/env python3
"""Strip debug/symbol data from native release payloads before archiving."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, NoReturn


MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
}


@dataclass(frozen=True)
class NativeFile:
    path: Path
    kind: str
    archive: bool = False


def fail(message: str) -> NoReturn:
    print(f"strip_native_release_binaries.py: {message}", file=sys.stderr)
    raise SystemExit(2)


def read_prefix(path: Path, size: int = 8) -> bytes:
    try:
        with path.open("rb") as handle:
            return handle.read(size)
    except OSError as error:
        fail(f"failed to read {path}: {error}")


def classify(path: Path) -> NativeFile | None:
    prefix = read_prefix(path)
    if prefix.startswith(b"\x7fELF"):
        return NativeFile(path, "elf")
    if prefix[:4] in MACHO_MAGICS:
        return NativeFile(path, "macho")
    if prefix.startswith(b"MZ"):
        return NativeFile(path, "pe")
    if prefix.startswith(b"!<arch>\n"):
        return NativeFile(path, "archive", archive=True)
    return None


def iter_files(roots: Iterable[Path]) -> Iterable[Path]:
    for root in roots:
        if root.is_file():
            yield root
            continue
        if not root.is_dir():
            fail(f"input path does not exist: {root}")
        for path in sorted(root.rglob("*")):
            if path.is_file():
                yield path


def env_tool(*names: str) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def find_tool(*names: str) -> str | None:
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            return resolved
    return None


def darwin_strip_tool() -> str | None:
    override = env_tool("OLIPHAUNT_MACHO_STRIP", "OLIPHAUNT_STRIP")
    if override:
        return override
    if sys.platform == "darwin":
        result = subprocess.run(
            ["xcrun", "--find", "strip"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    return find_tool("strip")


def strip_tool_for(native: NativeFile) -> tuple[str | None, list[str]]:
    if native.kind == "macho":
        tool = darwin_strip_tool()
        if not tool:
            fail(f"missing strip tool for Mach-O file {native.path}")
        return tool, ["-S"]
    if native.kind == "pe":
        tool = env_tool("OLIPHAUNT_PE_STRIP", "OLIPHAUNT_STRIP") or find_tool("llvm-strip", "strip")
        if not tool:
            print(f"skippedPeNativeFile={native.path}", file=sys.stderr)
            return None, []
        return tool, ["--strip-debug"]
    if native.archive and sys.platform == "darwin":
        tool = darwin_strip_tool()
        if not tool:
            fail(f"missing strip tool for archive {native.path}")
        return tool, ["-S"]
    if native.archive and native.path.suffix.lower() == ".lib":
        tool = env_tool("OLIPHAUNT_PE_STRIP", "OLIPHAUNT_STRIP") or find_tool("llvm-strip", "strip")
        if not tool:
            print(f"skippedPeNativeFile={native.path}", file=sys.stderr)
            return None, []
        return tool, ["--strip-debug"]
    tool = env_tool("OLIPHAUNT_ELF_STRIP", "OLIPHAUNT_STRIP") or find_tool("llvm-strip", "strip")
    if not tool:
        fail(f"missing strip tool for {native.kind} file {native.path}")
    if native.archive:
        return tool, ["--strip-debug"]
    return tool, ["--strip-unneeded"]


def strip_native(native: NativeFile) -> bool:
    before = native.path.stat().st_size
    tool, flags = strip_tool_for(native)
    if tool is None:
        return False
    result = subprocess.run(
        [tool, *flags, str(native.path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        fail(f"{tool} failed for {native.path}: {stderr or f'exit {result.returncode}'}")
    return native.path.stat().st_size != before


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args(argv)

    native_files = [native for path in iter_files(args.paths) if (native := classify(path)) is not None]
    changed = 0
    for native in native_files:
        if strip_native(native):
            changed += 1
    print(f"strippedNativeFiles={changed}")
    print(f"checkedNativeFiles={len(native_files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
