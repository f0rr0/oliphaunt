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
virtual_fs_url="$(toml_value virtual-fs url)"
virtual_fs_version="$(toml_value virtual-fs version)"
virtual_fs_sha256="$(toml_value virtual-fs sha256)"

for value in "$wasmer_js_url" "$wasmer_js_version" "$wasmer_js_commit" "$wasmer_wasix_url" "$wasmer_wasix_version" "$wasmer_wasix_sha256" "$wasmer_url" "$wasmer_version" "$wasmer_sha256" "$virtual_fs_url" "$virtual_fs_version" "$virtual_fs_sha256"; do
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
tool_output_limit_bytes="$(node "$provenance_script" --tool-output-limit-bytes)"
if [[ ! "$input_hash" =~ ^[0-9a-f]{64}$ ]] || [[ ! "$tool_output_limit_bytes" =~ ^[1-9][0-9]*$ ]]; then
  echo "wasix-ts host build: invalid source identity or tool output contract limit" >&2
  exit 1
fi

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
if [[ "$(wasm-pack --version)" != "wasm-pack ${WASM_PACK_VERSION:-0.15.0}" ]]; then
  echo "wasix-ts host build: wasm-pack ${WASM_PACK_VERSION:-0.15.0} is required" >&2
  exit 1
fi

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
virtual_fs_archive="$build_root/virtual-fs.crate"
virtual_fs_dir="$build_root/virtual-fs-$virtual_fs_version"

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

curl --fail --location --silent --show-error \
  --user-agent "oliphaunt-wasix-ts-source-build/0.0.0" \
  "$virtual_fs_url" --output "$virtual_fs_archive"
echo "$virtual_fs_sha256  $virtual_fs_archive" | "$sha256sum_command" --check --status
tar -xzf "$virtual_fs_archive" -C "$build_root"

for patch_name in "${patch_series[@]}"; do
  patch_file="$host_dir/patches/$patch_name"
  case "$patch_name" in
    ????-wasmer-js-*.patch)
      patch_dir="$wasmer_js_dir"
      ;;
    ????-wasmer-wasix-*.patch)
      patch_dir="$wasmer_wasix_dir"
      ;;
    ????-virtual-fs-*.patch)
      patch_dir="$virtual_fs_dir"
      ;;
    ????-wasmer-*.patch)
      patch_dir="$wasmer_dir"
      ;;
    *)
      echo "wasix-ts host build: patch target is not declared by its canonical name: $patch_name" >&2
      exit 1
      ;;
  esac
  "$patch_command" --batch --forward --fuzz=0 -d "$patch_dir" -p1 < "$patch_file"
done

# The browser host runs every WASIX syscall and virtual-filesystem operation.
# Fail closed if the pinned speed profile ever drifts back to the upstream
# size-first release settings recorded in the source patch.
grep -Fqx "lto = true" "$wasmer_js_dir/Cargo.toml"
grep -Fqx "opt-level = 3" "$wasmer_js_dir/Cargo.toml"
grep -Fqx 'wasm-opt = ["--enable-threads", "--enable-bulk-memory", "-O3"]' \
  "$wasmer_js_dir/Cargo.toml"
grep -Fq 'virtual-fs = { path = "../virtual-fs-0.601.0" }' \
  "$wasmer_js_dir/Cargo.toml"
grep -Fq 'if let Err(error) = getrandom::getrandom(&mut data)' \
  "$virtual_fs_dir/src/random_file.rs"
grep -Fq 'return Poll::Ready(Err(error.into()))' \
  "$virtual_fs_dir/src/random_file.rs"
if grep -Fq 'getrandom::getrandom(&mut data).ok()' "$virtual_fs_dir/src/random_file.rs"; then
  echo "wasix-ts host build: random device still discards entropy errors" >&2
  exit 1
fi
for policy_source in \
  "$wasmer_wasix_dir/src/syscalls/wasix/mod.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/thread_spawn.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_spawn.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_spawn2.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_exec3.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_fork.rs"; do
  grep -Fq 'single_program_requested' "$policy_source"
