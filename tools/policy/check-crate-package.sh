#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

allow_dirty=()
packages=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-dirty)
      allow_dirty=(--allow-dirty)
      shift
      ;;
    --package|-p)
      if [ -z "${2:-}" ]; then
        echo "--package requires a package name" >&2
        exit 2
      fi
      packages+=("$2")
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

rm -f target/package/*.crate
if [ "${#packages[@]}" -eq 0 ]; then
  cargo package --workspace --exclude xtask --locked --no-verify "${allow_dirty[@]}"
else
  for package in "${packages[@]}"; do
    cargo package -p "$package" --locked --no-verify "${allow_dirty[@]}"
  done
fi
tools/policy/check-crate-size.sh --enforce
