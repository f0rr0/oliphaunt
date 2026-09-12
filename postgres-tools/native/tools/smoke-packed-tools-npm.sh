#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 && $1 == --asset-dir ]] || { echo 'usage: smoke-packed-tools-npm.sh --asset-dir DIRECTORY' >&2; exit 2; }
: "${OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING:?a running native server is required}"
asset_dir=$(cd "$2" && pwd)
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-native-tools-npm-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
scratch=$(cd "$scratch" && pwd -P)
bash "$root/tools/dev/bun.sh" "$root/postgres-tools/native/tools/smoke-packed-tools-npm.mts" "$asset_dir" "$scratch"
{ IFS= read -r -d '' facade; IFS= read -r -d '' carrier; } < "$scratch/tarballs"
# These are the two freshly validated release packages. Extracting only this
# host's payload keeps the smoke offline without fake optional dependencies.
mkdir -p "$scratch/node_modules/@oliphaunt/tools" "$scratch/node_modules/@oliphaunt/tools-linux-x64-gnu"
tar -xzf "$facade" --strip-components=1 -C "$scratch/node_modules/@oliphaunt/tools"
tar -xzf "$carrier" --strip-components=1 -C "$scratch/node_modules/@oliphaunt/tools-linux-x64-gnu"
export OLIPHAUNT_LOGICAL_TOOLS_CONTRACT="$root/test-fixtures/postgres/logical-tools.json"
export OLIPHAUNT_LOGICAL_TOOLS_SEED="$root/test-fixtures/postgres/logical-tools-seed.sql"
export OLIPHAUNT_LOGICAL_TOOLS_VERIFY="$root/test-fixtures/postgres/logical-tools-verify.sql"
cd "$scratch"
timeout --kill-after=5 300 node "$scratch/smoke.mts" --engine node
timeout --kill-after=5 300 bash "$root/tools/dev/bun.sh" "$scratch/smoke.mts" --engine bun
timeout --kill-after=5 300 bash "$root/tools/dev/deno.sh" run --allow-all "$scratch/smoke.mts" --engine deno