done
grep -Fq 'pub struct WasiHostPolicy' "$wasmer_wasix_dir/src/capabilities.rs"
grep -Fq 'pub enum WasiGuestExecutionMode' "$wasmer_wasix_dir/src/capabilities.rs"
grep -Fq 'pub enum WasiClockTimeGetMode' "$wasmer_wasix_dir/src/capabilities.rs"
grep -Fq 'pub enum WasiFdClosePolicy' "$wasmer_wasix_dir/src/capabilities.rs"
grep -Fq 'WasiGuestExecutionMode::SingleProgram' "$wasmer_wasix_dir/src/state/builder.rs"
grep -Fq 'Some(1)' "$wasmer_wasix_dir/src/state/builder.rs"
grep -Fq 'if count >= max {' "$wasmer_wasix_dir/src/os/task/control_plane.rs"
if grep -R -Fq -- 'OLIPHAUNT_WASIX_SINGLE_BACKEND' \
  "$wasmer_js_dir/src" "$wasmer_wasix_dir/src"; then
  echo "wasix-ts host build: guest environment still controls host execution policy" >&2
  exit 1
fi
grep -Fq 'WasiEnv::do_pending_operations(&mut ctx)?;' \
  "$wasmer_wasix_dir/src/syscalls/wasi/clock_time_get.rs"
grep -Fq 'ctx = wasi_try_ok!(maybe_backoff::<M>(ctx)?);' \
  "$wasmer_wasix_dir/src/syscalls/wasi/clock_time_get.rs"
grep -Fq 'env.state.clock_offset.lock().unwrap()' \
  "$wasmer_wasix_dir/src/syscalls/wasi/clock_time_get.rs"
grep -Fq 'js_sys::Date::now()' "$wasmer_wasix_dir/src/syscalls/wasm.rs"
grep -Fq 'MONOTONIC_EPOCH.elapsed()' "$wasmer_wasix_dir/src/syscalls/wasm.rs"
grep -Fq 'Snapshot0Clockid::ProcessCputimeId | Snapshot0Clockid::ThreadCputimeId' \
  "$wasmer_wasix_dir/src/syscalls/wasm.rs"
grep -Fq 'Err(Errno::Notsup)' "$wasmer_wasix_dir/src/syscalls/wasm.rs"
if grep -Fq 'Local::now()' "$wasmer_wasix_dir/src/syscalls/wasm.rs"; then
  echo "wasix-ts host build: WASM clock regressed to the timezone-aware wall clock" >&2
  exit 1
fi
grep -Fq 'pub(crate) fn install_oliphaunt_direct_clock' "$wasmer_wasix_dir/src/lib.rs"
for clock_namespace in \
  wasi_snapshot_preview1 wasi_unstable wasix_32v1 wasix_64v1; do
  grep -Fq "\"$clock_namespace\"" "$wasmer_wasix_dir/src/lib.rs"
done
grep -Fq 'import.name() == "clock_time_set"' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'direct JavaScript clock is incompatible with CPU backoff' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'direct JavaScript clock is incompatible with journaling' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'direct JavaScript clock requires memory to be available before instantiation' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'MAX_CANONICAL_INTERVAL_MILLIS = 16' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'MAX_CANONICAL_NANOSECONDS = 9223372036854775807n' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'nanoseconds > MAX_CANONICAL_NANOSECONDS' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'lastRealtimeFallbackMillis === undefined' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'lastMonotonicFallbackMillis === undefined' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'realtimeDirectReadsSinceFallback >= MAX_DIRECT_READS_BETWEEN_FALLBACKS' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'monotonicDirectReadsSinceFallback >= MAX_DIRECT_READS_BETWEEN_FALLBACKS' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'errno === 0 ? sampleRealtimeMillis() : undefined' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'errno === 0 ? samplePerformanceMillis() : undefined' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'monotonicMillis - lastMonotonicFallbackMillis >= MAX_CANONICAL_INTERVAL_MILLIS' \
  "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'const realtimeMillis = sampleRealtimeMillis()' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'view.getBigUint64(pointer, true)' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'view.setBigUint64(pointer, nanoseconds, true)' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'pointer = timePointer >>> 0' "$wasmer_wasix_dir/src/lib.rs"
grep -Fq 'BigInt(Number.MAX_SAFE_INTEGER)' "$wasmer_wasix_dir/src/lib.rs"
if [[ "$(grep -Fc 'Some(&self.memory)' "$wasmer_wasix_dir/src/state/linker.rs")" != "2" ]]; then
  echo "wasix-ts host build: side-module clock policy gates are incomplete" >&2
  exit 1
