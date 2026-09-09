#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"

carrier="$(fresh_select_current_sealed_carrier)"
target="$(fresh_release_target)"

bash "$project_root/bin/build-native-client-tools.sh"
exec bash "$project_root/bin/qualify-wasix-immediate-recovery.sh" \
  --target "$target" \
  --sealed-carrier "$carrier" "$@"
