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
fresh_require_command flock
fresh_require_command grep
fresh_require_command python3
fresh_require_command sha256sum
fresh_require_command sort

[ -d "$install_dir" ] && [ ! -L "$install_dir" ] || fail "missing regular install prefix: $install_dir"
install_dir="$(cd "$install_dir" && pwd -P)"
postgres="$install_dir/bin/postgres"
[ -f "$postgres" ] && [ ! -L "$postgres" ] || fail "missing regular PostgreSQL module: $postgres"
fresh_require_managed_generated_path "$postgres" sealed-postgres-module

readonly publication_schema=oliphaunt.wasix-postmaster.sealed-export-publication.v1
readonly structure_relative=share/postgresql/wasix-postmaster.sealed-export.structure.receipt
declare -ar publication_relatives=(
  bin/postgres
  share/postgresql/wasix-postmaster.sealed-export.seed-proof.json
  share/postgresql/wasix-postmaster.sealed-export.final-proof.json
  share/postgresql/wasix-postmaster.sealed-export.allowlist
  share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json
  share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt
  "$structure_relative"
)

stage="$install_dir/.oliphaunt-sealed-export-closure.pending"
stage_initializing="$install_dir/.oliphaunt-sealed-export-closure.initializing"
stage_discarded="$install_dir/.oliphaunt-sealed-export-closure.discarded"
fresh_require_managed_generated_path "$stage" sealed-export-closure-stage
fresh_require_managed_generated_path "$stage_initializing" sealed-export-closure-initializer
fresh_require_managed_generated_path "$stage_discarded" sealed-export-closure-discarded

publication_lock_dir="$FRESH_WORK_ROOT/runtime/publication-locks"
fresh_require_managed_generated_path "$publication_lock_dir" sealed-export-publication-locks
mkdir -p "$publication_lock_dir"
[ -d "$publication_lock_dir" ] && [ ! -L "$publication_lock_dir" ] ||
  fail "unsafe publication lock directory: $publication_lock_dir"
publication_lock_subject="$(python3 - "$install_dir" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
before = os.lstat(path)
if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
    raise SystemExit("install prefix is not a non-symlink directory")
flags = (
    os.O_RDONLY
    | getattr(os, "O_CLOEXEC", 0)
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
descriptor = os.open(path, flags)
try:
    opened = os.fstat(descriptor)
    if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
        raise SystemExit("install prefix changed while deriving lock identity")
    print(f"{opened.st_dev}:{opened.st_ino}")
finally:
    os.close(descriptor)
PY
)" || fail 'could not derive publication lock subject'
publication_lock_key="$(printf '%s' "$publication_lock_subject" | sha256sum)" ||
  fail 'could not derive publication lock identity'
publication_lock_key="${publication_lock_key%% *}"
fresh_is_sha256 "$publication_lock_key" || fail 'invalid publication lock identity'
publication_lock="$publication_lock_dir/$publication_lock_key.lock"
[ ! -L "$publication_lock" ] || fail "unsafe publication lock: $publication_lock"
exec {publication_lock_fd}>"$publication_lock"
[ -f "$publication_lock" ] && [ ! -L "$publication_lock" ] ||
  fail "publication lock changed while opening: $publication_lock"
flock -x "$publication_lock_fd" || fail "could not lock export publication for $install_dir"
readonly completion_schema=oliphaunt.wasix-postmaster.sealed-export-completion.v2
publication_completion="$publication_lock_dir/$publication_lock_key.completed"
publication_completion_pending="$publication_lock_dir/$publication_lock_key.completed.pending"

fsync_paths() {
  python3 - "$@" <<'PY'
import os
import stat
import sys

for raw in sys.argv[1:]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(raw, flags)
    try:
        mode = os.fstat(fd).st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise SystemExit(f"refusing to fsync non-file path: {raw}")
        os.fsync(fd)
    finally:
        os.close(fd)
PY
}

