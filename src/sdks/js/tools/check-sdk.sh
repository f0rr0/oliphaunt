#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/tools/runtime/preflight.sh"

scratch_root_base="${OLIPHAUNT_SDK_CHECK_SCRATCH:-$root/target/liboliphaunt-sdk-check/oliphaunt-js}"
source_package_dir="src/sdks/js"
mode="${1:-release-check}"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_source_text() {
  file="$1"
  expected="$2"
  message="$3"
  if ! grep -Fq "$expected" "$file"; then
    echo "$message" >&2
    echo "expected '$expected' in $file" >&2
    exit 1
  fi
}

reject_source_text() {
  file="$1"
  rejected="$2"
  message="$3"
  if grep -Fq "$rejected" "$file"; then
    echo "$message" >&2
    echo "rejected '$rejected' in $file" >&2
    exit 1
  fi
}

prepare_package_worktree() {
  require rsync
  rm -rf "$package_dir"
  mkdir -p "$package_dir"
  cat >"$scratch_root/package.json" <<'JSON'
{
  "name": "oliphaunt-js-sdk-check-workspace",
  "private": true,
  "packageManager": "pnpm@11.5.0"
}
JSON
  cat >"$scratch_root/pnpm-workspace.yaml" <<'YAML'
packages:
  - "src/sdks/js"
  - "src/runtimes/liboliphaunt/native/packages/*"
  - "src/runtimes/liboliphaunt/native/tools-packages/*"
  - "src/runtimes/broker/packages/*"
  - "src/runtimes/node-direct/packages/*"
catalog:
  "@vitest/coverage-v8": ^4.1.8
  tsx: ^4.20.6
  typedoc: ^0.28.16
  typescript: ^5.9.3
  vitest: ^4.1.8
minimumReleaseAge: 1440
saveWorkspaceProtocol: rolling
updateNotifier: false
verifyDepsBeforeRun: false
confirmModulesPurge: false
autoInstallPeers: false

allowBuilds:
  core-js: false
  esbuild: true
  msgpackr-extract: true
  sharp: true
  unrs-resolver: true
YAML
  cp pnpm-lock.yaml "$scratch_root/pnpm-lock.yaml"
  cp LICENSE "$scratch_root/LICENSE"
  mkdir -p "$scratch_root/fixtures"
  mkdir -p "$scratch_root/tools/test"
  rsync -a --delete src/shared/fixtures/ "$scratch_root/fixtures/"
  rsync -a --delete tools/test/ "$scratch_root/tools/test/"
  mkdir -p "$scratch_root/src/runtimes/liboliphaunt/native/packages"
  rsync -a --delete \
    src/runtimes/liboliphaunt/native/packages/ \
    "$scratch_root/src/runtimes/liboliphaunt/native/packages/"
  mkdir -p "$scratch_root/src/runtimes/liboliphaunt/native/tools-packages"
  rsync -a --delete \
    src/runtimes/liboliphaunt/native/tools-packages/ \
    "$scratch_root/src/runtimes/liboliphaunt/native/tools-packages/"
  mkdir -p "$scratch_root/src/runtimes/broker/packages"
  rsync -a --delete \
    src/runtimes/broker/packages/ \
    "$scratch_root/src/runtimes/broker/packages/"
  mkdir -p "$scratch_root/src/runtimes/node-direct/packages"
  rsync -a --delete \
    src/runtimes/node-direct/packages/ \
    "$scratch_root/src/runtimes/node-direct/packages/"
  rsync -a --delete \
    --exclude node_modules \
    --exclude lib \
    "$source_package_dir/" "$package_dir/"
  rm -rf "$scratch_root/node_modules" "$package_dir/node_modules"
  run pnpm --dir "$scratch_root" install --frozen-lockfile --trust-lockfile
  if [ ! -e "$package_dir/node_modules" ]; then
    ln -s "$scratch_root/node_modules" "$package_dir/node_modules"
  fi
}

export_default_native_smoke_runtime() {
  oliphaunt_runtime_native_host_export_defaults
}

