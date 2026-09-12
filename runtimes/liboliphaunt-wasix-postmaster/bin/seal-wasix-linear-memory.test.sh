#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$project_root/lib/common.sh"
memory_tool="$FRESH_MEMORY_PROFILE_BIN"
[ -f "$memory_tool" ] && [ -x "$memory_tool" ] || {
  printf 'missing executable memory-profile tool: %s\n' "$memory_tool" >&2
  exit 2
}
repo_root="$(cd "$project_root/../.." && pwd -P)"
mkdir -p "$repo_root/target/oliphaunt-wasix-postmaster"
test_root="$(mktemp -d "$repo_root/target/oliphaunt-wasix-postmaster/linear-memory-test.XXXXXX")"
cleanup() {
  chmod -R u+w "$test_root" 2>/dev/null || true
  rm -rf -- "$test_root"
}
trap cleanup EXIT

make_fixture() {
  local name="$1"
  local root="$test_root/$name"
  local receipt="$root/executor.receipt"
  mkdir -p \
    "$root/install/bin" \
    "$root/install/lib/postgresql" \
    "$root/install/share/postgresql"
  for relative in bin/initdb bin/postgres lib/libpq.so.5.18 lib/postgresql/dict_snowball.so lib/postgresql/plpgsql.so; do
    printf '\x00\x61\x73\x6d\x01\x00\x00\x00\x02\x12\x01\x03\x65\x6e\x76\x06\x6d\x65\x6d\x6f\x72\x79\x02\x03\x01\x80\x80\x04' >"$root/install/$relative"
    chmod 0755 "$root/install/$relative"
  done
  bun "$project_root/testdata/make-sealed-export-fixture.mts" \
    --install-root "$root/install" \
    --project-root "$project_root"
  cp "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" "$receipt"
  printf '%s\n' "$root"
}

invoke() {
  local root="$1"
  FRESH_WORK_ROOT="$test_root/work" \
  WASIX_INSTALL_DIR="$root/install" \
  FRESH_WASIX_PRIVATE_INSTALL_DIR="$root/install" \
  FRESH_MEMORY_PROFILE_BIN="$memory_tool" \
  FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="$root/executor.receipt" \
    "$project_root/bin/seal-wasix-linear-memory.sh" \
      --install-dir "$root/install" \
      --predecessor-receipt \
        "$root/install/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
}

success_root="$(make_fixture success)"
invoke "$success_root"
module_paths="$(bun "$project_root/lib/linear-memory-profile.mts" modules "$success_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json")"
[ "$(printf '%s\n' "$module_paths" | wc -l | tr -d '[:space:]')" = 29 ]
printf '%s\n' "$module_paths" | LC_ALL=C sort -c
while IFS= read -r relative; do
  "$memory_tool" verify "$success_root/install/$relative" >/dev/null
done <<<"$module_paths"
receipt_before="$(sha256sum "$success_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" | awk '{print $1}')"
invoke "$success_root" >/dev/null
receipt_after="$(sha256sum "$success_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" | awk '{print $1}')"
[ "$receipt_before" = "$receipt_after" ] || {
  echo 'idempotent linear-memory sealing changed the aggregate receipt' >&2
  exit 1
}


# Completed generations must never be rewritten by standalone sealers.
printf 'admitted guest\n' >"$success_root/install/guest-build.receipt"
if invoke "$success_root" >/dev/null 2>&1; then
  echo 'memory sealer accepted a published generation' >&2
  exit 1
fi
[ "$(sha256sum "$success_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" | awk '{print $1}')" = "$receipt_before" ]

invalid_root="$(make_fixture invalid)"
printf 'invalid module\n' >"$invalid_root/install/bin/initdb"
if invoke "$invalid_root" >/dev/null 2>&1; then
  echo 'memory sealer accepted a broken predecessor chain' >&2
  exit 1
fi
[ ! -e "$invalid_root/install/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json" ]
printf 'WASIX private linear-memory sealer tests passed\n'
