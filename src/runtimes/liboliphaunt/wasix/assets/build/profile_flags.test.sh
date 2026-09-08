#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for profile in debug release release-o3 release-os release-oz; do
  (
    export OLIPHAUNT_WASM_BUILD_PROFILE="$profile"
    # These are owned build constants, not inherited consumer overrides.
    export OLIPHAUNT_WASM_GUEST_STACK_SIZE=1MB
    export OLIPHAUNT_WASM_INITIAL_MEMORY_SIZE=1MB
    . "$root/profile_flags.sh"
    [ "$OLIPHAUNT_WASM_GUEST_STACK_SIZE" = 8MB ]
    [ "$OLIPHAUNT_WASM_INITIAL_MEMORY_SIZE" = 128MB ]
    original="$(oliphaunt_wasix_wasix_profile_signature)"
    OLIPHAUNT_WASM_GUEST_STACK_SIZE=16MB
    [ "$original" != "$(oliphaunt_wasix_wasix_profile_signature)" ]
    OLIPHAUNT_WASM_GUEST_STACK_SIZE=8MB
    OLIPHAUNT_WASM_INITIAL_MEMORY_SIZE=256MB
    [ "$original" != "$(oliphaunt_wasix_wasix_profile_signature)" ]
  )
done
echo 'WASIX guest memory budget/profile identity: PASS'
