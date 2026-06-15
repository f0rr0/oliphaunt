#!/usr/bin/env python3
"""Exercise Moon's local output cache with a deterministic tiny fixture."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WITNESS_ROOT = ROOT / "target" / "graph" / "cache-witness"
INPUT = WITNESS_ROOT / "input.txt"
OUTPUT = WITNESS_ROOT / "output.txt"
RUNS = WITNESS_ROOT / "runs.txt"


def fail(message: str) -> None:
    raise SystemExit(f"cache-witness.py: {message}")


def read_text(path: Path) -> str:
    if not path.is_file():
        fail(f"missing expected file: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def fixture() -> int:
    value = read_text(INPUT).strip()
    WITNESS_ROOT.mkdir(parents=True, exist_ok=True)
    runs = 0
    if RUNS.is_file():
        runs = int(RUNS.read_text(encoding="utf-8").strip())
    runs += 1
    RUNS.write_text(f"{runs}\n", encoding="utf-8")
    OUTPUT.write_text(f"moon-cache-witness:{value}\n", encoding="utf-8")
    return 0


def run_moon_fixture() -> str:
    completed = subprocess.run(
        ["moon", "run", "graph-tools:cache-witness-fixture"],
        cwd=ROOT,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return completed.stdout


def assert_cache() -> int:
    WITNESS_ROOT.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    INPUT.write_text(f"{token}\n", encoding="utf-8")
    for path in (OUTPUT, RUNS):
        path.unlink(missing_ok=True)

    first_log = run_moon_fixture()
    expected = f"moon-cache-witness:{token}\n"
    if read_text(OUTPUT) != expected:
        fail("first run did not write the expected fixture output")
    if read_text(RUNS) != "1\n":
        fail("first run did not execute the fixture exactly once")

    OUTPUT.unlink()
    second_log = run_moon_fixture()
    if read_text(OUTPUT) != expected:
        fail("second run did not restore the expected fixture output")
    if read_text(RUNS) != "1\n":
        fail(
            "Moon reran the fixture instead of hydrating the declared output from cache "
            "(runs counter changed)"
        )

    print("Moon cache witness passed")
    print("first run:")
    print(first_log.rstrip())
    print("second run:")
    print(second_log.rstrip())
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("fixture")
    subparsers.add_parser("assert")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.command == "fixture":
        return fixture()
    if args.command == "assert":
        return assert_cache()
    fail(f"unsupported command {args.command}")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
