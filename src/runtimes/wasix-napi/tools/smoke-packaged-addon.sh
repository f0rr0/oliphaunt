#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
stage="$root/src/runtimes/wasix-napi/tools/smoke-packaged-addon.mts"
args=("$@")
runtime=''
manager=pnpm
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || { echo 'smoke options require values' >&2; exit 1; }
  case "$1" in
    --runtime) runtime="$2" ;;
    --package-manager) manager="$2" ;;
    --target) ;;
    *) echo "unknown smoke option: $1" >&2; exit 1 ;;
  esac
  shift 2
done

# macOS installs GNU timeout as gtimeout; Windows uses Git Bash's coreutils.
deadline="$(command -v gtimeout || command -v timeout)" || {
  echo 'packaged addon smoke requires GNU coreutils (timeout or gtimeout)' >&2
  exit 1
}
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
node "$stage" stage "$scratch" "${args[@]}"
cd "$scratch"
export NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
export NPM_CONFIG_IGNORE_SCRIPTS=true PNPM_CONFIG_IGNORE_SCRIPTS=true
if [ "$manager" = pnpm ]; then
  "$deadline" --kill-after=3s 300s pnpm install --ignore-scripts --no-frozen-lockfile
else
  "$deadline" --kill-after=3s 300s npm install --ignore-scripts --no-audit --no-fund --package-lock=false
fi

case "$runtime" in
  node) host=(node) ;;
  bun) host=(bash "$root/tools/dev/bun.sh") ;;
  deno) host=(bash "$root/tools/dev/deno.sh" run --allow-env --allow-ffi --allow-net=127.0.0.1 --allow-read) ;;
  electron)
    host=(env ELECTRON_RUN_AS_NODE=1 NPM_CONFIG_IGNORE_SCRIPTS=false PNPM_CONFIG_IGNORE_SCRIPTS=false
      npm exec --yes --package=electron@39.2.5 -- electron)
    ;;
esac
"$deadline" --kill-after=3s 300s "${host[@]}" "$scratch/worker-unload.mjs" > worker.log
cat worker.log
grep -F "oliphaunt-wasix-napi-worker-unload-$runtime:PASS" worker.log >/dev/null
"$deadline" --kill-after=3s 300s "${host[@]}" "$scratch/verify.mjs"

if [ "$runtime" = electron ]; then
  node "$stage" asar "$scratch" "${args[@]}"
  "$deadline" --kill-after=3s 300s npm exec --yes --package=@electron/asar@3.4.1 -- \
    asar pack asar-source app.asar --unpack '**/prebuilds/**'
  node "$stage" asar-check "$scratch" "${args[@]}"
  binary="$(cat asar-binary.txt)"
  mv "$binary" "$binary.missing"
  status=0
  "$deadline" --kill-after=3s 300s "${host[@]}" ./app.asar/main.cjs > missing.log 2>&1 || status=$?
  mv "$binary.missing" "$binary"
  if [ "$status" = 0 ] || [ "$status" = 124 ] || [ "$status" = 137 ]; then
    cat missing.log >&2
    echo 'Electron must promptly reject a missing unpacked addon' >&2
    exit 1
  fi
  grep -F 'oliphaunt_wasix_napi.node' missing.log >/dev/null || {
    cat missing.log >&2
    exit 1
  }
  "$deadline" --kill-after=3s 300s "${host[@]}" ./app.asar/main.cjs > asar.log
  cat asar.log
  grep -F 'oliphaunt-wasix-napi-asar-unpacked:PASS' asar.log >/dev/null
fi
printf 'WASIX Node-API packaged %s/%s smoke passed\n' "$runtime" "$manager"
