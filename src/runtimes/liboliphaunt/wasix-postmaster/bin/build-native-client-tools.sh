#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

lock_dir="$FRESH_WORK_ROOT/.native-build.lock"
managed_work_probe="$FRESH_WORK_ROOT/.managed-path-boundary"
fresh_require_managed_generated_path "$managed_work_probe" FRESH_WORK_ROOT
fresh_require_managed_generated_path "$CLIENT_TOOLS_BUILD_DIR" CLIENT_TOOLS_BUILD_DIR
fresh_require_managed_generated_path "$CLIENT_TOOLS_INSTALL_DIR" CLIENT_TOOLS_INSTALL_DIR
fresh_require_managed_generated_path "$REPORT_DIR" REPORT_DIR
fresh_require_managed_generated_path "$RUN_DIR" RUN_DIR
fresh_require_managed_generated_path "$lock_dir" native-build-lock

fresh_ensure_dirs
fresh_require_command git
fresh_require_command make

lock_waits=0
until mkdir "$lock_dir" 2>/dev/null; do
  lock_waits=$((lock_waits + 1))
  if [ "$lock_waits" -gt 900 ]; then
    echo "timed out waiting for native build lock: $lock_dir" >&2
    exit 2
  fi
  sleep 0.2
done
cleanup() {
  fresh_unlock_postgres_baseline || true
  rmdir "$lock_dir" 2>/dev/null || true
}
trap cleanup EXIT

jobs="${JOBS:-$(fresh_jobs)}"

"$FRESH_ROOT/bin/prepare-baseline.sh" >/dev/null

fresh_lock_postgres_baseline shared
baseline_fingerprint="$(fresh_postgres_baseline_fingerprint)"
fresh_require_postgres_baseline "$baseline_fingerprint" || {
  printf 'native build refused an invalid PostgreSQL baseline: %s\n' "$BASELINE_DIR" >&2
  exit 2
}
baseline_head="$FRESH_POSTGRES_BASELINE_HEAD"
baseline_tree="$FRESH_POSTGRES_BASELINE_TREE"

report="$REPORT_DIR/native-client-tools-build.md"
log="$REPORT_DIR/native-client-tools-build.log"
fresh_require_managed_generated_path "$report" native-build-report
fresh_require_managed_generated_path "$log" native-build-log
fresh_write_report_header "$report" "Native PostgreSQL Client Tools Build"

configure_args=(
  "--prefix=$CLIENT_TOOLS_INSTALL_DIR"
  "--without-readline"
  "--without-icu"
  "--without-zlib"
  "--without-llvm"
  "--without-pam"
  "--with-openssl=no"
)

source_signature="$(
  {
    printf 'build_signature_version=3\n'
    printf 'baseline_fingerprint=%s\n' "$baseline_fingerprint"
    printf 'baseline=%s\n' "$baseline_head"
    printf 'baseline_tree=%s\n' "$baseline_tree"
    printf 'postgres_tag=%s\n' "$POSTGRES_TAG"
    printf '%s\n' "${configure_args[@]}"
  } | shasum -a 256 | awk '{print $1}'
)"
build_signature_file="$CLIENT_TOOLS_BUILD_DIR/.fresh-native-client-tools-build-signature"
fresh_require_managed_generated_path "$build_signature_file" native-build-signature
if [ -f "$build_signature_file" ] && [ "$(cat "$build_signature_file")" = "$source_signature" ]; then
  mkdir -p "$CLIENT_TOOLS_BUILD_DIR" "$CLIENT_TOOLS_INSTALL_DIR"
else
  fresh_require_managed_generated_path "$CLIENT_TOOLS_BUILD_DIR" CLIENT_TOOLS_BUILD_DIR
  fresh_require_managed_generated_path "$CLIENT_TOOLS_INSTALL_DIR" CLIENT_TOOLS_INSTALL_DIR
  rm -rf "$CLIENT_TOOLS_BUILD_DIR" "$CLIENT_TOOLS_INSTALL_DIR"
  mkdir -p "$CLIENT_TOOLS_BUILD_DIR" "$CLIENT_TOOLS_INSTALL_DIR"
  printf '%s' "$source_signature" >"$build_signature_file"
fi

{
  printf '## Configure\n\n'
  printf '```text\n'
  printf '%q ' "$BASELINE_DIR/configure" "${configure_args[@]}"
  printf '\n```\n\n'
  printf '## Source\n\n'
  printf -- '- Baseline fingerprint: `%s`\n' "$baseline_fingerprint"
  printf -- '- Baseline commit: `%s`\n' "$baseline_head"
  printf -- '- Baseline tree: `%s`\n' "$baseline_tree"
  printf -- '- Build signature: `%s`\n\n' "$source_signature"
  printf '## Build Log\n\n'
  printf 'See `%s`.\n' "$log"
} >>"$report"

fresh_require_managed_generated_path "$CLIENT_TOOLS_BUILD_DIR" CLIENT_TOOLS_BUILD_DIR
fresh_require_managed_generated_path "$CLIENT_TOOLS_INSTALL_DIR" CLIENT_TOOLS_INSTALL_DIR
(
  set -euo pipefail
  cd "$CLIENT_TOOLS_BUILD_DIR"
  if [ ! -f config.status ]; then
    "$BASELINE_DIR/configure" "${configure_args[@]}"
  fi
  make -j "$jobs"
  make install
) >"$log" 2>&1

{
  printf '\n## Result\n\n'
  printf -- '- Status: `pass`\n'
  printf -- '- Install directory: `%s`\n' "$CLIENT_TOOLS_INSTALL_DIR"
} >>"$report"

printf 'built native PostgreSQL client tools at %s\n' "$CLIENT_TOOLS_INSTALL_DIR"
