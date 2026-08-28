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
  run tools/dev/bun.sh tools/runtime/with-native-runtime-lock.mjs "$@"
}

run_artifact_relay_build_script_tests() {
  relay_test_dir="$(prepare_scratch_dir artifact-relay-build-script)"
  relay_test="$relay_test_dir/relay-build-script-tests"
  if [ -n "${CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER:-}" ]; then
    run rustc --edition=2024 --test src/sdks/rust/build.rs -C "linker=$CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER" -o "$relay_test"
  else
    run rustc --edition=2024 --test src/sdks/rust/build.rs -o "$relay_test"
  fi
  run "$relay_test"
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
  run bun tools/test/create-liboliphaunt-release-fixture.mjs \
    --asset-dir "$fixture_assets" \
    --version "$liboliphaunt_version"
  run tools/dev/bun.sh tools/release/check-liboliphaunt-release-assets.mjs \
    --asset-dir "$fixture_assets"
  run cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- \
    --resolve-release-assets \
    --liboliphaunt-native-version "$liboliphaunt_version" \
    --release-asset-base-url "file://$fixture_assets" \
    --release-target linux-x64-gnu \
    --release-asset-cache "$fixture_cache" \
    --output "$fixture_output" \
    --force >"$fixture_log"
  cat "$fixture_log"
  if ! grep -Fq "liboliphauntReleaseAssets=liboliphaunt-$liboliphaunt_version-linux-x64-gnu.tar.gz,oliphaunt-tools-$liboliphaunt_version-linux-x64-gnu.tar.gz" "$fixture_log"; then
    echo "Rust SDK release asset resolver did not select the expected release-shaped liboliphaunt assets" >&2
    exit 1
  fi
  for required in \
    manifest.properties \
    runtime/bin/postgres \
    cluster-seed/manifest.properties \
    cluster-seed-icu/manifest.properties \
    lib/liboliphaunt.so; do
    if [ ! -f "$fixture_output/$required" ]; then
      echo "Rust SDK release asset resolver did not extract the desktop target carrier member $required" >&2
      exit 1
    fi
  done
}

check_broker_release_asset_fixture() {
  broker_version="$(tools/dev/bun.sh tools/release/product-version.mjs version oliphaunt-broker)"
  fixture_assets="$(prepare_scratch_dir broker-release-assets)"
  fixture_cache="$(prepare_scratch_dir broker-release-cache)"
  fixture_output="$(prepare_scratch_dir broker-release-output)"
  fixture_log="$scratch_base/$mode/broker-release-assets.log"
  run bun tools/test/create-broker-release-fixture.mjs \
    --asset-dir "$fixture_assets" \
    --version "$broker_version"
  run tools/dev/bun.sh tools/release/check-broker-release-assets.mjs \
    --asset-dir "$fixture_assets"
  run cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- \
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
  run cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources --locked -- \
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
  check_broker_cargo_relay_fixture "$broker_version" "$fixture_assets"
}

