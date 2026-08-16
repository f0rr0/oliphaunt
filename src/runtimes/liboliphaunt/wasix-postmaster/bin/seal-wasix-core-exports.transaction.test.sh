#!/usr/bin/env bash

set -euo pipefail

# Exercise the real publication transaction with tiny deterministic producer
# fixtures.  The command shims do not replace transaction operations: they
# only make the expensive Cargo/Docker analyzers local and inject SIGKILL at
# externally observable filesystem boundaries.

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
repo_root="$(cd "$project_root/../../../.." && pwd -P)"
wrapper="$project_root/bin/seal-wasix-core-exports.sh"
side_manifest="$project_root/runtime/policies/sealed-side-modules.v1.tsv"
managed_root="$repo_root/target/oliphaunt-wasix-postmaster"

fail() {
  printf 'sealed export transaction test: %s\n' "$*" >&2
  exit 1
}

for command in bash cmp cp find flock grep mktemp python3 sha256sum sort; do
  command -v "$command" >/dev/null 2>&1 || fail "missing test command: $command"
done
[ -x "$wrapper" ] || fail "missing executable wrapper: $wrapper"
[ -f "$side_manifest" ] && [ ! -L "$side_manifest" ] ||
  fail "missing regular side-module manifest: $side_manifest"

real_cp="$(command -v cp)"
real_mv="$(command -v mv)"
real_rm="$(command -v rm)"
real_python3="$(command -v python3)"
real_sha256sum="$(command -v sha256sum)"
tx_docker_recipe_sha256="$(
  bash -c 'source "$1/lib/common.sh"; fresh_wasix_builder_recipe_sha256' \
    bash "$project_root"
)" || fail 'could not derive fixture WASIX builder recipe identity'

mkdir -p "$managed_root"
[ -d "$managed_root" ] && [ ! -L "$managed_root" ] ||
  fail "unsafe managed test root: $managed_root"
test_root="$(mktemp -d "$managed_root/sealed-export-transaction-test.XXXXXX")"
fake_bin="$test_root/fake-bin"
mkdir -p "$fake_bin"
active_pids=""

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  find "$test_root" -type f -name '*.gate-release' -exec touch {} + 2>/dev/null || :
  for pid in $active_pids; do
    kill -TERM "$pid" 2>/dev/null || :
  done
  for pid in $active_pids; do
    wait "$pid" 2>/dev/null || :
  done
  "$real_rm" -rf -- "$test_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fake_closure_tool="$test_root/fake-sealed-export-closure"
fake_closure_attest="$test_root/fake-sealed-export-attest.py"
fake_start_proof="$test_root/fake-start-proof"
executor_receipt="$test_root/postmaster-executor-build.receipt"

cat >"$fake_closure_attest" <<'PY'
#!/usr/bin/env python3
import json
import pathlib
import runpy
import sys

(
    fixture_helper,
    install_raw,
    staged_raw,
    mandatory_raw,
    dlsym_raw,
    seed_raw,
    final_raw,
    allowlist_raw,
    structure_raw,
    dce_sha256,
    dce_version,
    side_manifest_sha256,
    *side_paths,
) = sys.argv[1:]
fixture = runpy.run_path(fixture_helper)
digest = fixture["digest"]
json_bytes = fixture["json_bytes"]
module_summary = fixture["module_summary"]
proof = fixture["proof"]
snapshot = fixture["snapshot"]

