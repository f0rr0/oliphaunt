#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-artifact-download.XXXXXXXX")"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
script=.github/scripts/download-build-artifacts.mts
bun "$script" download "$scratch" "$@"
while IFS= read -r -d '' directory; do
  archive="$directory/.artifact.zip"
  unzip -Z1 "$archive" > "$scratch/members"
  bun "$script" validate-zip "$archive" "$scratch/members"
  unzip -q "$archive" -d "$directory"
  rm "$archive"
done < "$scratch/archives"
bun "$script" merge "$scratch"