check_broker_cargo_relay_fixture() {
  broker_version="$1"
  fixture_assets="$2"
  liboliphaunt_version="$(cat src/runtimes/liboliphaunt/native/VERSION)"
  liboliphaunt_fixture_assets="$(prepare_scratch_dir liboliphaunt-cargo-release-assets)"
  liboliphaunt_cargo_artifacts="$(prepare_scratch_dir liboliphaunt-cargo-artifacts)"
  run bun tools/test/create-liboliphaunt-release-fixture.mjs \
    --asset-dir "$liboliphaunt_fixture_assets" \
    --version "$liboliphaunt_version"
  run tools/dev/bun.sh tools/release/check-liboliphaunt-release-assets.mjs \
    --asset-dir "$liboliphaunt_fixture_assets"
  run tools/dev/bun.sh tools/release/package-liboliphaunt-cargo-artifacts.mjs \
    --asset-dir "$liboliphaunt_fixture_assets" \
    --output-dir "$liboliphaunt_cargo_artifacts" \
    --version "$liboliphaunt_version" \
    --part-bytes 1048576

  cargo_artifacts="$(prepare_scratch_dir broker-cargo-artifacts)"
  broker_cargo_sources="$(prepare_scratch_dir broker-cargo-sources)"
  run tools/dev/bun.sh tools/release/package_broker_cargo_artifacts.mjs \
    --asset-dir "$fixture_assets" \
    --output-dir "$cargo_artifacts" \
    --source-output-dir "$broker_cargo_sources" \
    --version "$broker_version"

  run tools/dev/bun.sh tools/release/prepare-rust-release-source.mjs

  smoke="$(prepare_scratch_dir broker-cargo-relay-smoke)"
  mkdir -p "$smoke/src"
  cat >"$smoke/Cargo.toml" <<EOF
[package]
name = "oliphaunt-broker-relay-smoke"
version = "0.0.0"
edition = "2024"
publish = false
build = "build.rs"

[workspace]

[dependencies]
oliphaunt = { path = "$root/target/release/cargo-package-sources/oliphaunt" }
oliphaunt-tools = "=$liboliphaunt_version"

[build-dependencies]
oliphaunt-build = { path = "$root/src/sdks/rust/crates/oliphaunt-build" }

[package.metadata.oliphaunt]
runtime = "liboliphaunt-native"
runtime-version = "$liboliphaunt_version"
extensions = []

[patch.crates-io]
EOF
  bun src/sdks/rust/tools/cargo-artifact-patches.mjs \
    "$root" \
    "$liboliphaunt_cargo_artifacts/packages.json" >>"$smoke/Cargo.toml"
  cat >>"$smoke/Cargo.toml" <<EOF
oliphaunt-broker-linux-arm64-gnu = { path = "$broker_cargo_sources/oliphaunt-broker-linux-arm64-gnu" }
oliphaunt-broker-linux-x64-gnu = { path = "$broker_cargo_sources/oliphaunt-broker-linux-x64-gnu" }
oliphaunt-broker-macos-arm64 = { path = "$broker_cargo_sources/oliphaunt-broker-macos-arm64" }
oliphaunt-broker-windows-x64-msvc = { path = "$broker_cargo_sources/oliphaunt-broker-windows-x64-msvc" }
EOF
  cat >"$smoke/build.rs" <<'EOF'
use std::env;
use std::fs;

fn main() {
    let output = oliphaunt_build::try_configure().expect("oliphaunt-build stages Cargo-resolved artifacts");
    let lock = fs::read_to_string(&output.lock_file).expect("staged Oliphaunt lockfile is readable");
    assert!(lock.contains("product = \"liboliphaunt-native\""));
    assert!(lock.contains("kind = \"native-runtime\""));
    assert!(lock.contains("product = \"oliphaunt-tools\""));
    assert!(lock.contains("kind = \"native-tools\""));
    assert!(lock.contains("product = \"oliphaunt-broker\""));
    assert!(lock.contains("kind = \"broker-helper\""));
    assert!(output.resources_dir.join("native-runtime/liboliphaunt-native").is_dir());
    assert!(output.resources_dir.join("native-tools/oliphaunt-tools").is_dir());
    assert!(output.resources_dir.join("broker-helper/oliphaunt-broker").is_dir());
    for instruction in output.cargo_instructions {
        println!("{instruction}");
    }

    let target = env::var("TARGET").expect("TARGET is set");
    let Some((env_key, expected_target, expected_relative)) = broker_manifest_for_target(&target)
    else {
        return;
    };
    let manifest = env::var(env_key).expect("oliphaunt relays the Cargo-resolved broker artifact manifest");
    println!("cargo::rerun-if-changed={manifest}");
    let text = fs::read_to_string(&manifest).expect("relayed broker artifact manifest is readable");
    assert!(text.contains("product = \"oliphaunt-broker\""));
    assert!(text.contains("kind = \"broker-helper\""));
    assert!(text.contains(&format!("target = {expected_target:?}")));
    assert!(text.contains(&format!("relative = {expected_relative:?}")));
    let Some((native_env_key, native_expected_target)) = native_manifest_for_target(&target)
    else {
        return;
    };
    let native_manifest = env::var(native_env_key).expect("oliphaunt relays the Cargo-resolved native artifact manifest");
    let native_text = fs::read_to_string(native_manifest).expect("relayed native artifact manifest is readable");
    assert!(native_text.contains("product = \"liboliphaunt-native\""));
    assert!(native_text.contains("kind = \"native-runtime\""));
    assert!(native_text.contains(&format!("target = {native_expected_target:?}")));
}

fn broker_manifest_for_target(target: &str) -> Option<(&'static str, &'static str, &'static str)> {
    match target {
        "aarch64-unknown-linux-gnu" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_BROKER_LINUX_ARM64_GNU_MANIFEST",
            "aarch64-unknown-linux-gnu",
            "bin/oliphaunt-broker",
        )),
        "x86_64-unknown-linux-gnu" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_BROKER_LINUX_X64_GNU_MANIFEST",
            "x86_64-unknown-linux-gnu",
            "bin/oliphaunt-broker",
        )),
        "aarch64-apple-darwin" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_BROKER_MACOS_ARM64_MANIFEST",
            "aarch64-apple-darwin",
            "bin/oliphaunt-broker",
        )),
        "x86_64-pc-windows-msvc" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_BROKER_WINDOWS_X64_MSVC_MANIFEST",
            "x86_64-pc-windows-msvc",
            "bin/oliphaunt-broker.exe",
        )),
        _ => None,
    }
}

