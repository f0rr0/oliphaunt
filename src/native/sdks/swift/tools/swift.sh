#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
bash "$root/src/native/mobile-bindings/tools/generate.sh"
bash "$root/src/native/sdks/swift/tools/prepare-bindings.sh"
exec swift "$@" --package-path "$root/src/native/sdks/swift"
