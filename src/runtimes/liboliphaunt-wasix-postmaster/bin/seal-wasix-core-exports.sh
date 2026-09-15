#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: seal-wasix-core-exports.sh [options]

Derive the exact typed PostgreSQL main-module export closure from the packaged
side modules, remove unreachable definitions with one pinned Binaryen pass,
re-run the start/import/fence proofs, and publish the module plus receipts.

Options:
  --install-dir DIR       WASIX PostgreSQL prefix (default: WASIX_INSTALL_DIR)
  --expected-total COUNT  Exact final atomic.fence count for the packed latch proof
  -h, --help              Show this help
EOF
}

fail() {
  printf 'sealed export closure: %s\n' "$*" >&2
  exit 2
}

install_dir="$WASIX_INSTALL_DIR"
expected_total=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir|--expected-total)
      option="$1"
      shift
      [ "$#" -gt 0 ] || fail "$option requires a value"
      case "$option" in
        --install-dir) install_dir="$1" ;;
        --expected-total) expected_total="$1" ;;
      esac
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
  shift
done

case "$expected_total" in
  ''|*[!0-9]*) fail '--expected-total must be a nonnegative integer' ;;
esac

fresh_require_command cargo
fresh_require_command cmp
fresh_require_command cp
fresh_require_command find
fresh_require_command grep
fresh_require_command bun
fresh_require_command sha256sum
fresh_require_command sort

[ -d "$install_dir" ] && [ ! -L "$install_dir" ] || fail "missing regular install prefix: $install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
postgres="$install_dir/bin/postgres"
[ -f "$postgres" ] && [ ! -L "$postgres" ] || fail "missing regular PostgreSQL module: $postgres"
fresh_require_managed_generated_path "$postgres" sealed-postgres-module

[ "${FRESH_WASIX_PRIVATE_INSTALL_DIR:-}" = "$install_dir" ] && [ ! -e "$install_dir/guest-build.receipt" ] ||
  fail "export sealing requires the producer private install directory"
stage="$install_dir/.oliphaunt-sealed-export-closure.pending"
[ ! -e "$stage" ] && [ ! -L "$stage" ] || fail "private export stage already exists"
mkdir -p "$stage/bin" "$stage/share/postgresql"
trap 'rm -rf -- "$stage"' EXIT

readonly tool_manifest="$FRESH_ROOT/tools/sealed-export-closure/Cargo.toml"
readonly mandatory_policy="$FRESH_ROOT/wasmer/policies/sealed-main-runtime-exports.v1.txt"
readonly dlsym_policy="$FRESH_ROOT/wasmer/policies/sealed-main-dlsym-exports.v1.txt"
readonly side_manifest="$FRESH_ROOT/wasmer/policies/sealed-side-modules.v1.tsv"
for required in "$tool_manifest" "$mandatory_policy" "$dlsym_policy" "$side_manifest"; do
  [ -f "$required" ] && [ ! -L "$required" ] || fail "missing regular closure input: $required"
done
grep -Fxq '# schema=oliphaunt.wasix-postmaster.sealed-side-modules.v1' "$side_manifest" ||
  fail 'side-module manifest schema differs'

