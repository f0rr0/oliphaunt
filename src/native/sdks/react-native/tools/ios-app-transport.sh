#!/usr/bin/env bash
set -euo pipefail
tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ios-app-transport.mts"
if [ "$#" = 1 ] && { [ "$1" = --help ] || [ "$1" = -h ]; }; then
  exec bun "$tool" --help
fi
command -v jq >/dev/null
scratch="$(mktemp -d)"
state="$scratch/state.json"
# The Shell process owns staging directories across the TypeScript phases.
# shellcheck disable=SC2317
cleanup() {
  if [ -f "$state" ]; then
    work="$(jq -r '.work // empty' "$state")"
    if [ -n "$work" ]; then rm -rf "$work"; fi
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
bun "$tool" describe "$state" "$@"
for command in ditto plutil; do
  command -v "$command" >/dev/null || {
    echo "required Apple command $command was not found; run this operation on macOS with ditto and plutil available" >&2
    exit 1
  }
done
export TZ=UTC
if [ "$(jq -r '.command' "$state")" = pack ]; then
  app="$(bun "$tool" locate "$state")"
  plutil -extract CFBundleExecutable raw -o - "$app/Info.plist" > "$state.executable"
  bun "$tool" prepare "$state"
  staged_app="$(jq -r '.stagedApp' "$state")"
  ditto "$app" "$staged_app"
  bun "$tool" normalize "$state"
  work="$(jq -r '.work' "$state")"
  app_name="$(jq -r '.appData.name' "$state")"
  temporary_archive="$(jq -r '.temporaryArchive' "$state")"
  (cd "$work" && ditto -c -k --sequesterRsrc --keepParent "$app_name" "$temporary_archive")
else
  bun "$tool" prepare "$state"
  archive="$(jq -r '.archive' "$state")"
  work="$(jq -r '.work' "$state")"
  ditto -x -k "$archive" "$work"
  app="$(jq -r '.appPath' "$state")"
  plutil -extract CFBundleExecutable raw -o - "$app/Info.plist" > "$state.executable"
fi
bun "$tool" finish "$state"
