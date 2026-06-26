#!/usr/bin/env python3
"""Package the WASIX Rust SDK publish-shaped crate without resolving dependencies."""

from __future__ import annotations

import argparse
from pathlib import Path

import local_registry_publish
import release


ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    output_dir = args.output_dir
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    version = release.current_product_version("oliphaunt-wasix-rust")
    manifest = release.prepare_oliphaunt_wasix_release_source(version)
    crate_path = local_registry_publish.manual_cargo_package_source(manifest, output_dir)
    print(crate_path.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
