#!/usr/bin/env python3
"""Verify a product-scoped release-please tag points at the release commit."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from typing import NoReturn

import product_metadata


def fail(message: str) -> NoReturn:
    print(f"verify_product_tag.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def git_output(args: list[str]) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def commit_for_ref(ref: str) -> str:
    return git_output(["rev-parse", f"{ref}^{{commit}}"])


def tag_ref(tag: str) -> str:
    return f"refs/tags/{tag}"


def tag_commit(tag: str) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{tag_ref(tag)}^{{commit}}"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return None


def product_tag(product: str) -> str:
    prefix = product_metadata.tag_prefix(product)
    version = product_metadata.read_current_version(product)
    return f"{prefix}{version}"


def verify_tag(product: str, target: str) -> str:
    tag = product_tag(product)
    target_commit = commit_for_ref(target)
    existing = tag_commit(tag)
    if existing is None:
        fail(f"{tag} does not exist. Run release-please before package-native publish steps.")
    if existing != target_commit:
        fail(f"{tag} points at {existing}, not release commit {target_commit}")
    print(f"{tag} points at {target_commit}")
    return tag


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", help="release product id")
    parser.add_argument(
        "--target",
        default=os.environ.get("GITHUB_SHA", "HEAD"),
        help="commitish that the tag must point at",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    verify_tag(args.product, args.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
