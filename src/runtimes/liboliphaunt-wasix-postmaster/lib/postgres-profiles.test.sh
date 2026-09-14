#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/lib/common.sh"
source "$root/lib/postgres-profiles.sh"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

[ "$(fresh_postgres_runtime_footprint_file embedded-concurrent)" = \
  "$root/profiles/runtime-footprints/embedded-concurrent-v1.gucs" ]
[ "$(fresh_postgres_durability_file safe)" = \
  "$root/profiles/durability/safe-v1.gucs" ]
if fresh_postgres_runtime_footprint_file ../embedded-concurrent >/dev/null 2>&1; then
  echo 'unsafe runtime-footprint ID was accepted' >&2
  exit 1
fi
if fresh_postgres_durability_file safest >/dev/null 2>&1; then
  echo 'unknown durability ID was accepted' >&2
  exit 1
fi

fresh_resolve_postgres_profiles embedded-concurrent safe \
  work_mem=4MB shared_buffers=64MB
expected=$'autovacuum_worker_slots=4\nfsync=on\nfull_page_writes=on\nio_method=sync\nmax_connections=8\nmax_wal_senders=10\nmax_worker_processes=8\nshared_buffers=64MB\nsynchronous_commit=on\nwork_mem=4MB'
[ "$(printf '%s\n' "${FRESH_POSTGRES_PROFILE_GUCS[@]}")" = "$expected" ]
[ "${FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT[*]}" = shared_buffers ]
[ "$FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256" = \
  "$(fresh_wasmer_bin_hash "$root/profiles/runtime-footprints/embedded-concurrent-v1.gucs")" ]
[ "$FRESH_POSTGRES_DURABILITY_SHA256" = \
  "$(fresh_wasmer_bin_hash "$root/profiles/durability/safe-v1.gucs")" ]
[[ "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" =~ ^[0-9a-f]{64}$ ]]
first_resolution_identity="$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY"
fresh_write_postgres_profile_evidence \
  "$tmp/profile-inputs.tsv" "$tmp/profile-resolution.tsv"
[ "$(stat -c '%a' "$tmp/profile-inputs.tsv")" = 444 ]
[ "$(stat -c '%a' "$tmp/profile-resolution.tsv")" = 444 ]
[ "$(awk 'END { print NR }' "$tmp/profile-inputs.tsv")" -eq 3 ]
awk -F '\t' '
  NR == 1 { next }
  $1 == "shared_buffers" {
    found = 1
    if ($2 != "64MB" || $3 != "explicit" || $7 != 3) exit 1
  }
  END { exit !found }
' "$tmp/profile-resolution.tsv"
inputs_sha256="$(fresh_wasmer_bin_hash "$tmp/profile-inputs.tsv")"
resolution_sha256="$(fresh_wasmer_bin_hash "$tmp/profile-resolution.tsv")"
if fresh_write_postgres_profile_evidence \
  "$tmp/profile-inputs.tsv" "$tmp/profile-resolution.tsv" >/dev/null 2>&1; then
  echo 'existing PostgreSQL profile evidence was replaced' >&2
  exit 1
fi
[ "$(fresh_wasmer_bin_hash "$tmp/profile-inputs.tsv")" = "$inputs_sha256" ]
[ "$(fresh_wasmer_bin_hash "$tmp/profile-resolution.tsv")" = "$resolution_sha256" ]

# Either durable member can survive an interrupted pair publication. Replaying
# the same resolved profiles verifies that member and admits only its sibling.
mkdir -p "$tmp/partial-input" "$tmp/partial-resolution"
fresh_write_postgres_profile_evidence \
  "$tmp/partial-input/inputs.tsv" "$tmp/partial-input/resolution.tsv"
partial_input_inode="$(stat -c '%d:%i' "$tmp/partial-input/inputs.tsv")"
rm -f -- "$tmp/partial-input/resolution.tsv"
fresh_write_postgres_profile_evidence \
  "$tmp/partial-input/inputs.tsv" "$tmp/partial-input/resolution.tsv"
[ "$(stat -c '%d:%i' "$tmp/partial-input/inputs.tsv")" = \
  "$partial_input_inode" ]
[ -f "$tmp/partial-input/resolution.tsv" ]

fresh_write_postgres_profile_evidence \
  "$tmp/partial-resolution/inputs.tsv" \
  "$tmp/partial-resolution/resolution.tsv"
partial_resolution_inode="$(stat -c '%d:%i' \
  "$tmp/partial-resolution/resolution.tsv")"
rm -f -- "$tmp/partial-resolution/inputs.tsv"
fresh_write_postgres_profile_evidence \
  "$tmp/partial-resolution/inputs.tsv" \
  "$tmp/partial-resolution/resolution.tsv"
[ "$(stat -c '%d:%i' "$tmp/partial-resolution/resolution.tsv")" = \
  "$partial_resolution_inode" ]
