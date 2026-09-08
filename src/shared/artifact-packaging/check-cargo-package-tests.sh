#!/usr/bin/env bash
set -euo pipefail
helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${CARGO_TARGET_DIR:-$helper_dir/../../../target}"
prepare_args=()
test_args=()
all_features=false
explicit_features=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir|--features|--crate|--path-dependencies-from|--stub-dependency|--stub-dependency-prefix)
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then echo "$1 requires a value" >&2; exit 1; fi
      case "$1" in
        --target-dir) target_dir="$2" ;;
        --features) explicit_features=true; test_args+=("$1" "$2") ;;
        *) prepare_args+=("$1" "$2") ;;
      esac
      shift 2 ;;
    --all-features) all_features=true; test_args+=("$1"); shift ;;
    --no-default-features|--lib) test_args+=("$1"); shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
if "$all_features" && "$explicit_features"; then
  echo '--all-features and --features are mutually exclusive' >&2; exit 1
fi
timeout_bin=$(command -v timeout || command -v gtimeout) || {
  echo 'GNU timeout is required (coreutils on macOS)' >&2; exit 1;
}
mkdir -p "$target_dir"
CARGO_TARGET_DIR=$(cd "$target_dir" && pwd)
export CARGO_TARGET_DIR CARGO_TERM_COLOR=never
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-cargo-package-test-XXXXXX")
scratch=$(cd "$scratch" && pwd -P)
trap 'rm -rf "$scratch"' EXIT
manifest=$(bun "$helper_dir/cargo-package-test-closure.mts" "$scratch" "${prepare_args[@]}")
while IFS= read -r name; do
  case "$name" in OLIPHAUNT_*) unset "$name" ;; esac
done < <(compgen -e)
cd "$scratch"
"$timeout_bin" 1800 cargo generate-lockfile --manifest-path "$manifest" --offline
"$timeout_bin" 1800 cargo test --manifest-path "$manifest" --locked --offline --no-run "${test_args[@]}"
echo "Cargo package test closure verified: $(basename "$(dirname "$manifest")")"
