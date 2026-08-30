#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$workspace_root"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command cargo
require_command git
require_command node
require_command pnpm

host_system="$(uname -s)"
host_machine="$(uname -m)"
if [[ "$host_system" == "Linux" ]]; then
  linux_libc="$(node src/runtimes/wasix-napi/tools/detect-linux-libc.mjs)"
  case "$linux_libc" in
    glibc) ;;
    musl)
      echo "WASIX N-API native addons do not support Linux musl; use a glibc build host" >&2
      exit 2
      ;;
    *)
      echo "WASIX N-API could not verify that this Linux build host uses glibc" >&2
      exit 2
      ;;
  esac
fi

target_id="${1:-${OLIPHAUNT_WASIX_NAPI_TARGET:-}}"
if [[ -z "$target_id" ]]; then
  case "$host_system:$host_machine" in
    Darwin:arm64|Darwin:aarch64) target_id="macos-arm64" ;;
    Linux:x86_64|Linux:amd64) target_id="linux-x64-gnu" ;;
    Linux:arm64|Linux:aarch64) target_id="linux-arm64-gnu" ;;
    MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) target_id="windows-x64-msvc" ;;
    *)
      echo "unsupported WASIX N-API host: $(uname -s)/$(uname -m)" >&2
      exit 2
      ;;
  esac
fi

case "$target_id" in
  macos-arm64)
    cargo_target="aarch64-apple-darwin"
    library_name="liboliphaunt_wasix_napi.dylib"
    ;;
  linux-arm64-gnu)
    cargo_target="aarch64-unknown-linux-gnu"
    library_name="liboliphaunt_wasix_napi.so"
    ;;
  linux-x64-gnu)
    cargo_target="x86_64-unknown-linux-gnu"
    library_name="liboliphaunt_wasix_napi.so"
    ;;
  windows-x64-msvc)
    cargo_target="x86_64-pc-windows-msvc"
    library_name="oliphaunt_wasix_napi.dll"
    ;;
  *)
    echo "unsupported WASIX N-API target: $target_id" >&2
    exit 2
    ;;
esac

