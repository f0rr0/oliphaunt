#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

fresh_ensure_dirs
fresh_require_command git
fresh_require_command make

lock_dir="$FRESH_WORK_ROOT/.native-build.lock"
lock_waits=0
until mkdir "$lock_dir" 2>/dev/null; do
  lock_waits=$((lock_waits + 1))
  if [ "$lock_waits" -gt 900 ]; then
    echo "timed out waiting for native build lock: $lock_dir" >&2
    exit 2
  fi
  sleep 0.2
done
trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT

jobs="${JOBS:-$(fresh_jobs)}"

"$FRESH_ROOT/bin/prepare-baseline.sh" >/dev/null

baseline_head="$(git -C "$BASELINE_DIR" rev-parse HEAD)"

report="$REPORT_DIR/native-build.md"
log="$REPORT_DIR/native-build.log"
fresh_write_report_header "$report" "Native PostgreSQL Oracle Build"

configure_args=(
  "--prefix=$NATIVE_INSTALL_DIR"
  "--without-readline"
  "--without-icu"
  "--without-zlib"
  "--without-llvm"
  "--without-pam"
  "--with-openssl=no"
)

source_signature="$(
  {
    printf 'build_signature_version=2\n'
    printf 'baseline=%s\n' "$baseline_head"
    printf 'postgres_tag=%s\n' "$POSTGRES_TAG"
    printf '%s\n' "${configure_args[@]}"
  } | shasum -a 256 | awk '{print $1}'
)"
build_signature_file="$NATIVE_BUILD_DIR/.fresh-native-oracle-build-signature"
if [ -f "$build_signature_file" ] && [ "$(cat "$build_signature_file")" = "$source_signature" ]; then
  mkdir -p "$NATIVE_BUILD_DIR" "$NATIVE_INSTALL_DIR"
else
  rm -rf "$NATIVE_BUILD_DIR" "$NATIVE_INSTALL_DIR"
  mkdir -p "$NATIVE_BUILD_DIR" "$NATIVE_INSTALL_DIR"
  printf '%s' "$source_signature" >"$build_signature_file"
fi

{
  printf '## Configure\n\n'
  printf '```text\n'
  printf '%q ' "$BASELINE_DIR/configure" "${configure_args[@]}"
  printf '\n```\n\n'
  printf '## Source\n\n'
  printf -- '- Baseline commit: `%s`\n' "$baseline_head"
  printf -- '- Build signature: `%s`\n\n' "$source_signature"
  printf '## Build Log\n\n'
  printf 'See `%s`.\n' "$log"
} >>"$report"

(
  set -euo pipefail
  cd "$NATIVE_BUILD_DIR"
  if [ ! -f config.status ]; then
    "$BASELINE_DIR/configure" "${configure_args[@]}"
  fi
  make -j "$jobs"
  make install
) >"$log" 2>&1

{
  printf '\n## Result\n\n'
  printf -- '- Status: `pass`\n'
  printf -- '- Install directory: `%s`\n' "$NATIVE_INSTALL_DIR"
} >>"$report"

printf 'built native PostgreSQL oracle at %s\n' "$NATIVE_INSTALL_DIR"
