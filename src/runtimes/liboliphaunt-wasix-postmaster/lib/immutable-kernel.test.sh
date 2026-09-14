#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] || exit 0
lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
source "$lib/common.sh"
source "$lib/immutable-carrier.sh"
export FRESH_WORK_ROOT="$temporary"
binding="$(fresh_immutable_kernel)"
[ "$(HOST_CC=false fresh_immutable_kernel)" = "$binding" ]
OLIPHAUNT_IMMUTABLE_KERNEL="$binding" bun test "$lib/immutable-carrier.test.mts" -t 'native immutable'
