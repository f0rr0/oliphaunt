#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export OLIPHAUNT_ANDROID_ABI="${OLIPHAUNT_ANDROID_ABI:-x86_64}"
exec "$script_dir/build-postgres18-android-arm64.sh" "$@"
