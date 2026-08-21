#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-wasmer-receipt.XXXXXX")"
test_root="$(cd "$test_root" && pwd -P)"
guard_sandbox=""

cleanup() {
  if [ -n "$guard_sandbox" ]; then
    rm -f "$guard_sandbox/escape"
    rmdir "$guard_sandbox" 2>/dev/null || true
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

export FRESH_WORK_ROOT="$test_root/work"
export FRESH_UPSTREAM_WASMER_BIN="$test_root/patched-wasmer"
export FRESH_UPSTREAM_WASMER_HEADLESS_BIN="$test_root/patched-wasmer-headless"
export FRESH_POSTMASTER_EXECUTOR_BIN="$test_root/postmaster-executor"
export FRESH_START_PROOF_BIN="$test_root/start-proof"
export FRESH_MEMORY_PROFILE_BIN="$test_root/memory-profile"
export FRESH_POSTMASTER_COMPILER_BIN="$test_root/postmaster-compiler"
export FRESH_WASMER_BUILD_RECEIPT="$test_root/default-build-receipt-must-not-be-used"
export FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="$test_root/postmaster-executor-build.receipt"
export WASMER_BUILD_RECEIPT="$test_root/wasmer-build.receipt"
unset WASMER_BIN

source "$project_root/lib/common.sh"

original_work_root="$FRESH_WORK_ROOT"
original_baseline_dir="$BASELINE_DIR"
mkdir -p "$(fresh_managed_generated_root)"
FRESH_WORK_ROOT="$(mktemp -d "$(fresh_managed_generated_root)/common-lock.XXXXXX")"
BASELINE_DIR="$FRESH_WORK_ROOT/sources/postgresql-$POSTGRES_VERSION"
fresh_lock_postgres_baseline exclusive
[ -f "$FRESH_WORK_ROOT/baseline-locks/postgres-baseline.lock" ]
fresh_unlock_postgres_baseline
[ -z "${FRESH_POSTGRES_BASELINE_LOCK_FD:-}" ]
rm -rf -- "$FRESH_WORK_ROOT"
FRESH_WORK_ROOT="$original_work_root"
BASELINE_DIR="$original_baseline_dir"

[ "$(fresh_release_target_for_host_arch linux-arm64)" = "linux-arm64-gnu" ]
[ "$(fresh_release_target_for_host_arch linux-amd64)" = "linux-x64-gnu" ]
[ "$(fresh_release_target_for_host_arch darwin-arm64)" = "macos-arm64" ]
[ "$(fresh_release_target_triple linux-arm64-gnu)" = "aarch64-unknown-linux-gnu" ]
[ "$(fresh_release_target_triple linux-x64-gnu)" = "x86_64-unknown-linux-gnu" ]
[ "$(fresh_release_target_triple macos-arm64)" = "aarch64-apple-darwin" ]
if fresh_release_target_for_host_arch darwin-amd64 >/dev/null 2>&1; then
  echo 'macOS x64 unexpectedly mapped to a WASIX postmaster release target' >&2
  exit 1
fi
if fresh_release_target_triple windows-x64-msvc >/dev/null 2>&1; then
  echo 'planned Windows x64 unexpectedly mapped to a qualified release triple' >&2
  exit 1
fi

if (FRESH_PROJECT_SOURCE_ID_PREFIX=mutable) 2>/dev/null; then
  echo 'canonical project source identity prefix remained mutable after sourcing' >&2
  exit 1
fi

expect_source_prefix_failure() {
  env FRESH_PROJECT_SOURCE_ID_PREFIX=wrong \
    bash -c 'source "$1/lib/common.sh"' bash "$project_root" >/dev/null 2>&1
}
if expect_source_prefix_failure; then
  echo 'common library accepted a caller-controlled project source identity prefix' >&2
  exit 1
fi
if env FRESH_PROJECT_SOURCE_ID_PREFIX=src/runtimes/liboliphaunt/wasix-postmaster \
  bash -c 'source "$1/lib/common.sh"; FRESH_PROJECT_SOURCE_ID_PREFIX=mutable' \
  bash "$project_root" >/dev/null 2>&1; then
  echo 'inherited canonical project source identity prefix remained mutable' >&2
  exit 1
fi

[ "$(fresh_project_source_identity_path \
  "$project_root/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch")" = \
  "src/runtimes/liboliphaunt/wasix-postmaster/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch" ]
original_fresh_root="$FRESH_ROOT"
frozen_root="$test_root/measurement-tool-closures/example"
mkdir -p "$frozen_root/runtime/patches/wasix-libc"
FRESH_ROOT="$frozen_root"
[ "$(fresh_project_source_identity_path \
  "$frozen_root/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch")" = \
  "src/runtimes/liboliphaunt/wasix-postmaster/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch" ]
expect_source_identity_failure() {
  fresh_project_source_identity_path "$1" >/dev/null 2>&1
}
if expect_source_identity_failure "$test_root/outside"; then
  echo 'source identity accepted a path outside the frozen project root' >&2
  exit 1
fi
FRESH_ROOT="$original_fresh_root"

live_runtime_recipe="$(fresh_runtime_build_recipe_sha256)"
for relative in \
  lib/common.sh \
  sources.lock.toml \
  runtime/capabilities.tsv \
  runtime/bin/prepare-upstream-checkouts.sh \
  runtime/bin/build-runtime.sh \
  runtime/bin/build-patched-wasix-libc-sysroot.sh \
  runtime/bin/validate-runtime-capabilities.sh \
  runtime/bin/verify-runtime-execution-ownership.py \
  runtime/bin/verify-runtime-state-ownership.py \
  runtime/bin/verify-source-lock.py; do
  mkdir -p "$frozen_root/$(dirname "$relative")"
  cp "$original_fresh_root/$relative" "$frozen_root/$relative"
  chmod u+w "$frozen_root/$relative"
done
FRESH_ROOT="$frozen_root"
[ "$(fresh_runtime_build_recipe_sha256)" = "$live_runtime_recipe" ] || {
  echo 'runtime build recipe changed under a byte-identical frozen project relocation' >&2
  exit 1
}
chmod -x "$frozen_root/runtime/bin/build-runtime.sh"
[ "$(fresh_runtime_build_recipe_sha256)" != "$live_runtime_recipe" ] || {
  echo 'runtime build recipe ignored executable-mode drift' >&2
  exit 1
}
chmod +x "$frozen_root/runtime/bin/build-runtime.sh"
[ "$(fresh_runtime_build_recipe_sha256)" = "$live_runtime_recipe" ] || {
  echo 'runtime build recipe did not recover after restoring executable mode' >&2
  exit 1
}
printf '\n# byte-drift probe\n' >>"$frozen_root/runtime/bin/verify-source-lock.py"
[ "$(fresh_runtime_build_recipe_sha256)" != "$live_runtime_recipe" ] || {
  echo 'runtime build recipe ignored producer validation byte drift' >&2
  exit 1
}
cp "$original_fresh_root/runtime/bin/verify-source-lock.py" \
  "$frozen_root/runtime/bin/verify-source-lock.py"
[ "$(fresh_runtime_build_recipe_sha256)" = "$live_runtime_recipe" ] || {
  echo 'runtime build recipe did not recover after restoring producer bytes' >&2
  exit 1
}
FRESH_ROOT="$original_fresh_root"

original_toolchain_root="$WASIX_TOOLCHAIN_ROOT"
live_builder_recipe="$(fresh_wasix_builder_recipe_sha256)"
portable_file_mode() {
  local mode
  local path="$1"

  if mode="$(stat -c %a "$path" 2>/dev/null)"; then
    :
  elif mode="$(stat -f %Lp "$path" 2>/dev/null)"; then
    :
  else
    printf 'could not read file mode: %s\n' "$path" >&2
    return 1
  fi
  printf '%s\n' "$mode"
}
builder_recipe_inputs=(
  docker/Dockerfile
  docker/isrg-root-x1.pem
  docker/install-pinned-apt-packages.sh
  docker/install-pinned-wasixcc.sh
  docker/pinned-wasixcc-assets.tsv
)

# The Dockerfile is itself the fifth recipe input. Every other recipe input
# must be a direct COPY source, and the Dockerfile must not consume an input
# that is absent from the recipe identity.
dockerfile_copy_sources="$(
  awk '
    toupper($1) != "COPY" { next }
    {
      source_field = 2
      while (source_field <= NF && $source_field ~ /^--/) {
        source_field++
      }
      if (source_field >= NF) {
        printf "unsupported Dockerfile COPY instruction on line %d\n", NR > "/dev/stderr"
        exit 2
      }
      for (field = source_field; field < NF; field++) {
        print $field
      }
    }
  ' "$original_toolchain_root/docker/Dockerfile"
)" || {
  echo 'failed to enumerate WASIX builder Dockerfile COPY sources' >&2
  exit 1
}
expected_builder_context_inputs="$(
  printf '%s\n' "${builder_recipe_inputs[@]#docker/}" | LC_ALL=C sort
)"
actual_builder_context_inputs="$(
  {
    printf 'Dockerfile\n'
    printf '%s\n' "$dockerfile_copy_sources"
  } | LC_ALL=C sort
)"
[ "$actual_builder_context_inputs" = "$expected_builder_context_inputs" ] || {
  printf 'WASIX builder recipe inputs do not match Dockerfile COPY sources\n' >&2
  printf 'expected:\n%s\nactual:\n%s\n' \
    "$expected_builder_context_inputs" "$actual_builder_context_inputs" >&2
  exit 1
}

