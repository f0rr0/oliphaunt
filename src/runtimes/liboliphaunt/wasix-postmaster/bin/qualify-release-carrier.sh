#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"

carrier="$(fresh_select_current_sealed_carrier)"
target="$(fresh_release_target)"

bash "$project_root/bin/build-native-client-tools.sh"
if [ "$target" = macos-arm64 ]; then
  exec bash "$project_root/bin/qualify-wasix-immediate-recovery.sh" \
    --target "$target" \
    --sealed-carrier "$carrier"
fi

receipt_dir="$FRESH_WORK_ROOT/immutable-receipts"
mkdir -p "$receipt_dir"
receipt="$receipt_dir/$(basename "$carrier").json"
cleanup() {
  status=$?
  trap - EXIT
  if [ -f "$receipt" ]; then
    sudo bash "$project_root/bin/deploy-immutable-sealed-carrier.sh" \
      --sealed-carrier "$carrier" \
      --receipt "$receipt" \
      --remove || {
        cleanup_status=$?
        [ "$status" -ne 0 ] || status=$cleanup_status
      }
  fi
  exit "$status"
}
trap cleanup EXIT
sudo bash "$project_root/bin/deploy-immutable-sealed-carrier.sh" \
  --sealed-carrier "$carrier" \
  --receipt "$receipt"
bash "$project_root/bin/qualify-wasix-immediate-recovery.sh" \
  --target "$target" \
  --sealed-carrier "$carrier" \
  --immutable-carrier-receipt "$receipt" \
  --cgroup-memory-max 4G \
  --cgroup-memory-high 3G \
  --cgroup-swap-max 0