ensure_broker_smoke_helper() {
  if [ -n "${OLIPHAUNT_BROKER:-}" ]; then
    return
  fi
  require cargo
  run cargo build -p oliphaunt-broker --locked
  export_default_native_smoke_runtime
}

case "$mode" in
  check-static|test-unit|package-shape|smoke-runtime|regression|coverage|release-check)
    ;;
  --smoke)
    mode="smoke-runtime"
    ;;
  "")
    mode="release-check"
    ;;
  *)
    echo "usage: src/sdks/js/tools/check-sdk.sh [check-static|test-unit|package-shape|smoke-runtime|regression|coverage|release-check]" >&2
    exit 2
    ;;
esac

scratch_root="$scratch_root_base/$mode"
package_dir="$scratch_root/$source_package_dir"

require node
require pnpm
export CI="${CI:-1}"

if [ "$mode" = "coverage" ]; then
  exec tools/coverage/run-product oliphaunt-js
fi

prepare_package_worktree
if [ "$mode" = "test-unit" ]; then
  run pnpm --dir "$package_dir" test --if-present
  exit 0
fi

run pnpm --dir "$package_dir" run build
if [ "$mode" != "package-shape" ]; then
  run pnpm --dir "$package_dir" run typecheck
fi
if [ "$mode" = "release-check" ] || [ "$mode" = "regression" ]; then
  run pnpm --dir "$package_dir" test --if-present
fi

if [ "$mode" != "check-static" ]; then
  pack_dir="$(mktemp -d "$scratch_root/pack.XXXXXX")"
  pack_json="$(pnpm --dir "$package_dir" pack --pack-destination "$pack_dir" --json)"
  printf '%s\n' "$pack_json"
  pack_file="$(
    PACK_JSON="$pack_json" PACK_DIR="$pack_dir" node -e "
const manifest = JSON.parse(process.env.PACK_JSON || '{}');
if (!manifest.filename || !manifest.filename.endsWith('.tgz')) {
  throw new Error('pnpm pack did not report a .tgz filename');
}
const path = require('node:path');
console.log(path.isAbsolute(manifest.filename) ? manifest.filename : path.join(process.env.PACK_DIR || '', manifest.filename));
"
  )"
  tar -xOf "$pack_file" package/package.json | node -e "
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const pkg = JSON.parse(input);
  const source = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const liboliphauntVersion = source.oliphaunt && source.oliphaunt.liboliphauntVersion;
  const brokerVersion = source.oliphaunt && source.oliphaunt.brokerVersion;
  const nodeDirectVersion = source.oliphaunt && source.oliphaunt.nodeDirectAddonVersion;
  if (typeof liboliphauntVersion !== 'string' || liboliphauntVersion.length === 0) {
    throw new Error('source TypeScript package must pin oliphaunt.liboliphauntVersion');
  }
  if (typeof brokerVersion !== 'string' || brokerVersion.length === 0) {
    throw new Error('source TypeScript package must pin oliphaunt.brokerVersion');
  }
  if (typeof nodeDirectVersion !== 'string' || nodeDirectVersion.length === 0) {
    throw new Error('source TypeScript package must pin oliphaunt.nodeDirectAddonVersion');
  }
  const expectedDependencies = {};
  const expectedOptional = {
    '@oliphaunt/broker-darwin-arm64': brokerVersion,
    '@oliphaunt/broker-linux-arm64-gnu': brokerVersion,
    '@oliphaunt/broker-linux-x64-gnu': brokerVersion,
    '@oliphaunt/broker-win32-x64-msvc': brokerVersion,
    '@oliphaunt/liboliphaunt-darwin-arm64': liboliphauntVersion,
    '@oliphaunt/liboliphaunt-linux-arm64-gnu': liboliphauntVersion,
    '@oliphaunt/liboliphaunt-linux-x64-gnu': liboliphauntVersion,
    '@oliphaunt/liboliphaunt-win32-x64-msvc': liboliphauntVersion,
    '@oliphaunt/node-direct-darwin-arm64': nodeDirectVersion,
    '@oliphaunt/node-direct-linux-arm64-gnu': nodeDirectVersion,
    '@oliphaunt/node-direct-linux-x64-gnu': nodeDirectVersion,
    '@oliphaunt/node-direct-win32-x64-msvc': nodeDirectVersion,
    '@oliphaunt/tools-darwin-arm64': liboliphauntVersion,
    '@oliphaunt/tools-linux-arm64-gnu': liboliphauntVersion,
    '@oliphaunt/tools-linux-x64-gnu': liboliphauntVersion,
    '@oliphaunt/tools-win32-x64-msvc': liboliphauntVersion,
  };
  if (JSON.stringify(pkg.dependencies || {}) !== JSON.stringify(expectedDependencies)) {
    throw new Error('packed TypeScript package must not declare regular runtime artifact dependencies');
  }
  if (JSON.stringify(pkg.optionalDependencies || {}) !== JSON.stringify(expectedOptional)) {
    throw new Error('packed TypeScript package must rewrite runtime optional dependencies to exact published versions');
  }
  for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (pkg.scripts && Object.hasOwn(pkg.scripts, scriptName)) {
      throw new Error('packed TypeScript package must not run consumer install lifecycle script ' + scriptName);
    }
  }
});
" "$package_dir/package.json"
  if [ "$mode" != "package-shape" ] && [ "${OLIPHAUNT_JS_SKIP_REGISTRY_DRY_RUN:-0}" != "1" ]; then
    run pnpm --dir "$package_dir" exec jsr publish --dry-run --allow-dirty
  fi
  if [ "$mode" != "package-shape" ]; then
    cat >"$package_dir/.oliphaunt-bun-smoke.ts" <<'TS'