builder_fixture="$test_root/builder-fixture"
mkdir -p "$builder_fixture"
cp -a "$original_toolchain_root/." "$builder_fixture/"
WASIX_TOOLCHAIN_ROOT="$builder_fixture"
for relative in "${builder_recipe_inputs[@]}"; do
  fixture="$builder_fixture/$relative"
  original_mode="$(portable_file_mode "$fixture")"
  fixture_runtime_recipe="$(fresh_runtime_build_recipe_sha256)"
  printf '\n# builder-recipe drift probe\n' >>"$fixture"
  [ "$(fresh_wasix_builder_recipe_sha256)" != "$live_builder_recipe" ] || {
    printf 'WASIX builder recipe ignored byte drift in %s\n' "$relative" >&2
    exit 1
  }
  [ "$(fresh_runtime_build_recipe_sha256)" != "$fixture_runtime_recipe" ] || {
    printf 'runtime build recipe ignored WASIX builder byte drift in %s\n' "$relative" >&2
    exit 1
  }
  cp "$original_toolchain_root/$relative" "$fixture"
  chmod "$original_mode" "$fixture"
  [ "$(fresh_wasix_builder_recipe_sha256)" = "$live_builder_recipe" ] || {
    printf 'WASIX builder recipe did not recover after restoring %s\n' "$relative" >&2
    exit 1
  }
