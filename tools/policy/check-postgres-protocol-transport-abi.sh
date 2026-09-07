#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

case "$(uname -s)" in
  Linux | Darwin) ;;
  *)
    echo "PostgreSQL protocol bridge ABI: skipped on non-POSIX host"
    exit 0
    ;;
esac

compiler="${CC:-cc}"
if ! command -v "$compiler" >/dev/null 2>&1; then
  echo "PostgreSQL protocol bridge ABI: required C compiler not found: $compiler" >&2
  exit 1
fi

output="$root/target/policy/oliphaunt-wasix-protocol-bridge-abi"
mkdir -p "$(dirname "$output")"
"$compiler" -std=c11 -Wall -Wextra -Werror \
  src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge.c \
  src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge_abi_test.c \
  -o "$output"
"$output"

echo "PostgreSQL protocol bridge ABI: PASS"