import { Oliphaunt, createBunNativeBinding, simpleQuery } from './lib/index.js';

const bytes: Uint8Array = simpleQuery('SELECT 1');
if (bytes.byteLength === 0) {
  throw new Error('empty protocol frame');
}
if (typeof Oliphaunt.supportedModes !== 'function') {
  throw new Error('missing Oliphaunt.supportedModes');
}
if (typeof createBunNativeBinding !== 'function') {
  throw new Error('missing Bun native binding export');
}
TS
    run "$root/tools/dev/bun.sh" "$package_dir/.oliphaunt-bun-smoke.ts"
    rm -f "$package_dir/.oliphaunt-bun-smoke.ts"
    cat >"$package_dir/.oliphaunt-deno-smoke.ts" <<'TS'
import { Oliphaunt, createDenoNativeBinding, simpleQuery } from './lib/index.js';

const bytes: Uint8Array = simpleQuery('SELECT 1');
if (bytes.byteLength === 0) {
  throw new Error('empty protocol frame');
}
if (typeof Oliphaunt.supportedModes !== 'function') {
  throw new Error('missing Oliphaunt.supportedModes');
}
if (typeof createDenoNativeBinding !== 'function') {
  throw new Error('missing Deno native binding export');
}
if (typeof Deno.version.deno !== 'string') {
  throw new Error('Deno runtime metadata missing');
}
TS
    run "$root/tools/dev/deno.sh" run --allow-read --allow-env "$package_dir/.oliphaunt-deno-smoke.ts"
    rm -f "$package_dir/.oliphaunt-deno-smoke.ts"
  fi
fi

if [ "$mode" = "package-shape" ]; then
  rm -rf "$package_dir/node_modules"
  find "$package_dir" -path "*/node_modules" -prune -exec rm -rf {} +
  exit 0
fi

