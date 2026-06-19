#!/usr/bin/env python3
"""Validate that staged oliphaunt-wasix crates include generated payloads."""

from __future__ import annotations

import argparse
import subprocess
import sys
from typing import NoReturn


AOT_TARGETS = [
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
]


def fail(message: str) -> NoReturn:
    print(f"check_wasm_crate_payloads.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def package_files(package: str, allow_dirty: bool) -> set[str]:
    command = ["cargo", "package", "--list", "-p", package, "--locked"]
    if allow_dirty:
        command.append("--allow-dirty")
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def require_package_entries(package: str, files: set[str], required: list[str]) -> None:
    missing = sorted(entry for entry in required if entry not in files)
    if missing:
        fail(f"{package} package is missing generated release payload entries: {', '.join(missing)}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-dirty", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    require_package_entries(
        "oliphaunt-wasix-assets",
        package_files("oliphaunt-wasix-assets", args.allow_dirty),
        [
            "payload/manifest.json",
        ],
    )
    for target in AOT_TARGETS:
        package = f"oliphaunt-wasix-aot-{target}"
        require_package_entries(
            package,
            package_files(package, args.allow_dirty),
            [
                "artifacts/manifest.json",
            ],
        )
    print("WASM crate generated payload package contents verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
