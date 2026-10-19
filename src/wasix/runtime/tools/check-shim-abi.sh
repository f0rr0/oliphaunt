#!/usr/bin/env bash
set -euo pipefail
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exit 0 ;; esac
shim="$(cd "$(dirname "${BASH_SOURCE[0]}")/../assets/build/wasix_shim" && pwd)"
output="$(mktemp -d)"
trap 'rm -rf "$output"' EXIT
for name in oliphaunt_wasix_bridge oliphaunt_wasix_initdb_shim; do
  "${CC:-cc}" -std=c11 -Wall -Wextra "$shim/$name.c" "$shim/${name}_abi_test.c" -o "$output/$name"
  "$output/$name"
done