base64_runtime_hits="$(
  if command -v rg >/dev/null 2>&1; then
    rg -n -i --glob '!**/README.md' --glob '!**/node_modules/**' \
      --glob '!**/__tests__/**' \
      'base64|atob|btoa' \
      "$package_dir/src" \
      "$package_dir/package.json" || true
  else
    grep -RInE 'base64|atob|btoa' "$package_dir/src" "$package_dir/package.json" 2>/dev/null |
      grep -Ev '(/README\.md|/node_modules/|/__tests__/)' || true
  fi
)"
if [ -n "$base64_runtime_hits" ]; then
  echo "TypeScript SDK runtime must keep protocol bytes as Uint8Array, not base64:" >&2
  echo "$base64_runtime_hits" >&2
  exit 1
fi

runtime_download_hits="$(
  if command -v rg >/dev/null 2>&1; then
    rg -n --glob '!**/__tests__/**' \
      'fetch\(|releases/download|ReleaseAssetUrl|ReleaseTarget|OLIPHAUNT_.*ASSET_DIR|OLIPHAUNT_.*RELEASE_BASE_URL|CACHE_DIR' \
      "$package_dir/src/native" \
      "$package_dir/src/runtime/broker.ts" || true
  else
    grep -RInE 'fetch\(|releases/download|ReleaseAssetUrl|ReleaseTarget|OLIPHAUNT_.*ASSET_DIR|OLIPHAUNT_.*RELEASE_BASE_URL|CACHE_DIR' \
      "$package_dir/src/native" "$package_dir/src/runtime/broker.ts" 2>/dev/null || true
  fi
)"
if [ -n "$runtime_download_hits" ]; then
  echo "TypeScript SDK runtime must resolve native artifacts from installed packages, not runtime downloads:" >&2
  echo "$runtime_download_hits" >&2
  exit 1
fi

require_source_text "$package_dir/package.json" '"./node"' \
  "TypeScript SDK package exports must include an explicit Node entrypoint"
require_source_text "$package_dir/package.json" '"./bun"' \
  "TypeScript SDK package exports must include an explicit Bun entrypoint"
require_source_text "$package_dir/package.json" '"./deno"' \
  "TypeScript SDK package exports must include an explicit Deno entrypoint"
require_source_text "$package_dir/package.json" '"liboliphauntVersion"' \
  "TypeScript SDK package metadata must pin the compatible liboliphaunt release"
require_source_text "$package_dir/package.json" '"brokerVersion"' \
  "TypeScript SDK package metadata must pin the compatible Rust broker helper release"
require_source_text "$package_dir/package.json" '"nodeDirectAddon"' \
  "TypeScript SDK package metadata must pin the compatible Node.js native-direct adapter release"
node -e "
const pkg = require(process.argv[1]);
const expectedDependencies = {};
const expectedOptional = [
  '@oliphaunt/broker-darwin-arm64',
  '@oliphaunt/broker-linux-arm64-gnu',
  '@oliphaunt/broker-linux-x64-gnu',
  '@oliphaunt/broker-win32-x64-msvc',
  '@oliphaunt/liboliphaunt-darwin-arm64',
  '@oliphaunt/liboliphaunt-linux-arm64-gnu',
  '@oliphaunt/liboliphaunt-linux-x64-gnu',
  '@oliphaunt/liboliphaunt-win32-x64-msvc',
  '@oliphaunt/node-direct-darwin-arm64',
  '@oliphaunt/node-direct-linux-arm64-gnu',
  '@oliphaunt/node-direct-linux-x64-gnu',
  '@oliphaunt/node-direct-win32-x64-msvc',
  '@oliphaunt/tools-darwin-arm64',
  '@oliphaunt/tools-linux-arm64-gnu',
  '@oliphaunt/tools-linux-x64-gnu',
  '@oliphaunt/tools-win32-x64-msvc',
];
const optional = Object.keys(pkg.optionalDependencies || {}).sort();
if (
  JSON.stringify(pkg.dependencies || {}) !== JSON.stringify(expectedDependencies) ||
  JSON.stringify(optional) !== JSON.stringify(expectedOptional.sort())
) {
  throw new Error('TypeScript SDK installs must declare only platform-selected runtime packages');
}
" "$package_dir/package.json"
require_source_text "$package_dir/jsr.json" '".": "./src/jsr.ts"' \
  "TypeScript SDK must publish a protocol-only JSR root entrypoint"
