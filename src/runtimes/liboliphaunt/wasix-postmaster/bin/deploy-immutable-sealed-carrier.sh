#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$project_root/lib/common.sh"
source "$project_root/lib/sealed-carrier.sh"
source "$project_root/lib/qualification-identities.sh"

usage() {
  cat <<'USAGE'
Usage: deploy-immutable-sealed-carrier.sh --sealed-carrier DIR --receipt FILE [--remove]

Deploy the exact sealed carrier's complete AOT closure as Linux ext-family
immutable inodes. This command requires effective UID 0 and
CAP_LINUX_IMMUTABLE. The canonical receipt is written outside the carrier
before any inode flag changes and doubles as a crash-recovery journal.

--remove restores only the exact receipt-bound inodes to their recorded
pre-deployment flags and then removes that exact receipt. It never traverses or
changes another carrier entry.
USAGE
}

carrier=""
receipt=""
remove=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sealed-carrier)
      shift
      [ "$#" -gt 0 ] || { echo '--sealed-carrier requires a directory' >&2; exit 2; }
      [ -z "$carrier" ] || { echo '--sealed-carrier may only be specified once' >&2; exit 2; }
      carrier="$1"
      ;;
    --receipt)
      shift
      [ "$#" -gt 0 ] || { echo '--receipt requires a file' >&2; exit 2; }
      [ -z "$receipt" ] || { echo '--receipt may only be specified once' >&2; exit 2; }
      receipt="$1"
      ;;
    --remove) remove=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[ -n "$carrier" ] || { echo '--sealed-carrier is required' >&2; exit 2; }
[ -n "$receipt" ] || { echo '--receipt is required' >&2; exit 2; }
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

fresh_capture_qualification_carrier_identity "$carrier" || {
  printf 'sealed carrier verification failed: %s\n' "$carrier" >&2
  exit 1
}

arguments=(
  --carrier "$carrier"
  --receipt "$receipt"
  --manifest-sha256 "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
  --wasmer-build-receipt-sha256 "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
  --payload-inventory-sha256 "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
  --headless-sha256 "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
)
if [ "$remove" -eq 1 ]; then
  python3 "$project_root/lib/immutable-carrier.py" --remove "${arguments[@]}"
  fresh_verify_sealed_headless_carrier "$carrier" || {
    echo 'carrier verification failed after immutable deployment removal' >&2
    exit 1
  }
else
  python3 "$project_root/lib/immutable-carrier.py" --deploy "${arguments[@]}"
  # The complete payload is verified again after +i, then the read-only
  # deployment verifier proves the receipt and every live immutable inode.
  fresh_capture_qualification_carrier_identity "$carrier" || {
    echo 'carrier verification failed after immutable deployment' >&2
    exit 1
  }
  python3 "$project_root/lib/immutable-carrier.py" --verify "${arguments[@]}"
fi