source_sha="$(git rev-parse HEAD)"
artifact_source_sha="${OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA:-$source_sha}"
if [[ ! "$artifact_source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA must be a lowercase 40-character Git SHA" >&2
  exit 2
fi

manifest="src/runtimes/wasix-napi/Cargo.toml"
package_manifest="src/runtimes/wasix-napi/package.json"
metadata_contract="$(node - "$package_manifest" <<'JS'
const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
const values = [
  manifest.oliphaunt?.runtimeVersion,
  manifest.oliphaunt?.addonAbiVersion,
  manifest.oliphaunt?.nodeApiVersion,
];
if (
  !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(values[0] ?? "")
  || !Number.isSafeInteger(values[1])
  || !Number.isSafeInteger(values[2])
) {
  throw new Error("WASIX N-API package metadata has an invalid runtime/ABI contract");
}
process.stdout.write(values.join("\t"));
JS
)"
IFS=$'\t' read -r expected_runtime_version expected_addon_abi expected_node_api <<< "$metadata_contract"
product_target_root="${OLIPHAUNT_WASIX_NAPI_BUILD_ROOT:-$workspace_root/target/oliphaunt-wasix-napi}"
prebuild_dir="$product_target_root/prebuilds/$target_id"
cargo_target_dir="$product_target_root/cargo-release"
build_inputs_file="$product_target_root/build-inputs/$target_id.json"
mkdir -p "$prebuild_dir"

# Release addons must consume the exact portable runtime, target AOT, exact
# extension, and ICU payloads staged by the same CI run. Export the canonical
# dependency build-script variables explicitly so no source-only fallback can
# be selected through a package-local or stale workspace probe.
export OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR="${OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR:-$workspace_root/target/oliphaunt-wasix/assets}"
export OLIPHAUNT_WASM_GENERATED_AOT_DIR="${OLIPHAUNT_WASM_GENERATED_AOT_DIR:-$workspace_root/target/oliphaunt-wasix/aot}"
export OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT="${OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT:-$workspace_root/target/extension-artifacts}"
export OLIPHAUNT_ICU_DATA_DIR="${OLIPHAUNT_ICU_DATA_DIR:-$workspace_root/target/oliphaunt-wasix/wasix-build/work/icu-wasix/share/icu}"
export OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD=1
export OLIPHAUNT_WASIX_NAPI_BUILD_INPUTS="$build_inputs_file"

build_input_args=(
  --target "$target_id"
  --target-triple "$cargo_target"
  --portable-root "$OLIPHAUNT_WASIX_GENERATED_ASSETS_DIR"
  --aot-root "$OLIPHAUNT_WASM_GENERATED_AOT_DIR"
  --extension-root "$OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT"
  --icu-root "$OLIPHAUNT_ICU_DATA_DIR"
)
tools/dev/bun.sh src/runtimes/wasix-napi/tools/check-build-inputs.mjs \
  "${build_input_args[@]}" \
  --output "$build_inputs_file"

# Release profile environment variables work whether the crate is built as a
# workspace member or through its manifest directly.
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_STRIP=symbols

build_addon() {
  local output="$1"

  echo "building WASIX N-API addon for $target_id ($cargo_target)"
  if [[ "$target_id" == linux-*-gnu ]]; then
    tools/release/build-linux-wasix-napi-baseline.sh \
      "$cargo_target_dir" \
      "$cargo_target" \
      release
  else
    CARGO_TARGET_DIR="$cargo_target_dir" cargo build \
      --locked \
      --manifest-path "$manifest" \
      --target "$cargo_target" \
      --release \
      --no-default-features \
      --features release
  fi

  local library="$cargo_target_dir/$cargo_target/release/$library_name"
  if [[ ! -f "$library" ]]; then
    echo "Cargo did not produce expected addon library: $library" >&2
    exit 1
  fi
  cp "$library" "$output"
}

addon="$prebuild_dir/oliphaunt_wasix_napi.node"
build_addon "$addon"

# Recompute the complete input inventory after compilation so packaging
# cannot attest to payloads that changed during compilation.
tools/dev/bun.sh src/runtimes/wasix-napi/tools/check-build-inputs.mjs \
  "${build_input_args[@]}" \
  --check "$build_inputs_file"

# Loading a foreign-target addon is impossible. For a host build, validate the
# complete stable N-API contract before it can be packaged.
host_target=""
case "$host_system:$host_machine" in
  Darwin:arm64|Darwin:aarch64) host_target="macos-arm64" ;;
  Linux:x86_64|Linux:amd64) host_target="linux-x64-gnu" ;;
  Linux:arm64|Linux:aarch64) host_target="linux-arm64-gnu" ;;
  MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64) host_target="windows-x64-msvc" ;;
esac
if [[ "$target_id" == "$host_target" ]]; then
  node - \
    "$addon" \
    "$expected_runtime_version" \
    "$expected_addon_abi" \
    "$expected_node_api" \
    "$build_inputs_file" <<'JS'
const { readFileSync, statSync } = require("node:fs");
const { resolve } = require("node:path");

const [addonPath, expectedRuntime, expectedAbiRaw, expectedNodeApiRaw, buildInputsPath] =
  process.argv.slice(2);
const expectedAbi = Number(expectedAbiRaw);
const expectedNodeApi = Number(expectedNodeApiRaw);
const buildInputs = JSON.parse(readFileSync(buildInputsPath, "utf8"));
const expectedFunctions = [
  "addonAbiVersion",
  "extensionIdentity",
  "nodeApiVersion",
  "payloadIdentity",
  "restore",
  "restoreDirect",
  "runtimeVersion",
  "supportedProfiles",
  "toolIdentity",
];
const expectedDatabaseMethods = [
  "backup",
  "close",
  "execProtocolRaw",
  "execProtocolRawStream",
  "pgDump",
  "psql",
];
const expectedServerMethods = ["close"];
const addon = require(addonPath);
for (const name of expectedFunctions) {
  if (typeof addon[name] !== "function") {
    throw new Error(`${addonPath} is missing function export ${name}`);
  }
}
if (
  addon.addonAbiVersion() !== expectedAbi
  || addon.nodeApiVersion() !== expectedNodeApi
  || addon.runtimeVersion() !== expectedRuntime
  || JSON.stringify(addon.supportedProfiles()) !== JSON.stringify(["standard", "icu"])
) {
  throw new Error(`${addonPath} reports an incompatible ABI/runtime/profile contract`);
}