reject_source_text "$package_dir/jsr.json" '"./deno"' \
  "TypeScript SDK JSR package must not expose native runtime entrypoints"
require_source_text "$package_dir/src/native/node.ts" "loadNodeDirectAddon" \
  "TypeScript Node native-direct binding must load the Oliphaunt-owned prebuilt Node-API adapter"
require_source_text "$package_dir/src/client.ts" "defaultEngineForRuntime(runtime: JavaScriptRuntime" \
  "TypeScript SDK must make the default engine explicit"
require_source_text "$package_dir/src/client.ts" "case 'node':" \
  "TypeScript SDK must treat Node.js consistently in default engine selection"
require_source_text "$package_dir/src/client.ts" "return 'nativeDirect'" \
  "TypeScript SDK must default Node.js, Bun, and Deno to nativeDirect"
require_source_text "$package_dir/src/client.ts" "restorePhysicalArchiveWithBroker" \
  "TypeScript SDK must keep explicit broker restore support separate from nativeDirect defaults"
require_source_text "$package_dir/src/native/common.ts" "liboliphauntPackageTarget" \
  "TypeScript SDK must select the compatible liboliphaunt platform package"
require_source_text "$package_dir/src/native/assets-node.ts" "runtimeRelativePath" \
  "TypeScript Node/Bun native binding must resolve runtime resources from the selected liboliphaunt package"
require_source_text "$package_dir/src/native/assets-node.ts" "publishRuntimeCache" \
  "TypeScript Node/Bun native binding must publish package-managed runtime caches through a staged cache root"
require_source_text "$package_dir/src/native/assets-node.ts" "withRuntimeCacheLock" \
  "TypeScript Node/Bun native binding must serialize package-managed runtime cache publication"
require_source_text "$package_dir/src/native/assets-node.ts" ".build-" \
  "TypeScript Node/Bun native binding must build package-managed runtime caches outside the live root"
require_source_text "$package_dir/src/native/node-addon.ts" "oliphaunt-node-direct" \
  "TypeScript Node native-direct binding must resolve the installed prebuilt Node-API adapter package"
require_source_text "$root/src/runtimes/node-direct/tools/build-node-addon.sh" "oliphaunt-node-direct-\$version-\$target.tar.gz" \
  "Node direct runtime must package the prebuilt Node.js native-direct adapter as a release asset"
require_source_text "$root/tools/release/release.py" "ensure_node_direct_release_assets" \
  "Node direct release dry-run must validate staged Node.js native-direct adapter release assets"
require_source_text "$root/tools/release/release.py" "node_direct_optional_npm_tarballs" \
  "Node direct release dry-run must validate staged optional npm tarballs from builder jobs"
require_source_text "$package_dir/src/native/assets-deno.ts" "runtimeRelativePath" \
  "TypeScript Deno native binding must resolve runtime resources from the selected liboliphaunt package"
require_source_text "$package_dir/src/native/assets-deno.ts" "target.toolsPackageName" \
  "TypeScript Deno native binding must resolve the split oliphaunt-tools package"
require_source_text "$package_dir/src/native/assets-deno.ts" "materializeDenoToolsRuntime" \
  "TypeScript Deno native binding must merge liboliphaunt and oliphaunt-tools runtime trees"
require_source_text "$package_dir/src/native/assets-deno.ts" "nativeClientToolsForTarget" \
  "TypeScript Deno native binding must validate pg_dump and psql in the split tools package"
require_source_text "$package_dir/src/native/assets-deno.ts" "publishDenoRuntimeCache" \
  "TypeScript Deno native binding must publish package-managed runtime caches through a staged cache root"
require_source_text "$package_dir/src/native/assets-deno.ts" "withDenoRuntimeCacheLock" \
  "TypeScript Deno native binding must serialize package-managed runtime cache publication"
