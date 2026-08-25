#!/usr/bin/env bash
set -euo pipefail

host_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binding_dir="$(cd "$host_dir/.." && pwd)"
repo_root="$(cd "$binding_dir/../../.." && pwd)"
source_manifest="$host_dir/source.toml"
provenance_script="$host_dir/build-provenance.mjs"
target_parent="$repo_root/target/oliphaunt-wasix-ts/host"
target_dir="$target_parent/wasmer-sdk"
cargo_target_dir="$target_parent/cargo"

toml_value() {
  local wanted_section="$1"
  local wanted_key="$2"
  awk -v wanted_section="$wanted_section" -v wanted_key="$wanted_key" '
    /^\[/ {
      section = $0
      gsub(/^\[|\]$/, "", section)
      next
    }
    section == wanted_section && $1 == wanted_key {
      sub(/^[^=]*=[[:space:]]*"/, "")
      sub(/"[[:space:]]*$/, "")
      print
      exit
    }
  ' "$source_manifest"
}

wasmer_js_url="$(toml_value wasmer-js url)"
wasmer_js_version="$(toml_value wasmer-js version)"
wasmer_js_commit="$(toml_value wasmer-js commit)"
wasmer_wasix_url="$(toml_value wasmer-wasix url)"
wasmer_wasix_version="$(toml_value wasmer-wasix version)"
wasmer_wasix_sha256="$(toml_value wasmer-wasix sha256)"
wasmer_url="$(toml_value wasmer url)"
wasmer_version="$(toml_value wasmer version)"
wasmer_sha256="$(toml_value wasmer sha256)"

for value in "$wasmer_js_url" "$wasmer_js_version" "$wasmer_js_commit" "$wasmer_wasix_url" "$wasmer_wasix_version" "$wasmer_wasix_sha256" "$wasmer_url" "$wasmer_version" "$wasmer_sha256"; do
  if [[ -z "$value" ]]; then
    echo "wasix-ts host build: malformed $source_manifest" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "wasix-ts host build: required command not found: node" >&2
  exit 1
fi
mapfile -t patch_series < <(node "$provenance_script" --patch-series)
input_hash="$(node "$provenance_script" --inputs-sha256)"

patch_command="patch"
sha256sum_command="sha256sum"
if command -v gpatch >/dev/null 2>&1; then
  patch_command="gpatch"
fi
if command -v gsha256sum >/dev/null 2>&1; then
  sha256sum_command="gsha256sum"
fi

if [[ -f "$target_dir/.oliphaunt-input-sha256" ]] \
    && [[ "$(<"$target_dir/.oliphaunt-input-sha256")" == "$input_hash" ]] \
    && [[ -f "$target_dir/dist/index.mjs" ]] \
    && [[ -f "$target_dir/dist/worker.mjs" ]] \
    && [[ -f "$target_dir/dist/wasmer_js_bg.wasm" ]]; then
  echo "wasix-ts host build: using source-pinned SDK at $target_dir"
  exit 0
fi

mkdir -p "$target_parent"

for command_name in awk curl git node npm "$patch_command" "$sha256sum_command" tar wasm-pack; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "wasix-ts host build: required command not found: $command_name" >&2
    exit 1
  fi
done

build_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-wasmer-sdk.XXXXXX")"
cleanup() {
  rm -rf -- "$build_root"
}
trap cleanup EXIT

wasmer_js_dir="$build_root/wasmer-js"
wasmer_wasix_archive="$build_root/wasmer-wasix.crate"
wasmer_wasix_dir="$build_root/wasmer-wasix-$wasmer_wasix_version"
wasmer_archive="$build_root/wasmer.crate"
wasmer_dir="$build_root/wasmer-$wasmer_version"

git init --quiet "$wasmer_js_dir"
git -C "$wasmer_js_dir" remote add origin "$wasmer_js_url"
git -C "$wasmer_js_dir" fetch --quiet --depth 1 origin "$wasmer_js_commit"
git -C "$wasmer_js_dir" checkout --quiet --detach FETCH_HEAD
if [[ "$(git -C "$wasmer_js_dir" rev-parse HEAD)" != "$wasmer_js_commit" ]]; then
  echo "wasix-ts host build: Wasmer JS checkout did not resolve the pinned commit" >&2
  exit 1
fi
actual_wasmer_js_version="$(node -p "require(process.argv[1]).version" "$wasmer_js_dir/package.json")"
if [[ "$actual_wasmer_js_version" != "$wasmer_js_version" ]]; then
  echo "wasix-ts host build: pinned Wasmer JS version is $actual_wasmer_js_version, expected $wasmer_js_version" >&2
  exit 1
fi

curl --fail --location --silent --show-error \
  --user-agent "oliphaunt-wasix-ts-source-build/0.0.0" \
  "$wasmer_wasix_url" --output "$wasmer_wasix_archive"
echo "$wasmer_wasix_sha256  $wasmer_wasix_archive" | "$sha256sum_command" --check --status
tar -xzf "$wasmer_wasix_archive" -C "$build_root"

curl --fail --location --silent --show-error \
  --user-agent "oliphaunt-wasix-ts-source-build/0.0.0" \
  "$wasmer_url" --output "$wasmer_archive"
echo "$wasmer_sha256  $wasmer_archive" | "$sha256sum_command" --check --status
tar -xzf "$wasmer_archive" -C "$build_root"

for patch_name in "${patch_series[@]}"; do
  patch_file="$host_dir/patches/$patch_name"
  case "$patch_name" in
    ????-wasmer-js-*.patch)
      patch_dir="$wasmer_js_dir"
      ;;
    ????-wasmer-wasix-*.patch)
      patch_dir="$wasmer_wasix_dir"
      ;;
    ????-wasmer-*.patch)
      patch_dir="$wasmer_dir"
      ;;
    *)
      echo "wasix-ts host build: patch target is not declared by its canonical name: $patch_name" >&2
      exit 1
      ;;
  esac
  "$patch_command" --batch --forward -d "$patch_dir" -p1 < "$patch_file"
