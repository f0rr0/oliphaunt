#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
publication="$project_root/lib/durable-publication.mts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf 'exact durable evidence\n' > "$work/expected"
for point in source-fsync link destination-fsync commit-directory-fsync source-unlink cleanup-directory-fsync; do
  mkdir "$work/$point"
  pending="$work/$point/pending"
  admitted="$work/$point/admitted"
  bun "$publication" write-stdin "$pending" < "$work/expected"
  status=0
  bun "$project_root/testdata/crash-durable-publication.mts" "$point" "$pending" "$admitted" > "$work/$point/crash.log" 2>&1 || status=$?
  [ "$status" -eq 137 ] || { cat "$work/$point/crash.log" >&2; exit 1; }
  if [ -f "$admitted" ]; then
    bun "$publication" require-equal "$work/expected" "$admitted"
    bun "$publication" discard-private "$pending"
  else
    bun "$publication" publish "$pending" "$admitted"
  fi
  [ ! -e "$pending" ]
  before="$(bun "$publication" identify-source "$admitted")"
  bun "$publication" write-stdin "$pending" < "$work/expected"
  bun "$publication" require-equal "$pending" "$admitted"
  bun "$publication" discard-private "$pending"
  [ "$(bun "$publication" identify-source "$admitted")" = "$before" ]
done
# Exercise a pipe larger than the comparison bound, including token handoff and
# partial-set replay. The producer must stream without dropping pipe output.
dd if=/dev/zero bs=1048576 count=17 2>/dev/null |
  bun "$publication" write-stdin-identified "$work/large" > "$work/large.token"
IFS=$'\t' read -r device inode size hash < "$work/large.token"
[ "$size" -eq 17825792 ]
bun "$publication" publish-identified "$work/large" "$work/large-published" "$device" "$inode" "$size" "$hash"
printf 'wrong generation' > "$work/large"
chmod 0444 "$work/large"
if bun "$publication" publish-identified "$work/large" "$work/forbidden" "$device" "$inode" "$size" "$hash" >/dev/null 2>&1; then
  exit 1
fi
[ ! -e "$work/forbidden" ]
for name in first second; do
  bun "$publication" write-stdin "$work/$name" < "$work/large-published"
done
bun "$publication" publish-set "$work/first" "$work/large-published" "$work/second" "$work/second-published"
[ ! -e "$work/first" ] && [ ! -e "$work/second" ]
cmp "$work/large-published" "$work/second-published"
printf 'durable publication crash boundaries and streamed CLI handoff passed\n'
