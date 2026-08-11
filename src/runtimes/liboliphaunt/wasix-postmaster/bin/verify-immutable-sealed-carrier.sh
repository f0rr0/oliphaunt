#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"
source "$project_root/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: verify-immutable-sealed-carrier.sh --sealed-carrier DIR --receipt FILE [--fast]

Without --fast, perform one complete cryptographic carrier verification and
bind it to the immutable deployment receipt. With --fast, read only the small
receipt and verify the receipt-bound inode identities, modes, and +i flags.
The fast form is valid only between full campaign-boundary verifications.
USAGE
}

carrier=""
receipt=""
fast=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier)
      shift
      [ "$#" -gt 0 ] && [ -z "$carrier" ] || { usage >&2; exit 2; }
      carrier="$1"
      ;;
    --receipt)
      shift
      [ "$#" -gt 0 ] && [ -z "$receipt" ] || { usage >&2; exit 2; }
      receipt="$1"
      ;;
    --fast) fast=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
[ -n "$carrier" ] && [ -n "$receipt" ] || { usage >&2; exit 2; }
[ -d "$carrier" ] && [ ! -L "$carrier" ] || {
  printf 'sealed carrier must be a non-symlink directory: %s\n' "$carrier" >&2
  exit 2
}
carrier="$(cd "$carrier" && pwd -P)"
receipt_parent="$(dirname "$receipt")"
[ -d "$receipt_parent" ] && [ ! -L "$receipt_parent" ] || {
  printf 'receipt parent must be a non-symlink directory: %s\n' "$receipt_parent" >&2
  exit 2
}
receipt="$(cd "$receipt_parent" && pwd -P)/$(basename "$receipt")"

arguments=(--verify-fast --carrier "$carrier" --receipt "$receipt")
if [ "$fast" -eq 0 ]; then
  fresh_capture_qualification_carrier_identity "$carrier" || {
    printf 'sealed carrier verification failed: %s\n' "$carrier" >&2
    exit 1
  }
  arguments+=(
    --manifest-sha256 "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
    --wasmer-build-receipt-sha256 "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
    --payload-inventory-sha256 "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
    --headless-sha256 "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
  )
fi
python3 "$project_root/lib/immutable-carrier.py" "${arguments[@]}"