done

# The browser host runs every WASIX syscall and virtual-filesystem operation.
# Fail closed if the pinned speed profile ever drifts back to the upstream
# size-first release settings recorded in the source patch.
grep -Fqx "lto = true" "$wasmer_js_dir/Cargo.toml"
grep -Fqx "opt-level = 3" "$wasmer_js_dir/Cargo.toml"
grep -Fqx 'wasm-opt = ["--enable-threads", "--enable-bulk-memory", "-O3"]' \
  "$wasmer_js_dir/Cargo.toml"
for policy_source in \
  "$wasmer_wasix_dir/src/syscalls/wasix/mod.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/thread_spawn.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_spawn.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_spawn2.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_exec3.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_fork.rs"; do
  grep -Fq 'oliphaunt_single_backend_requested' "$policy_source"
done
grep -Fq 'OLIPHAUNT_WASIX_SINGLE_BACKEND=1' \
  "$wasmer_wasix_dir/src/state/env.rs"
grep -Fq '.unwrap_or(true)' "$wasmer_wasix_dir/src/state/env.rs"
grep -Fq 'oliphaunt_fast_clock_calls' "$wasmer_wasix_dir/src/state/env.rs"
grep -Fq 'env.oliphaunt_fast_clock_calls & 0x03ff == 0' \
  "$wasmer_wasix_dir/src/syscalls/wasi/clock_time_get.rs"
grep -Fq 'js_sys::Date::now()' "$wasmer_wasix_dir/src/syscalls/wasm.rs"
grep -Fq 'MONOTONIC_EPOCH.elapsed()' "$wasmer_wasix_dir/src/syscalls/wasm.rs"
if grep -Fq 'Local::now()' "$wasmer_wasix_dir/src/syscalls/wasm.rs"; then
  echo "wasix-ts host build: WASM clock regressed to the timezone-aware wall clock" >&2
  exit 1
