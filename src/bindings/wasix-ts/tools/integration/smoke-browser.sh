#!/usr/bin/env bash
set -euo pipefail
# Separate process groups let the EXIT trap close Vite, Chrome and their workers.
set -m
# Match Node's child-process limit: OPFS needs more than the shell default of 1024.
ulimit -Sn "$(ulimit -Hn)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
cd "$root"
tool="$root/src/bindings/wasix-ts/tools/integration/smoke-browser.mts"
report="$root/benchmarks/perf/wasix-browser/benchmark.mts"
deadline="$(command -v gtimeout || command -v timeout)"
command -v jq >/dev/null
chrome=''
for candidate in "${CHROME_BIN:-}" /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then chrome="$candidate"; break; fi
done
[ -n "$chrome" ] || { echo 'browser smoke requires Chrome/Chromium; set CHROME_BIN' >&2; exit 1; }
scratch="$(mktemp -d)"
pids=()
# Invoked by the EXIT trap, including failed launches and smoke assertions.
# shellcheck disable=SC2317
cleanup() {
  status=$?
  trap - EXIT
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  if [ "${#pids[@]}" -gt 0 ]; then sleep 2; fi
  for pid in "${pids[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  if [ "$status" != 0 ]; then
    for log in "$scratch/vite.log" "$scratch/chrome.log"; do
      if [ -f "$log" ]; then tail -c 32768 "$log" >&2; fi
    done
  fi
  rm -rf "$scratch"
  exit "$status"
}
trap cleanup EXIT
node "$tool" --prepare "$scratch" "$@"
configuration="$scratch/browser.json"
mode="$(jq -r '.mode' "$configuration")"
snapshot_git() {
  git rev-parse HEAD > "$scratch/git-commit${1:-}"
  git rev-parse 'HEAD^{tree}' > "$scratch/git-tree${1:-}"
  git status --porcelain=v1 --untracked-files=all > "$scratch/git-status${1:-}"
}
if [ "$mode" = benchmark ]; then
  snapshot_git
  node "$report" --prepare "$scratch"
fi
packed_consumer="$(jq -r '.packedConsumer // empty' "$configuration")"
if [ -n "$packed_consumer" ]; then
  export OLIPHAUNT_WASIX_BROWSER_PACKAGE_ROOT="$packed_consumer"
  (
    cd "$OLIPHAUNT_WASIX_BROWSER_PACKAGE_ROOT"
    NPM_CONFIG_IGNORE_SCRIPTS=true PNPM_CONFIG_IGNORE_SCRIPTS=true \
      "$deadline" --kill-after=3s 120s pnpm install --ignore-scripts --no-frozen-lockfile
  )
else
  unset OLIPHAUNT_WASIX_BROWSER_PACKAGE_ROOT
fi
vite_port="$(jq -r '.vitePort' "$configuration")"
chrome_port="$(jq -r '.chromePort' "$configuration")"
pnpm --dir "$root/src/bindings/wasix-ts" exec vite \
  --config "$root/examples/browser-wasix/vite.config.ts" --host 127.0.0.1 \
  --port "$vite_port" --strictPort > "$scratch/vite.log" 2>&1 &
pids+=("$!")
ready_deadline=$((SECONDS + 30))
until curl --silent --fail --max-time 1 "http://127.0.0.1:$vite_port/" -o /dev/null; do
  kill -0 "${pids[0]}"
  [ "$SECONDS" -lt "$ready_deadline" ] || { echo 'Vite did not become ready' >&2; exit 1; }
  sleep 0.2
done
"$chrome" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  "--user-data-dir=$scratch/profile" "--remote-debugging-port=$chrome_port" \
  about:blank > "$scratch/chrome.log" 2>&1 &
pids+=("$!")
seconds="$(jq -r '(.timeoutMs / 1000 | ceil) + 90' "$configuration")"
"$deadline" --kill-after=3s "${seconds}s" node "$tool" --run "$scratch"
for pid in "${pids[@]}"; do kill -0 "$pid"; done
if [ "$mode" = benchmark ]; then
  snapshot_git -after
  node "$report" --report "$scratch"
elif [ "$mode" = diagnostic ]; then
  node "$report" --diagnostic "$scratch"
fi
