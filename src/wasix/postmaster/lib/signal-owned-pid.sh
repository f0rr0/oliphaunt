#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
"${HOST_CC:-cc}" -std=c11 -O2 -Wall -Wextra -Werror "$script_dir/signal-owned-pid.c" -o "$work/signal-owned-pid"
"$work/signal-owned-pid" "$@"