fsync_tree_directories() {
  python3 - "$1" <<'PY'
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
directories = []
for current, names, _files in os.walk(root, topdown=True, followlinks=False):
    names.sort()
    for name in names:
        candidate = os.path.join(current, name)
        mode = os.lstat(candidate).st_mode
        if stat.S_ISLNK(mode):
            raise SystemExit(f"refusing symlink directory in publication tree: {candidate}")
        if not stat.S_ISDIR(mode):
            raise SystemExit(f"refusing non-directory in publication tree: {candidate}")
    directories.append(current)
for current in reversed(directories):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(current, flags)
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise SystemExit(f"publication path changed type: {current}")
        os.fsync(fd)
    finally:
        os.close(fd)
PY
}

remove_pending_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] || fail "unsafe pending publication path: $path"
    rm -f -- "$path"
  fi
}

remove_disposable_tree() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -d "$path" ] && [ ! -L "$path" ] || fail "unsafe disposable transaction path: $path"
    rm -rf -- "$path"
    fsync_paths "$install_dir"
  fi
}

discard_canonical_stage() {
  [ -d "$stage" ] && [ ! -L "$stage" ] || fail "unsafe canonical transaction stage: $stage"
  remove_disposable_tree "$stage_discarded"
  mv -- "$stage" "$stage_discarded"
  fsync_paths "$install_dir"
  remove_disposable_tree "$stage_discarded"
}

remove_completion_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] || fail "unsafe completion path: $path"
    rm -f -- "$path"
    fsync_paths "$publication_lock_dir"
  fi
}

completion_matches_live() {
  [ -f "$publication_completion" ] && [ ! -L "$publication_completion" ] || return 1
  python3 - \
    "$publication_completion" \
    "$completion_schema" \
    "$install_dir" \
    "${publication_relatives[@]}" <<'PY'
import hashlib
import os
import stat
import sys
from pathlib import Path, PurePosixPath

receipt = Path(sys.argv[1])
schema = sys.argv[2]
install = Path(sys.argv[3])
relatives = sys.argv[4:]

def digest(path: Path) -> str:
    value = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise SystemExit(1)
    with os.fdopen(descriptor, "rb", closefd=True) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

identity = os.stat(install, follow_symlinks=False)
lines = [f"schema={schema}", f"install_identity={identity.st_dev}:{identity.st_ino}"]
for relative in relatives:
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise SystemExit(1)
    lines.append(f"file_sha256.{relative}={digest(install.joinpath(*pure.parts))}")
expected = ("\n".join(lines) + "\n").encode("ascii")
if receipt.read_bytes() != expected:
    raise SystemExit(1)
PY
}

publish_completion() {
  remove_completion_path "$publication_completion_pending"
  python3 - \
    "$completion_schema" \
    "$install_dir" \
    "${publication_relatives[@]}" >"$publication_completion_pending" <<'PY'
import hashlib
import os
import stat
import sys
from pathlib import Path, PurePosixPath

schema = sys.argv[1]
install = Path(sys.argv[2])
relatives = sys.argv[3:]

def digest(path: Path) -> str:
    value = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        raise SystemExit(f"completion input is not regular: {path}")
    with os.fdopen(descriptor, "rb", closefd=True) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()

identity = os.stat(install, follow_symlinks=False)
lines = [f"schema={schema}", f"install_identity={identity.st_dev}:{identity.st_ino}"]
for relative in relatives:
    pure = PurePosixPath(relative)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        raise SystemExit(f"unsafe completion path: {relative}")
    lines.append(f"file_sha256.{relative}={digest(install.joinpath(*pure.parts))}")
sys.stdout.write("\n".join(lines) + "\n")
PY
  fsync_paths "$publication_completion_pending"
  mv -f -- "$publication_completion_pending" "$publication_completion"
  fsync_paths "$publication_lock_dir"
}