function expectedIdentity(record, kind) {
  if (
    typeof record?.path !== "string"
    || !/^[0-9a-f]{64}$/.test(record?.sha256 ?? "")
  ) {
    throw new Error(`${buildInputsPath} has an invalid ${kind} record`);
  }
  const size = statSync(resolve(record.path)).size;
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error(`${record.path} has an invalid ${kind} size: ${size}`);
  }
  return `${record.sha256}:${size}`;
}

const portableTools = buildInputs.inputs?.portableTools;
if (
  buildInputs.schema !== "oliphaunt-wasix-napi-build-inputs-v1"
  || JSON.stringify(portableTools?.map(({ name }) => name)) !== JSON.stringify(["pg_dump", "psql"])
) {
  throw new Error(`${buildInputsPath} has an incompatible portable tool inventory`);
}
for (const tool of portableTools) {
  const actual = addon.toolIdentity(tool.name);
  const expected = expectedIdentity(tool, `${tool.name} tool`);
  if (actual !== expected) {
    throw new Error(`${addonPath} reports ${tool.name} tool identity ${actual}; expected ${expected}`);
  }
}

const portableExtensions = (buildInputs.inputs?.extensionArtifacts ?? [])
  .flatMap(({ portableArchives = [] }) => portableArchives);
const extensionNames = portableExtensions.map(({ sqlName }) => sqlName);
if (
  extensionNames.length === 0
  || extensionNames.some((name) => typeof name !== "string" || name.length === 0)
  || new Set(extensionNames).size !== extensionNames.length
) {
  throw new Error(`${buildInputsPath} has an invalid portable extension inventory`);
}
for (const extension of portableExtensions) {
  const actual = addon.extensionIdentity(extension.sqlName);
  const expected = expectedIdentity(extension, `${extension.sqlName} extension`);
  if (actual !== expected) {
    throw new Error(
      `${addonPath} reports ${extension.sqlName} extension identity ${actual}; expected ${expected}`,
    );
  }
}
for (const component of [
  "runtimeArchive",
  "standardSeedArchive",
  "standardSeedManifest",
  "icuDataArchive",
  "icuSeedArchive",
  "icuSeedManifest",
]) {
  const identity = addon.payloadIdentity(component);
  if (!/^[0-9a-f]{64}:[1-9][0-9]*$/.test(identity)) {
    throw new Error(`${addonPath} reports an invalid ${component} identity: ${identity}`);
  }
}
for (const constructor of ["NativeWasixActorDatabase", "NativeWasixDatabase"]) {
  if (typeof addon[constructor]?.open !== "function") {
    throw new Error(`${addonPath} is missing ${constructor}.open`);
  }
  for (const name of expectedDatabaseMethods) {
    if (typeof addon[constructor].prototype[name] !== "function") {
      throw new Error(`${addonPath} is missing ${constructor}.prototype.${name}`);
    }
  }
}
if (typeof addon.NativeWasixServer?.open !== "function") {
  throw new Error(`${addonPath} is missing NativeWasixServer.open`);
}
for (const name of expectedServerMethods) {
  if (typeof addon.NativeWasixServer.prototype[name] !== "function") {
    throw new Error(`${addonPath} is missing NativeWasixServer.prototype.${name}`);
  }
}
JS
fi

OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA="$artifact_source_sha" \
  node src/runtimes/wasix-napi/tools/package-platform.mjs \
  --target "$target_id" \
  --prebuild-dir "$prebuild_dir" \
  --build-inputs "$build_inputs_file"

# Exercise the packed carrier, never the build directory. Node covers both
# supported clean-install clients; every host then loads the same target addon
# through its own Node-API implementation. Electron also exercises the
# production ASAR-unpacked layout while remaining display-server-independent.
for runtime_and_manager in \
  "node npm" \
  "node pnpm" \
  "bun pnpm" \
  "deno pnpm" \
  "electron pnpm"; do
  read -r smoke_runtime smoke_package_manager <<< "$runtime_and_manager"
  node src/runtimes/wasix-napi/tools/smoke-packaged-addon.mjs \
    --target "$target_id" \
    --runtime "$smoke_runtime" \
    --package-manager "$smoke_package_manager"
done

printf 'WASIX N-API addon: %s\n' "$addon"
