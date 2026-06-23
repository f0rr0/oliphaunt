#!/usr/bin/env python3
"""Check whether selected Cargo product crates are published on crates.io."""

from __future__ import annotations

import argparse
import os
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NoReturn

import product_metadata


ROOT = Path(__file__).resolve().parents[2]
CRATES_IO_API = os.environ.get("CRATES_IO_API", "https://crates.io/api/v1")
REQUEST_ATTEMPTS = int(os.environ.get("OLIPHAUNT_REGISTRY_QUERY_ATTEMPTS", "3"))
REQUEST_RETRY_DELAY_SECONDS = float(
    os.environ.get("OLIPHAUNT_REGISTRY_QUERY_RETRY_DELAY", "1.0")
)


def fail(message: str) -> NoReturn:
    print(f"check_cratesio_publication.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def request_attempts() -> int:
    return max(1, REQUEST_ATTEMPTS)


def sleep_before_retry(attempt: int) -> None:
    if attempt + 1 < request_attempts() and REQUEST_RETRY_DELAY_SECONDS > 0:
        time.sleep(REQUEST_RETRY_DELAY_SECONDS)


def retryable_http_error(error: urllib.error.HTTPError) -> bool:
    return error.code == 429 or error.code >= 500


def cargo_package_name(manifest_path: str) -> str:
    path = ROOT / manifest_path
    manifest = tomllib.loads(path.read_text(encoding="utf-8"))
    package = manifest.get("package")
    if not isinstance(package, dict):
        fail(f"{manifest_path} does not define [package]")
    name = package.get("name")
    if not isinstance(name, str) or not name:
        fail(f"{manifest_path} does not define package.name")
    return name


def product_crates(product: str) -> list[str]:
    config = product_metadata.product_config(product)
    publish_targets = product_metadata.string_list(config, "publish_targets", product)
    if "crates-io" not in publish_targets:
        fail(f"{product} does not publish to crates.io")
    crates = [
        raw.split(":", 1)[1]
        for raw in product_metadata.string_list(config, "registry_packages", product)
        if raw.startswith("crates:")
    ]
    if not crates:
        for version_file in product_metadata.version_files(product):
            if Path(version_file).name == "Cargo.toml":
                crates.append(cargo_package_name(version_file))
    if not crates:
        fail(f"{product} does not declare Cargo registry packages")
    if len(crates) != len(set(crates)):
        fail(f"{product} declares duplicate Cargo registry packages: {crates}")
    return sorted(crates)


def query_crates(product: str) -> tuple[str, list[str], list[str], list[str]]:
    version = product_metadata.read_current_version(product)
    crates = product_crates(product)
    missing: list[str] = []
    published: list[str] = []
    for crate in crates:
        if crate_version_exists(crate, version):
            published.append(crate)
        else:
            missing.append(crate)
    return version, crates, missing, published


def assert_product_publication(product: str, *, require_published: bool) -> None:
    version, crates, missing, published = query_crates(product)
    if require_published and missing:
        fail(
            f"{product} tag exists but crates.io is missing version {version} for: "
            + ", ".join(missing)
        )
    if not require_published and published:
        fail(
            f"{product} version {version} is already published on crates.io for: "
            + ", ".join(published)
        )
    state = "published" if require_published else "unpublished"
    print(f"{product} crates.io {state} check passed for {version}: {', '.join(crates)}")


def crate_version_exists(crate: str, version: str) -> bool:
    crate_path = urllib.parse.quote(crate, safe="")
    version_path = urllib.parse.quote(version, safe="")
    url = f"{CRATES_IO_API.rstrip('/')}/crates/{crate_path}/{version_path}"
    return cratesio_url_exists(url, f"{crate} {version}")


def crate_exists(crate: str) -> bool:
    crate_path = urllib.parse.quote(crate, safe="")
    url = f"{CRATES_IO_API.rstrip('/')}/crates/{crate_path}"
    return cratesio_url_exists(url, crate)


def cratesio_url_exists(url: str, label: str) -> bool:
    last_error: Exception | None = None
    for attempt in range(request_attempts()):
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "oliphaunt-release-check (https://github.com/f0rr0/oliphaunt)",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return 200 <= response.status < 300
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return False
            if not retryable_http_error(error):
                fail(f"crates.io returned HTTP {error.code} for {label}")
            last_error = error
            sleep_before_retry(attempt)
        except urllib.error.URLError as error:
            last_error = error
            sleep_before_retry(attempt)
    assert last_error is not None
    if isinstance(last_error, urllib.error.HTTPError):
        fail(f"crates.io returned HTTP {last_error.code} for {label}")
    fail(f"failed to query crates.io for {label}: {last_error}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product", required=True, help="release product id")
    parser.add_argument(
        "--require-published",
        action="store_true",
        help="fail if any Cargo crate for the product is missing from crates.io",
    )
    parser.add_argument(
        "--require-unpublished",
        action="store_true",
        help="fail if any Cargo crate for the product already exists on crates.io",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.require_published == args.require_unpublished:
        fail("pass exactly one of --require-published or --require-unpublished")

    assert_product_publication(
        args.product,
        require_published=args.require_published,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