validate_existing_export_generation() {
  local relative
  local start_validation_pending
  local installed_start_proof="$install_dir/share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json"
  local installed_concurrency_receipt="$install_dir/share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt"

  for relative in "${publication_relatives[@]}"; do
    [ -f "$install_dir/$relative" ] && [ ! -L "$install_dir/$relative" ] ||
      fail "sealed export generation is missing a regular member: $relative"
  done
  python3 "$FRESH_ROOT/lib/sealed_export_chain.py" \
    --install-root "$install_dir" \
    --project-root "$FRESH_ROOT" ||
    fail 'installed sealed export proof chain is invalid'
  python3 "$FRESH_ROOT/runtime/bin/verify-postmaster-wasm-import.py" "$postgres" >/dev/null ||
    fail 'installed sealed export module import contract is invalid'
  fresh_require_start_proof_tool \
    "$FRESH_START_PROOF_BIN" \
    "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
  start_validation_pending="$publication_lock_dir/$publication_lock_key.start-proof.validation.pending"
  remove_completion_path "$start_validation_pending"
  "$FRESH_START_PROOF_BIN" "$postgres" >"$start_validation_pending"
  cmp -s "$start_validation_pending" "$installed_start_proof" || {
    remove_completion_path "$start_validation_pending"
    fail 'installed sealed export deterministic-start proof differs'
  }
  remove_completion_path "$start_validation_pending"
  python3 "$FRESH_ROOT/runtime/bin/verify-postmaster-concurrency-contract.py" \
    --expected-total "$expected_total" \
    --latch-state-contract packed-atomic-v1 \
    --verified-receipt "$installed_concurrency_receipt" \
    --receipt-only \
    "$postgres" >/dev/null ||
    fail 'installed sealed export concurrency receipt differs'
}

remove_publication_temporary() {
  local relative="$1"
  local destination="$install_dir/$relative"
  remove_pending_path "$(dirname "$destination")/.$(basename "$destination").oliphaunt-sealed-export.pending"
}

atomic_publish_file() {
  local source="$1"
  local relative="$2"
  local destination="$install_dir/$relative"
  local parent
  local temporary
  parent="$(dirname "$destination")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || fail "unsafe publication directory: $parent"
  [ -f "$source" ] && [ ! -L "$source" ] || fail "missing regular publication source: $source"
  temporary="$parent/.$(basename "$destination").oliphaunt-sealed-export.pending"
  remove_pending_path "$temporary"
  cp -p -- "$source" "$temporary"
  fsync_paths "$temporary"
  mv -f -- "$temporary" "$destination"
  fsync_paths "$parent"
}

remove_live_file() {
  local relative="$1"
  local destination="$install_dir/$relative"
  local parent
  parent="$(dirname "$destination")"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -f "$destination" ] && [ ! -L "$destination" ] ||
      fail "unsafe live publication path: $destination"
    rm -f -- "$destination"
    fsync_paths "$parent"
  fi
}

rollback_publication() {
  local relative backup absent destination parent temporary

  # The structural receipt is the sole admission point. Remove a possibly new
  # receipt before restoring any payload so no mixed generation is admissible.
  for relative in "${publication_relatives[@]}"; do
    remove_publication_temporary "$relative"
  done
  remove_live_file "$structure_relative"
  for relative in "${publication_relatives[@]}"; do
    [ "$relative" != "$structure_relative" ] || continue
    backup="$stage/originals/$relative"
    absent="$stage/originals/$relative.absent"
    if [ -f "$backup" ] && [ ! -L "$backup" ] && [ ! -e "$absent" ]; then
      atomic_publish_file "$backup" "$relative"
    elif [ -f "$absent" ] && [ ! -L "$absent" ] && [ ! -e "$backup" ]; then
      remove_live_file "$relative"
    else
      fail "incomplete rollback identity for $relative"
    fi
  done

  backup="$stage/originals/$structure_relative"
  absent="$stage/originals/$structure_relative.absent"
  if [ -f "$backup" ] && [ ! -L "$backup" ] && [ ! -e "$absent" ]; then
    atomic_publish_file "$backup" "$structure_relative"
  elif [ -f "$absent" ] && [ ! -L "$absent" ] && [ ! -e "$backup" ]; then
    :
  else
    fail "incomplete rollback identity for $structure_relative"
  fi
}