done
rm "$builder_fixture/docker/Dockerfile"
if fresh_wasix_builder_recipe_sha256 >/dev/null 2>&1; then
  echo 'WASIX builder recipe accepted a missing context input' >&2
  exit 1
fi
ln -s "$original_toolchain_root/docker/Dockerfile" \
  "$builder_fixture/docker/Dockerfile"
if fresh_wasix_builder_recipe_sha256 >/dev/null 2>&1; then
  echo 'WASIX builder recipe accepted a symlink context input' >&2
  exit 1
fi
rm "$builder_fixture/docker/Dockerfile"
cp "$original_toolchain_root/docker/Dockerfile" "$builder_fixture/docker/Dockerfile"
WASIX_TOOLCHAIN_ROOT="$original_toolchain_root"

WASIX_TOOLCHAIN_ROOT="${original_toolchain_root#"$REPO_ROOT"/}"
if fresh_runtime_build_recipe_sha256 >/dev/null 2>&1; then
  echo 'runtime build recipe accepted a relative toolchain root' >&2
  exit 1
fi
WASIX_TOOLCHAIN_ROOT="$REPO_ROOT/../$(basename "$REPO_ROOT")/src/runtimes/liboliphaunt/wasix/assets/build"
if fresh_runtime_build_recipe_sha256 >/dev/null 2>&1; then
  echo 'runtime build recipe accepted a non-canonical toolchain root' >&2
  exit 1
fi
WASIX_TOOLCHAIN_ROOT="$original_toolchain_root"

worktree_fixture="$test_root/worktree-state"
mkdir -p "$worktree_fixture"
git -C "$worktree_fixture" init --quiet
git -C "$worktree_fixture" config user.email test@example.invalid
git -C "$worktree_fixture" config user.name 'Oliphaunt Test'
printf 'tracked\n' >"$worktree_fixture/tracked.txt"
git -C "$worktree_fixture" add tracked.txt
git -C "$worktree_fixture" commit --quiet -m fixture
clean_worktree_state="$(fresh_git_worktree_state_sha256 "$worktree_fixture")"
fresh_is_sha256 "$clean_worktree_state"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture")" = "$clean_worktree_state" ] || {
  echo 'Git worktree identity is not deterministic' >&2
  exit 1
}

printf 'changed\n' >"$worktree_fixture/tracked.txt"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture")" != "$clean_worktree_state" ] || {
  echo 'Git worktree identity ignored tracked byte drift' >&2
  exit 1
}
printf 'tracked\n' >"$worktree_fixture/tracked.txt"
chmod +x "$worktree_fixture/tracked.txt"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture")" != "$clean_worktree_state" ] || {
  echo 'Git worktree identity ignored tracked executable-mode drift' >&2
  exit 1
}
chmod -x "$worktree_fixture/tracked.txt"

printf 'untracked\n' >"$worktree_fixture/untracked.txt"
untracked_worktree_state="$(fresh_git_worktree_state_sha256 "$worktree_fixture")"
[ "$untracked_worktree_state" != "$clean_worktree_state" ] || {
  echo 'Git worktree identity ignored an untracked file' >&2
  exit 1
}
printf 'changed untracked\n' >"$worktree_fixture/untracked.txt"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture")" != "$untracked_worktree_state" ] || {
  echo 'Git worktree identity ignored untracked byte drift' >&2
  exit 1
}
chmod +x "$worktree_fixture/untracked.txt"
executable_untracked_state="$(fresh_git_worktree_state_sha256 "$worktree_fixture")"
chmod -x "$worktree_fixture/untracked.txt"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture")" != "$executable_untracked_state" ] || {
  echo 'Git worktree identity ignored untracked executable-mode drift' >&2
  exit 1
}

ln -s first-target "$worktree_fixture/untracked-link"
first_symlink_state="$(fresh_git_worktree_state_sha256 "$worktree_fixture")"
rm "$worktree_fixture/untracked-link"
ln -s second-target "$worktree_fixture/untracked-link"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture")" != "$first_symlink_state" ] || {
  echo 'Git worktree identity ignored an untracked symlink-target change' >&2
  exit 1
}

printf 'signature one\n' >"$worktree_fixture/.generated-signature"
excluded_worktree_state="$(
  fresh_git_worktree_state_sha256 "$worktree_fixture" .generated-signature
)"
printf 'signature two\n' >"$worktree_fixture/.generated-signature"
[ "$(fresh_git_worktree_state_sha256 "$worktree_fixture" .generated-signature)" = \
    "$excluded_worktree_state" ] || {
  echo 'Git worktree identity did not exclude its exact generated signature' >&2
  exit 1
}
if fresh_git_worktree_state_sha256 "$test_root/not-a-worktree" >/dev/null 2>&1; then
  echo 'Git worktree identity accepted a missing worktree' >&2
  exit 1
fi

for profile in safe-o2 o3 o3-wasmopt o3-thinlto release-o3 release-o3-symbols; do
  unset WASIXCC_WASM_OPT_SUPPRESS_DEFAULT
  fresh_resolve_wasix_core_profile "$profile"
  [ "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT" = yes ] || {
    printf 'profile %s did not suppress implicit wasm-opt defaults\n' "$profile" >&2
    exit 1
  }