fi
grep -Fq 'oliphaunt_fast_clock_import' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'pub fn oliphaunt_direct_memory' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'fallbackAndCalibrate' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'view.getBigUint64(pointer, true)' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'anchor.nanoseconds' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq '} else if (clockId === 1) {' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'const wallMillis = Date.now();' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'wallMillis - lastFallbackWallMillis >= 16' "$wasmer_wasix_dir/src/lib.rs"
if grep -Fq 'clockId === 2' "$wasmer_wasix_dir/src/lib.rs"; then
  echo "wasix-ts host build: wall-time fast path incorrectly handles CPU clocks" >&2
  exit 1
fi
grep -Fq 'oliphaunt_direct_clock_active' "$wasmer_wasix_dir/src/state/env.rs"
grep -Fq 'js_name = "changedPaths"' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'js_name = "entryType"' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'record_change(&changes, &from)' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'struct ChangeTrackingFile' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'Pin::new(&mut *self.file).poll_write(cx, buffer)' \
  "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'conf.truncate || conf.create_new || (conf.create && !existed)' \
  "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'js_name = "createSync"' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'Directory::from_untracked_filesystem' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'if !self.track_changes {' "$wasmer_js_dir/src/fs/directory.rs"
grep -Fq 'struct SyncBridgeFileSystem' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'struct Backend' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq '.apply(&self.backend, &arguments)' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'unsafe { Uint8Array::view(payload) }' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'unsafe { Uint8Array::view_mut_raw(output.as_mut_ptr(), output.len()) }' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'let output = buffer.initialize_unfilled_to(requested);' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'const OP_WRITE: i32 = 10;' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'const OP_FILE_SIZE: i32 = 14;' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'pub fn create_sync(backend: JsValue, capacity: usize)' \
  "$wasmer_js_dir/src/fs/directory.rs"
if grep -Eq 'Atomics|Mailbox|OP_SYNC_ALL|OP_SHUTDOWN|OP_SYNC_WAL|js_name = "(syncAll|syncWal|closeSync)"|payload\.to_vec\(\)|buffer\.put_slice' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs" "$wasmer_js_dir/src/fs/directory.rs"; then
  echo "wasix-ts host build: synchronous bridge retained the obsolete mailbox protocol" >&2
  exit 1
fi
grep -Fq 'if !env.oliphaunt_single_backend {' \
  "$wasmer_wasix_dir/src/syscalls/wasi/fd_close.rs"
if grep -Fq 'key != "OLIPHAUNT_WASIX_SINGLE_BACKEND"' "$wasmer_js_dir/src/options.rs"; then
  echo "wasix-ts host build: direct execution discarded the single-backend invariant" >&2
  exit 1
fi
if grep -R -Fq -- 'OLIPHAUNT_WASIX_STDIO_PGWIRE' \
  "$wasmer_js_dir/src" "$wasmer_wasix_dir/src"; then
  echo "wasix-ts host build: retired stdio-pgwire product transport returned" >&2
  exit 1
fi
grep -Fq 'new Uint8Array(memory.buffer, pointer, input.byteLength).set(input)' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'new Uint8Array(memory.buffer, pointer, length).slice()' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'struct BoundedStderr' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'const STDERR_LIMIT_BYTES: usize = 16 * 1024' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'WASIX stderr (last 16 KiB)' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'builder.set_stderr(stderr)' "$wasmer_js_dir/src/options.rs"
grep -Fq 'js_name = execProtocolStream' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'js_name = execProtocolDuplex' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'const PROTOCOL_CHUNK_BYTES: usize = 64 * 1024' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'input.copy_to(buffer.initialize_unfilled_to(length))' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'buffer.advance(length)' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'let input = match value.dyn_into::<Uint8Array>()' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'if requested == 0 {' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'js_name = prepareOliphauntTool' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'struct OliphauntPreparedTool' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'ModuleHash::xxhash(&module_bytes)' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'js_name = runOliphauntToolDirect' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'Ok((module.clone().into(), bytes))' \
  "$wasmer_js_dir/src/run.rs"
