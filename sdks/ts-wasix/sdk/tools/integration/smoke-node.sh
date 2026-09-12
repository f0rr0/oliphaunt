#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
runtime=node
args=("$@")
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime) runtime="${2:?--runtime requires a value}"; shift 2 ;;
    --package-only) shift ;;
    *) echo "unknown smoke option: $1" >&2; exit 1 ;;
  esac
done
deadline="$(command -v gtimeout || command -v timeout)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun run --cwd "$root/sdks/ts-query" build
bun pm --cwd "$root/sdks/ts-query" pack --filename "$scratch/query.tgz" --quiet
bun "$root/sdks/ts-wasix/sdk/tools/integration/smoke-node.mts" "$scratch" "${args[@]}"
cd "$scratch/consumer"
export NPM_CONFIG_IGNORE_SCRIPTS=true
"$deadline" --kill-after=3s 120s bun install --ignore-scripts
case "$runtime" in
  node) host=(node) ;;
  bun) host=(bash "$root/tools/dev/bun.sh") ;;
  deno) host=(bash "$root/tools/dev/deno.sh" run --allow-env --allow-ffi --allow-net=127.0.0.1 --allow-read) ;;
  electron)
    host=(env ELECTRON_RUN_AS_NODE=1 NPM_CONFIG_IGNORE_SCRIPTS=false
      npm exec --yes --package=electron@39.2.5 -- electron)
    ;;
esac
"$deadline" --kill-after=3s 300s "${host[@]}" "$scratch/consumer/verify.mjs"
printf 'WASIX TypeScript %s smoke passed\n' "$runtime"