done
fresh_resolve_wasix_core_profile safe-o2
[ "$FRESH_WASIX_CORE_EXPECTED_ATOMIC_FENCE_TOTAL" = 275 ]
[ "$FRESH_WASIX_CORE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL" = 233 ]
fresh_resolve_wasix_core_profile release-o3
[ "$FRESH_WASIX_CORE_EXPECTED_ATOMIC_FENCE_TOTAL" = 1111 ]
[ "$FRESH_WASIX_CORE_EXPECTED_FINAL_ATOMIC_FENCE_TOTAL" = 995 ]
WASIXCC_WASM_OPT_SUPPRESS_DEFAULT=no fresh_resolve_wasix_core_profile release-o3
[ "$FRESH_WASIX_CORE_EFFECTIVE_WASM_OPT_SUPPRESS_DEFAULT" = no ]
expect_invalid_wasm_opt_default() {
  WASIXCC_WASM_OPT_SUPPRESS_DEFAULT=invalid \
    fresh_resolve_wasix_core_profile release-o3 >/dev/null 2>&1
}
if expect_invalid_wasm_opt_default; then
  echo 'invalid wasm-opt default suppression value unexpectedly passed' >&2
  exit 1
fi
unset WASIXCC_WASM_OPT_SUPPRESS_DEFAULT

true_bin="$(type -P true)"
cp "$true_bin" "$FRESH_UPSTREAM_WASMER_BIN"
chmod u+wx "$FRESH_UPSTREAM_WASMER_BIN"
cp "$true_bin" "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
chmod u+wx "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
cp "$true_bin" "$FRESH_POSTMASTER_EXECUTOR_BIN"
chmod u+wx "$FRESH_POSTMASTER_EXECUTOR_BIN"
cp "$project_root/testdata/fake-start-proof.py" "$FRESH_START_PROOF_BIN"
chmod +x "$FRESH_START_PROOF_BIN"
cp "$true_bin" "$FRESH_MEMORY_PROFILE_BIN"
chmod u+wx "$FRESH_MEMORY_PROFILE_BIN"
cp "$project_root/testdata/fake-postmaster-compiler.py" "$FRESH_POSTMASTER_COMPILER_BIN"
chmod +x "$FRESH_POSTMASTER_COMPILER_BIN"

write_receipt() {
  local host_platform="${1:-$(fresh_host_arch)}"
  local receipt="${2:-$WASMER_BUILD_RECEIPT}"
  local cargo_lock_sha256
  local runtime_abi_id

  cargo_lock_sha256="$(printf test-cargo-lock | fresh_sha256_stream)"
  runtime_abi_id="$(fresh_runtime_abi_id \
    "$cargo_lock_sha256" test-host "$host_platform" "$(fresh_host_abi)")"

  {
    printf 'schema=oliphaunt.wasix-postmaster.wasmer-build.v2\n'
    printf 'build_recipe_sha256=%s\n' "$(fresh_runtime_build_recipe_sha256)"
    printf 'wasmer_source_commit=1d1b3420beef28550afbb4692b664bd7f6bc2581\n'
    printf 'wasmer_napi_commit=706383f42391cb4e4e82e5fd5e63a0ebf81ae19d\n'
    printf 'wasmer_test_files_commit=7f27e84c69af3b772f751d6c4a733d9f448b2c70\n'
    printf 'wasmer_spec_commit=7e0b83aba9dbbb6e0623c9334b0f73b3bb584b90\n'
    printf 'wasmer_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$project_root/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch")"
    printf 'wasmer_prepared_signature_sha256=%064d\n' 0
    printf 'wasmer_cargo_lock_sha256=%s\n' "$cargo_lock_sha256"
    printf 'wasmer_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_UPSTREAM_WASMER_BIN")"
    printf 'wasmer_features=%s\n' "$FRESH_WASMER_COMPILER_FEATURES"
    printf 'wasmer_headless_binary_sha256=%s\n' "$(fresh_wasmer_bin_hash "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN")"
    printf 'wasmer_headless_features=%s\n' "$FRESH_WASMER_HEADLESS_FEATURES"
    printf 'runtime_abi_id=%s\n' "$runtime_abi_id"
    printf 'artifact_abi_version=%s\n' "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
    printf 'wasix_libc_source_commit=34178a6272804f90448b5bd08dc7bcf0d85438e3\n'
    printf 'wasix_libc_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$project_root/runtime/patches/wasix-libc/0001-postgres-wasix-blockers.patch")"
    printf 'wasix_libc_prepared_signature_sha256=%064d\n' 0
    printf 'sysroot_carrier_manifest_sha256=%064d\n' 0
    printf 'sysroot_variant=%s\n' "$WASIXCC_SYSROOT_VARIANT"
    printf 'sysroot_variant_manifest_sha256=%064d\n' 0
    printf 'host_platform=%s\n' "$host_platform"
    printf 'host_abi=%s\n' "$(fresh_host_abi)"
    printf 'rustc_host=test-host\n'
    printf 'rustc_version=test-rustc\n'
    printf 'llvm_version=22.1.0\n'
  } >"$receipt"
}