declare -a side_modules=()
declare -A admitted_side_paths=()
manifest_records=0
while IFS=$'\t' read -r canonical aliases abi_policy extra; do
  case "$canonical" in
    ''|'#'*) continue ;;
  esac
  [ -z "${extra:-}" ] || fail "side-module manifest has extra columns: $canonical"
  [ -n "$aliases" ] && [ -n "$abi_policy" ] || fail "incomplete side-module record: $canonical"
  case "$canonical" in
    /*|*/../*|../*|*/./*|./*|*//*|*[$'\n\r']*) fail "unsafe canonical side path: $canonical" ;;
  esac
  [ -z "${admitted_side_paths[$canonical]+x}" ] || fail "duplicate side path: $canonical"
  canonical_file="$install_dir/$canonical"
  [ -f "$canonical_file" ] && [ ! -L "$canonical_file" ] ||
    fail "missing regular canonical side module: $canonical"
  admitted_side_paths[$canonical]=1
  side_modules+=("$canonical")
  manifest_records=$((manifest_records + 1))
  if [ "$aliases" != - ]; then
    IFS=',' read -r -a alias_paths <<<"$aliases"
    [ "${#alias_paths[@]}" -gt 0 ] || fail "empty alias set: $canonical"
    for alias_path in "${alias_paths[@]}"; do
      case "$alias_path" in
        ''|/*|*/../*|../*|*/./*|./*|*//*|*[$'\n\r']*) fail "unsafe side alias: $alias_path" ;;
      esac
      [ -z "${admitted_side_paths[$alias_path]+x}" ] || fail "duplicate side alias: $alias_path"
      alias_file="$install_dir/$alias_path"
      [ -f "$alias_file" ] || fail "missing side alias: $alias_path"
      cmp -s "$canonical_file" "$alias_file" ||
        fail "side alias bytes differ from $canonical: $alias_path"
      admitted_side_paths[$alias_path]=1
    done
  fi
done <"$side_manifest"
[ "$manifest_records" -gt 0 ] || fail 'side-module manifest has no records'

find "$install_dir/lib" \( -type f -o -type l \) \
  \( -name '*.so' -o -name '*.so.*' \) -printf '%P\0' >"$stage/discovered-side-modules.unsorted"
LC_ALL=C sort -z "$stage/discovered-side-modules.unsorted" >"$stage/discovered-side-modules.sorted"
while IFS= read -r -d '' discovered; do
  relative="lib/$discovered"
  [ -n "${admitted_side_paths[$relative]+x}" ] ||
    fail "installed side module is absent from the sealed graph: $relative"
done <"$stage/discovered-side-modules.sorted"

tool_target="$FRESH_WORK_ROOT/runtime/sealed-export-closure-target"
fresh_require_managed_generated_path "$tool_target" sealed-export-closure-tool-target
CARGO_TARGET_DIR="$tool_target" cargo build --locked --release --manifest-path "$tool_manifest"
closure_tool="$tool_target/release/oliphaunt-wasix-sealed-export-closure"
[ -x "$closure_tool" ] && [ ! -L "$closure_tool" ] || fail "missing built closure analyzer: $closure_tool"

docker_bin="$(fresh_docker_bin)"
fresh_ensure_docker_image
docker_image_id="$(fresh_wasix_builder_image_id)" ||
  fail 'could not resolve pinned WASIX builder image identity'
readonly container_wasm_opt=/opt/wasixcc-home/.wasixcc/binaryen/bin/wasm-opt
dce_identity="$($docker_bin run --rm "$docker_image_id" sha256sum "$container_wasm_opt")" ||
  fail 'could not hash pinned wasm-opt'
dce_sha256="${dce_identity%% *}"
fresh_is_sha256 "$dce_sha256" || fail "invalid wasm-opt SHA-256: $dce_sha256"
dce_version="$($docker_bin run --rm "$docker_image_id" "$container_wasm_opt" --version)" ||
  fail 'could not read pinned wasm-opt version'
[ "$(printf '%s\n' "$dce_version" | wc -l | tr -d ' ')" -eq 1 ] || fail 'wasm-opt version is multiline'

cp -p "$postgres" "$stage/bin/postgres.seed"
seed_proof="$stage/share/postgresql/wasix-postmaster.sealed-export.seed-proof.json"
final_proof="$stage/share/postgresql/wasix-postmaster.sealed-export.final-proof.json"
allowlist="$stage/share/postgresql/wasix-postmaster.sealed-export.allowlist"
structure_receipt="$stage/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
start_proof="$stage/share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json"
concurrency_receipt="$stage/share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt"

side_manifest_sha256="$(sha256sum "$side_manifest" | awk '{print $1}')"

(
  cd "$install_dir"
  "$closure_tool" seal \
    bin/postgres \
    "$mandatory_policy" \
    "$dlsym_policy" \
    "$seed_proof" \
    "$allowlist" \
    "${side_modules[@]}"
  "$closure_tool" rewrite \
    bin/postgres \
    "$allowlist" \
    .oliphaunt-sealed-export-closure.pending/bin/postgres.stripped
)

docker_stage="$(fresh_docker_path_for "$stage")"
"$docker_bin" run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$docker_image_id" \
  "$container_wasm_opt" \
  "$docker_stage/bin/postgres.stripped" \
  --remove-unused-module-elements \
  --enable-bulk-memory \
  --enable-threads \
  --enable-mutable-globals \
  --enable-exception-handling \
  --enable-extended-const \
  -o "$docker_stage/bin/postgres"
chmod --reference="$postgres" "$stage/bin/postgres"

(
  cd "$install_dir"
  "$closure_tool" attest-final \
    bin/postgres \
    .oliphaunt-sealed-export-closure.pending/bin/postgres \
    "$mandatory_policy" \
    "$dlsym_policy" \
    "$allowlist" \
    "$seed_proof" \
    "$final_proof" \
    "$structure_receipt" \
    "$dce_sha256" \
    "$dce_version" \
    "$side_manifest_sha256" \
    "${side_modules[@]}"
)

bun "$FRESH_ROOT/wasmer/bin/verify-postmaster-wasm-import.mts" "$stage/bin/postgres"
fresh_require_start_proof_tool "$FRESH_START_PROOF_BIN" "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
"$FRESH_START_PROOF_BIN" "$stage/bin/postgres" >"$start_proof"

bash "$FRESH_ROOT/wasmer/bin/analyze-wasm-concurrency.sh" "$docker_bin" "$docker_image_id" \
  "$stage/bin/postgres" \
  --expected-total "$expected_total" \
  --latch-state-contract packed-atomic-v1 \
  --receipt "$stage/share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt"

for artifact in \
  "$seed_proof" \
  "$final_proof" \
  "$allowlist" \
  "$structure_receipt" \
  "$start_proof" \
  "$concurrency_receipt"
do
  [ -f "$artifact" ] && [ ! -L "$artifact" ] || fail "missing staged receipt: $artifact"
done

# Only the complete install generation is published by build-wasix-core.sh.
# A failure here discards that private generation; no live files need rollback.
mv "$stage/bin/postgres" "$postgres"
cp -p "$stage/share/postgresql/"* "$install_dir/share/postgresql/"
printf 'sealed exact main-module export closure: module=%s\n' "$postgres"
