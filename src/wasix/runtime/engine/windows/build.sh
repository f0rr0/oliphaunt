#!/usr/bin/env bash
set -euo pipefail
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 0 ;; esac
cd "$(git rev-parse --show-toplevel)"
source tools/dev/acquisition.sh
oliphaunt_acquisition_start 'Windows WASIX engine' 1800
owner=src/wasix/runtime/engine/windows
inputs=target/oliphaunt-wasix/engine/inputs
mkdir -p "$inputs"
plan="$(bun "$owner/build.mts" acquisition-plan)"
while IFS=$'\t' read -r name url; do
  destination="$inputs/$name"
  if bun "$owner/build.mts" verify-input "$name" "$destination"; then continue; fi
  temporary="$(mktemp "$inputs/.download.XXXXXX")"
  trap 'rm -f "$temporary"' EXIT
  oliphaunt_acquisition_curl 1200 4 2 curl --fail --silent --show-error --location \
    --proto '=https' --proto-redir '=https' --output "$temporary" "$url"
  bun "$owner/build.mts" verify-input "$name" "$temporary"
  mv "$temporary" "$destination"
  trap - EXIT
done <<<"$plan"
bun "$owner/build.mts" build
