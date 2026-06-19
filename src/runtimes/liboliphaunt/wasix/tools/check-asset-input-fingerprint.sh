#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

base_ref="${ASSET_INPUT_BASE_REF:-}"
if [[ -z "$base_ref" ]]; then
  if git rev-parse --verify -q '@{upstream}' >/dev/null; then
    base_ref='@{upstream}'
  else
    base_ref='origin/main'
  fi
fi

if ! git rev-parse --verify -q "${base_ref}^{commit}" >/dev/null; then
  echo "asset input fingerprint check skipped: ${base_ref} is not available" >&2
  exit 0
fi

changed="$(
  git diff --name-only "${base_ref}...HEAD" -- \
    src/sources/third-party \
    src/sources/toolchains \
    src/extensions/catalog/extensions.promoted.toml \
    src/extensions/catalog/extensions.smoke.toml \
    src/runtimes/liboliphaunt/wasix/assets/build \
    src/runtimes/liboliphaunt/wasix/crates/assets/Cargo.toml \
    src/runtimes/liboliphaunt/wasix/crates/assets/build.rs \
    src/runtimes/liboliphaunt/wasix/crates/assets/src \
    src/runtimes/liboliphaunt/wasix/crates/aot \
    tools/xtask/src \
    src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256
)"

if [[ -z "$changed" ]]; then
  echo "asset input fingerprint check skipped: no asset input changes"
  exit 0
fi

cargo run -p xtask -- assets verify-committed