write_postmaster_executor_receipt() {
  local receipt="${1:-$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT}"

  {
    printf 'schema=oliphaunt.wasix-postmaster.postmaster-executor-build.v3\n'
    printf 'build_recipe_sha256=%s\n' "$(fresh_runtime_build_recipe_sha256)"
    printf 'wasmer_build_receipt_sha256=%s\n' "$(fresh_wasmer_bin_hash "$WASMER_BUILD_RECEIPT")"
    printf 'wasmer_source_commit=%s\n' "$FRESH_WASMER_SOURCE_COMMIT"
    printf 'wasmer_patch_sha256=%s\n' "$(fresh_wasmer_bin_hash "$project_root/runtime/patches/wasmer/0001-postgres-wasix-blockers.patch")"
    printf 'wasmer_prepared_signature_sha256=%s\n' \
      "$(fresh_manifest_value "$WASMER_BUILD_RECEIPT" wasmer_prepared_signature_sha256)"
    printf 'wasmer_cargo_lock_sha256=%s\n' \
      "$(fresh_manifest_value "$WASMER_BUILD_RECEIPT" wasmer_cargo_lock_sha256)"
    printf 'runtime_abi_id=%s\n' \
      "$(fresh_manifest_value "$WASMER_BUILD_RECEIPT" runtime_abi_id)"
    printf 'artifact_abi_version=%s\n' "$FRESH_WASMER_ARTIFACT_ABI_VERSION"
    printf 'executor_package=%s\n' "$FRESH_POSTMASTER_EXECUTOR_PACKAGE"
    printf 'executor_binary=%s\n' "$FRESH_POSTMASTER_EXECUTOR_BINARY"
    printf 'executor_features=%s\n' "$FRESH_POSTMASTER_EXECUTOR_FEATURES"
    printf 'executor_role=%s\n' "$FRESH_POSTMASTER_EXECUTOR_ROLE"
    printf 'runtime_policy_id=%s\n' "$FRESH_POSTMASTER_EXECUTOR_RUNTIME_POLICY_ID"
    printf 'cli_contract=%s\n' "$FRESH_POSTMASTER_EXECUTOR_CLI_CONTRACT"
    printf 'executor_binary_sha256=%s\n' \
      "$(fresh_wasmer_bin_hash "$FRESH_POSTMASTER_EXECUTOR_BIN")"
    printf 'start_proof_binary=%s\n' "$FRESH_START_PROOF_BINARY"
    printf 'start_proof_features=%s\n' "$FRESH_START_PROOF_FEATURES"
    printf 'start_proof_policy=%s\n' "$FRESH_START_PROOF_POLICY"
    printf 'start_proof_binary_sha256=%s\n' \
      "$(fresh_wasmer_bin_hash "$FRESH_START_PROOF_BIN")"
    printf 'memory_profile_binary=%s\n' "$FRESH_MEMORY_PROFILE_BINARY"
    printf 'memory_profile_features=%s\n' "$FRESH_MEMORY_PROFILE_FEATURES"
    printf 'linear_memory_profile_id=%s\n' "$FRESH_LINEAR_MEMORY_PROFILE_ID"
    printf 'memory_profile_binary_sha256=%s\n' \
      "$(fresh_wasmer_bin_hash "$FRESH_MEMORY_PROFILE_BIN")"
    printf 'postmaster_compiler_binary=%s\n' "$FRESH_POSTMASTER_COMPILER_BINARY"
    printf 'postmaster_compiler_features=%s\n' "$FRESH_POSTMASTER_COMPILER_FEATURES"
    printf 'compiler_cpu_policy=generic-baseline\n'
    printf 'compiler_cpu_features=none\n'
    printf 'postmaster_compiler_binary_sha256=%s\n' \
      "$(fresh_wasmer_bin_hash "$FRESH_POSTMASTER_COMPILER_BIN")"
    printf 'host_platform=%s\n' "$(fresh_host_arch)"
    printf 'host_abi=%s\n' "$(fresh_host_abi)"
    printf 'rustc_host=%s\n' "$(fresh_manifest_value "$WASMER_BUILD_RECEIPT" rustc_host)"
    printf 'rustc_version=test-rustc\n'
  } >"$receipt"
}

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    printf 'expected command to fail: %s\n' "$*" >&2
    exit 1
  fi
}

fake_docker_bin_dir="$test_root/fake-docker-bin"
mkdir -p "$fake_docker_bin_dir"
cat >"$fake_docker_bin_dir/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_DOCKER_LOG:?}"
: "${FAKE_DOCKER_STATE:?}"
: "${FAKE_DOCKER_INITIAL_INSPECT:?}"
: "${FAKE_DOCKER_POST_BUILD_INSPECT:?}"
: "${FAKE_DOCKER_EXPECTED_RECIPE:?}"
: "${FAKE_DOCKER_IMAGE_SHA256:?}"

arguments=("$@")
{
  printf '%s' "${arguments[0]-}"
  for ((argument = 1; argument < ${#arguments[@]}; argument++)); do
    printf '\t%s' "${arguments[$argument]}"
  done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

if [ "${arguments[0]-}" = image ] && [ "${arguments[1]-}" = inspect ]; then
  response="$FAKE_DOCKER_INITIAL_INSPECT"
  if [ -s "$FAKE_DOCKER_STATE" ]; then
    response="$FAKE_DOCKER_POST_BUILD_INSPECT"
  fi
  combined_record=no
  case "${arguments[3]-}" in
    *'.Id'*) combined_record=yes ;;
  esac
  case "$response" in
    error) exit 1 ;;
    empty)
      if [ "$combined_record" = yes ]; then
        printf 'sha256:%s|\n' "$FAKE_DOCKER_IMAGE_SHA256"
      else
        printf '\n'
      fi
      ;;
    expected)
      if [ "$combined_record" = yes ]; then
        printf 'sha256:%s|%s\n' \
          "$FAKE_DOCKER_IMAGE_SHA256" "$FAKE_DOCKER_EXPECTED_RECIPE"
      else
        printf '%s\n' "$FAKE_DOCKER_EXPECTED_RECIPE"
      fi
      ;;
    stale)
      if [ "$combined_record" = yes ]; then
        printf 'sha256:%s|stale-recipe\n' "$FAKE_DOCKER_IMAGE_SHA256"
      else
        printf 'stale-recipe\n'
      fi
      ;;
    invalid-id)
      [ "$combined_record" = yes ] || exit 64
      printf 'sha256:not-a-sha256|%s\n' "$FAKE_DOCKER_EXPECTED_RECIPE"
      ;;
    non-sha256-id)
      [ "$combined_record" = yes ] || exit 64
      printf 'local-image-id|%s\n' "$FAKE_DOCKER_EXPECTED_RECIPE"
      ;;
    *)
      printf 'unsupported fake Docker inspect response: %s\n' "$response" >&2
      exit 64
      ;;
  esac
  exit 0
