#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}

cargo_index="$root/target/local-registries/cargo/index"
npmrc="$root/target/local-registries/verdaccio/npmrc"

if [[ ! -d "$cargo_index" ]]; then
  echo "missing local Cargo registry index: $cargo_index" >&2
  echo "stage it with tools/release/local_registry_publish.py before running examples" >&2
  exit 1
fi

export CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX="file://$cargo_index"
if [[ -f "$npmrc" ]]; then
  export NPM_CONFIG_USERCONFIG="$npmrc"
fi
# Local Verdaccio publishes packages during the example setup; allow those
# freshly-published local packages without changing the workspace policy.
export PNPM_CONFIG_MINIMUM_RELEASE_AGE=0

exec "$@"