install = pathlib.Path(install_raw)
staged = pathlib.Path(staged_raw)
mandatory = digest(pathlib.Path(mandatory_raw).read_bytes())
dlsym = digest(pathlib.Path(dlsym_raw).read_bytes())
sides = [
    module_summary(
        relative,
        digest((install / relative).read_bytes()),
        (install / relative).stat().st_size,
    )
    for relative in side_paths
]
final_data = staged.read_bytes()
final_sha256 = digest(final_data)
final_main = module_summary("bin/postgres", final_sha256, len(final_data))
seed_sha256 = digest(b"pre-dce-fixture\0" + final_data)
seed_main = module_summary("bin/postgres", seed_sha256, len(final_data) + 16)
seed_data = json_bytes(proof(seed_main, sides, mandatory, dlsym))
final_proof_data = json_bytes(proof(final_main, sides, mandatory, dlsym))
pathlib.Path(seed_raw).write_bytes(seed_data)
pathlib.Path(final_raw).write_bytes(final_proof_data)
allowlist = pathlib.Path(allowlist_raw)
receipt = {
    "schema": "oliphaunt.wasix-postmaster.sealed-export-structure.v1",
    "policy-id": "oliphaunt.wasix-postmaster.sealed-export-closure.v1",
    "analyzer-version": "fixture",
    "analyzer-binary-sha256": "0" * 64,
    "dce-tool-sha256": dce_sha256,
    "dce-tool-version": dce_version,
    "dce-passes": ["--remove-unused-module-elements"],
    "mandatory-policy-sha256": mandatory,
    "declared-main-dlsym-policy-sha256": dlsym,
    "side-manifest-sha256": side_manifest_sha256,
    "allowlist-sha256": digest(allowlist.read_bytes()),
    "seed-proof-sha256": digest(seed_data),
    "final-proof-sha256": digest(final_proof_data),
    "seed": snapshot(seed_sha256, len(final_data) + 16),
    "final-module": snapshot(final_sha256, len(final_data)),
    "sides": [
        {"path": side["path"], "sha256": side["sha256"]} for side in sides
    ],
}
pathlib.Path(structure_raw).write_text(
    json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY
chmod 755 "$fake_closure_attest"

cat >"$fake_closure_tool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

command="$1"
shift
case "$command" in
  seal)
    seed_proof="$4"
    allowlist="$5"
    printf '{"schema":"fixture-seed-proof-v1"}\n' >"$seed_proof"
    printf 'fixture-export\n' >"$allowlist"
    ;;
  rewrite)
    main_module="$1"
    output="$3"
    "$TX_REAL_CP" -p -- "$main_module" "$output"
    # A valid empty-name custom section makes the successor byte-distinct.
    printf '\000\001\000' >>"$output"
    ;;
  attest-final)
    install="$PWD"
    staged_module="$2"
    mandatory_policy="$3"
    dlsym_policy="$4"
    allowlist="$5"
    seed_proof="$6"
    final_proof="$7"
    structure_receipt="$8"
    dce_sha256="$9"
    dce_version="${10}"
    side_manifest_sha256="${11}"
    shift 11
    "$TX_REAL_PYTHON3" "$TX_FAKE_CLOSURE_ATTEST" \
      "$TX_EXPORT_FIXTURE_HELPER" \
      "$install" "$staged_module" "$mandatory_policy" "$dlsym_policy" \
      "$seed_proof" "$final_proof" "$allowlist" "$structure_receipt" \
      "$dce_sha256" "$dce_version" "$side_manifest_sha256" "$@"
    ;;
  *)
    printf 'unexpected fake closure command: %s\n' "$command" >&2
    exit 2
    ;;
esac
EOF
chmod 755 "$fake_closure_tool"

cat >"$fake_start_proof" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 1 ] && [ "$1" = --policy-id ]; then
  printf '%s\n' llvm-shared-memory-init-restricted-effects.v1
  exit 0
fi
[ "$#" -eq 1 ] || exit 2
module_sha256="$("$TX_REAL_SHA256SUM" "$1")"
module_sha256="${module_sha256%% *}"
printf '{"schema":"fixture-start-proof-v1","module-sha256":"%s"}\n' \
  "$module_sha256"
EOF
chmod 755 "$fake_start_proof"

zero_sha=0000000000000000000000000000000000000000000000000000000000000000
start_proof_sha256="$("$real_sha256sum" "$fake_start_proof")"
start_proof_sha256="${start_proof_sha256%% *}"
cat >"$executor_receipt" <<EOF
schema=oliphaunt.wasix-postmaster.postmaster-executor-build.v3
build_recipe_sha256=$zero_sha
wasmer_build_receipt_sha256=$zero_sha
wasmer_source_commit=fixture
wasmer_patch_sha256=$zero_sha
wasmer_prepared_signature_sha256=$zero_sha
wasmer_cargo_lock_sha256=$zero_sha
runtime_abi_id=$zero_sha
artifact_abi_version=21
executor_package=fixture
executor_binary=fixture
executor_features=fixture
executor_role=fixture
runtime_policy_id=fixture
cli_contract=fixture
executor_binary_sha256=$zero_sha
start_proof_binary=oliphaunt-wasix-start-proof
start_proof_features=start-proof-tool
start_proof_policy=llvm-shared-memory-init-restricted-effects.v1
start_proof_binary_sha256=$start_proof_sha256
memory_profile_binary=fixture
memory_profile_features=fixture
linear_memory_profile_id=fixture
memory_profile_binary_sha256=$zero_sha
postmaster_compiler_binary=fixture
postmaster_compiler_features=fixture
compiler_cpu_policy=fixture
compiler_cpu_features=fixture
postmaster_compiler_binary_sha256=$zero_sha
host_platform=fixture
host_abi=fixture
rustc_host=fixture
rustc_version=fixture
EOF

cat >"$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$$" >>"$TX_CARGO_LOG"
if [ "${TX_FAIL_BUILD:-0}" = 1 ]; then
  exit 23
fi
if [ -n "${TX_GATE_READY:-}" ]; then
  : >"$TX_GATE_READY"
  while [ ! -e "$TX_GATE_RELEASE" ]; do
    sleep 0.02
  done
fi
mkdir -p "$CARGO_TARGET_DIR/release"
"$TX_REAL_CP" -p -- \
  "$TX_FAKE_CLOSURE_TOOL" \
  "$CARGO_TARGET_DIR/release/oliphaunt-wasix-sealed-export-closure"
chmod 755 "$CARGO_TARGET_DIR/release/oliphaunt-wasix-sealed-export-closure"
EOF
chmod 755 "$fake_bin/cargo"

cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