fi

if [ "${arguments[0]-}" = build ]; then
  printf 'built\n' >"$FAKE_DOCKER_STATE"
  exit 0
fi

printf 'unsupported fake Docker invocation: %s\n' "$*" >&2
exit 64
FAKE_DOCKER
chmod +x "$fake_docker_bin_dir/docker"
fake_docker_image_sha256=1111111111111111111111111111111111111111111111111111111111111111
fake_docker_image_id="sha256:$fake_docker_image_sha256"

run_fake_docker_case() {
  local name="$1"
  local initial_inspect="$2"
  local post_build_inspect="$3"
  local expected_status="$4"
  local expected_build_count="$5"
  local case_root="$test_root/fake-docker-$name"
  local image="oliphaunt-wasix-builder-test:$name"
  local label=dev.oliphaunt.wasix-builder.recipe-sha256
  local context="$original_toolchain_root/docker"
  local log="$case_root/invocations.tsv"
  local output="$case_root/output"
  local state="$case_root/state"
  local actual_status
  local actual_build_count
  local actual_inspect_count
  local expected_build
  local actual_build

  mkdir -p "$case_root"
  : >"$log"
  : >"$state"
  if (
    export PATH="$fake_docker_bin_dir:$PATH"
    export FAKE_DOCKER_LOG="$log"
    export FAKE_DOCKER_STATE="$state"
    export FAKE_DOCKER_INITIAL_INSPECT="$initial_inspect"
    export FAKE_DOCKER_POST_BUILD_INSPECT="$post_build_inspect"
    export FAKE_DOCKER_EXPECTED_RECIPE="$live_builder_recipe"
    export FAKE_DOCKER_IMAGE_SHA256="$fake_docker_image_sha256"
    fresh_ensure_docker_image "$image"
  ) >"$output" 2>&1; then
    actual_status=0
  else
    actual_status=$?
  fi
  [ "$actual_status" -eq "$expected_status" ] || {
    printf 'fake Docker case %s returned %s instead of %s\n' \
      "$name" "$actual_status" "$expected_status" >&2
    sed 's/^/  /' "$output" >&2
    exit 1
  }

  actual_build_count="$(
    awk -F '\t' '$1 == "build" { count++ } END { print count + 0 }' "$log"
  )"
  [ "$actual_build_count" -eq "$expected_build_count" ] || {
    printf 'fake Docker case %s built %s times instead of %s\n' \
      "$name" "$actual_build_count" "$expected_build_count" >&2
    exit 1
  }
  actual_inspect_count="$(
    awk -F '\t' '$1 == "image" && $2 == "inspect" { count++ } END { print count + 0 }' "$log"
  )"
  [ "$actual_inspect_count" -eq "$((expected_build_count + 1))" ] || {
    printf 'fake Docker case %s inspected %s times instead of %s\n' \
      "$name" "$actual_inspect_count" "$((expected_build_count + 1))" >&2
    exit 1
  }

  if [ "$expected_build_count" -eq 1 ]; then
    expected_build="$(printf 'build\t--label\t%s=%s\t-f\t%s/Dockerfile\t-t\t%s\t%s' \
      "$label" "$live_builder_recipe" "$context" "$image" "$context")"
    actual_build="$(awk -F '\t' '$1 == "build"' "$log")"
    [ "$actual_build" = "$expected_build" ] || {
      printf 'fake Docker case %s used unexpected build arguments\n' "$name" >&2
      printf 'expected: %s\nactual:   %s\n' "$expected_build" "$actual_build" >&2
      exit 1
    }
  fi
}

run_fake_docker_case matching-label expected expected 0 0
run_fake_docker_case absent-image error expected 0 1
run_fake_docker_case missing-label empty expected 0 1
run_fake_docker_case stale-label stale expected 0 1
run_fake_docker_case missing-label-after-build error empty 2 1
run_fake_docker_case wrong-label-after-build error stale 2 1