fi
grep -Fq 'pub fn oliphaunt_direct_memory' "$wasmer_wasix_dir/src/lib.rs"
if grep -Eq 'oliphaunt_(fast_clock_import|direct_clock_active|fast_clock_calls|clock_offset_active)|fallbackAndCalibrate|0x03ff' \
  "$wasmer_wasix_dir/src/lib.rs" \
  "$wasmer_wasix_dir/src/state/env.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasi/clock_time_get.rs"; then
  echo "wasix-ts host build: retired clock shortcut is still present" >&2
  exit 1
fi
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
grep -Fq 'static REALM_BACKENDS: RefCell<HashMap<u32, Rc<RealmBackend>>>' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
if [[ "$(grep -Fc 'wasmer::js::current_thread_id()' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs")" != "3" ]]; then
  echo "wasix-ts host build: filesystem bridge realm checks are incomplete or redundant" >&2
  exit 1
fi
grep -Fq 'let _guard = self.gate.try_lock()' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'backends.insert(id, Rc::new(RealmBackend { backend, request }));' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq '.map(Rc::clone)' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'let transfer = Uint8Array::new_with_length(' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'u32::try_from(transfer_length).map_err(|_| FsError::StorageFull)?' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'transfer.copy_from(payload);' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq '.copy_to(&mut output[..response_len]);' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'if transfer.length() as usize != transfer_length {' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq '.apply(&realm_backend.backend, &arguments)' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'impl Drop for Backend' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'let output = buffer.initialize_unfilled_to(requested);' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'const OP_WRITE: i32 = 10;' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'const OP_FILE_SIZE: i32 = 14;' "$wasmer_js_dir/src/fs/sync_bridge.rs"
grep -Fq 'pub fn create_sync(backend: JsValue, capacity: usize)' \
  "$wasmer_js_dir/src/fs/directory.rs"
if grep -Eq 'unsafe impl (Send|Sync) for Backend|Uint8Array::view(_mut_raw)?|self\.gate\.lock\(|transfer: Uint8Array' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs"; then
  echo "wasix-ts host build: filesystem bridge exposes Rust-owned memory to JavaScript" >&2
  exit 1
fi
if grep -Eq 'Atomics|Mailbox|OP_SYNC_ALL|OP_SHUTDOWN|OP_SYNC_WAL|js_name = "(syncAll|syncWal|closeSync)"|payload\.to_vec\(\)|buffer\.put_slice' \
  "$wasmer_js_dir/src/fs/sync_bridge.rs" "$wasmer_js_dir/src/fs/directory.rs"; then
  echo "wasix-ts host build: synchronous bridge retained the obsolete mailbox protocol" >&2
  exit 1
fi
grep -Fq 'env.host_policy.fd_close() == WasiFdClosePolicy::FlushBeforeClose' \
  "$wasmer_wasix_dir/src/syscalls/wasi/fd_close.rs"
grep -Fq 'fn clone_registered<T>(' \
  "$wasmer_wasix_dir/src/state/handles/thread_local.rs"
grep -Fq 'let borrow: Ref<WasiModuleTreeHandles> = inner.try_borrow().ok()?;' \
  "$wasmer_wasix_dir/src/state/handles/thread_local.rs"
grep -Fq 'let borrow: RefMut<WasiModuleTreeHandles> = inner.try_borrow_mut().ok()?;' \
  "$wasmer_wasix_dir/src/state/handles/thread_local.rs"
grep -Fq 'remove_registered(map, id);' \
  "$wasmer_wasix_dir/src/state/handles/thread_local.rs"
grep -Fq '.try_inner()' \
  "$wasmer_wasix_dir/src/syscalls/wasix/callback_signal.rs"
grep -Fq '.try_inner_mut()' \
  "$wasmer_wasix_dir/src/syscalls/wasix/callback_signal.rs"
if grep -Fq '.inner()' \
  "$wasmer_wasix_dir/src/syscalls/wasix/callback_signal.rs"; then
  echo "wasix-ts host build: callback signal still has an infallible instance-handle borrow" >&2
  exit 1
fi
if grep -Fq 'let map = map.borrow_mut();' \
  "$wasmer_wasix_dir/src/state/handles/thread_local.rs"; then
  echo "wasix-ts host build: instance handle inner borrow still retains the registry borrow" >&2
  exit 1
fi
grep -Fq 'builder.set_host_policy(WasiHostPolicy::new(' "$wasmer_js_dir/src/options.rs"
grep -Fq 'WasiClockTimeGetMode::DirectJs' "$wasmer_js_dir/src/options.rs"
grep -Fq 'WasiClockTimeGetMode::Canonical' "$wasmer_js_dir/src/options.rs"
grep -Fq 'WasiFdClosePolicy::WritesCompleteSynchronously' "$wasmer_js_dir/src/options.rs"
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
grep -Fq 'const PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT: i32 = 3;' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'const PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES: i32 = 64 * 1024 * 1024;' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn buffered_protocol_error(&self, error: anyhow::Error) -> Error {' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'buffered protocol exchange contract: buffered protocol output has a {PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES}-byte limit' \
  "$wasmer_js_dir/src/postgres_direct.rs"
if [[ "$(grep -Fc 'self.buffered_protocol_error(error)' \
  "$wasmer_js_dir/src/postgres_direct.rs")" != "2" ]]; then
  echo "wasix-ts host build: buffered protocol errors do not uniformly disclose the output limit" >&2
  exit 1
fi
grep -Fq 'pq_flush: TypedFunction<(), i32>,' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'enum ProtocolStdoutFailure {' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'LockPoisoned,' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'struct ProtocolStdoutState {' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn with_state<T>(' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'Err(poisoned) =>' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'let mut state = poisoned.into_inner();' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'Err(state.poison_lock())' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'state.record_callback_failure(format!("{error:?}"))' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT,' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'output.length() == 0,' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'replaced == transport,' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'flush_status == 0,' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'len <= PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES,' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'input.copy_to(buffer.initialize_unfilled_to(length))' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'buffer.advance(length)' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'let input = match value.dyn_into::<Uint8Array>()' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'if requested == 0 {' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'enum MainLoopOutcome {' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq '0 => Some(Self::Processed),' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq '1 => Some(Self::Recovered),' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq '2 => Some(Self::InputEnded),' "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'main_loop: TypedFunction<(), i32>,' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn call_main_loop(&mut self) -> anyhow::Result<MainLoopOutcome> {' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn terminal_main_loop_error(&self, error: wasmer::RuntimeError)' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'PostgresMainLoopOnce returned invalid typed outcome {status}' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'MainLoopOutcome::InputEnded if streaming =>' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'PostgresMainLoopOnce reported input end while dispatching buffered protocol input' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn send_ready_after_main_loop(&mut self) -> anyhow::Result<()> {' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn flush_after_main_loop(&mut self) -> anyhow::Result<()> {' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'protocol output flush returned {status} after a typed main-loop outcome; buffered protocol output has a {PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES}-byte limit' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'Err(error) if runtime_exit_code(&error) == Some(OLIPHAUNT_EXIT_ALIVE) => {}' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'const OLIPHAUNT_EXIT_STARTUP_REJECTED: i32 = 98;' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'const STARTUP_OUTCOME_VERSION: u32 = 1;' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'const STARTUP_OUTCOME_DESCRIPTOR_BYTES: u32 = 32;' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'startup_outcome: TypedFunction<(), i32>,' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq '"oliphaunt_wasix_startup_outcome_v1"' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn read_startup_outcome_descriptor(' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'descriptor_pointer != 0' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'descriptor_pointer as u32' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'fn read_startup_rejection(&self, descriptor_pointer: i32)' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'pending.kind == STARTUP_OUTCOME_PENDING' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'descriptor.kind == STARTUP_OUTCOME_REJECTED' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'validate_startup_rejection_protocol(&protocol)?;' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'startup ErrorResponse did not contain a SQLSTATE' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'Uint8Array::from(protocol.as_slice())' \
  "$wasmer_js_dir/src/postgres_direct.rs"
grep -Fq 'let restore = if execution.is_err() {' "$wasmer_js_dir/src/postgres_direct.rs"
if grep -Eq 'pq_flush\.call\(&mut self\.store\)\.ok\(\)' \
  "$wasmer_js_dir/src/postgres_direct.rs"; then
  echo "wasix-ts host build: direct protocol flush status is discarded" >&2
  exit 1
fi
if grep -Eq 'protocol stdout lock poisoned|protocol callback failure must be recorded' \
  "$wasmer_js_dir/src/postgres_direct.rs"; then
  echo "wasix-ts host build: protocol callback failure handling can still panic" >&2
  exit 1
fi
if grep -Eq 'PostgresMainLongJmp|POSTGRES_MAIN_LONGJMP|force_host_error_recovery|recover_protocol_error|recover_non_trapping_protocol_error|output_contains_error|legacy_captured_startup_error|captured_startup_error|startup_outcome_reset' \
  "$wasmer_js_dir/src/postgres_direct.rs"; then
  echo "wasix-ts host build: retired host-driven recovery or startup re-entry returned" >&2
  exit 1
fi
if sed -n \
  '/Err(error) if runtime_exit_code(&error) == Some(OLIPHAUNT_EXIT_STARTUP_REJECTED)/,/Ok(()) =>/p' \
  "$wasmer_js_dir/src/postgres_direct.rs" | grep -Fq '.call('; then
  echo "wasix-ts host build: Exit98 handling re-enters a guest export" >&2
  exit 1
fi
if [[ "$(grep -Fc 'self.main_loop.call(&mut self.store)' \
  "$wasmer_js_dir/src/postgres_direct.rs")" != "1" ]]; then
  echo "wasix-ts host build: PostgreSQL loop calls bypass the typed outcome decoder" >&2
  exit 1
fi
if [[ "$(grep -Fc 'runtime_exit_code' \
  "$wasmer_js_dir/src/postgres_direct.rs")" != "3" ]]; then
  echo "wasix-ts host build: runtime exit classification escaped startup handling" >&2
  exit 1
fi
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
grep -Fq 'let chunk = Uint8Array::from(&input[..length]);' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'The protocol write callback receives an owned JavaScript copy that it may retain.' \
  "$wasmer_js_dir/src/tool_direct.rs"
if grep -Eq 'Uint8Array::view(_mut_raw)?' "$wasmer_js_dir/src/tool_direct.rs"; then
  echo "wasix-ts host build: tool protocol write still borrows Rust-owned memory" >&2
  exit 1
fi
grep -Fq "const TOOL_OUTPUT_LIMIT_BYTES: usize = $tool_output_limit_bytes;" \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'struct CaptureState' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'self.total_bytes.checked_add(input.len())' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'if total_bytes > TOOL_OUTPUT_LIMIT_BYTES {' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq '.try_reserve(input.len())' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'self.failure.get_or_insert(failure)' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'Self::LockPoisoned => io::ErrorKind::Other' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'self.failure = Some(CaptureFailure::LockPoisoned);' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'self.stdout.clear();' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'self.stderr.clear();' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'let failure = state.poison_lock();' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'let (stdout, stderr) = capture.finish().map_err(Error::from)?;' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'Err(virtual_fs::FsError::PermissionDenied)' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'typescript_type = "OliphauntToolOutput"' "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'Ok(tool_output(code, stdout, stderr))' \
  "$wasmer_js_dir/src/tool_direct.rs"
grep -Fq 'configure_tool_direct_builder' "$wasmer_js_dir/src/options.rs"
grep -Fq 'OLIPHAUNT_DIRECT_PGWIRE' "$wasmer_js_dir/src/options.rs"
grep -Fq '/dev/oliphaunt-pgwire' "$wasmer_js_dir/src/options.rs"
grep -Fq 'StaticFile::new(input)' "$wasmer_js_dir/src/options.rs"
if grep -Eq 'ThreadPool|ReadableStream|WritableStream|bounded_duplex_pipe|TOOL_PROTOCOL_CAPACITY_BYTES|ArcFile|BufferFile|read_capture|\.to_module\(|JsOutput|lazily_decoded' \
  "$wasmer_js_dir/src/tool_direct.rs"; then
  echo "wasix-ts host build: direct tool runner regained per-run preparation or output copying" >&2
  exit 1
fi
if sed -n '/struct CaptureState/,/Run an Oliphaunt frontend tool/p' \
  "$wasmer_js_dir/src/tool_direct.rs" | grep -Eq '\.resize\(|\.expect\(|\.unwrap\(|\.unwrap_or_else\('; then
  echo "wasix-ts host build: tool output capture can resize arbitrarily, panic, or silently recover a poisoned lock" >&2
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