map_path() {
  case "$1" in
    /work) printf '%s\n' "$TX_REPO_ROOT" ;;
    /work/*) printf '%s/%s\n' "$TX_REPO_ROOT" "${1#/work/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

case "${1:-}" in
  image)
    [ "${2:-}" = inspect ] || exit 2
    case "${4:-}" in
      *'.Id'*)
        printf 'sha256:%s|%s\n' \
          "$TX_DOCKER_IMAGE_SHA256" "$TX_DOCKER_RECIPE_SHA256"
        ;;
      *) printf '%s\n' "$TX_DOCKER_RECIPE_SHA256" ;;
    esac
    exit 0
    ;;
  run)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --rm) shift ;;
        --user|-v|-w) shift 2 ;;
        *) image="$1"; shift; break ;;
      esac
    done
    [ -n "${image:-}" ] && [ "$#" -gt 0 ] || exit 2
    command="$1"
    shift
    case "$command" in
      sha256sum)
        printf '%s  %s\n' \
          1111111111111111111111111111111111111111111111111111111111111111 \
          "${1:-/opt/fake-wasm-opt}"
        ;;
      */wasm-opt)
        if [ "${1:-}" = --version ]; then
          printf 'fixture-wasm-opt 1\n'
          exit 0
        fi
        input="$(map_path "$1")"
        output=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = -o ]; then
            shift
            output="$(map_path "$1")"
            break
          fi
          shift
        done
        [ -n "$output" ] || exit 2
        "$TX_REAL_CP" -p -- "$input" "$output"
        ;;
      python3)
        receipt=""
        postgres=""
        while [ "$#" -gt 0 ]; do
          if [ "$1" = --receipt ]; then
            shift
            receipt="$(map_path "$1")"
          fi
          postgres="$1"
          shift
        done
        postgres="$(map_path "$postgres")"
        [ -n "$receipt" ] && [ -f "$postgres" ] || exit 2
        postgres_sha256="$("$TX_REAL_SHA256SUM" "$postgres")"
        postgres_sha256="${postgres_sha256%% *}"
        cat >"$receipt" <<RECEIPT
schema=oliphaunt.wasix-postmaster.final-wasm-concurrency.v1
postgres_sha256=$postgres_sha256
wasm_dis_sha256=2222222222222222222222222222222222222222222222222222222222222222
wasm_dis_version=fixture-wasm-dis-1
latch_state_contract=packed-atomic-v1
atomic_fence_total=7
atomic_fence_set_latch=2
atomic_fence_reset_latch=1
atomic_fence_wait_event_set_wait=1
i32_atomic_load_total=1
i32_atomic_load_wait_event_set_wait=1
i32_atomic_rmw_and_total=3
i32_atomic_rmw_and_reset_latch=1
i32_atomic_rmw_and_wait_event_set_wait=2
i32_atomic_rmw_or_total=2
i32_atomic_rmw_or_set_latch=1
i32_atomic_rmw_or_wait_event_set_wait=1
RECEIPT
        ;;
      *)
        printf 'unexpected fake docker command: %s\n' "$command" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    exit 2
    ;;
esac
EOF
chmod 755 "$fake_bin/docker"

cat >"$fake_bin/cp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

previous=""
last=""
for argument in "$@"; do
  previous="$last"
  last="$argument"
done
source_path="$previous"
destination="$last"
stage="$WASIX_INSTALL_DIR/.oliphaunt-sealed-export-closure.pending"
share="$WASIX_INSTALL_DIR/share/postgresql"
trip=0
case "${TX_KILL_AT:-}" in
  de-admit)
    [ "$source_path" = "$stage/bin/postgres" ] &&
      [ "$destination" = "$WASIX_INSTALL_DIR/bin/.postgres.oliphaunt-sealed-export.pending" ] &&
      trip=1
    ;;
  READY)
    [ "$source_path" = "$stage/share/postgresql/wasix-postmaster.sealed-export.structure.receipt" ] &&
      [ "$destination" = "$share/.wasix-postmaster.sealed-export.structure.receipt.oliphaunt-sealed-export.pending" ] &&
      trip=1
    ;;
esac
if [ "$trip" -eq 1 ]; then
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
exec "$TX_REAL_CP" "$@"
EOF
chmod 755 "$fake_bin/cp"

cat >"$fake_bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

previous=""
last=""
for argument in "$@"; do
  previous="$last"
  last="$argument"
done
source_path="$previous"
destination="$last"
stage="$WASIX_INSTALL_DIR/.oliphaunt-sealed-export-closure.pending"
initializing="$WASIX_INSTALL_DIR/.oliphaunt-sealed-export-closure.initializing"
discarded="$WASIX_INSTALL_DIR/.oliphaunt-sealed-export-closure.discarded"