run_fake_docker_image_id_case() {
  local name="$1"
  local inspect_response="$2"
  local expected_status="$3"
  local expected_output="$4"
  local case_root="$test_root/fake-docker-image-id-$name"
  local image="oliphaunt-wasix-builder-id-test:$name"
  local log="$case_root/invocations.tsv"
  local output="$case_root/output"
  local errors="$case_root/errors"
  local state="$case_root/state"
  local actual_status
  local actual_inspect
  local expected_inspect

  mkdir -p "$case_root"
  : >"$log"
  : >"$state"
  if (
    export PATH="$fake_docker_bin_dir:$PATH"
    export FAKE_DOCKER_LOG="$log"
    export FAKE_DOCKER_STATE="$state"
    export FAKE_DOCKER_INITIAL_INSPECT="$inspect_response"
    export FAKE_DOCKER_POST_BUILD_INSPECT="$inspect_response"
    export FAKE_DOCKER_EXPECTED_RECIPE="$live_builder_recipe"
    export FAKE_DOCKER_IMAGE_SHA256="$fake_docker_image_sha256"
    fresh_wasix_builder_image_id "$image"
  ) >"$output" 2>"$errors"; then
    actual_status=0
  else
    actual_status=$?
  fi
  [ "$actual_status" -eq "$expected_status" ] || {
    printf 'builder image ID case %s returned %s instead of %s\n' \
      "$name" "$actual_status" "$expected_status" >&2
    sed 's/^/  /' "$errors" >&2
    exit 1
  }
  [ "$(cat "$output")" = "$expected_output" ] || {
    printf 'builder image ID case %s returned an unexpected identity\n' "$name" >&2
    exit 1
  }
  [ "$(awk -F '\t' '$1 == "build" { count++ } END { print count + 0 }' "$log")" -eq 0 ] || {
    printf 'builder image ID case %s unexpectedly built an image\n' "$name" >&2
    exit 1
  }
  expected_inspect="$(printf 'image\tinspect\t--format\t{{.Id}}|{{ index .Config.Labels "dev.oliphaunt.wasix-builder.recipe-sha256" }}\t%s' "$image")"
  actual_inspect="$(cat "$log")"
  [ "$actual_inspect" = "$expected_inspect" ] || {
    printf 'builder image ID case %s used unexpected inspect arguments\n' "$name" >&2
    printf 'expected: %s\nactual:   %s\n' "$expected_inspect" "$actual_inspect" >&2
    exit 1
  }
}

run_fake_docker_image_id_case success expected 0 "$fake_docker_image_id"
run_fake_docker_image_id_case missing-image error 2 ''
run_fake_docker_image_id_case invalid-id invalid-id 2 ''
run_fake_docker_image_id_case non-sha256-id non-sha256-id 2 ''
run_fake_docker_image_id_case missing-label empty 2 ''
run_fake_docker_image_id_case stale-label stale 2 ''

fresh_validate_postmaster_task_budget_profile
task_budget_profile_tampered="$test_root/task-budget-profile.tampered.tsv"
sed 's/\t96\t1\t1000$/\t95\t1\t1000/' \
  "$FRESH_POSTMASTER_TASK_BUDGET_PROFILE" >"$task_budget_profile_tampered"
expect_failure fresh_validate_postmaster_task_budget_profile \
  "$task_budget_profile_tampered"
runtime_footprint_tampered="$test_root/runtime-footprint.tampered.gucs"
sed 's/^max_connections=8$/max_connections=9/' \
  "$FRESH_POSTMASTER_RUNTIME_FOOTPRINT_PROFILE" >"$runtime_footprint_tampered"
expect_failure fresh_validate_postmaster_task_budget_profile \
  "$FRESH_POSTMASTER_TASK_BUDGET_PROFILE" "$runtime_footprint_tampered"

managed_root="$(fresh_managed_generated_root)"
(
  unset \
    FRESH_WORK_ROOT \
    CLIENT_TOOLS_BUILD_DIR \
    CLIENT_TOOLS_INSTALL_DIR \
    WASIX_BUILD_DIR \
    WASIX_INSTALL_DIR \
    REPORT_DIR \
    RUN_DIR
  source "$project_root/lib/common.sh"
  [ "$FRESH_WORK_ROOT" = "$(fresh_managed_generated_root)" ]
  fresh_require_managed_generated_path "$CLIENT_TOOLS_BUILD_DIR" CLIENT_TOOLS_BUILD_DIR
  fresh_require_managed_generated_path "$CLIENT_TOOLS_INSTALL_DIR" CLIENT_TOOLS_INSTALL_DIR
  fresh_require_managed_generated_path "$WASIX_BUILD_DIR" WASIX_BUILD_DIR
  fresh_require_managed_generated_path "$WASIX_INSTALL_DIR" WASIX_INSTALL_DIR
  fresh_require_managed_generated_path "$REPORT_DIR" REPORT_DIR
  fresh_require_managed_generated_path "$RUN_DIR" RUN_DIR
)

expect_failure fresh_require_managed_generated_path ""
expect_failure fresh_require_managed_generated_path /
expect_failure fresh_require_managed_generated_path "$managed_root"
expect_failure fresh_require_managed_generated_path relative/build
expect_failure fresh_require_managed_generated_path "$test_root/outside"
expect_failure fresh_require_managed_generated_path "$managed_root-other/build"
expect_failure fresh_require_managed_generated_path "$managed_root/builds/../outside"
expect_failure fresh_require_managed_generated_path "$managed_root/builds/./native-client-tools"
expect_failure fresh_require_managed_generated_path "$managed_root//builds/native-client-tools"
expect_failure fresh_require_managed_generated_path "$managed_root/builds/native-client-tools/"

mkdir -p "$managed_root" "$test_root/outside"
guard_sandbox="$(mktemp -d "$managed_root/.common-path-guard.XXXXXX")"
ln -s "$test_root/outside" "$guard_sandbox/escape"
expect_failure fresh_require_managed_generated_path "$guard_sandbox/escape"
expect_failure fresh_require_managed_generated_path "$guard_sandbox/escape/victim"

claim_root="$guard_sandbox/claims"
fresh_claim_generated_directories "$claim_root/one" "$claim_root/two"
[ -d "$claim_root/one" ] && [ ! -L "$claim_root/one" ]
[ -d "$claim_root/two" ] && [ ! -L "$claim_root/two" ]
expect_failure fresh_claim_generated_directories "$claim_root/one"
mkdir "$claim_root/existing"
expect_failure fresh_claim_generated_directories \
  "$claim_root/rolled-back" "$claim_root/existing"
