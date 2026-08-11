#!/usr/bin/env python3

"""Minimal receipt-aware product-compiler fixture."""

from __future__ import annotations

import hashlib
import pathlib
import sys


PROFILE = "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1"


def main() -> int:
    arguments = sys.argv[1:]
    if arguments == ["--version"]:
        print(f"oliphaunt-wasix-postmaster-compiler fixture {PROFILE}")
        return 0
    if len(arguments) == 3 and arguments[0] == "verify-aot":
        module = pathlib.Path(arguments[1])
        artifact = pathlib.Path(arguments[2])
        expected = b"fake-product-aot\0" + hashlib.sha256(module.read_bytes()).digest()
        if artifact.read_bytes() != expected:
            raise SystemExit("fake product AOT identity differs")
        print(hashlib.sha256(module.read_bytes()).hexdigest())
        return 0
    try:
        output_index = arguments.index("-o")
        output = pathlib.Path(arguments[output_index + 1])
        module = pathlib.Path(arguments[-1])
    except (ValueError, IndexError):
        raise SystemExit("fake product compiler requires -o OUTPUT MODULE")
    if "--llvm" not in arguments or "--enable-exceptions" not in arguments or "--enable-threads" not in arguments:
        raise SystemExit("fake product compiler requires LLVM, exceptions, and threads")
    payload = module.read_bytes()
    output.write_bytes(b"fake-product-aot\0" + hashlib.sha256(payload).digest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