recover_stale_publication() {
  local schema_path="$stage/TRANSACTION_SCHEMA"
  local ready="$stage/READY_TO_ADMIT"
  local staged_receipt="$stage/$structure_relative"
  local live_receipt="$install_dir/$structure_relative"

  [ -d "$stage" ] && [ ! -L "$stage" ] || fail "unsafe stale closure staging path: $stage"
  [ -f "$schema_path" ] && [ ! -L "$schema_path" ] ||
    fail "stale closure transaction has no regular schema: $stage"
  [ "$(cat "$schema_path")" = "$publication_schema" ] ||
    fail "stale closure transaction schema differs: $stage"

  # READY is durable only after every non-admission file and directory is
  # durable. A matching live structural receipt therefore proves the new
  # generation reached its atomic admission point before interruption.
  if [ -f "$ready" ] && [ ! -L "$ready" ] &&
    [ -f "$staged_receipt" ] && [ ! -L "$staged_receipt" ] &&
    [ -f "$live_receipt" ] && [ ! -L "$live_receipt" ] &&
    cmp -s "$staged_receipt" "$live_receipt"; then
    recovery_committed=1
    return 0
  fi
  if [ -f "$stage/BACKUPS_COMPLETE" ] && [ ! -L "$stage/BACKUPS_COMPLETE" ]; then
    rollback_publication
  fi
}

recovery_committed=0
remove_disposable_tree "$stage_initializing"
remove_disposable_tree "$stage_discarded"
remove_completion_path "$publication_completion_pending"
if [ -e "$stage" ] || [ -L "$stage" ]; then
  recover_stale_publication
  if [ "$recovery_committed" -eq 1 ]; then
    validate_existing_export_generation
    publish_completion
    discard_canonical_stage
    printf 'recovered committed sealed export closure: module=%s receipt=%s\n' \
      "$postgres" "$install_dir/$structure_relative"
    exit 0
  fi
  discard_canonical_stage
fi
linear_memory_descendant="$install_dir/share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
if [ -e "$linear_memory_descendant" ] || [ -L "$linear_memory_descendant" ]; then
  [ -f "$linear_memory_descendant" ] && [ ! -L "$linear_memory_descendant" ] ||
    fail "unsafe linear-memory descendant receipt: $linear_memory_descendant"
  python3 "$FRESH_ROOT/lib/sealed_export_chain.py" \
    --install-root "$install_dir" \
    --project-root "$FRESH_ROOT" \
    --allow-linear-memory-descendant ||
    fail 'installed linear-memory descendant does not validate against the sealed export generation'
  printf 'sealed export closure already has a validated linear-memory descendant: module=%s receipt=%s\n' \
    "$postgres" "$install_dir/$structure_relative"
  exit 0
fi
if [ -e "$install_dir/$structure_relative" ] || [ -L "$install_dir/$structure_relative" ]; then
  validate_existing_export_generation
  publish_completion
  printf 'validated existing sealed export closure: module=%s receipt=%s\n' \
    "$postgres" "$install_dir/$structure_relative"
  exit 0
fi
remove_completion_path "$publication_completion"
mkdir -p "$stage_initializing/bin" "$stage_initializing/share/postgresql"
printf '%s\n' "$publication_schema" >"$stage_initializing/TRANSACTION_SCHEMA"
fsync_paths "$stage_initializing/TRANSACTION_SCHEMA"
fsync_tree_directories "$stage_initializing"
mv -- "$stage_initializing" "$stage"
fsync_paths "$install_dir"