grep -Fq 'CallerRealmTaskManager' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'prepared.runtime.reset()' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq '.instantiate_ext_async(prepared.module.clone(), prepared.module_hash, &mut store)' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'const PROTOCOL_CHUNK_BYTES: usize = 64 * 1024' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'ActiveProtocolCallbacks::begin' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'input.copy_to(buffer.initialize_unfilled_to(length))' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'buffer.advance(length)' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'never mutate, and never retain' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'unsafe { Uint8Array::view(&input[..length]) }' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'struct CaptureFile' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'typescript_type = "OliphauntToolOutput"' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'Ok(tool_output(code, stdout.take(), stderr.take()))' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'configure_tool_direct_builder' "$wasmer_js_dir/src/options.rs"
grep -Fq 'OLIPHAUNT_WASIX_SINGLE_BACKEND' "$wasmer_js_dir/src/options.rs"
grep -Fq 'OLIPHAUNT_DIRECT_PGWIRE' "$wasmer_js_dir/src/options.rs"
grep -Fq '/dev/oliphaunt-pgwire' "$wasmer_js_dir/src/options.rs"
grep -Fq 'StaticFile::new(input)' "$wasmer_js_dir/src/options.rs"
if grep -Eq 'ThreadPool|ReadableStream|WritableStream|bounded_duplex_pipe|TOOL_PROTOCOL_CAPACITY_BYTES|ArcFile|BufferFile|read_capture|\.to_module\(|JsOutput|lazily_decoded' \
  "$wasmer_js_dir/src/tool_direct.rs"; then
  echo "wasix-ts host build: direct tool runner regained per-run preparation or output copying" >&2
  exit 1
fi
if grep -R -Eq 'OliphauntToolInstance|bounded_duplex_pipe|TOOL_PROTOCOL_CAPACITY_BYTES' \
  "$wasmer_js_dir/src"; then
  echo "wasix-ts host build: retired tool WebStream transport returned" >&2
  exit 1
fi
grep -Fq 'wasmparser::RefType::EXNREF' "$wasmer_dir/src/utils/polyfill.rs"
grep -Fq 'wasmparser::RefType::NULLEXNREF' "$wasmer_dir/src/utils/polyfill.rs"
grep -Fq 'Ok(Type::ExceptionRef)' "$wasmer_dir/src/utils/polyfill.rs"

# The pinned source commit's npm lock predates its package metadata. Patch only
# the missing root metadata and dependencies, then install the integrity-pinned
# graph without allowing the package manager to rewrite it.
npm --prefix "$wasmer_js_dir" ci --ignore-scripts --no-audit --no-fund

(
  cd "$wasmer_js_dir"
  CARGO_TARGET_DIR="$cargo_target_dir" wasm-pack build --release --target=web --weak-refs --no-pack
  npm run build:rollup
)

for output in index.mjs worker.mjs wasmer_js_bg.wasm; do
  if [[ ! -f "$wasmer_js_dir/dist/$output" ]]; then
    echo "wasix-ts host build: expected output missing: dist/$output" >&2
    exit 1
  fi
done

staging_dir="$target_parent/.wasmer-sdk-$input_hash"
if [[ -e "$staging_dir" ]]; then
  rm -rf -- "$staging_dir"
fi
mkdir -p "$staging_dir"
cp -R "$wasmer_js_dir/dist" "$staging_dir/dist"
cp "$wasmer_js_dir/LICENSE" "$staging_dir/LICENSE"
printf '%s\n' "$input_hash" > "$staging_dir/.oliphaunt-input-sha256"
node "$provenance_script" --json > "$staging_dir/provenance.json"
chmod -R u+rwX,go+rX "$staging_dir"

previous_dir="$target_parent/.wasmer-sdk-previous"
if [[ -e "$previous_dir" ]]; then
  rm -rf -- "$previous_dir"
fi
if [[ -e "$target_dir" ]]; then
  mv "$target_dir" "$previous_dir"
fi
mv "$staging_dir" "$target_dir"
if [[ -e "$previous_dir" ]]; then
  rm -rf -- "$previous_dir"
fi

echo "wasix-ts host build: wrote source-pinned SDK to $target_dir"