trip_before=0
trip_after=0
case "${TX_KILL_AT:-}" in
  init)
    [ "$source_path" = "$initializing" ] && [ "$destination" = "$stage" ] && trip_before=1
    ;;
  payload:*)
    relative="${TX_KILL_AT#payload:}"
    live="$WASIX_INSTALL_DIR/$relative"
    temporary="$(dirname "$live")/.$(basename "$live").oliphaunt-sealed-export.pending"
    [ "$source_path" = "$temporary" ] && [ "$destination" = "$live" ] && trip_after=1
    ;;
  rollback:*)
    relative="${TX_KILL_AT#rollback:}"
    live="$WASIX_INSTALL_DIR/$relative"
    temporary="$(dirname "$live")/.$(basename "$live").oliphaunt-sealed-export.pending"
    [ "$source_path" = "$temporary" ] && [ "$destination" = "$live" ] && trip_after=1
    ;;
  completion)
    case "$source_path:$destination" in
      *.completed.pending:*.completed) trip_after=1 ;;
    esac
    ;;
  tombstone)
    [ "$source_path" = "$stage" ] && [ "$destination" = "$discarded" ] && trip_after=1
    ;;
esac

if [ "$trip_before" -eq 1 ]; then
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
if [ "$trip_after" -eq 1 ]; then
  "$TX_REAL_MV" "$@"
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
exec "$TX_REAL_MV" "$@"
EOF
chmod 755 "$fake_bin/mv"

cat >"$fake_bin/rm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

last=""
for argument in "$@"; do
  last="$argument"
done
structure="$WASIX_INSTALL_DIR/share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
if [ "${TX_KILL_AT:-}" = backup ] && [ "$last" = "$structure" ]; then
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
exec "$TX_REAL_RM" "$@"
EOF
chmod 755 "$fake_bin/rm"

cat >"$fake_bin/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

stage="$WASIX_INSTALL_DIR/.oliphaunt-sealed-export-closure.pending"
backups_complete="$stage/BACKUPS_COMPLETE"
partial_backup="$stage/originals/share/postgresql/wasix-postmaster.sealed-export.final-proof.json"
if [ "${TX_KILL_AT:-}" = backup ] &&
  [ "${1:-}" = - ] && [ "${2:-}" = "$backups_complete" ]; then
  "$TX_REAL_PYTHON3" "$@"
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
if [ "${TX_KILL_AT:-}" = backup-partial ] &&
  [ "${1:-}" = - ] && [ "${2:-}" = "$partial_backup" ]; then
  "$TX_REAL_PYTHON3" "$@"
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
if [ "${TX_KILL_AT:-}" = admission ] &&
  [ "${1:-}" = - ] &&
  [ "${2:-}" = oliphaunt.wasix-postmaster.sealed-export-completion.v2 ]; then
  printf '%s\n' "$TX_KILL_AT" >>"$TX_HOOK_LOG"
  kill -KILL "$PPID"
  exit 137
fi
exec "$TX_REAL_PYTHON3" "$@"
EOF
chmod 755 "$fake_bin/python3"

publication_relatives=(
  bin/postgres
  share/postgresql/wasix-postmaster.sealed-export.seed-proof.json
  share/postgresql/wasix-postmaster.sealed-export.final-proof.json
  share/postgresql/wasix-postmaster.sealed-export.allowlist
  share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json
  share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt
  share/postgresql/wasix-postmaster.sealed-export.structure.receipt
)
structure_relative=share/postgresql/wasix-postmaster.sealed-export.structure.receipt

write_minimal_postmaster() {
  "$real_python3" - "$1" <<'PY'
import pathlib
import sys

def uleb(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)

def vector(items: list[bytes]) -> bytes:
    return uleb(len(items)) + b"".join(items)

def name(value: str) -> bytes:
    raw = value.encode("utf-8")
    return uleb(len(raw)) + raw

def function_type(parameters: tuple[int, ...]) -> bytes:
    return b"\x60" + vector([bytes([value]) for value in parameters]) + vector([b"\x7f"])

types = [function_type((0x7f, 0x7e, 0x7e, 0x7f))]
imports = [name("oliphaunt_postmaster_v1") + name("fd_sync_range") + b"\x00" + uleb(0)]

def section(identifier: int, payload: bytes) -> bytes:
    return bytes([identifier]) + uleb(len(payload)) + payload

module = b"\x00asm\x01\x00\x00\x00" + section(1, vector(types)) + section(2, vector(imports))
path = pathlib.Path(sys.argv[1])
path.write_bytes(module)
PY
}

create_fixture() {
  case_root="$1"
  install="$case_root/install"
  mkdir -p "$install/bin" "$install/lib/postgresql" "$install/share/postgresql" "$case_root/work"
  write_minimal_postmaster "$install/bin/postgres"
  chmod 755 "$install/bin/postgres"

  while IFS=$'\t' read -r canonical aliases _abi extra; do
    case "$canonical" in
      ''|'#'*) continue ;;
    esac
    [ -z "${extra:-}" ] || fail "unexpected side-manifest column: $canonical"
    mkdir -p "$(dirname "$install/$canonical")"
    printf 'fixture-side-module-v1\n' >"$install/$canonical"
    if [ "$aliases" != - ]; then
      IFS=',' read -r -a alias_paths <<<"$aliases"
      for alias_path in "${alias_paths[@]}"; do
        mkdir -p "$(dirname "$install/$alias_path")"
        "$real_cp" -p -- "$install/$canonical" "$install/$alias_path"
      done
    fi
  done <"$side_manifest"

  printf 'old-seed-proof\n' >"$install/share/postgresql/wasix-postmaster.sealed-export.seed-proof.json"
  printf 'old-final-proof\n' >"$install/share/postgresql/wasix-postmaster.sealed-export.final-proof.json"
  printf 'old-allowlist\n' >"$install/share/postgresql/wasix-postmaster.sealed-export.allowlist"
  printf 'old-start-proof\n' >"$install/share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json"
  printf 'old-concurrency-receipt\n' >"$install/share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt"
}

