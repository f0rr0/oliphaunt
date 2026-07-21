#!/usr/bin/env bash
set -euo pipefail

unset MOON_BASE
unset MOON_HEAD

moon_bin="${MOON_BIN:-moon}"

exec "$moon_bin" run "$@"
