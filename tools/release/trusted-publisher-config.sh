#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
tool="$root/tools/release/trusted-publisher-config.mts"
scratch="$(mktemp -d)"
reservation=''
temporary=''
cleanup() {
  [ -z "$temporary" ] || rm -f "$temporary"
  [ -z "$reservation" ] || rmdir "$reservation"
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [ "${1:-}" = --npm ]; then
  cp "$2/context.json" "$scratch/context.json"
else
  bash tools/dev/bun.sh "$tool" --prepare "$scratch" "$@"
fi
[ -f "$scratch/context.json" ] || exit 0
command -v jq >/dev/null
deadline="$(command -v gtimeout || command -v timeout)"
output="$(jq -r '.output' "$scratch/context.json")"
# Reserve the report before authentication or mutation. Final publication is an
# atomic no-overwrite hard link; the output path stays absent until it is complete.
mkdir "$output.oliphaunt-reservation"
reservation="$output.oliphaunt-reservation"
if [ -e "$output" ] || [ -L "$output" ]; then echo "refusing to overwrite $output" >&2; exit 2; fi
temporary="$(mktemp "$(dirname "$output")/.trusted-publisher-report.XXXXXX")"
ln "$temporary" "$reservation/probe"
rm "$reservation/probe"
if [ ! -t 0 ] || [ ! -t 1 ]; then echo 'npm trust audit/apply requires an interactive terminal for authentication' >&2; exit 2; fi
"$deadline" --foreground --kill-after=5s 30s npm --version > "$scratch/npm-version"
bash tools/dev/bun.sh "$tool" --npm-runtime "$scratch"
export NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=1000 NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=5000 NPM_CONFIG_FETCH_TIMEOUT=20000
npm_names=()
while IFS= read -r name; do npm_names+=("$name"); done < <(jq -r '.selection.identities[].name' "$scratch/context.json")
# npm's authentication dialog requires both stdin and stdout to remain TTYs.
warmup() {
  NPM_CONFIG_FETCH_RETRIES=3 "$deadline" --foreground --kill-after=5s 300s npm trust list "$1" --json --registry https://registry.npmjs.org/
  sleep 2
}
list() {
  local name="$1" destination="$2" status=0
  NPM_CONFIG_FETCH_RETRIES=3 "$deadline" --foreground --kill-after=5s 30s npm trust list "$name" --json --registry https://registry.npmjs.org/ > "$destination" 2> "$scratch/list-error" || status=$?
  if [ "$status" != 0 ]; then
    if grep -Eqi '(^|[^[:alnum:]_])EOTP([^[:alnum:]_]|$)|one-time pass(word)?' "$scratch/list-error"; then
      sleep 2
      warmup "$name"
      # Only one read-only authentication retry. Never replay a mutation.
      NPM_CONFIG_FETCH_RETRIES=3 "$deadline" --foreground --kill-after=5s 30s npm trust list "$name" --json --registry https://registry.npmjs.org/ > "$destination"
    else
      tail -c 8192 "$scratch/list-error" >&2
      return "$status"
    fi
  fi
}
audit() {
  local pass="$1" index
  warmup "${npm_names[0]}"
  for index in "${!npm_names[@]}"; do
    list "${npm_names[$index]}" "$scratch/$pass-$index"
    sleep 2
  done
}
audit initial
bash tools/dev/bun.sh "$tool" --npm-initial "$scratch"
if jq -e '.apply' "$scratch/context.json" >/dev/null && jq -e '.conflicts | length == 0' "$scratch/initial-report.json" >/dev/null; then
  while IFS= read -r index; do
    name="${npm_names[$index]}"
    status=0
    NPM_CONFIG_FETCH_RETRIES=0 "$deadline" --foreground --kill-after=5s 300s npm trust github "$name" --file release.yml --repo f0rr0/oliphaunt --env release-publish --allow-publish --yes --json --registry https://registry.npmjs.org/ || status=$?
    sleep 2
    list "$name" "$scratch/reconcile-$index"
    bash tools/dev/bun.sh "$tool" --npm-reconcile "$scratch" "$index"
    [ "$status" = 0 ] || echo "reconciled $name after an ambiguous npm exit $status" >&2
    sleep 2
  done < <(jq -r '.[]' "$scratch/missing.json")
  audit final
fi
bash tools/dev/bun.sh "$tool" --npm-report "$scratch" > "$temporary"
bash tools/dev/bun.sh "$tool" --npm-commit "$scratch" "$temporary"