[ ! -e "$claim_root/rolled-back" ] && [ ! -L "$claim_root/rolled-back" ]
rmdir "$claim_root/one" "$claim_root/two" "$claim_root/existing" "$claim_root"

write_receipt
write_postmaster_executor_receipt
fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
fresh_require_patched_wasmer_headless "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
fresh_require_patched_postmaster_executor \
  "$FRESH_POSTMASTER_EXECUTOR_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" \
  "$WASMER_BUILD_RECEIPT"
fresh_require_start_proof_tool \
  "$FRESH_START_PROOF_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
fresh_require_patched_postmaster_compiler \
  "$FRESH_POSTMASTER_COMPILER_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" \
  "$WASMER_BUILD_RECEIPT" \
  "$FRESH_POSTMASTER_EXECUTOR_BIN"
[ "$(fresh_wasmer_bin)" = "$FRESH_UPSTREAM_WASMER_BIN" ]

default_cache_dir="$(fresh_wasmer_cache_dir "$FRESH_UPSTREAM_WASMER_BIN")"
default_cache_bucket="$(fresh_wasmer_compiler_cache_bucket llvm aggressive 21)"
[ -n "$default_cache_dir" ]
[ "$default_cache_bucket" = llvm-opta-v21 ]

mv "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

# The product executor has an independent native-binary receipt and must fail
# closed if either its own bytes or the exact parent runtime receipt changes.
cp "$FRESH_POSTMASTER_EXECUTOR_BIN" "$test_root/postmaster-executor.saved"
printf 'tamper' >>"$FRESH_POSTMASTER_EXECUTOR_BIN"
expect_failure fresh_require_patched_postmaster_executor \
  "$FRESH_POSTMASTER_EXECUTOR_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" \
  "$WASMER_BUILD_RECEIPT"
mv "$test_root/postmaster-executor.saved" "$FRESH_POSTMASTER_EXECUTOR_BIN"
chmod +x "$FRESH_POSTMASTER_EXECUTOR_BIN"
write_postmaster_executor_receipt

cp "$FRESH_START_PROOF_BIN" "$test_root/start-proof.saved"
printf 'tamper' >>"$FRESH_START_PROOF_BIN"
expect_failure fresh_require_start_proof_tool \
  "$FRESH_START_PROOF_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
mv "$test_root/start-proof.saved" "$FRESH_START_PROOF_BIN"
chmod +x "$FRESH_START_PROOF_BIN"
write_postmaster_executor_receipt

cp "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" "$test_root/postmaster-receipt.saved"
sed 's/^executor_features=.*/executor_features=headless-minimal/' \
  "$test_root/postmaster-receipt.saved" >"$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
expect_failure fresh_require_patched_postmaster_executor \
  "$FRESH_POSTMASTER_EXECUTOR_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" \
  "$WASMER_BUILD_RECEIPT"
mv "$test_root/postmaster-receipt.saved" "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
sed 's/^rustc_version=.*/rustc_version=different-parent/' \
  "$test_root/receipt.saved" >"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_postmaster_executor \
  "$FRESH_POSTMASTER_EXECUTOR_BIN" \
  "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT" \
  "$WASMER_BUILD_RECEIPT"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"
write_postmaster_executor_receipt

cp "$FRESH_UPSTREAM_WASMER_BIN" "$test_root/wasmer.saved"
printf 'tamper' >>"$FRESH_UPSTREAM_WASMER_BIN"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/wasmer.saved" "$FRESH_UPSTREAM_WASMER_BIN"
chmod +x "$FRESH_UPSTREAM_WASMER_BIN"
write_receipt

cp "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN" "$test_root/wasmer-headless.saved"
printf 'tamper' >>"$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
expect_failure fresh_require_patched_wasmer_headless "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
mv "$test_root/wasmer-headless.saved" "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
chmod +x "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
write_receipt

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
printf 'wasmer_features=llvm,wat\n' >>"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
printf 'unknown_required_feature=true\n' >>"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
sed 's/^wasmer_cargo_lock_sha256=.*/wasmer_cargo_lock_sha256=not-a-hash/' \
  "$test_root/receipt.saved" >"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

write_receipt wrong-host
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
write_receipt

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
sed 's/^artifact_abi_version=.*/artifact_abi_version=22/' \
  "$test_root/receipt.saved" >"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
sed 's/^runtime_abi_id=.*/runtime_abi_id=0000000000000000000000000000000000000000000000000000000000000000/' \
  "$test_root/receipt.saved" >"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer_headless "$FRESH_UPSTREAM_WASMER_HEADLESS_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

cp "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
awk 'NR == 2 { saved=$0; next } NR == 3 { print; print saved; next } { print }' \
  "$test_root/receipt.saved" >"$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

mv "$WASMER_BUILD_RECEIPT" "$test_root/receipt.saved"
ln -s "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"
expect_failure fresh_require_patched_wasmer "$FRESH_UPSTREAM_WASMER_BIN"
rm "$WASMER_BUILD_RECEIPT"
mv "$test_root/receipt.saved" "$WASMER_BUILD_RECEIPT"

mkdir -p "$test_root/bin"
cp "$true_bin" "$test_root/bin/wasmer"
chmod u+wx "$test_root/bin/wasmer"
FRESH_UPSTREAM_WASMER_BIN="$test_root/missing" \
  PATH="$test_root/bin:$PATH" \
  expect_failure fresh_wasmer_bin

printf 'patched Wasmer receipt selection tests passed\n'
