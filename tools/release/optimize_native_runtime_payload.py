#!/usr/bin/env python3
"""Prune, strip, and validate liboliphaunt native runtime payloads."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal, NoReturn

import strip_native_release_binaries


ROOT = Path(__file__).resolve().parents[2]
NATIVE_RUNTIME_TOOL_STEMS = ("initdb", "pg_ctl", "postgres")
NATIVE_TOOLS_TOOL_STEMS = ("pg_dump", "psql")
NATIVE_PACKAGED_TOOL_STEMS = (*NATIVE_RUNTIME_TOOL_STEMS, *NATIVE_TOOLS_TOOL_STEMS)
NativeToolSet = Literal["packaged", "runtime", "tools"]
ELF_DEBUG_SECTION = re.compile(r"\]\s+\.(debug_[^\s]+|symtab|strtab)\s")
MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
}
DEV_RUNTIME_DIRS = (
    PurePosixPath("include"),
    PurePosixPath("lib/pkgconfig"),
    PurePosixPath("lib/postgresql/pgxs"),
)
DEV_RUNTIME_SUFFIXES = (".a", ".la", ".pdb")
WINDOWS_DEV_RUNTIME_SUFFIXES = (".lib",)


@dataclass(frozen=True)
class NativeFile:
    path: Path
    kind: str
    archive: bool = False


def fail(message: str) -> NoReturn:
    print(f"optimize_native_runtime_payload.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def read_prefix(path: Path, size: int = 8) -> bytes:
    try:
        with path.open("rb") as file:
            return file.read(size)
    except OSError as error:
        fail(f"failed to read {path}: {error}")


def classify_native_file(path: Path) -> NativeFile | None:
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


def is_windows_target(target: str | None, runtime_dir: Path | None = None) -> bool:
    if target is not None and target.startswith("windows-"):
        return True
    if runtime_dir is None:
        return False
    bin_dir = runtime_dir / "bin"
    return any((bin_dir / f"{stem}.exe").exists() for stem in NATIVE_PACKAGED_TOOL_STEMS)


def required_runtime_tools(target: str | None, runtime_dir: Path | None = None) -> tuple[str, ...]:
    if is_windows_target(target, runtime_dir):
        return tuple(f"{stem}.exe" for stem in NATIVE_RUNTIME_TOOL_STEMS)
    return NATIVE_RUNTIME_TOOL_STEMS


def required_tools_package_tools(
    target: str | None, runtime_dir: Path | None = None
) -> tuple[str, ...]:
    if is_windows_target(target, runtime_dir):
        return tuple(f"{stem}.exe" for stem in NATIVE_TOOLS_TOOL_STEMS)
    return NATIVE_TOOLS_TOOL_STEMS


def packaged_runtime_tools(target: str | None, runtime_dir: Path | None = None) -> tuple[str, ...]:
    if is_windows_target(target, runtime_dir):
        return tuple(f"{stem}.exe" for stem in NATIVE_PACKAGED_TOOL_STEMS)
    return NATIVE_PACKAGED_TOOL_STEMS


def runtime_tools_for_set(
    target: str | None,
    runtime_dir: Path | None = None,
    *,
    tool_set: NativeToolSet = "packaged",
) -> tuple[str, ...]:
    if tool_set == "runtime":
        return required_runtime_tools(target, runtime_dir)
    if tool_set == "tools":
        return required_tools_package_tools(target, runtime_dir)
    return packaged_runtime_tools(target, runtime_dir)


def required_runtime_member_paths(target: str | None, *, prefix: str) -> list[str]:
    return [f"{prefix.rstrip('/')}/{tool}" for tool in required_runtime_tools(target)]


def required_tools_member_paths(target: str | None, *, prefix: str) -> list[str]:
    return [f"{prefix.rstrip('/')}/{tool}" for tool in required_tools_package_tools(target)]


def runtime_dir_for(root: Path) -> Path | None:
    for candidate in [
        root / "runtime",
        root / "oliphaunt" / "runtime" / "files",
    ]:
        if candidate.is_dir():
            return candidate
    if (root / "bin").is_dir() and ((root / "share").is_dir() or (root / "lib").is_dir()):
        return root
    return None


def remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def prune_empty_dirs(root: Path) -> None:
    if not root.is_dir():
        return
    for path in sorted((item for item in root.rglob("*") if item.is_dir()), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def is_dev_runtime_file(relative: PurePosixPath, *, windows: bool) -> bool:
    name = relative.name.lower()
    if name.endswith(DEV_RUNTIME_SUFFIXES):
        return True
    if windows and name.endswith(WINDOWS_DEV_RUNTIME_SUFFIXES):
        return True
    return False


def prune_runtime_payload(
    root: Path,
    target: str | None = None,
    *,
    tool_set: NativeToolSet = "packaged",
) -> None:
    runtime_dir = runtime_dir_for(root)
    if runtime_dir is None:
        return

    windows = is_windows_target(target, runtime_dir)
    required_tools = set(runtime_tools_for_set(target, runtime_dir, tool_set=tool_set))
    bin_dir = runtime_dir / "bin"
    if bin_dir.is_dir():
        for path in sorted(bin_dir.iterdir()):
            name = path.name
            if windows:
                if name.lower().endswith(".exe") and name not in required_tools:
                    remove_path(path)
            elif name not in required_tools:
                remove_path(path)

    for relative in DEV_RUNTIME_DIRS:
        remove_path(runtime_dir.joinpath(*relative.parts))

    for path in sorted(runtime_dir.rglob("*"), reverse=True):
        if path.is_dir() and path.name.endswith(".dSYM"):
            remove_path(path)
            continue
        if not path.is_file():
            continue
        relative = PurePosixPath(path.relative_to(runtime_dir).as_posix())
        if is_dev_runtime_file(relative, windows=windows):
            remove_path(path)

    prune_empty_dirs(runtime_dir)


def strip_supported_for_target(target: str | None) -> bool:
    if target is None:
        return True
    if target.startswith(("linux-", "android-")):
        return sys.platform.startswith("linux")
    if target.startswith(("macos-", "ios-")):
        return sys.platform == "darwin"
    if target.startswith("windows-"):
        return bool(
            os.environ.get("OLIPHAUNT_PE_STRIP")
            or os.environ.get("OLIPHAUNT_STRIP")
            or shutil.which("llvm-strip")
            or sys.platform == "win32"
        )
    return True


def strip_payload(root: Path) -> None:
    result = strip_native_release_binaries.main([str(root)])
    if result != 0:
        fail(f"failed to strip native payload under {rel(root)}")


def iter_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file())


def file_output(path: Path) -> str | None:
    file_tool = shutil.which("file")
    if file_tool is None:
        return None
    result = subprocess.run(
        [file_tool, str(path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def elf_debug_errors(path: Path) -> list[str]:
    readelf = shutil.which("readelf")
    if readelf is not None:
        result = subprocess.run(
            [readelf, "-S", str(path)],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if result.returncode != 0:
            return [f"{rel(path)} could not be inspected with readelf: {result.stderr.strip()}"]
        sections = sorted({match.group(1) for match in ELF_DEBUG_SECTION.finditer(result.stdout)})
        return [f"{rel(path)} contains unstripped ELF section .{section}" for section in sections]

    output = file_output(path)
    if output is not None and ("not stripped" in output or "with debug_info" in output):
        return [f"{rel(path)} appears to contain unstripped ELF debug/symbol data"]
    return []


def validate_native_files(root: Path) -> list[str]:
    errors: list[str] = []
    for path in iter_files(root):
        native = classify_native_file(path)
        if native is None:
            continue
        if native.kind == "elf" and not native.archive:
            errors.extend(elf_debug_errors(path))
    return errors


def validate_runtime_tree(
    root: Path,
    target: str | None,
    require_runtime: bool,
    *,
    tool_set: NativeToolSet = "packaged",
) -> list[str]:
    errors: list[str] = []
    runtime_dir = runtime_dir_for(root)
    if runtime_dir is None:
        if require_runtime:
            errors.append(f"{rel(root)} is missing a runtime tree")
        return errors

    windows = is_windows_target(target, runtime_dir)
    required_tools = set(runtime_tools_for_set(target, runtime_dir, tool_set=tool_set))
    bin_dir = runtime_dir / "bin"
    if require_runtime and not bin_dir.is_dir():
        errors.append(f"{rel(runtime_dir)} is missing bin")
    if bin_dir.is_dir():
        for tool in sorted(required_tools):
            path = bin_dir / tool
            if not path.is_file():
                errors.append(f"{rel(runtime_dir)} is missing required runtime tool bin/{tool}")
                continue
            if not windows and not os.access(path, os.X_OK):
                errors.append(f"{rel(path)} must be executable")
        for path in sorted(bin_dir.iterdir()):
            if windows:
                if path.name.lower().endswith(".exe") and path.name not in required_tools:
                    errors.append(f"{rel(path)} is an extra Windows runtime executable")
            elif path.name not in required_tools:
                errors.append(f"{rel(path)} is an extra runtime tool")

    for relative in DEV_RUNTIME_DIRS:
        path = runtime_dir.joinpath(*relative.parts)
        if path.exists():
            errors.append(f"{rel(path)} is a development-only runtime path")

    for path in sorted(runtime_dir.rglob("*")):
        if path.is_dir() and path.name.endswith(".dSYM"):
            errors.append(f"{rel(path)} is a development-only debug symbol bundle")
            continue
        if not path.is_file():
            continue
        relative = PurePosixPath(path.relative_to(runtime_dir).as_posix())
        if is_dev_runtime_file(relative, windows=windows):
            errors.append(f"{rel(path)} is a development-only runtime file")

    return errors


def validate_payload(
    root: Path,
    target: str | None = None,
    *,
    require_runtime: bool = True,
    tool_set: NativeToolSet = "packaged",
) -> None:
    errors = [
        *validate_runtime_tree(
            root,
            target,
            require_runtime=require_runtime,
            tool_set=tool_set,
        ),
        *validate_native_files(root),
    ]
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        fail(f"{rel(root)} is not an optimized native runtime payload")


def optimize_payload(
    root: Path,
    target: str | None = None,
    *,
    strip: bool | Literal["auto"] = "auto",
    require_runtime: bool = True,
    tool_set: NativeToolSet = "packaged",
) -> None:
    prune_runtime_payload(root, target, tool_set=tool_set)
    should_strip = strip is True or (strip == "auto" and strip_supported_for_target(target))
    if should_strip:
        strip_payload(root)
    validate_payload(root, target, require_runtime=require_runtime, tool_set=tool_set)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--target", default=None)
    parser.add_argument("--check", action="store_true", help="validate without mutating the payload")
    parser.add_argument(
        "--no-strip",
        action="store_true",
        help="prune but skip native binary stripping before validation",
    )
    parser.add_argument(
        "--allow-missing-runtime",
        action="store_true",
        help="validate native files even when the archive is a library-only mobile payload",
    )
    parser.add_argument(
        "--tool-set",
        choices=("packaged", "runtime", "tools"),
        default="packaged",
        help="which packaged runtime bin tools are expected in the payload",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = args.root.resolve()
    if not root.exists():
        fail(f"payload root does not exist: {root}")
    if args.check:
        validate_payload(
            root,
            args.target,
            require_runtime=not args.allow_missing_runtime,
            tool_set=args.tool_set,
        )
        return 0
    optimize_payload(
        root,
        args.target,
        strip=False if args.no_strip else "auto",
        require_runtime=not args.allow_missing_runtime,
        tool_set=args.tool_set,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