require_source_text "$package_dir/src/native/assets-deno.ts" ".build-" \
  "TypeScript Deno native binding must build package-managed runtime caches outside the live root"
require_source_text "$package_dir/src/native/assets-deno.ts" "deno.rename" \
  "TypeScript Deno native binding must install finished runtime caches with runtime-owned rename"
require_source_text "$package_dir/src/native/deno.ts" "install.packageManaged" \
  "TypeScript Deno nativeDirect must reject registry-managed extension materialization until it has a dedicated resolver"
require_source_text "$package_dir/src/native/extension-runtime.ts" "validatePreparedRuntimeExtensions" \
  "TypeScript native bindings must share prepared runtimeDirectory extension validation"
require_source_text "$package_dir/src/native/assets-deno.ts" "validatePreparedDenoRuntimeExtensions" \
  "TypeScript Deno native binding must validate explicit prepared runtimeDirectory extension files"
require_source_text "$package_dir/src/runtime/broker.ts" "Deno nativeBroker explicit runtimeDirectory" \
  "TypeScript Deno nativeBroker must validate explicit prepared runtimeDirectory extension files"
require_source_text "$package_dir/src/runtime/server.ts" "resolveDenoNativeInstall" \
  "TypeScript Deno nativeServer must resolve package-managed server tools through the Deno native resolver"
require_source_text "$package_dir/src/runtime/server.ts" "Deno nativeServer does not automatically materialize extension packages" \
  "TypeScript Deno nativeServer must fail clearly for registry-managed extension materialization"
require_source_text "$package_dir/src/runtime/broker.ts" "Deno nativeBroker does not automatically materialize extension packages" \
  "TypeScript Deno nativeBroker must fail clearly for registry-managed extension materialization"
require_source_text "$package_dir/src/runtime/broker.ts" "brokerNativeInstallEnv(nativeInstall)" \
  "TypeScript nativeBroker restore must pass the resolved native install environment"
require_source_text "$package_dir/src/runtime/server.ts" "requireServerClientTools" \
  "TypeScript nativeServer must preflight split client tools"
require_source_text "$package_dir/src/runtime/server.ts" "requireTool(toolDirectory, 'psql')" \
  "TypeScript nativeServer must validate psql alongside pg_dump"
require_source_text "$package_dir/src/native/tar.ts" "extractTarArchive" \
  "TypeScript SDK must extract verified liboliphaunt release assets without shelling out"
require_source_text "$package_dir/src/client.ts" "supportedModes(options: SupportedModesOptions = {}): Promise<EngineModeSupport[]>" \
  "TypeScript SDK must expose mode support discovery"
require_source_text "$package_dir/src/client.ts" "async transaction<T>" \
  "TypeScript SDK must expose the transaction helper"
require_source_text "$package_dir/src/client.ts" "async checkpoint(): Promise<void>" \
  "TypeScript SDK must expose checkpoint"
require_source_text "$package_dir/src/config.ts" "pgdata: join(resolvedRoot, 'pgdata')" \
  "TypeScript SDK roots must use the shared Oliphaunt root/pgdata layout"
require_source_text "$package_dir/src/config.ts" "generatedExtensionBySqlName(trimmed)" \
  "TypeScript SDK must validate selected extensions against the generated extension catalog"
require_source_text "$package_dir/src/config.ts" "unknown Oliphaunt extension id" \
  "TypeScript SDK must fail clearly for unknown selected extensions"
require_source_text "$package_dir/src/native/extension-runtime.ts" "metadata.selectedExtensionDependencies" \
  "TypeScript native extension materialization must use generated package-materialization dependencies"
require_source_text "$package_dir/src/types.ts" "backupFormats: BackupFormat[]" \
  "TypeScript SDK capabilities must expose backup formats"
require_source_text "$package_dir/src/types.ts" "restoreFormats: BackupFormat[]" \
  "TypeScript SDK capabilities must expose restore formats"
require_source_text "$package_dir/src/query.ts" "function validateUtf8(bytes: Uint8Array, label: string): void" \
  "TypeScript SDK query parser must reject malformed backend UTF-8"