publish_complete=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if completion_matches_live; then
    status=0
  fi
  if [ -d "$stage" ] && [ ! -L "$stage" ]; then
    if [ "$publish_complete" -eq 0 ]; then
      recovery_committed=0
      recover_stale_publication
      if [ "$recovery_committed" -eq 1 ]; then
        publish_completion
        status=0
      fi
    fi
    discard_canonical_stage
  fi
  remove_disposable_tree "$stage_initializing"
  remove_disposable_tree "$stage_discarded"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

readonly tool_manifest="$FRESH_ROOT/tools/sealed-export-closure/Cargo.toml"
readonly mandatory_policy="$FRESH_ROOT/runtime/policies/sealed-main-runtime-exports.v1.txt"
readonly dlsym_policy="$FRESH_ROOT/runtime/policies/sealed-main-dlsym-exports.v1.txt"
readonly side_manifest="$FRESH_ROOT/runtime/policies/sealed-side-modules.v1.tsv"
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

python3 "$FRESH_ROOT/runtime/bin/verify-postmaster-wasm-import.py" "$stage/bin/postgres"
fresh_require_start_proof_tool "$FRESH_START_PROOF_BIN" "$FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT"
"$FRESH_START_PROOF_BIN" "$stage/bin/postgres" >"$start_proof"

"$docker_bin" run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$REPO_ROOT:/work" \
  -w /work \
  "$docker_image_id" \
  python3 \
  /work/src/runtimes/liboliphaunt/wasix-postmaster/runtime/bin/verify-postmaster-concurrency-contract.py \
  --expected-total "$expected_total" \
  --latch-state-contract packed-atomic-v1 \
  --wasm-dis /opt/wasixcc-home/.wasixcc/binaryen/bin/wasm-dis \
  --receipt "$docker_stage/share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt" \
  "$docker_stage/bin/postgres"

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

share_dir="$install_dir/share/postgresql"
mkdir -p "$share_dir"
[ ! -L "$share_dir" ] || fail "unsafe publication directory: $share_dir"

# Copy every predecessor before changing the live prefix. BACKUPS_COMPLETE is a
# durable write-ahead boundary: before it, cleanup may discard the stage;
# after it, cleanup can restore the exact predecessor generation.
for relative in "${publication_relatives[@]}"; do
  destination="$install_dir/$relative"
  backup="$stage/originals/$relative"
  absent="$stage/originals/$relative.absent"
  mkdir -p "$(dirname "$backup")"
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    [ -f "$destination" ] && [ ! -L "$destination" ] ||
      fail "unsafe predecessor publication path: $destination"
    cp -p -- "$destination" "$backup"
    fsync_paths "$backup" "$(dirname "$backup")"
  else
    : >"$absent"
    fsync_paths "$absent" "$(dirname "$absent")"
  fi
done
fsync_tree_directories "$stage/originals"
: >"$stage/BACKUPS_COMPLETE"
fsync_paths "$stage/BACKUPS_COMPLETE" "$stage/originals" "$stage"

# De-admit the predecessor first. Publish the rewritten module and auxiliary
# proofs, make them durable, mark READY, and only then atomically publish the
# structural receipt that admits the new generation.
remove_live_file "$structure_relative"
for relative in "${publication_relatives[@]}"; do
  [ "$relative" != "$structure_relative" ] || continue
  atomic_publish_file "$stage/$relative" "$relative"
done
fsync_paths "$stage/$structure_relative" "$(dirname "$stage/$structure_relative")"
: >"$stage/READY_TO_ADMIT"
fsync_paths "$stage/READY_TO_ADMIT" "$stage"
atomic_publish_file "$stage/$structure_relative" "$structure_relative"
publish_completion
publish_complete=1

printf 'sealed exact main-module export closure: module=%s receipt=%s\n' \
  "$postgres" "$share_dir/wasix-postmaster.sealed-export.structure.receipt"
