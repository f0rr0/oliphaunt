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

package_oliphaunt_wasix() {
  python3 tools/release/package_oliphaunt_wasix_sdk_crate.py --output-dir target/package >/dev/null
}

default_packages() {
  python3 - <<'PY'
import json
import subprocess

metadata = json.loads(
    subprocess.check_output(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        text=True,
    )
)
for package in sorted(metadata["packages"], key=lambda item: item["name"]):
    if package.get("publish") == []:
        continue
    name = package["name"]
    if name == "oliphaunt-wasix":
        continue
    print(name)
PY
}

if [ "${#packages[@]}" -eq 0 ]; then
  while IFS= read -r package; do
    cargo package -p "$package" --locked --no-verify "${allow_dirty[@]}"
  done < <(default_packages)
  package_oliphaunt_wasix
else
  for package in "${packages[@]}"; do
    if [ "$package" = "oliphaunt-wasix" ]; then
      package_oliphaunt_wasix
    else
      cargo package -p "$package" --locked --no-verify "${allow_dirty[@]}"
    fi
  done
fi
tools/policy/check-crate-size.sh --enforce