[ -f "$tmp/partial-resolution/inputs.tsv" ]

mkdir -p "$tmp/relocated/profiles/runtime-footprints" \
  "$tmp/relocated/profiles/durability"
cp "$root/profiles/runtime-footprints/embedded-concurrent-v1.gucs" \
  "$tmp/relocated/profiles/runtime-footprints/embedded-concurrent-v1.gucs"
cp "$root/profiles/durability/safe-v1.gucs" \
  "$tmp/relocated/profiles/durability/safe-v1.gucs"
FRESH_ROOT="$tmp/relocated"
fresh_resolve_postgres_profiles embedded-concurrent safe \
  work_mem=4MB shared_buffers=64MB
[ "$FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY" = "$first_resolution_identity" ]
export FRESH_ROOT="$root"

if fresh_resolve_postgres_profiles embedded-concurrent safe work_mem=4MB work_mem=8MB \
  >/dev/null 2>&1; then
  echo 'duplicate explicit setting was accepted' >&2
  exit 1
fi

write_invalid() {
  local name="$1"
  local contents="$2"
  printf '%b' "$contents" >"$tmp/$name.gucs"
  if fresh_postgres_profile_file_rows runtime-footprint test "$tmp/$name.gucs" \
    "$(fresh_wasmer_bin_hash "$tmp/$name.gucs")" >/dev/null 2>&1; then
    printf 'invalid profile fixture was accepted: %s\n' "$name" >&2
    exit 1
  fi
}
write_invalid blank $'io_method=sync\n\n'
write_invalid syntax $'io_method sync\n'
write_invalid uppercase $'IO_METHOD=sync\n'
write_invalid duplicate $'io_method=sync\nio_method=worker\n'
write_invalid control $'io_method=sy\tnc\n'
write_invalid no-newline 'io_method=sync'
ln -s "$root/profiles/runtime-footprints/embedded-concurrent-v1.gucs" \
  "$tmp/symlink.gucs"
if fresh_postgres_profile_file_rows runtime-footprint test "$tmp/symlink.gucs" \
  deadbeef >/dev/null 2>&1; then
  echo 'symlinked profile was accepted' >&2
  exit 1
fi

fresh_resolve_postgres_profiles embedded-concurrent safe
settings="$tmp/effective.tsv"
{
  printf 'name\tsetting\tunit\tsource\n'
  printf 'autovacuum_worker_slots\t4\t\tcommand line\n'
  printf 'fsync\ton\t\tcommand line\n'
  printf 'full_page_writes\ton\t\tcommand line\n'
  printf 'io_method\tsync\t\tcommand line\n'
  printf 'max_connections\t8\t\tcommand line\n'
  printf 'max_wal_senders\t10\t\tcommand line\n'
  printf 'max_worker_processes\t8\t\tcommand line\n'
  printf 'shared_buffers\t4096\t8kB\tcommand line\n'
  printf 'synchronous_commit\ton\t\tcommand line\n'
} >"$settings"
fresh_validate_postgres_profile_settings "$settings" "$tmp/validation.tsv"
[ "$(stat -c '%a' "$tmp/validation.tsv")" = 444 ]
[ "$(awk -F '\t' 'NR > 1 && $7 == "matched" { count++ } END { print count + 0 }' \
  "$tmp/validation.tsv")" -eq 9 ]
sed 's/shared_buffers\t4096/shared_buffers\t8192/' "$settings" >"$tmp/mismatch.tsv"
if fresh_validate_postgres_profile_settings \
  "$tmp/mismatch.tsv" "$tmp/mismatch-validation.tsv"; then
  echo 'mismatched effective profile was accepted' >&2
  exit 1
fi
grep -q $'^shared_buffers\t4096\t8kB\t8192\t8kB\tcommand line\tmismatched$' \
  "$tmp/mismatch-validation.tsv"
printf 'existing validation\n' >"$tmp/existing-validation.tsv"
existing_validation_sha256="$(fresh_wasmer_bin_hash "$tmp/existing-validation.tsv")"
if fresh_validate_postgres_profile_settings \
  "$settings" "$tmp/existing-validation.tsv" >/dev/null 2>&1; then
  echo 'existing PostgreSQL profile validation was replaced' >&2
  exit 1
fi
[ "$(fresh_wasmer_bin_hash "$tmp/existing-validation.tsv")" = \
  "$existing_validation_sha256" ]

original_path="$FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH"
original_digest="$FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256"
printf 'io_method=worker\n' >"$tmp/mutated.gucs"
FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH="$tmp/mutated.gucs"
if fresh_assert_postgres_profile_inputs >/dev/null 2>&1; then
  echo 'mutated profile identity was accepted' >&2
  exit 1
fi
FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH="$original_path"
FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256="$original_digest"

printf 'passed: PostgreSQL profile resolution and evidence\n'
