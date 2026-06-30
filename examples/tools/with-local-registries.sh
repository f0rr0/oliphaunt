#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}

cargo_index="$root/target/local-registries/cargo/index"
cargo_home="$root/target/local-registries/cargo-home"
npmrc="$root/target/local-registries/verdaccio/npmrc"

if [[ ! -d "$cargo_index" ]]; then
  echo "missing local Cargo registry index: $cargo_index" >&2
  echo "stage it with tools/dev/bun.sh tools/release/local-registry-publish.mjs before running examples" >&2
  exit 1
fi

export CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX="file://$cargo_index"
mkdir -p "$cargo_home"
# Local release validation republishes the same Cargo package versions into the
# file registry. Keep Cargo's package cache local so same-version republishes do
# not reuse stale sources from ~/.cargo/registry/src.
export CARGO_HOME="$cargo_home"
if [[ -f "$npmrc" ]]; then
  export NPM_CONFIG_USERCONFIG="$npmrc"
fi
# Local Verdaccio publishes packages during the example setup; allow those
# freshly-published local packages without changing the workspace policy.
export PNPM_CONFIG_MINIMUM_RELEASE_AGE=0
# Local release validation republishes the same package versions into Verdaccio.
# Keep examples off the repository lockfile and global pnpm store so they resolve
# the current local registry bytes instead of stale same-version artifacts.
export PNPM_CONFIG_LOCKFILE=false
export PNPM_CONFIG_STORE_DIR="$root/target/local-registries/pnpm-store"
export PNPM_CONFIG_PREFER_OFFLINE=false
export electron_config_cache="$root/target/local-registries/electron-cache"

exec "$@"
