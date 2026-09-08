#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$script_dir" rev-parse --show-toplevel)"
cd "$root"
source_sha="$(git rev-parse HEAD)"
plan="$(bun "$script_dir/package-platform.mts" stage "$@" --source-sha "$source_sha")"
IFS=$'\t' read -r release_stage package_work package_output <<<"$plan"
[ -d "$release_stage" ] && [ -d "$package_work" ] && [ -d "$package_output" ]
case "$release_stage" in
  */linux-*-gnu)
    target="${release_stage##*/}"
    bash src/shared/artifact-packaging/check-linux-consumer-baseline.sh --target "$target" --root "$release_stage"
    ;;
esac
pack_result="$(mktemp)"
trap 'rm -f "$pack_result"' EXIT
pnpm --dir "$package_work" pack --pack-destination "$root/$package_output" --json >"$pack_result"
bun "$script_dir/package-platform.mts" finish "$@" --pack-result "$pack_result"