require_source_text "$package_dir/src/__tests__/protocol-fixtures.test.ts" "query-response-cases.json" \
  "TypeScript SDK tests must consume the shared protocol fixture corpus"
require_source_text "$package_dir/src/__tests__/broker-frames.test.ts" "encodeBrokerRequest" \
  "TypeScript SDK tests must cover the native broker frame codec"
require_source_text "$package_dir/src/__tests__/server-wire.test.ts" "encodeStartupMessage" \
  "TypeScript SDK tests must cover the native server wire client"
require_source_text "$package_dir/src/__tests__/physical-archive.test.ts" "createPhysicalArchive" \
  "TypeScript SDK tests must cover native server physical archive backup assembly"
require_source_text "$package_dir/src/__tests__/asset-resolver.test.ts" "nodeResolverUsesInstalledPackages" \
  "TypeScript SDK tests must cover package-local liboliphaunt resolution"
require_source_text "$package_dir/src/__tests__/asset-resolver.test.ts" "typeScriptPackageMetadataMatchesRuntimePackages" \
  "TypeScript SDK tests must cover runtime package metadata"
require_source_text "$package_dir/src/__tests__/native-smoke.ts" "smokeMode('nativeBroker'" \
  "TypeScript SDK smoke must execute native broker mode when OLIPHAUNT_BROKER is set"
require_source_text "$package_dir/src/__tests__/native-smoke.ts" "smokeMode('nativeServer'" \
  "TypeScript SDK smoke must execute native server mode when OLIPHAUNT_POSTGRES is set"
require_source_text "$package_dir/src/__tests__/native-smoke.ts" "restoreSmokeBackup" \
  "TypeScript SDK smoke must restore physical backup artifacts and reopen restored roots"
require_source_text "$package_dir/src/runtime/broker.ts" "resolveBrokerNativeInstall" \
  "TypeScript broker mode must resolve the same liboliphaunt native install that direct mode uses"
require_source_text "$package_dir/src/runtime/broker.ts" "OLIPHAUNT_INSTALL_DIR" \
  "TypeScript broker mode must pass the resolved PostgreSQL runtime tree to the Rust helper"
require_source_text "$package_dir/src/runtime/broker.ts" "LIBOLIPHAUNT_PATH" \
  "TypeScript broker mode must pass the resolved liboliphaunt library to the Rust helper"
require_source_text "$package_dir/src/runtime/broker.ts" "packageBrokerExecutable" \
  "TypeScript broker mode must resolve the installed Rust broker helper package"
require_source_text "$package_dir/src/runtime/broker.ts" "restorePhysicalArchiveWithBroker" \
  "TypeScript broker helper must restore physical archives without requiring a Node native FFI dependency"
require_source_text "$package_dir/tools/check-sdk.sh" "export_default_native_smoke_runtime" \
  "TypeScript SDK smoke must discover native artifacts produced by the liboliphaunt smoke dependency"
require_source_text "$package_dir/tools/check-sdk.sh" "cargo build -p oliphaunt-broker --locked" \
  "TypeScript SDK smoke must build the broker helper when the default artifact is missing"

if [ "$mode" = "check-static" ] || [ "$mode" = "package-shape" ]; then
  exit 0
fi

if [ "$mode" = "smoke-runtime" ]; then
  export_default_native_smoke_runtime
  ensure_broker_smoke_helper
  oliphaunt_runtime_native_host_require basic
  if [ -z "${OLIPHAUNT_BROKER:-}" ]; then
    echo "OLIPHAUNT_BROKER is required for the TypeScript SDK native broker smoke check" >&2
    exit 2
  fi
  if [ -z "${OLIPHAUNT_POSTGRES:-}" ]; then
    echo "OLIPHAUNT_POSTGRES is required for the TypeScript SDK native server smoke check" >&2
    exit 2
  fi
  run pnpm --dir "$package_dir" exec tsx src/__tests__/native-smoke.ts
fi
