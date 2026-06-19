#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/tools/runtime/preflight.sh"

native_runtime_ready=0
mode="${1:-release-check}"
scratch_base="${OLIPHAUNT_SDK_CHECK_SCRATCH:-$root/target/liboliphaunt-sdk-check/oliphaunt-rust}"

case "$mode" in
  check-static|test-unit|package-shape|smoke-runtime|regression|extension-regression|coverage|release-check)
    ;;
  "")
    mode="release-check"
    ;;
  *)
    echo "usage: src/sdks/rust/tools/check-sdk.sh [check-static|test-unit|package-shape|smoke-runtime|regression|extension-regression|coverage|release-check]" >&2
    exit 2
    ;;
esac

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

native_runtime_lock() {
  run tools/runtime/with-native-runtime-lock.py "$@"
}

prepare_scratch_dir() {
  dir="$scratch_base/$mode/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

require_cargo_package_entry() {
  listing="$1"
  entry="$2"
  if ! grep -Fxq "$entry" "$listing"; then
    echo "Rust SDK package file list did not include $entry" >&2
    exit 1
  fi
}

require_text() {
  file="$1"
  text="$2"
  message="$3"
  if ! grep -Fq -- "$text" "$file"; then
    echo "$message" >&2
    echo "expected '$text' in $file" >&2
    exit 1
  fi
}

reject_cargo_package_entry_pattern() {
  listing="$1"
  pattern="$2"
  if grep -Eq "$pattern" "$listing"; then
    echo "Rust SDK package file list included generated or product-external files matching $pattern" >&2
    exit 1
  fi
}

check_release_asset_fixture() {
  liboliphaunt_version="$(cat src/runtimes/liboliphaunt/native/VERSION)"
  fixture_assets="$(prepare_scratch_dir liboliphaunt-release-assets)"
  fixture_cache="$(prepare_scratch_dir liboliphaunt-release-cache)"
  fixture_output="$(prepare_scratch_dir liboliphaunt-release-output)"
  fixture_log="$scratch_base/$mode/liboliphaunt-release-assets.log"
  run python3 tools/test/create-liboliphaunt-release-fixture.py \
    --asset-dir "$fixture_assets" \
    --version "$liboliphaunt_version"
  run cargo run -p oliphaunt --bin oliphaunt-resources --locked -- \
    --resolve-release-assets \
    --liboliphaunt-native-version "$liboliphaunt_version" \
    --release-asset-base-url "file://$fixture_assets" \
    --release-target linux-x64-gnu \
    --release-asset-cache "$fixture_cache" \
    --output "$fixture_output" \
    --force >"$fixture_log"
  cat "$fixture_log"
  if ! grep -Fq "liboliphauntReleaseAssets=liboliphaunt-$liboliphaunt_version-linux-x64-gnu.tar.gz,liboliphaunt-$liboliphaunt_version-runtime-resources.tar.gz" "$fixture_log"; then
    echo "Rust SDK release asset resolver did not select the expected release-shaped liboliphaunt assets" >&2
    exit 1
  fi
  if [ ! -f "$fixture_output/oliphaunt/runtime/manifest.properties" ]; then
    echo "Rust SDK release asset resolver did not extract runtime-resources into the output directory" >&2
    exit 1
  fi
}

check_broker_release_asset_fixture() {
  broker_version="$(python3 tools/release/product_metadata.py version oliphaunt-broker)"
  fixture_assets="$(prepare_scratch_dir broker-release-assets)"
  fixture_cache="$(prepare_scratch_dir broker-release-cache)"
  fixture_output="$(prepare_scratch_dir broker-release-output)"
  fixture_log="$scratch_base/$mode/broker-release-assets.log"
  run python3 tools/test/create-broker-release-fixture.py \
    --asset-dir "$fixture_assets" \
    --version "$broker_version"
  run cargo run -p oliphaunt --bin oliphaunt-resources --locked -- \
    --resolve-broker-release-assets \
    --broker-version "$broker_version" \
    --broker-release-asset-base-url "file://$fixture_assets" \
    --broker-release-target linux-x64-gnu \
    --broker-release-asset-cache "$fixture_cache" \
    --output "$fixture_output" \
    --force >"$fixture_log"
  cat "$fixture_log"
  if ! grep -Fq "oliphauntBrokerReleaseAssets=oliphaunt-broker-$broker_version-linux-x64-gnu.tar.gz" "$fixture_log"; then
    echo "Rust SDK broker release asset resolver did not select the expected release-shaped broker asset" >&2
    exit 1
  fi
  if [ ! -x "$fixture_output/bin/oliphaunt-broker" ]; then
    echo "Rust SDK broker release asset resolver did not extract an executable broker helper" >&2
    exit 1
  fi
  windows_fixture_output="$(prepare_scratch_dir broker-release-output-windows)"
  windows_fixture_log="$scratch_base/$mode/broker-release-assets-windows.log"
  run cargo run -p oliphaunt --bin oliphaunt-resources --locked -- \
    --resolve-broker-release-assets \
    --broker-version "$broker_version" \
    --broker-release-asset-base-url "file://$fixture_assets" \
    --broker-release-target windows-x64-msvc \
    --broker-release-asset-cache "$fixture_cache" \
    --output "$windows_fixture_output" \
    --force >"$windows_fixture_log"
  cat "$windows_fixture_log"
  if ! grep -Fq "oliphauntBrokerReleaseAssets=oliphaunt-broker-$broker_version-windows-x64-msvc.zip" "$windows_fixture_log"; then
    echo "Rust SDK broker release asset resolver did not select the expected Windows broker asset" >&2
    exit 1
  fi
  if [ ! -f "$windows_fixture_output/bin/oliphaunt-broker.exe" ]; then
    echo "Rust SDK broker release asset resolver did not extract the Windows broker helper" >&2
    exit 1
  fi
}

if ! command -v cargo >/dev/null 2>&1; then
  echo "missing required command: cargo" >&2
  exit 1
fi

if [ "$mode" = "coverage" ]; then
  exec tools/coverage/run-product oliphaunt-rust
fi

if [ "$mode" = "check-static" ]; then
  run cargo check -p oliphaunt --locked --all-targets
  exit 0
fi

if [ "$mode" = "regression" ]; then
  if ! oliphaunt_runtime_native_host_ready basic; then
    oliphaunt_runtime_native_host_diagnostics basic
    exit 1
  fi
  native_runtime_lock cargo test -p oliphaunt --locked \
    --test native_sql_regression \
    -- \
    --test-threads=1
  exit 0
fi

if oliphaunt_runtime_native_host_ready extensions; then
  native_runtime_ready=1
  echo "using existing native Oliphaunt runtime at $(oliphaunt_runtime_native_host_work_root)"
elif [ -n "${OLIPHAUNT_REQUIRE_NATIVE:-}" ]; then
  oliphaunt_runtime_native_host_diagnostics extensions
  exit 1
else
  echo "warning: native Oliphaunt runtime unavailable or incomplete; env-gated Rust SDK tests will skip" >&2
  oliphaunt_runtime_native_host_diagnostics extensions
fi

if [ "$mode" = "smoke-runtime" ]; then
  if [ "$native_runtime_ready" -ne 1 ]; then
    oliphaunt_runtime_native_host_diagnostics extensions
    exit 1
  fi
  native_runtime_lock cargo test -p oliphaunt --locked --test sdk_native_smoke -- --test-threads=1
  exit 0
fi

if [ "$mode" = "extension-regression" ]; then
  if [ "$native_runtime_ready" -ne 1 ]; then
    oliphaunt_runtime_native_host_diagnostics extensions
    exit 1
  fi
  native_runtime_lock cargo test -p oliphaunt --locked \
    --test native_extensions \
    -- \
    --test-threads=1
  exit 0
fi

if [ "$mode" = "test-unit" ]; then
  if ! cargo nextest --version >/dev/null 2>&1; then
    echo "missing cargo-nextest; run tools/dev/bootstrap-tools.sh" >&2
    exit 1
  fi
  require_text src/sdks/rust/tests/sdk_config_modes.rs "rust_handle_types_are_thread_safe_shared_executor_handles" \
    "Rust SDK tests must prove Oliphaunt handles remain thread-safe shared-executor handles"
  require_text src/sdks/rust/tests/sdk_shape.rs "cloned_handles_share_one_serial_owner_executor" \
    "Rust SDK tests must prove cloned handles share one serial owner executor"
  require_text src/sdks/rust/tests/protocol_query_fixtures.rs "query-response-cases.json" \
    "Rust SDK tests must consume the shared protocol fixture corpus"
  run cargo test -p oliphaunt --doc --locked
  native_runtime_lock cargo nextest run -p oliphaunt --locked --profile ci --no-tests=fail --test-threads=1
  exit 0
fi

package_listing="$root/target/liboliphaunt-sdk-check/rust-cargo-package-list.txt"
mkdir -p "$(dirname "$package_listing")"
printf '\n==> cargo package -p oliphaunt --locked --allow-dirty --list\n'
cargo package -p oliphaunt --locked --allow-dirty --list >"$package_listing"
cat "$package_listing"
for required in \
  Cargo.toml \
  README.md \
  ARCHITECTURE.md \
  src/lib.rs \
  src/database.rs \
  src/query.rs \
  src/runtime_resources.rs \
  src/bin/extension_artifact.rs \
  src/bin/extension_index.rs \
  src/bin/package_resources.rs \
  tests/sdk_config_modes.rs \
  tests/sdk_shape.rs \
  tests/sdk_extensions.rs \
  tests/sdk_native_smoke.rs \
  tests/native_sql_regression.rs
do
  require_cargo_package_entry "$package_listing" "$required"
done
reject_cargo_package_entry_pattern "$package_listing" '^(target/|oliphaunt/|sdks/|src/bindings/wasix-rust/crates/oliphaunt-wasix/)'

require_text src/sdks/rust/tests/sdk_config_modes.rs "rust_handle_types_are_thread_safe_shared_executor_handles" \
  "Rust SDK tests must prove Oliphaunt handles remain thread-safe shared-executor handles"
require_text src/sdks/rust/tests/sdk_config_modes.rs "direct_mode_rejects_fake_multi_session_pools" \
  "Rust SDK tests must reject fake direct-mode multi-session pools"
require_text src/sdks/rust/tests/sdk_config_modes.rs "broker_mode_rejects_fake_multi_session_pools" \
  "Rust SDK tests must reject fake broker-mode multi-session pools"
require_text src/sdks/rust/tests/sdk_config_modes.rs "server_mode_advertises_true_independent_sessions" \
  "Rust SDK tests must prove server mode is the independent-session mode"
require_text src/sdks/rust/tests/sdk_config_modes.rs "direct_broker_server_lifecycle_capabilities_are_honest" \
  "Rust SDK tests must lock direct/broker/server lifecycle capability semantics"
require_text src/sdks/rust/tests/sdk_shape.rs "cloned_handles_share_one_serial_owner_executor" \
  "Rust SDK tests must prove cloned handles share one serial owner executor"
require_text src/sdks/rust/tests/sdk_shape.rs "cloned_handles_share_pin_and_close_state_for_every_sdk_mode" \
  "Rust SDK tests must prove clones share pin and close state for direct/broker/server"
require_text src/sdks/rust/tests/sdk_shape.rs "cloned_handles_queue_fifo_on_one_owner_executor_for_every_sdk_mode" \
  "Rust SDK tests must prove cloned handles queue fairly on one owner executor for direct/broker/server"
require_text src/sdks/rust/tests/sdk_extensions.rs "native_extension_manifest_covers_every_supported_pg18_extension" \
  "Rust SDK extension tests must lock the PG18 extension manifest"
require_text src/sdks/rust/tests/sdk_extensions.rs "release_ready_extension_catalog_is_exact_and_excludes_external_candidates" \
  "Rust SDK extension tests must prevent external candidates from entering release packages implicitly"
require_text src/sdks/rust/tests/sdk_native_smoke.rs "native_liboliphaunt_runtime_select_one_when_env_is_available" \
  "Rust SDK native smoke tests must cover direct liboliphaunt runtime selection"
require_text src/sdks/rust/README.md "never creates an independent PostgreSQL connection" \
  "Rust SDK README must document clone/executor semantics"
require_text src/sdks/rust/README.md "shared executor runs FIFO" \
  "Rust SDK README must document FIFO executor semantics"
check_release_asset_fixture
check_broker_release_asset_fixture

if [ "$mode" = "package-shape" ]; then
  exit 0
fi

if ! cargo nextest --version >/dev/null 2>&1; then
  echo "missing cargo-nextest; run tools/dev/bootstrap-tools.sh" >&2
  exit 1
fi
run cargo test -p oliphaunt --doc --locked
native_runtime_lock cargo nextest run -p oliphaunt --locked --profile ci --no-tests=fail --test-threads=1