fn native_manifest_for_target(target: &str) -> Option<(&'static str, &'static str)> {
    match target {
        "aarch64-unknown-linux-gnu" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_LIBOLIPHAUNT_NATIVE_LINUX_ARM64_GNU_MANIFEST",
            "aarch64-unknown-linux-gnu",
        )),
        "x86_64-unknown-linux-gnu" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_LIBOLIPHAUNT_NATIVE_LINUX_X64_GNU_MANIFEST",
            "x86_64-unknown-linux-gnu",
        )),
        "aarch64-apple-darwin" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_LIBOLIPHAUNT_NATIVE_MACOS_ARM64_MANIFEST",
            "aarch64-apple-darwin",
        )),
        "x86_64-pc-windows-msvc" => Some((
            "DEP_OLIPHAUNT_ARTIFACT_RELAY_LIBOLIPHAUNT_NATIVE_WINDOWS_X64_MSVC_MANIFEST",
            "x86_64-pc-windows-msvc",
        )),
        _ => None,
    }
}
EOF
  printf 'fn main() {}\n' >"$smoke/src/main.rs"
  run cargo check --manifest-path "$smoke/Cargo.toml" --offline
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
  run cargo check -p oliphaunt-build --locked --all-targets
  run_artifact_relay_build_script_tests
  exit 0
fi

if [ "$mode" = "regression" ]; then
  if ! oliphaunt_runtime_native_host_ready basic; then
    oliphaunt_runtime_native_host_diagnostics basic
    exit 1
  fi
  native_runtime_lock cargo test -p oliphaunt --locked \
    --test native_smoke \
    --test native_sql_regression \
    -- \
    --test-threads=1
  native_runtime_lock cargo test -p oliphaunt-native-tools-proof --locked -- --test-threads=1
  exit 0
fi

native_runtime_profile=""
case "$mode" in
  extension-regression)
    native_runtime_profile="extensions"
    ;;
  release-check|smoke-runtime|test-unit)
    native_runtime_profile="basic"
    ;;
esac

if [ -n "$native_runtime_profile" ]; then
  if oliphaunt_runtime_native_host_ready "$native_runtime_profile"; then
    native_runtime_ready=1
    echo "using existing native Oliphaunt runtime at $(oliphaunt_runtime_native_host_work_root)"
  elif [ -n "${OLIPHAUNT_REQUIRE_NATIVE:-}" ]; then
    oliphaunt_runtime_native_host_diagnostics "$native_runtime_profile"
    exit 1
  else
    echo "warning: native Oliphaunt runtime unavailable or incomplete; env-gated Rust SDK tests will skip" >&2
    oliphaunt_runtime_native_host_diagnostics "$native_runtime_profile"
  fi
fi

if [ "$mode" = "smoke-runtime" ]; then
  if [ "$native_runtime_ready" -ne 1 ]; then
    oliphaunt_runtime_native_host_diagnostics basic
    exit 1
  fi
  native_runtime_lock cargo test -p oliphaunt --locked \
    --test native_smoke \
    -- \
    --test-threads=1
  native_runtime_lock cargo test -p oliphaunt-native-tools-proof --locked -- --test-threads=1
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
  require_text src/sdks/rust/tests/public_api.rs "public_api_has_only_the_deliberate_native_vocabulary" \
    "Rust SDK tests must lock the minimal PostgreSQL-shaped API"
  run cargo test -p oliphaunt --doc --locked
  run cargo test -p oliphaunt-build --locked
  native_runtime_lock cargo nextest run -p oliphaunt --locked --profile ci --no-tests=fail --test-threads=1
  exit 0
fi

require_text src/sdks/rust/Cargo.toml 'license = "MIT"' \
  "Rust SDK source-only Cargo package must declare its MIT license truthfully"
require_text src/sdks/rust/crates/oliphaunt-build/Cargo.toml 'license = "MIT"' \
  "oliphaunt-build source-only Cargo package must declare its MIT license truthfully"

package_listing="$root/target/liboliphaunt-sdk-check/rust-cargo-package-list.txt"
mkdir -p "$(dirname "$package_listing")"
run tools/dev/bun.sh tools/release/prepare-rust-release-source.mjs
release_manifest="$root/target/release/cargo-package-sources/oliphaunt/Cargo.toml"
release_query_core="$root/target/release/cargo-package-sources/oliphaunt/src/query_core.rs"
if ! cmp -s src/shared/rust-query-core/query_core.rs "$release_query_core"; then
  echo "Rust SDK staged query core must exactly match src/shared/rust-query-core/query_core.rs" >&2
  exit 1
