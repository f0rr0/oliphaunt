#!/usr/bin/env bash
set -euo pipefail
sql_name='' stem='' simulator='' device='' macos='' output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --help ] || [ "$1" = -h ]; then
    echo 'usage: ios-extension-registration.sh --sql-name NAME --native-module-stem STEM --simulator-out DIR --device-out DIR --macos-out DIR --output FILE'
    exit 0
  fi
  [ "$#" -ge 2 ] || { echo "missing value for $1" >&2; exit 1; }
  case "$1" in
    --sql-name) sql_name=$2 ;; --native-module-stem) stem=$2 ;;
    --simulator-out) simulator=$2 ;; --device-out) device=$2 ;; --macos-out) macos=$2 ;;
    --output) output=$2 ;; *) echo "unknown argument $1" >&2; exit 1 ;;
  esac
  shift 2
done
for required in "$sql_name" "$stem" "$simulator" "$device" "$macos" "$output"; do
  [ -n "$required" ] || { echo 'all registration arguments are required' >&2; exit 1; }
done
for identifier in "$sql_name" "$stem"; do
  case "$identifier" in *[!A-Za-z0-9._-]*) echo 'invalid extension identifier' >&2; exit 1 ;; esac
  [ "${#identifier}" -le 128 ] || exit 1
done
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-ios-symbols-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
index=0
for slice in "$simulator" "$device" "$macos"; do
  objects=()
  while IFS= read -r object || [ -n "$object" ]; do
    object=${object%$'\r'}
    [ -n "$object" ] || continue
    case "$object" in -*) object="./$object" ;; esac
    objects+=("$object")
  done < "$slice/extensions/$stem/objects.list"
  [ "${#objects[@]}" -gt 0 ] || { echo "empty object list for $slice/$stem" >&2; exit 1; }
  nm -g "${objects[@]}" | head -c 67108865 > "$scratch/$index.txt"
  index=$((index + 1))
done
bun "$(dirname "${BASH_SOURCE[0]}")/ios-extension-registration.mts" "$sql_name" "$stem" "$simulator" "$device" "$macos" "$output" "$scratch"
