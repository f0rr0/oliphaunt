#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
if [ "$#" != 2 ] || [ "$1" != --runtime ]; then
  echo 'usage: smoke-host.sh --runtime node|bun|deno' >&2
  exit 1
fi
case "$2" in
  node) host=(node) ;;
  bun) host=(bash "$root/tools/dev/bun.sh") ;;
  deno) host=(bash "$root/tools/dev/deno.sh" run --allow-all) ;;
  *) echo "unsupported tools smoke runtime: $2" >&2; exit 1 ;;
esac
deadline="$(command -v gtimeout || command -v timeout)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
bun run --cwd "$root/src/sdks/ts-query" build
bun pm --cwd "$root/src/sdks/ts-query" pack --filename "$scratch/query.tgz" --quiet
bun "$root/src/sdks/ts-wasix/sdk/tools/integration/packed-node-fixture.mts" "$scratch" --pgtap --tools
cd "$scratch/consumer"
if [ "$2" = deno ]; then
  printf '%s\n' '{"nodeModulesDir":"manual"}' > deno.json
  host+=(--config "$scratch/consumer/deno.json")
fi
export NPM_CONFIG_IGNORE_SCRIPTS=true
"$deadline" --kill-after=3s 120s bun install --ignore-scripts
"$deadline" --kill-after=3s 300s "${host[@]}" \
  "$root/src/postgres-tools/wasix/ts/tests/smoke-host.mts" "$scratch/packed-consumer.json" "$@"