fi
printf '\n==> cargo package --manifest-path %s --allow-dirty --list\n' "$release_manifest"
cargo package --manifest-path "$release_manifest" --allow-dirty --list >"$package_listing"
cat "$package_listing"
for required in \
  Cargo.toml \
  build.rs \
  README.md \
  ARCHITECTURE.md \
  src/lib.rs \
  src/builder.rs \
  src/database.rs \
  src/direct.rs \
  src/session.rs \
  src/query_core.rs \
  src/query.rs \
  tests/public_api.rs \
  tests/sdk_extensions.rs \
  tests/native_smoke.rs \
  tests/native_sql_regression.rs \
  tests/native_extensions.rs \
  testdata/query-response-cases.json \
  testdata/structured-sql-cases.json \
  testdata/database-root.json \
  testdata/behavior-contract.json
do
  require_cargo_package_entry "$package_listing" "$required"
done
canonical_extension_smoke_count=0
for source_recipe in src/shared/fixtures/extensions/*.sql; do
  canonical_extension_smoke_count=$((canonical_extension_smoke_count + 1))
  require_cargo_package_entry \
    "$package_listing" \
    "tests/fixtures/extensions/$(basename "$source_recipe")"
done
packaged_extension_smoke_count="$(grep -Ec '^tests/fixtures/extensions/[^/]+\.sql$' "$package_listing" || true)"
if [ "$packaged_extension_smoke_count" -ne "$canonical_extension_smoke_count" ]; then
  echo "Rust SDK package must contain exactly the canonical extension smoke recipes: expected $canonical_extension_smoke_count, found $packaged_extension_smoke_count" >&2
  grep -E '^tests/fixtures/extensions/' "$package_listing" >&2 || true
  exit 1
fi
if git ls-files --error-unmatch src/sdks/rust/tests/fixtures/extensions/'*.sql' >/dev/null 2>&1; then
  echo "Rust SDK source must not commit package-local extension smoke copies; package them from src/shared/fixtures/extensions" >&2
  exit 1
fi
reject_cargo_package_entry_pattern "$package_listing" '^tests/fixtures/postgis-smoke\.sql$'
reject_cargo_package_entry_pattern "$package_listing" '^testdata/logical-tools([.-]|$)'
reject_cargo_package_entry_pattern "$package_listing" '^(target/|oliphaunt/|sdks/|src/bindings/wasix-rust/crates/oliphaunt-wasix/)'
reject_cargo_package_entry_pattern "$package_listing" '^src/(runtime_resources|bin/oliphaunt-(resources|extension-artifact|extension-index))'
reject_cargo_package_entry_pattern "$package_listing" '^crates/oliphaunt-build/'
reject_cargo_package_entry_pattern "$package_listing" '^(\.gitignore|moon.yml|release.toml|tools/)'

build_package_listing="$root/target/liboliphaunt-sdk-check/oliphaunt-build-cargo-package-list.txt"
printf '\n==> cargo package -p oliphaunt-build --locked --allow-dirty --list\n'
cargo package -p oliphaunt-build --locked --allow-dirty --list >"$build_package_listing"
cat "$build_package_listing"
for required in \
  Cargo.toml \
  README.md \
  src/lib.rs
do
  require_cargo_package_entry "$build_package_listing" "$required"
done
reject_cargo_package_entry_pattern "$build_package_listing" '^(target/|src/sdks/rust/src/|src/bindings/|src/runtimes/)'

require_text src/sdks/rust/tests/public_api.rs "public_api_has_only_the_deliberate_native_vocabulary" \
  "Rust SDK tests must lock the minimal PostgreSQL-shaped API"
require_text src/sdks/rust/tests/sdk_extensions.rs "public_extension_catalog_matches_generated_extension_selection_metadata" \
  "Rust SDK extension tests must lock public selection to generated metadata"
require_text src/sdks/rust/tests/sdk_extensions.rs "extension_selection_uses_exact_sql_names_without_aliases" \
  "Rust SDK extension tests must pin exact-name selection without aliases"
require_text src/sdks/rust/tests/native_smoke.rs "direct_query_transaction_backup_restore_and_process_ownership_when_available" \
  "Rust SDK native smoke tests must cover direct liboliphaunt process ownership"
require_text src/sdks/rust/tests/native_smoke.rs "server_supports_external_psql_and_pg_basebackup_when_available" \
  "Rust SDK native smoke tests must cover the standard external client and physical server backup path"
require_text src/sdks/rust/tests/native_sql_regression.rs "native_postgres_types_errors_and_transaction_recovery_when_available" \
  "Rust SDK regression tests must preserve PostgreSQL type, error, and recovery coverage"
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
run cargo test -p oliphaunt-build --locked
native_runtime_lock cargo nextest run -p oliphaunt --locked --profile ci --no-tests=fail --test-threads=1
