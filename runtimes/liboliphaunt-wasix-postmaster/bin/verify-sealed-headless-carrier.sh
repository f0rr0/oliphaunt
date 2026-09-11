#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf 'Usage: verify-sealed-headless-carrier.sh CARRIER_DIR\n' >&2
  exit 2
fi

fresh_verify_sealed_headless_carrier "$1"
printf 'verified sealed headless WASIX PostgreSQL carrier: %s\n' \
  "$(cd "$1" && pwd -P)"
