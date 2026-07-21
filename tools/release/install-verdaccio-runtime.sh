#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "install-verdaccio-runtime.sh: $*" >&2
  exit 1
}

testing="${OLIPHAUNT_VERDACCIO_TESTING:-0}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
runtime_root="$script_dir/verdaccio-runtime"
if [[ -n "${OLIPHAUNT_VERDACCIO_RUNTIME_ROOT:-}" ]]; then
  [[ "$testing" == "1" ]] || fail "OLIPHAUNT_VERDACCIO_RUNTIME_ROOT is test-only"
  runtime_root="$OLIPHAUNT_VERDACCIO_RUNTIME_ROOT"
fi

pnpm_command="${OLIPHAUNT_VERDACCIO_PNPM:-pnpm}"
store_dir="${OLIPHAUNT_VERDACCIO_STORE_DIR:-}"
offline="${OLIPHAUNT_VERDACCIO_OFFLINE:-0}"
for override in OLIPHAUNT_VERDACCIO_PNPM OLIPHAUNT_VERDACCIO_STORE_DIR; do
  if [[ -n "${!override:-}" && "$testing" != "1" ]]; then
    fail "$override is test-only"
  fi
done

case "$offline" in
  0 | 1) ;;
  *) fail "OLIPHAUNT_VERDACCIO_OFFLINE must be 0 or 1" ;;
esac

manifest="$runtime_root/package.json"
lockfile="$runtime_root/pnpm-lock.yaml"
for input in "$manifest" "$lockfile"; do
  [[ -f "$input" && ! -L "$input" ]] || fail "missing regular runtime input: $input"
done
command -v node >/dev/null 2>&1 || fail "missing required command: node"
command -v "$pnpm_command" >/dev/null 2>&1 || fail "missing required command: $pnpm_command"

identity="$(node - "$manifest" <<'JS'
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write([
  manifest.name ?? "",
  manifest.dependencies?.verdaccio ?? "",
  manifest.packageManager ?? "",
].join("\t"));
JS
)"
IFS=$'\t' read -r package_name verdaccio_version package_manager <<<"$identity"
[[ "$package_name" == "@oliphaunt/verdaccio-runtime" ]] ||
  fail "runtime package identity must be @oliphaunt/verdaccio-runtime"
[[ "$verdaccio_version" == "6.8.0" ]] ||
  fail "runtime dependency must pin verdaccio 6.8.0 exactly"
[[ "$package_manager" == "pnpm@11.5.0" ]] ||
  fail "runtime packageManager must pin pnpm@11.5.0 exactly"
observed_pnpm="$({ "$pnpm_command" --version; } 2>&1)" ||
  fail "could not inspect pnpm version: $observed_pnpm"
[[ "$observed_pnpm" == "11.5.0" ]] ||
  fail "expected pnpm 11.5.0; observed $observed_pnpm"

install_args=(
  --dir "$runtime_root"
  install
  --ignore-workspace
  --frozen-lockfile
  --ignore-scripts
  --trust-lockfile
)
if [[ "$offline" == "1" ]]; then
  install_args+=(--offline)
else
  install_args+=(--prefer-offline)
fi
if [[ -n "$store_dir" ]]; then
  install_args+=(--store-dir "$store_dir")
fi
"$pnpm_command" "${install_args[@]}"

observed="$({ "$pnpm_command" --dir "$runtime_root" exec verdaccio --version; } 2>&1)" ||
  fail "installed Verdaccio CLI did not start: $observed"
observed="${observed#v}"
[[ "$observed" == "$verdaccio_version" ]] ||
  fail "expected Verdaccio $verdaccio_version; observed $observed"
printf '%s\n' "$observed"
