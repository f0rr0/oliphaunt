#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
if [ "$#" != 2 ] || [ "$1" != --runtime ]; then
  echo 'usage: smoke-tools-host.sh --runtime node|bun|deno' >&2
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
node "$root/src/bindings/wasix-ts/tools/integration/packed-node-fixture.mts" "$scratch" --pgtap --tools
cd "$scratch/consumer"
export NPM_CONFIG_IGNORE_SCRIPTS=true PNPM_CONFIG_IGNORE_SCRIPTS=true
"$deadline" --kill-after=3s 120s pnpm install --ignore-scripts --no-frozen-lockfile
"$deadline" --kill-after=3s 300s "${host[@]}" \
  "$root/src/bindings/wasix-ts/tools/integration/smoke-tools-host.mts" "$scratch/packed-consumer.json" "$@"
