#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wrapper="$project_root/bin/seal-wasix-core-exports.sh"
build_script="$project_root/bin/build-wasix-core.sh"
tool_manifest="$project_root/tools/sealed-export-closure/Cargo.toml"
runtime_roots="$project_root/runtime/policies/sealed-main-runtime-exports.v1.txt"
dlsym_roots="$project_root/runtime/policies/sealed-main-dlsym-exports.v1.txt"
side_manifest="$project_root/runtime/policies/sealed-side-modules.v1.tsv"

bash -n "$wrapper"
bash -n "$build_script"
"$wrapper" --help >/dev/null

test_target="$(mktemp -d)"
cleanup() {
  status=$?
  trap - EXIT
  rm -rf -- "$test_target"
  exit "$status"
}
trap cleanup EXIT
CARGO_TARGET_DIR="$test_target" cargo test --locked --manifest-path "$tool_manifest"

python3 - "$runtime_roots" "$dlsym_roots" "$side_manifest" "$build_script" "$wrapper" <<'PY'
import pathlib
import sys

runtime_path, dlsym_path, side_path, build_path, wrapper_path = map(pathlib.Path, sys.argv[1:])


def names(path: pathlib.Path) -> list[str]:
    raw = path.read_bytes()
    assert raw.endswith(b"\n") and b"\r" not in raw
    values = []
    for line in raw.decode().splitlines():
        value = line.split("#", 1)[0].strip()
        if value:
            assert not any(char.isspace() for char in value)
            values.append(value)
    assert len(values) == len(set(values))
    return values


runtime = set(names(runtime_path))
assert runtime == {
    "__data_end",
    "__tls_align",
    "__tls_base",
    "__tls_size",
    "__wasm_apply_data_relocs",
    "__wasm_call_ctors",
    "__wasm_init_memory",
    "__wasm_init_tls",
    "__wasm_signal",
    "_start",
    "wasi_thread_start",
    "ResetLatch",
    "SetLatch",
    "WaitEventSetWait",
}
assert names(dlsym_path) == []

raw = side_path.read_bytes()
assert raw.endswith(b"\n") and b"\r" not in raw
lines = [
    line
    for line in raw.decode().splitlines()
    if line and not line.startswith("#")
]
assert lines == [
    "lib/libpq.so.5.18\tlib/libpq.so,lib/libpq.so.5\tpublic-libpq-abi",
    "lib/postgresql/cyrillic_and_mic.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/dict_snowball.so\t-\tpostgresql-server-extension",
    "lib/postgresql/euc2004_sjis2004.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/euc_cn_and_mic.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/euc_jp_and_sjis.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/euc_kr_and_mic.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/euc_tw_and_big5.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/latin2_and_win1250.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/latin_and_mic.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/plpgsql.so\t-\tpostgresql-server-extension",
    "lib/postgresql/utf8_and_big5.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_cyrillic.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_euc2004.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_euc_cn.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_euc_jp.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_euc_kr.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_euc_tw.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_gb18030.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_gbk.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_iso8859.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_iso8859_1.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_johab.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_sjis.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_sjis2004.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_uhc.so\t-\tpostgresql-encoding-conversion",
    "lib/postgresql/utf8_and_win.so\t-\tpostgresql-encoding-conversion",
]

build = build_path.read_text(encoding="utf-8")
pipeline_markers = [
    '"$FRESH_ROOT/bin/seal-wasix-core-exports.sh"',
    '"$FRESH_ROOT/bin/seal-wasix-linear-memory.sh"',
    'final_start_proof="$proof_dir/wasix-postmaster.start-proof.json"',
    'final_concurrency_receipt="$proof_dir/wasix-postmaster.final-wasm-concurrency.receipt"',
]
positions = [build.rindex(marker) for marker in pipeline_markers]
assert positions == sorted(positions), positions
assert "schema=oliphaunt.wasix-postmaster.guest-build.v5" in build
guest_fields = [
    "docker_image_id",
    "final_wasm_concurrency_receipt_sha256",
    "linear_memory_profile_id",
    "linear_memory_install_receipt_sha256",
    "postgres_tag",
]
guest_positions = [build.rindex(f"printf '{field}=") for field in guest_fields]
assert guest_positions == sorted(guest_positions), guest_positions

wrapper = wrapper_path.read_text(encoding="utf-8")
assert 'sealed-export-publication.v1' in wrapper
assert 'READY_TO_ADMIT' in wrapper
assert 'BACKUPS_COMPLETE' in wrapper
assert 'cmp -s "$staged_receipt" "$live_receipt"' in wrapper
assert 'done < <(' not in wrapper
assert '>"$stage/discovered-side-modules.unsorted"' in wrapper
assert 'sort -z "$stage/discovered-side-modules.unsorted"' in wrapper
publication_markers = [
    ': >"$stage/BACKUPS_COMPLETE"',
    'remove_live_file "$structure_relative"',
    'atomic_publish_file "$stage/$relative" "$relative"',
    ': >"$stage/READY_TO_ADMIT"',
    'atomic_publish_file "$stage/$structure_relative" "$structure_relative"',
]
positions = [wrapper.rindex(marker) for marker in publication_markers]
assert positions == sorted(positions), positions
PY

printf 'sealed export closure policy and analyzer tests passed\n'
