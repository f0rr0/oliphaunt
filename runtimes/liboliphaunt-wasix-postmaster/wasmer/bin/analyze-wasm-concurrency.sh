#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
docker="${1:?Docker executable required}"
image="${2:?Builder image identity required}"
module="${3:?PostgreSQL module required}"
shift 3
case "$module" in "$repo"/*) ;; *) echo 'module must be under the mounted repository' >&2; exit 2 ;; esac
output="$(mktemp)"
trap 'rm -f "$output"' EXIT
"$docker" run --rm --user "$(id -u):$(id -g)" -v "$repo:/work" -w /work "$image" \
  bash -euo pipefail -c '
    tool=/opt/wasixcc-home/.wasixcc/binaryen/bin/wasm-dis
    version="$(timeout 30 "$tool" --version 2>&1)"
    case "$version" in ""|*$'"'"'\n'"'"'*|*$'"'"'\r'"'"'*) echo "non-canonical wasm-dis version" >&2; exit 1 ;; esac
    sha256sum "$tool" | cut -d " " -f 1
    printf "%s\n" "$version"
    "$tool" "$1"
  ' bash "/work/${module#"$repo"/}" > "$output"
# Do not admit a receipt until Binaryen and Docker have both exited successfully.
bun "$here/verify-postmaster-concurrency-contract.mts" --wasm-dis-output "$output" "$@" "$module"
