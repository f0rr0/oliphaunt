#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: pin-runtime-artifacts.sh [options]

Create a named experiment snapshot from a WASIX PostgreSQL install, matched
Wasmer binary/build receipt, and compiled Wasmer cache. The snapshot lives under
the ignored work tree so measurements can be replayed without recompiling. It is
not a signed, self-contained, or distributable host carrier.

Options:
  --name NAME          Pin name. Defaults to profile plus Wasmer hash/config.
  --profile PROFILE    WASIX profile for the install tree. Defaults to current profile.
  --wasmer-bin PATH    Wasmer binary to pin. Defaults to fresh_wasmer_bin.
  --install-dir PATH   WASIX PostgreSQL install tree to pin.
  --cache-dir PATH     Compiled Wasmer cache tree to pin.
  --force              Replace an existing pin with the same name.
  -h, --help           Show this help.
USAGE
}

profile="$WASIX_CORE_PROFILE"
pin_name=""
wasmer_bin=""
install_dir=""
cache_dir=""
force=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--name requires a value" >&2
        exit 2
      fi
      pin_name="$1"
      ;;
    --profile)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--profile requires a WASIX_CORE_PROFILE value" >&2
        exit 2
      fi
      profile="$(fresh_normalize_wasix_core_profile "$1")"
      ;;
    --wasmer-bin)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--wasmer-bin requires a path" >&2
        exit 2
      fi
      wasmer_bin="$1"
      ;;
    --install-dir)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--install-dir requires a path" >&2
        exit 2
      fi
      install_dir="$1"
      ;;
    --cache-dir)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--cache-dir requires a path" >&2
        exit 2
      fi
      cache_dir="$1"
      ;;
    --force)
      force=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$wasmer_bin" ]; then
  wasmer_bin="$(fresh_wasmer_bin)"
fi
if [ -z "$install_dir" ]; then
  install_dir="$(fresh_wasix_core_install_dir_for "$profile")"
fi
if [ -z "$cache_dir" ]; then
  cache_dir="$(fresh_wasmer_cache_dir "$wasmer_bin")"
fi

if [ ! -x "$wasmer_bin" ]; then
  printf 'missing executable Wasmer binary: %s\n' "$wasmer_bin" >&2
  exit 2
fi
fresh_require_patched_wasmer "$wasmer_bin"
wasmer_build_receipt="${WASMER_BUILD_RECEIPT:-$FRESH_WASMER_BUILD_RECEIPT}"
if [ ! -x "$install_dir/bin/postgres" ] || [ ! -x "$install_dir/bin/initdb" ]; then
  printf 'missing WASIX PostgreSQL install tree: %s\n' "$install_dir" >&2
  exit 2
fi
if [ ! -d "$cache_dir" ]; then
  printf 'missing compiled Wasmer cache tree: %s\n' "$cache_dir" >&2
  exit 2
fi

wasmer_hash="$(fresh_wasmer_bin_hash "$wasmer_bin")"
if [ -z "$pin_name" ]; then
  pin_name="$profile-$wasmer_hash"
  if fresh_wasmer_llvm_native_cpu_enabled; then
    pin_name="${pin_name}-nativecpu"
  fi
  if fresh_wasmer_llvm_full_o3_enabled; then
    pin_name="${pin_name}-fullo3"
  fi
  if fresh_wasmer_llvm_indirect_call_cache_enabled; then
    pin_name="${pin_name}-indirectcache"
  fi
fi
case "$pin_name" in
  ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
    printf 'pin name must start with a letter or number and contain only letters, numbers, ".", "_", and "-": %s\n' "$pin_name" >&2
    exit 2
    ;;
esac

pin_parent="$FRESH_WORK_ROOT/tools/pinned-runtimes"
pin_root="$pin_parent/$pin_name"
tmp_root="$pin_parent/.${pin_name}.tmp.$$"
old_root="$pin_parent/.${pin_name}.old.$$"
fresh_require_managed_generated_path "$pin_parent" "pinned runtime parent"
fresh_require_managed_generated_path "$pin_root" "pinned runtime destination"
fresh_require_managed_generated_path "$tmp_root" "pinned runtime staging directory"
fresh_require_managed_generated_path "$old_root" "pinned runtime rollback directory"

cleanup_pin() {
  if [ -e "$old_root" ] && [ ! -e "$pin_root" ]; then
    mv "$old_root" "$pin_root" 2>/dev/null || true
  fi
  rm -rf "$tmp_root" "$old_root"
}
trap cleanup_pin EXIT

