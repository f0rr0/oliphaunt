#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

cargo semver-checks check-release --package oliphaunt-wasix --manifest-path src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml
