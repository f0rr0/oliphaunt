#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
builder="$project_root/bin/build-wasix-core.sh"

for unsupported in copied-fork fork typo; do
  set +e
  output="$(WASIX_CORE_CHILD_BACKEND="$unsupported" "$builder" --configure-only 2>&1)"
  status=$?
  set -e

  [ "$status" -eq 2 ] || {
    printf 'unsupported backend %s exited %s instead of 2\n' \
      "$unsupported" "$status" >&2
    exit 1
  }
  [ "$output" = "unsupported WASIX_CORE_CHILD_BACKEND=$unsupported; expected exec" ] || {
    printf 'unexpected unsupported-backend diagnostic for %s: %s\n' \
      "$unsupported" "$output" >&2
    exit 1
  }
done

test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-build-identity.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
signature_function="$test_root/compute-source-signature.sh"
sed -n '/^compute_source_signature() {$/,/^}$/p' \
  "$builder" >"$signature_function"
[ -s "$signature_function" ] || {
  echo 'could not extract compute_source_signature from builder' >&2
  exit 1
}
# shellcheck source=/dev/null
source "$signature_function"

# Keep every source input fixed while varying only the immutable builder ID.
# File hashing is replaced with stable fixture records; the final pipeline hash
# still processes the complete framed source-signature stream.
shasum() {
  [ "${1-}" = -a ] && [ "${2-}" = 256 ] || return 2
  shift 2
  if [ "$#" -gt 0 ]; then
    local path
    for path in "$@"; do
      printf '%064d  %s\n' 0 "$path"
    done
    return
  fi
  python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest(), " -")'
}

postgres_worktree_signature="$test_root/postgres-worktree.signature"
printf 'schema=fixture\nworktree_state_sha256=%064d\n' 0 \
  >"$postgres_worktree_signature"
FRESH_ROOT="$project_root"
durable_publication="$project_root/lib/durable_publication.py"
WASIXCC_SYSROOT_PREFIX=""
WASIXCC_SYSROOT=""
WASIX_CORE_PROFILE=release-o3
wasix_core_child_backend=exec
wasix_core_latch_state_contract=packed-atomic-v1
wasix_core_cflags='-O3 -g0 -flto=thin'
wasix_core_ldflags='-flto=thin'
wasixcc_run_wasm_opt=yes
wasixcc_wasm_opt_flags='--converge --strip-debug --strip-producers'
wasixcc_wasm_opt_suppress_default=yes
expected_atomic_fence_total=1111
expected_final_atomic_fence_total=995
FRESH_LINEAR_MEMORY_PROFILE_ID=fixture-linear-memory
FRESH_LINEAR_MEMORY_MAXIMUM_PAGES=4096
FRESH_LINEAR_MEMORY_STATIC_BOUND_PAGES=65536
FRESH_LINEAR_MEMORY_STATIC_OFFSET_GUARD_BYTES=2147483648
worktree_state="$(printf '1%.0s' {1..64})"
first_image_id="sha256:$(printf 'a%.0s' {1..64})"
second_image_id="sha256:$(printf 'b%.0s' {1..64})"
first_signature="$(compute_source_signature "$worktree_state" "$first_image_id")"
replayed_signature="$(compute_source_signature "$worktree_state" "$first_image_id")"
second_signature="$(compute_source_signature "$worktree_state" "$second_image_id")"
case "$first_signature$replayed_signature$second_signature" in
  *[!0-9a-f]*|'') echo 'source signature fixture did not emit canonical SHA-256 values' >&2; exit 1 ;;
esac
[ "${#first_signature}" -eq 64 ] && \
  [ "${#replayed_signature}" -eq 64 ] && \
  [ "${#second_signature}" -eq 64 ] || {
  echo 'source signature fixture emitted a non-SHA-256 length' >&2
  exit 1
}
[ "$first_signature" = "$replayed_signature" ] || {
  echo 'identical immutable builder IDs produced different source signatures' >&2
  exit 1
}
[ "$first_signature" != "$second_signature" ] || {
  echo 'an immutable builder image ID-only change did not invalidate the source signature' >&2
  exit 1
}

image_line="$(grep -nF -m1 'docker_image_id="$(fresh_wasix_builder_image_id)"' \
  "$builder" | cut -d: -f1)"
signature_line="$(grep -nF -m1 \
  'compute_source_signature "$postgres_worktree_state" "$docker_image_id"' \
  "$builder" | cut -d: -f1)"
[ -n "$image_line" ] && [ -n "$signature_line" ] && \
  [ "$image_line" -lt "$signature_line" ] || {
  echo 'builder must resolve the immutable image ID before its source signature' >&2
  exit 1
}
grep -Fq "printf 'docker_image_id=%s\\n' \"\$docker_image_id\"" "$builder" || {
  echo 'guest build receipt does not record the immutable Docker image ID' >&2
  exit 1
}
grep -Fq 'fresh_require_managed_generated_path "$WASIX_INSTALL_DIR" WASIX_INSTALL_DIR' \
  "$builder" &&
  grep -Fq 'rm -rf "$WASIX_BUILD_DIR" "$WASIX_INSTALL_DIR"' "$builder" || {
  echo 'clean rebuild must validate and reset both managed output trees' >&2
  exit 1
}

printf 'WASIX core backend validation tests passed\n'