case "$wasmer_bin" in "$pin_root"|"$pin_root"/*) echo "refusing to pin from destination Wasmer binary" >&2; exit 2 ;; esac
case "$install_dir" in "$pin_root"|"$pin_root"/*) echo "refusing to pin from destination install tree" >&2; exit 2 ;; esac
case "$cache_dir" in "$pin_root"|"$pin_root"/*) echo "refusing to pin from destination cache tree" >&2; exit 2 ;; esac

if [ -L "$pin_root" ]; then
  printf 'refusing symlinked pin destination: %s\n' "$pin_root" >&2
  exit 2
fi
if [ -e "$pin_root" ] && [ "$force" -ne 1 ]; then
  printf 'pin already exists: %s\n' "$pin_root" >&2
  printf 'Use --force to replace it.\n' >&2
  exit 2
fi

copy_tree() {
  local src="$1"
  local dst="$2"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src"/ "$dst"/
  else
    (cd "$src" && tar -cf - .) | (cd "$dst" && tar -xf -)
  fi
}

shell_quote() {
  printf '%q' "$1"
}

write_tree_manifest() {
  local root="$1"
  local prefix="$2"
  local out="$3"
  (
    cd "$root"
    find . -type f | LC_ALL=C sort | while IFS= read -r rel; do
      hash="$(fresh_wasmer_bin_hash "$rel")"
      printf '%s\t%s/%s\n' "$hash" "$prefix" "${rel#./}"
    done
    find . -type l | LC_ALL=C sort | while IFS= read -r rel; do
      target="$(readlink "$rel")"
      printf 'SYMLINK\t%s/%s\t%s\n' "$prefix" "${rel#./}" "$target"
    done
  ) >"$out"
}

mkdir -p "$pin_parent"
rm -rf "$tmp_root"
mkdir -p "$tmp_root"

cp -p "$wasmer_bin" "$tmp_root/wasmer"
chmod +x "$tmp_root/wasmer"
cp -p "$wasmer_build_receipt" "$tmp_root/wasmer-build.receipt"
WASMER_BUILD_RECEIPT="$tmp_root/wasmer-build.receipt" \
  fresh_require_patched_wasmer "$tmp_root/wasmer"
copy_tree "$install_dir" "$tmp_root/install"
copy_tree "$cache_dir" "$tmp_root/wasmer-cache"

write_tree_manifest "$tmp_root/install" install "$tmp_root/install.files.tsv"
write_tree_manifest "$tmp_root/wasmer-cache" wasmer-cache "$tmp_root/wasmer-cache.files.tsv"
{
  printf 'HASH\tPATH\n'
  printf '%s\twasmer\n' "$(fresh_wasmer_bin_hash "$tmp_root/wasmer")"
  printf '%s\twasmer-build.receipt\n' "$(fresh_wasmer_bin_hash "$tmp_root/wasmer-build.receipt")"
  cat "$tmp_root/install.files.tsv" "$tmp_root/wasmer-cache.files.tsv"
} >"$tmp_root/manifest.files.tsv"

install_manifest_hash="$(fresh_wasmer_bin_hash "$tmp_root/install.files.tsv")"
cache_manifest_hash="$(fresh_wasmer_bin_hash "$tmp_root/wasmer-cache.files.tsv")"
bundle_manifest_hash="$(fresh_wasmer_bin_hash "$tmp_root/manifest.files.tsv")"
wasmer_version="$(fresh_wasmer_version "$wasmer_bin" 2>/dev/null || true)"
created_utc="$(fresh_timestamp)"

{
  printf 'PINNED_RUNTIME_NAME=%s\n' "$(shell_quote "$pin_name")"
  printf 'PINNED_CREATED_UTC=%s\n' "$(shell_quote "$created_utc")"
  printf 'PINNED_PROFILE=%s\n' "$(shell_quote "$profile")"
  printf 'PINNED_ROOT=%s\n' "$(shell_quote "$pin_root")"
  printf 'PINNED_WASMER_BIN_SOURCE=%s\n' "$(shell_quote "$wasmer_bin")"
  printf 'PINNED_WASMER_SHA256=%s\n' "$(shell_quote "$wasmer_hash")"
  printf 'PINNED_WASMER_BUILD_RECEIPT_SHA256=%s\n' "$(shell_quote "$(fresh_wasmer_bin_hash "$tmp_root/wasmer-build.receipt")")"
  printf 'PINNED_WASMER_VERSION=%s\n' "$(shell_quote "$wasmer_version")"
  printf 'PINNED_INSTALL_SOURCE_DIR=%s\n' "$(shell_quote "$install_dir")"
  printf 'PINNED_INSTALL_MANIFEST_SHA256=%s\n' "$(shell_quote "$install_manifest_hash")"
  printf 'PINNED_WASMER_CACHE_SOURCE_DIR=%s\n' "$(shell_quote "$cache_dir")"
  printf 'PINNED_WASMER_CACHE_MANIFEST_SHA256=%s\n' "$(shell_quote "$cache_manifest_hash")"
  printf 'PINNED_BUNDLE_MANIFEST_SHA256=%s\n' "$(shell_quote "$bundle_manifest_hash")"
  printf 'WASIX_CORE_PROFILE=%s\n' "$(shell_quote "$profile")"
  printf 'WASMER_LLVM_NATIVE_CPU=%s\n' "$(shell_quote "${WASMER_LLVM_NATIVE_CPU:-0}")"
  printf 'WASMER_LLVM_FULL_O3_PIPELINE=%s\n' "$(shell_quote "${WASMER_LLVM_FULL_O3_PIPELINE:-0}")"
  printf 'WASMER_LLVM_INDIRECT_CALL_CACHE=%s\n' "$(shell_quote "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}")"
  printf 'WASMER_LLVM_VOLATILE_MEMOPS=%s\n' "$(shell_quote "${WASMER_LLVM_VOLATILE_MEMOPS:-0}")"
  printf 'WASMER_COMPILER=%s\n' "$(shell_quote "${WASMER_COMPILER:-llvm}")"
  printf 'WASMER_LLVM_OPT_LEVEL=%s\n' "$(shell_quote "${WASMER_LLVM_OPT_LEVEL:-aggressive}")"
  printf 'WASMER_CACHE_ARTIFACT_VERSION=%s\n' "$(shell_quote "${WASMER_CACHE_ARTIFACT_VERSION:-21}")"
  printf 'WASMER_STACK_SIZE=%s\n' "$(shell_quote "${WASMER_STACK_SIZE:-33554432}")"
} >"$tmp_root/manifest.env"

{
  printf '# Source this file to replay benchmarks against the experiment snapshot.\n'
  printf 'export FRESH_PINNED_RUNTIME_NAME=%s\n' "$(shell_quote "$pin_name")"
  printf 'export FRESH_PINNED_RUNTIME_ROOT=%s\n' "$(shell_quote "$pin_root")"
  printf 'export FRESH_PINNED_WASIX_CORE_PROFILE=%s\n' "$(shell_quote "$profile")"
  printf 'export FRESH_PINNED_WASIX_INSTALL_DIR=%s\n' "$(shell_quote "$pin_root/install")"
  printf 'export FRESH_PINNED_WASMER_CACHE_DIR=%s\n' "$(shell_quote "$pin_root/wasmer-cache")"
  printf 'export WASIX_CORE_PROFILE=%s\n' "$(shell_quote "$profile")"
  printf 'export WASIX_INSTALL_DIR=%s\n' "$(shell_quote "$pin_root/install")"
  printf 'export WASMER_BIN=%s\n' "$(shell_quote "$pin_root/wasmer")"
  printf 'export WASMER_BUILD_RECEIPT=%s\n' "$(shell_quote "$pin_root/wasmer-build.receipt")"
  printf 'export WASMER_CACHE_DIR=%s\n' "$(shell_quote "$pin_root/wasmer-cache")"
  printf 'export WASMER_LLVM_NATIVE_CPU=%s\n' "$(shell_quote "${WASMER_LLVM_NATIVE_CPU:-0}")"
  printf 'export WASMER_LLVM_FULL_O3_PIPELINE=%s\n' "$(shell_quote "${WASMER_LLVM_FULL_O3_PIPELINE:-0}")"
  printf 'export WASMER_LLVM_INDIRECT_CALL_CACHE=%s\n' "$(shell_quote "${WASMER_LLVM_INDIRECT_CALL_CACHE:-0}")"
  printf 'export WASMER_LLVM_VOLATILE_MEMOPS=%s\n' "$(shell_quote "${WASMER_LLVM_VOLATILE_MEMOPS:-0}")"
  printf 'export WASMER_COMPILER=%s\n' "$(shell_quote "${WASMER_COMPILER:-llvm}")"
  printf 'export WASMER_LLVM_OPT_LEVEL=%s\n' "$(shell_quote "${WASMER_LLVM_OPT_LEVEL:-aggressive}")"
  printf 'export WASMER_CACHE_ARTIFACT_VERSION=%s\n' "$(shell_quote "${WASMER_CACHE_ARTIFACT_VERSION:-21}")"
  printf 'export WASMER_STACK_SIZE=%s\n' "$(shell_quote "${WASMER_STACK_SIZE:-33554432}")"
} >"$tmp_root/env.sh"

if [ -e "$pin_root" ]; then
  mv "$pin_root" "$old_root"
fi
if ! mv "$tmp_root" "$pin_root"; then
  [ ! -e "$old_root" ] || mv "$old_root" "$pin_root"
  exit 1
fi
rm -rf "$old_root"
trap - EXIT

printf 'pinned runtime experiment snapshot: %s\n' "$pin_root"
printf '  wasmer: %s (%s)\n' "$pin_root/wasmer" "$wasmer_hash"
printf '  install: %s\n' "$pin_root/install"
printf '  wasmer cache: %s\n' "$pin_root/wasmer-cache"
printf '  manifest: %s\n' "$pin_root/manifest.env"
printf '  env: %s\n' "$pin_root/env.sh"