make_linear_memory_descendant() {
  "$real_python3" - "$1/install" "$side_manifest" <<'PY'
import hashlib
import json
import pathlib
import sys

install = pathlib.Path(sys.argv[1])
side_manifest = pathlib.Path(sys.argv[2])
side_paths = [
    line.split("\t", 1)[0]
    for line in side_manifest.read_text(encoding="utf-8").splitlines()
    if line and not line.startswith("#")
]
paths = sorted(["bin/postgres", *side_paths])

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

records = []
for relative in paths:
    path = install / relative
    source = path.read_bytes()
    sealed = source + b"\x00\x01\x00"
    path.write_bytes(sealed)
    records.append(
        {
            "path": relative,
            "source-module-sha256": digest(source),
            "module-sha256": digest(sealed),
            "initial-pages": 1,
            "maximum-pages": 4096,
            "maximum-bytes": 268435456,
            "shared": True,
            "import-module": "env",
            "import-name": "memory",
            "transformation": "pinned-wasixcc-65536-to-embedded-4096-reversible-v1",
        }
    )

def closure_hash(field: str) -> str:
    value = hashlib.sha256()
    for item in (
        "oliphaunt.wasix-postmaster.linear-memory-install-closure.v1",
        field,
    ):
        encoded = item.encode()
        value.update(len(encoded).to_bytes(8, "big"))
        value.update(encoded)
    for record in records:
        for item in (record["path"], record[field]):
            encoded = item.encode()
            value.update(len(encoded).to_bytes(8, "big"))
            value.update(encoded)
    return value.hexdigest()

predecessor_relative = "share/postgresql/wasix-postmaster.sealed-export.structure.receipt"
predecessor = (install / predecessor_relative).read_bytes()
receipt = {
    "schema": "oliphaunt.wasix-postmaster.linear-memory-install.v1",
    "profile-id": "oliphaunt.wasix-postmaster.linear-memory.wasm32-max256m-u64-static4g-guard2g.v1",
    "address-width": "wasm32",
    "supported-host-pointer-width": "u64",
    "maximum-pages": 4096,
    "maximum-bytes": 268435456,
    "static-bound-pages": 65536,
    "static-offset-guard-bytes": 2147483648,
    "static-access-lowering": "wasmer-llvm-unchecked-reservation-and-guard-v1",
    "requires-shared": True,
    "requires-import": "env.memory",
    "excludes-wasm32-end-wrap": True,
    "predecessor-export-closure-receipt": predecessor_relative,
    "predecessor-export-closure-receipt-sha256": digest(predecessor),
    "source-module-closure-sha256": closure_hash("source-module-sha256"),
    "module-closure-sha256": closure_hash("module-sha256"),
    "module-count": len(records),
    "modules": records,
}
output = install / "share/postgresql/wasix-postmaster.linear-memory-profile.receipt.json"
output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

write_snapshot() {
  install="$1"
  output="$2"
  : >"$output"
  for relative in "${publication_relatives[@]}"; do
    if [ -f "$install/$relative" ] && [ ! -L "$install/$relative" ]; then
      value="$("$real_sha256sum" "$install/$relative")"
      printf '%s\t%s\n' "${value%% *}" "$relative" >>"$output"
    elif [ ! -e "$install/$relative" ] && [ ! -L "$install/$relative" ]; then
      printf 'absent\t%s\n' "$relative" >>"$output"
    else
      fail "snapshot source is neither regular nor absent: $install/$relative"
    fi
  done
}

snapshot_hash() {
  snapshot="$1"
  relative="$2"
  awk -F '\t' -v expected="$relative" '$2 == expected { count += 1; value = $1 } END { if (count != 1) exit 2; print value }' "$snapshot"
}

assert_matches() {
  install="$1"
  snapshot="$2"
  relative="$3"
  expected="$(snapshot_hash "$snapshot" "$relative")"
  if [ "$expected" = absent ]; then
    assert_absent "$install/$relative"
    return
  fi
  [ -f "$install/$relative" ] && [ ! -L "$install/$relative" ] ||
    fail "missing regular publication file: $install/$relative"
  actual="$("$real_sha256sum" "$install/$relative")"
  actual="${actual%% *}"
  [ "$actual" = "$expected" ] ||
    fail "$relative does not match $(basename "$snapshot")"
}

assert_snapshot() {
  install="$1"
  snapshot="$2"
  for relative in "${publication_relatives[@]}"; do
    assert_matches "$install" "$snapshot" "$relative"
  done
}

assert_absent() {
  path="$1"
  [ ! -e "$path" ] && [ ! -L "$path" ] || fail "expected absent path: $path"
}

assert_transaction_clean() {
  case_root="$1"
  install="$case_root/install"
  for suffix in pending initializing discarded; do
    assert_absent "$install/.oliphaunt-sealed-export-closure.$suffix"
  done
  if find "$install" -type f -name '*.oliphaunt-sealed-export.pending' -print -quit | grep -q .; then
    fail "publication temporary survived under $install"
  fi
  if find "$case_root/work/runtime/publication-locks" -type f -name '*.completed.pending' -print -quit 2>/dev/null | grep -q .; then
    fail "completion temporary survived under $case_root/work"
  fi
}

invoke_wrapper() {
  case_root="$1"
  kill_at="$2"
  fail_build="$3"
  gate_ready="$4"
  gate_release="$5"
  install="$case_root/install"
  mkdir -p "$case_root/work"
  env \
    PATH="$fake_bin:$PATH" \
    FRESH_WORK_ROOT="$case_root/work" \
    FRESH_START_PROOF_BIN="$fake_start_proof" \
    FRESH_POSTMASTER_EXECUTOR_BUILD_RECEIPT="$executor_receipt" \
    FRESH_WASIX_DOCKER_IMAGE=fixture-wasix-image \
    WASIX_INSTALL_DIR="$install" \
    TX_CARGO_LOG="$case_root/cargo.log" \
    TX_DOCKER_IMAGE_SHA256=1111111111111111111111111111111111111111111111111111111111111111 \
    TX_DOCKER_RECIPE_SHA256="$tx_docker_recipe_sha256" \
    TX_FAIL_BUILD="$fail_build" \
    TX_GATE_READY="$gate_ready" \
    TX_GATE_RELEASE="$gate_release" \
    TX_HOOK_LOG="$case_root/hook.log" \
    TX_KILL_AT="$kill_at" \
    TX_EXPORT_FIXTURE_HELPER="$project_root/testdata/make-sealed-export-fixture.py" \
    TX_FAKE_CLOSURE_ATTEST="$fake_closure_attest" \
    TX_FAKE_CLOSURE_TOOL="$fake_closure_tool" \
    TX_REAL_CP="$real_cp" \
    TX_REAL_MV="$real_mv" \
    TX_REAL_RM="$real_rm" \
    TX_REAL_PYTHON3="$real_python3" \
    TX_REAL_SHA256SUM="$real_sha256sum" \
    TX_REPO_ROOT="$repo_root" \
    "$wrapper" --install-dir "$install" --expected-total 7
}

run_crash() {
  case_root="$1"
  boundary="$2"
  set +e
  invoke_wrapper "$case_root" "$boundary" 0 '' '' >"$case_root/crash.out" 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$boundary fault unexpectedly committed"
  [ -f "$case_root/hook.log" ] || fail "$boundary fault hook was not reached"
  [ "$(cat "$case_root/hook.log")" = "$boundary" ] ||
    fail "$boundary fault hook was reached more than once or at the wrong boundary"
}

recover_rollback() {
  case_root="$1"
  set +e
  invoke_wrapper "$case_root" '' 1 '' '' >"$case_root/recover.out" 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "rollback recovery unexpectedly reached a new commit"
  assert_snapshot "$case_root/install" "$old_snapshot"
  assert_transaction_clean "$case_root"
}

recover_committed() {
  case_root="$1"
  cargo_count_before=0
  if [ -f "$case_root/cargo.log" ]; then
    cargo_count_before="$(wc -l <"$case_root/cargo.log" | tr -d ' ')"
  fi
  invoke_wrapper "$case_root" '' 1 '' '' >"$case_root/recover.out" 2>&1 ||
    fail "admitted generation recovery failed"
  assert_snapshot "$case_root/install" "$new_snapshot"
  assert_transaction_clean "$case_root"
  completed_count="$(find "$case_root/work/runtime/publication-locks" -type f -name '*.completed' | wc -l | tr -d ' ')"
  [ "$completed_count" -eq 1 ] || fail "admission recovery did not publish one completion record"
  cargo_count_after="$(wc -l <"$case_root/cargo.log" | tr -d ' ')"
  [ "$cargo_count_after" -eq "$cargo_count_before" ] ||
    fail "admission recovery unexpectedly rebuilt the generation"
}

wait_for_path() {
  path="$1"
  attempts=0
  while [ ! -e "$path" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 500 ] || fail "timed out waiting for $path"
    sleep 0.02
  done
}

# Establish exact old and new byte generations once.  Every crash fixture is
# separately created and compared against these deterministic snapshots.
golden="$test_root/golden"
create_fixture "$golden"
old_snapshot="$test_root/old.snapshot"
new_snapshot="$test_root/new.snapshot"
write_snapshot "$golden/install" "$old_snapshot"
invoke_wrapper "$golden" '' 0 '' '' >"$golden/commit.out" 2>&1 ||
  fail "golden transaction failed"
write_snapshot "$golden/install" "$new_snapshot"
assert_transaction_clean "$golden"

init_case="$test_root/crash-init"
create_fixture "$init_case"
run_crash "$init_case" init
[ -d "$init_case/install/.oliphaunt-sealed-export-closure.initializing" ] ||
  fail "initialization crash lacks the durable initializing tree"
assert_absent "$init_case/install/.oliphaunt-sealed-export-closure.pending"
assert_snapshot "$init_case/install" "$old_snapshot"
recover_rollback "$init_case"

partial_backup_case="$test_root/crash-partial-backup"
create_fixture "$partial_backup_case"
run_crash "$partial_backup_case" backup-partial
[ -f "$partial_backup_case/install/.oliphaunt-sealed-export-closure.pending/originals/share/postgresql/wasix-postmaster.sealed-export.final-proof.json" ] ||
  fail "partial-backup crash did not reach the selected durable backup"
assert_absent "$partial_backup_case/install/.oliphaunt-sealed-export-closure.pending/BACKUPS_COMPLETE"
assert_snapshot "$partial_backup_case/install" "$old_snapshot"
recover_rollback "$partial_backup_case"

backup_case="$test_root/crash-backup"
create_fixture "$backup_case"
run_crash "$backup_case" backup
[ -f "$backup_case/install/.oliphaunt-sealed-export-closure.pending/BACKUPS_COMPLETE" ] ||
  fail "backup crash lacks durable BACKUPS_COMPLETE"
assert_snapshot "$backup_case/install" "$old_snapshot"
recover_rollback "$backup_case"

deadmit_case="$test_root/crash-de-admit"
create_fixture "$deadmit_case"
run_crash "$deadmit_case" de-admit
assert_absent "$deadmit_case/install/$structure_relative"
for relative in "${publication_relatives[@]}"; do
  [ "$relative" = "$structure_relative" ] ||
    assert_matches "$deadmit_case/install" "$old_snapshot" "$relative"
done
recover_rollback "$deadmit_case"

payload_relatives=(
  bin/postgres
  share/postgresql/wasix-postmaster.sealed-export.seed-proof.json
  share/postgresql/wasix-postmaster.sealed-export.final-proof.json
  share/postgresql/wasix-postmaster.sealed-export.allowlist
  share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json
  share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt
)
payload_index=0
for crashed_payload in "${payload_relatives[@]}"; do
  payload_case="$test_root/crash-payload-$payload_index"
  create_fixture "$payload_case"
  run_crash "$payload_case" "payload:$crashed_payload"
  assert_absent "$payload_case/install/$structure_relative"
  check_index=0
  for relative in "${payload_relatives[@]}"; do
    if [ "$check_index" -le "$payload_index" ]; then
      assert_matches "$payload_case/install" "$new_snapshot" "$relative"
    else
      assert_matches "$payload_case/install" "$old_snapshot" "$relative"
    fi
    check_index=$((check_index + 1))
  done
  recover_rollback "$payload_case"
  payload_index=$((payload_index + 1))
done

ready_case="$test_root/crash-READY"
create_fixture "$ready_case"
run_crash "$ready_case" READY
[ -f "$ready_case/install/.oliphaunt-sealed-export-closure.pending/READY_TO_ADMIT" ] ||
  fail "READY crash lacks durable READY_TO_ADMIT"
assert_absent "$ready_case/install/$structure_relative"
for relative in "${publication_relatives[@]}"; do
  [ "$relative" = "$structure_relative" ] ||
    assert_matches "$ready_case/install" "$new_snapshot" "$relative"
done
recover_rollback "$ready_case"

# Interrupt rollback itself after restoring a middle payload.  A third
# invocation must safely repeat the rollback from its beginning and recover
# the exact predecessor generation.
rollback_case="$test_root/crash-rollback"
create_fixture "$rollback_case"
run_crash "$rollback_case" READY
: >"$rollback_case/hook.log"
rollback_relative=share/postgresql/wasix-postmaster.sealed-export.final-proof.json
set +e
invoke_wrapper "$rollback_case" "rollback:$rollback_relative" 1 '' '' \
  >"$rollback_case/rollback-crash.out" 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "rollback interruption unexpectedly completed"
[ "$(cat "$rollback_case/hook.log")" = "rollback:$rollback_relative" ] ||
  fail "rollback interruption did not reach the selected payload"
assert_absent "$rollback_case/install/$structure_relative"
for relative in \
  bin/postgres \
  share/postgresql/wasix-postmaster.sealed-export.seed-proof.json \
  share/postgresql/wasix-postmaster.sealed-export.final-proof.json
do
  assert_matches "$rollback_case/install" "$old_snapshot" "$relative"
done
for relative in \
  share/postgresql/wasix-postmaster.sealed-export.allowlist \
  share/postgresql/wasix-postmaster.sealed-export.start-proof.intermediate.json \
  share/postgresql/wasix-postmaster.sealed-export.concurrency.intermediate.receipt
do
  assert_matches "$rollback_case/install" "$new_snapshot" "$relative"
done
recover_rollback "$rollback_case"

admission_case="$test_root/crash-admission"
create_fixture "$admission_case"
run_crash "$admission_case" admission
[ -f "$admission_case/install/.oliphaunt-sealed-export-closure.pending/READY_TO_ADMIT" ] ||
  fail "admission crash lacks durable READY_TO_ADMIT"
assert_snapshot "$admission_case/install" "$new_snapshot"
if find "$admission_case/work/runtime/publication-locks" -type f -name '*.completed' -print -quit 2>/dev/null | grep -q .; then
  fail "admission fault occurred after completion publication"
fi
recover_committed "$admission_case"

completion_case="$test_root/crash-completion"
create_fixture "$completion_case"
run_crash "$completion_case" completion
assert_snapshot "$completion_case/install" "$new_snapshot"
[ -d "$completion_case/install/.oliphaunt-sealed-export-closure.pending" ] ||
  fail "completion crash unexpectedly discarded the recovery journal"
completed_count="$(find "$completion_case/work/runtime/publication-locks" -type f -name '*.completed' | wc -l | tr -d ' ')"
[ "$completed_count" -eq 1 ] || fail "completion crash did not reach the completion rename"
recover_committed "$completion_case"

tombstone_case="$test_root/crash-tombstone"
create_fixture "$tombstone_case"
run_crash "$tombstone_case" tombstone
assert_snapshot "$tombstone_case/install" "$new_snapshot"
assert_absent "$tombstone_case/install/.oliphaunt-sealed-export-closure.pending"
[ -d "$tombstone_case/install/.oliphaunt-sealed-export-closure.discarded" ] ||
  fail "tombstone crash did not preserve the renamed transaction journal"
recover_committed "$tombstone_case"

# A linear-memory successor intentionally makes the export completion record
# stale because the module bytes changed.  The wrapper must validate that
# descendant chain and return without trying to reseal its predecessor.
descendant_case="$test_root/linear-memory-descendant"
create_fixture "$descendant_case"
invoke_wrapper "$descendant_case" '' 0 '' '' >"$descendant_case/seal.out" 2>&1 ||
  fail "descendant predecessor seal failed"
make_linear_memory_descendant "$descendant_case"
descendant_snapshot="$test_root/descendant.snapshot"
write_snapshot "$descendant_case/install" "$descendant_snapshot"
cargo_count_before="$(wc -l <"$descendant_case/cargo.log" | tr -d ' ')"
invoke_wrapper "$descendant_case" '' 1 '' '' >"$descendant_case/recheck.out" 2>&1 ||
  fail "valid linear-memory descendant was not accepted"
cargo_count_after="$(wc -l <"$descendant_case/cargo.log" | tr -d ' ')"
[ "$cargo_count_after" -eq "$cargo_count_before" ] ||
  fail "linear-memory descendant caused its export predecessor to be resealed"
grep -Fq 'validated linear-memory descendant' "$descendant_case/recheck.out" ||
  fail "linear-memory descendant did not use the strict successor path"
assert_snapshot "$descendant_case/install" "$descendant_snapshot"
assert_transaction_clean "$descendant_case"

# Hold the first invocation inside the producer after it owns the publication
# lock.  A second invocation must neither run Cargo nor mutate the prefix; once
# released, it must observe the first invocation's durable completion.
concurrent_case="$test_root/concurrent"
create_fixture "$concurrent_case"
gate_ready="$concurrent_case/producer.gate-ready"
gate_release="$concurrent_case/producer.gate-release"
invoke_wrapper "$concurrent_case" '' 0 "$gate_ready" "$gate_release" \
  >"$concurrent_case/first.out" 2>&1 &
first_pid=$!
active_pids="$active_pids $first_pid"
wait_for_path "$gate_ready"
invoke_wrapper "$concurrent_case" '' 0 '' '' \
  >"$concurrent_case/second.out" 2>&1 &
second_pid=$!
active_pids="$active_pids $second_pid"
sleep 0.2
kill -0 "$second_pid" 2>/dev/null || fail "second invocation did not wait for the publication lock"
cargo_count="$(wc -l <"$concurrent_case/cargo.log" | tr -d ' ')"
[ "$cargo_count" -eq 1 ] || fail "concurrent invocation entered the producer while the lock was held"
assert_snapshot "$concurrent_case/install" "$old_snapshot"
: >"$gate_release"
wait "$first_pid" || fail "first concurrent invocation failed"
wait "$second_pid" || fail "second concurrent invocation failed"
active_pids=""
cargo_count="$(wc -l <"$concurrent_case/cargo.log" | tr -d ' ')"
[ "$cargo_count" -eq 1 ] || fail "second concurrent invocation rebuilt an already committed generation"
grep -Fq 'validated existing sealed export closure' "$concurrent_case/second.out" ||
  fail "second concurrent invocation did not validate the committed generation"
assert_snapshot "$concurrent_case/install" "$new_snapshot"
assert_transaction_clean "$concurrent_case"

printf 'sealed export transaction crash-recovery and exclusion tests passed\n'
