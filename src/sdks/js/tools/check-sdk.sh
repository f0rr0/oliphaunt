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
  run node "$root/tools/dev/write-scoped-pnpm-workspace.mjs" \
    --source "$root/pnpm-workspace.yaml" \
    --output "$scratch_root/pnpm-workspace.yaml" \
    --package "src/sdks/js" \
    --package "src/runtimes/liboliphaunt/native/packages/*" \
    --package "src/runtimes/broker/packages/*" \
    --package "src/runtimes/node-direct/packages/*"
  cp pnpm-lock.yaml "$scratch_root/pnpm-lock.yaml"
  cp LICENSE "$scratch_root/LICENSE"
  mkdir -p "$scratch_root/src/shared/fixtures"
  mkdir -p "$scratch_root/src/shared/cluster-seed-contract/fixtures"
  mkdir -p "$scratch_root/src/shared/js-core/test"
  mkdir -p "$scratch_root/tools/dev"
  mkdir -p "$scratch_root/tools/test"
  rsync -a --delete src/shared/fixtures/ "$scratch_root/src/shared/fixtures/"
  rsync -a --delete \
    src/shared/cluster-seed-contract/fixtures/ \
    "$scratch_root/src/shared/cluster-seed-contract/fixtures/"
  cp src/shared/js-core/test/protocol-fixtures.mjs \
    src/shared/js-core/test/protocol-fixtures.d.mts \
    "$scratch_root/src/shared/js-core/test/"
  cp "$root/tools/dev/clean-package-lib.mjs" "$scratch_root/tools/dev/clean-package-lib.mjs"
  cp "$root/tools/test/run-js-tests.mjs" "$scratch_root/tools/test/run-js-tests.mjs"
  mkdir -p "$scratch_root/src/runtimes/liboliphaunt/native/packages"
  rsync -a --delete \
    src/runtimes/liboliphaunt/native/packages/ \
    "$scratch_root/src/runtimes/liboliphaunt/native/packages/"
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
for removed in \
  "$package_dir/lib/runtime/physical-archive.js" \
  "$package_dir/lib/runtime/physical-archive.d.ts"
do
  if [ -e "$removed" ]; then
    echo "TypeScript SDK fresh build retained deleted output $removed" >&2
    exit 1
  fi
done
if [ "$mode" != "package-shape" ]; then
  run pnpm --dir "$package_dir" run typecheck
fi
if [ "$mode" = "release-check" ] || [ "$mode" = "regression" ]; then
  run pnpm --dir "$package_dir" test --if-present
fi

if [ "$mode" != "check-static" ]; then
  run node tools/release/source-only-sdk-package.mjs prepare-npm js "$package_dir"
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
  run node tools/release/source-only-sdk-package.mjs check-npm-archive js "$pack_file"
  if [ "$mode" != "package-shape" ]; then
    cat >"$package_dir/.oliphaunt-bun-smoke.ts" <<'TS'
import * as sdk from './lib/index.js';
import type { OliphauntDatabase } from './lib/index.js';

if (typeof sdk.Oliphaunt.open !== 'function' || typeof sdk.Oliphaunt.openServer !== 'function') {
  throw new Error('missing Oliphaunt openers');
}
if ('simpleQuery' in sdk || 'createOliphauntClient' in sdk) throw new Error('internal helper exported');
const acceptsDatabase = (_database: OliphauntDatabase): void => {};
void acceptsDatabase;
TS
    run "$root/tools/dev/bun.sh" "$package_dir/.oliphaunt-bun-smoke.ts"
    rm -f "$package_dir/.oliphaunt-bun-smoke.ts"
    cat >"$package_dir/.oliphaunt-deno-smoke.ts" <<'TS'
import * as sdk from './lib/index.js';
import type { OliphauntDatabase } from './lib/index.js';

if (typeof sdk.Oliphaunt.open !== 'function' || typeof sdk.Oliphaunt.openServer !== 'function') {
  throw new Error('missing Oliphaunt openers');
}
if ('createDenoNativeBinding' in sdk) {
  throw new Error('Deno native binding factory must remain internal');
}
if (typeof Deno.version.deno !== 'string') {
  throw new Error('Deno runtime metadata missing');
}
const acceptsDatabase = (_database: OliphauntDatabase): void => {};
void acceptsDatabase;
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

reject_source_text "$package_dir/package.json" '"./node"' \
  "TypeScript SDK package must use runtime detection instead of a Node binding subpath"
reject_source_text "$package_dir/package.json" '"./bun"' \
  "TypeScript SDK package must use runtime detection instead of a Bun binding subpath"
reject_source_text "$package_dir/package.json" '"./deno"' \
  "TypeScript SDK package must use runtime detection instead of a Deno binding subpath"
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
];
const optional = Object.keys(pkg.optionalDependencies || {}).sort();
const expectedExports = ['.', './package.json', './protocol', './query'];
const actualExports = Object.keys(pkg.exports || {}).sort();
if (
  JSON.stringify(pkg.dependencies || {}) !== JSON.stringify(expectedDependencies) ||
  JSON.stringify(optional) !== JSON.stringify(expectedOptional.sort())
) {
  throw new Error('TypeScript SDK installs must declare only platform-selected runtime packages');
}
if (JSON.stringify(actualExports) !== JSON.stringify(expectedExports.sort())) {
  throw new Error('TypeScript SDK exports do not match its deliberate public surface');
}
for (const name of ['protocol', 'query']) {
  const entry = pkg.exports['./' + name];
  if (
    JSON.stringify(Object.keys(entry || {})) !== JSON.stringify(['types', 'default']) ||
    entry.types !== './lib/' + name + '.d.ts' ||
    entry.default !== './lib/' + name + '.js'
  ) {
    throw new Error('TypeScript SDK ' + name + ' subpath does not match its compiled entrypoint');
  }
}
" "$package_dir/package.json"
for internal_export in \
  createOliphauntClient \
  nativeDirectCapabilities \
  createDefaultNativeBinding \
  createNodeNativeBinding \
  createDenoNativeBinding \
  MaybePromise \
  NativeBinding \
  NativeBindingFactory \
  NativeBindingOptions \
  NativeOpenConfig \
  NativeRestoreOptions \
  NativeHandle \
  RuntimeBinding \
  RuntimeHandle
do
  reject_source_text "$package_dir/lib/index.d.ts" "$internal_export" \
    "TypeScript SDK root declarations must not expose internal runtime plumbing"
done
require_source_text "$package_dir/lib/index.d.ts" "OliphauntDatabase" \
  "TypeScript SDK root declarations must expose the structural database type"
require_source_text "$package_dir/src/native/node.ts" "loadNodeDirectAddon" \
  "TypeScript Node native-direct binding must load the Oliphaunt-owned prebuilt Node-API adapter"
require_source_text "$package_dir/src/config.ts" "const execution = config.execution ?? 'direct';" \
  "TypeScript SDK config normalization must default to direct execution"
require_source_text "$package_dir/src/__tests__/config.test.ts" "assert.equal(direct.execution, 'direct');" \
  "TypeScript SDK tests must prove the direct execution default"
reject_source_text "$package_dir/src/client.ts" "restorePhysicalArchiveWithBroker" \
  "TypeScript SDK public restore must not expose a broker-specific path"
require_source_text "$package_dir/src/client.ts" "await binding.restore({" \
  "TypeScript SDK public restore must use the runtime-detected native binding"
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
require_source_text "$package_dir/src/native/assets-deno.ts" "runtimeRelativePath" \
  "TypeScript Deno native binding must resolve runtime resources from the selected liboliphaunt package"
reject_source_text "$package_dir/src/native/assets-deno.ts" "@oliphaunt/tools-" \
  "TypeScript Deno native binding must not depend on split native client-tool packages"
reject_source_text "$package_dir/src/native/assets-node.ts" "@oliphaunt/tools-" \
  "TypeScript Node/Bun native binding must not depend on split native client-tool packages"
require_source_text "$package_dir/src/native/deno.ts" "install.packageManaged" \
  "TypeScript Deno direct execution must reject registry-managed extension materialization until it has a dedicated resolver"
require_source_text "$package_dir/src/native/extension-runtime.ts" "validatePreparedRuntimeExtensions" \
  "TypeScript native bindings must share prepared runtimeDirectory extension validation"
require_source_text "$package_dir/src/native/assets-deno.ts" "validatePreparedDenoRuntimeExtensions" \
  "TypeScript Deno native binding must validate explicit prepared runtimeDirectory extension files"
require_source_text "$package_dir/src/runtime/broker.ts" "Deno broker explicit runtimeDirectory" \
  "TypeScript Deno broker execution must validate explicit prepared runtimeDirectory extension files"
require_source_text "$package_dir/src/runtime/server.ts" "resolveDenoNativeInstall" \
  "TypeScript Deno server execution must resolve its package-managed server runtime through the base native carrier"
require_source_text "$package_dir/src/runtime/server.ts" "Deno server execution does not automatically materialize extension packages" \
  "TypeScript Deno server execution must fail clearly for registry-managed extension materialization"
require_source_text "$package_dir/src/runtime/broker.ts" "Deno broker execution does not automatically materialize extension packages" \
  "TypeScript Deno broker execution must fail clearly for registry-managed extension materialization"
require_source_text "$package_dir/src/runtime/broker.ts" "brokerNativeInstallEnv(nativeInstall)" \
  "TypeScript broker restore must pass the resolved native install environment"
require_source_text "$package_dir/src/native/tar.ts" "extractTarArchive" \
  "TypeScript SDK must extract verified liboliphaunt release assets without shelling out"
reject_source_text "$package_dir/src/client.ts" "supportedModes" \
  "TypeScript SDK must not expose speculative mode support discovery"
require_source_text "$package_dir/src/client.ts" "async transaction<T>" \
  "TypeScript SDK must expose the transaction helper"
require_source_text "$package_dir/src/client.ts" "async checkpoint(): Promise<void>" \
  "TypeScript SDK must expose checkpoint"
require_source_text "$package_dir/src/types.ts" "storage?: DatabaseStorage" \
  "TypeScript SDK open config must expose the structured native storage model"
require_source_text "$package_dir/src/types.ts" "kind: 'temporaryDirectory'" \
  "TypeScript SDK native storage must expose temporaryDirectory"
require_source_text "$package_dir/src/types.ts" "kind: 'directory'" \
  "TypeScript SDK native storage must expose caller-owned directories"
reject_source_text "$package_dir/src/types.ts" "root?: string" \
  "TypeScript SDK must not expose the internal database root"
reject_source_text "$package_dir/src/types.ts" "temporary?: boolean" \
  "TypeScript SDK must not expose ambiguous boolean temporary storage"
require_source_text "$package_dir/src/types.ts" "restore(destination: string, backup: BinaryInput, options?: RestoreOptions): Promise<void>" \
  "TypeScript SDK restore must use destination plus physical backup bytes"
require_source_text "$package_dir/src/config.ts" "pgdata: join(resolvedStorage.instanceDirectory, 'pgdata')" \
  "TypeScript SDK must derive the internal PGDATA layout from resolved storage"
require_source_text "$package_dir/src/client.ts" "createdTemporaryDirectory" \
  "TypeScript SDK must track cleanup ownership for materialized temporary directories"
require_source_text "$package_dir/src/config.ts" "generatedExtensionBySqlName(trimmed)" \
  "TypeScript SDK must validate selected extensions against the generated extension catalog"
require_source_text "$package_dir/src/config.ts" "unknown Oliphaunt extension id" \
  "TypeScript SDK must fail clearly for unknown selected extensions"
require_source_text "$package_dir/src/native/extension-runtime.ts" "metadata.selectedExtensionDependencies" \
  "TypeScript native extension materialization must use generated package-materialization dependencies"
reject_source_text "$package_dir/src/types.ts" "Capabilities" \
  "TypeScript SDK must not expose a speculative capability matrix"
require_source_text "$package_dir/src/query.ts" "function validateUtf8(bytes: Uint8Array, label: string): void" \
  "TypeScript SDK query parser must reject malformed backend UTF-8"
require_source_text "$package_dir/src/__tests__/protocol-fixtures.test.ts" "assertSharedProtocolFixtures" \
  "TypeScript SDK tests must consume the shared protocol fixture corpus"
require_source_text "$package_dir/src/__tests__/broker-frames.test.ts" "encodeBrokerRequest" \
  "TypeScript SDK tests must cover the native broker frame codec"
require_source_text "$package_dir/src/__tests__/runtime-adapters.test.ts" "encodeStartupMessage" \
  "TypeScript SDK tests must cover the native server wire client"
require_source_text "$package_dir/src/__tests__/asset-resolver.test.ts" "nodeResolverUsesInstalledPackages" \
  "TypeScript SDK tests must cover package-local liboliphaunt resolution"
require_source_text "$package_dir/src/__tests__/asset-resolver.test.ts" "typeScriptPackageMetadataMatchesRuntimePackages" \
  "TypeScript SDK tests must cover runtime package metadata"
require_source_text "$package_dir/src/__tests__/native-smoke.ts" "execution: 'broker'" \
  "TypeScript SDK smoke must execute broker placement when OLIPHAUNT_BROKER is set"
require_source_text "$package_dir/src/__tests__/native-smoke.ts" "Oliphaunt.openServer" \
  "TypeScript SDK smoke must execute native server mode when OLIPHAUNT_POSTGRES is set"
require_source_text "$package_dir/src/__tests__/native-direct-contract.mjs" "Oliphaunt.restore(restoredRoot, backup)" \
  "TypeScript SDK runtime contract must restore physical backup artifacts"
require_source_text "$package_dir/src/__tests__/native-smoke.ts" "assertNativeDatabaseContract" \
  "TypeScript SDK Node smoke must consume the shared native runtime contract"
require_source_text "$package_dir/src/__tests__/deno-native-smoke.mjs" "assertNativeDatabaseContract" \
  "TypeScript SDK Deno smoke must consume the shared native runtime contract"
require_source_text "$package_dir/src/runtime/broker.ts" "resolveBrokerNativeInstall" \
  "TypeScript broker mode must resolve the same liboliphaunt native install that direct mode uses"
require_source_text "$package_dir/src/runtime/broker.ts" "OLIPHAUNT_INSTALL_DIR" \
  "TypeScript broker mode must pass the resolved PostgreSQL runtime tree to the Rust helper"
require_source_text "$package_dir/src/runtime/broker.ts" "LIBOLIPHAUNT_PATH" \
  "TypeScript broker mode must pass the resolved liboliphaunt library to the Rust helper"
require_source_text "$package_dir/src/runtime/broker.ts" "packageBrokerExecutable" \
  "TypeScript broker mode must resolve the installed Rust broker helper package"
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
  if [ -z "${OLIPHAUNT_NODE_ADDON:-}" ]; then
    node_addon="$root/target/oliphaunt-artifacts/node-direct/$(oliphaunt_runtime_native_host_target_id)/oliphaunt_node.node"
    if [ ! -f "$node_addon" ]; then
      echo "OLIPHAUNT_NODE_ADDON is required for the TypeScript SDK native-direct smoke check: $node_addon" >&2
      exit 2
    fi
    export OLIPHAUNT_NODE_ADDON="$node_addon"
  fi
  if [ -z "${OLIPHAUNT_BROKER:-}" ]; then
    echo "OLIPHAUNT_BROKER is required for the TypeScript SDK native broker smoke check" >&2
    exit 2
  fi
  if [ -z "${OLIPHAUNT_POSTGRES:-}" ]; then
    echo "OLIPHAUNT_POSTGRES is required for the TypeScript SDK native server smoke check" >&2
    exit 2
  fi
  run pnpm --dir "$package_dir" exec tsx src/__tests__/native-smoke.ts
  run "$root/tools/dev/deno.sh" run --allow-all \
    "$package_dir/src/__tests__/deno-native-smoke.mjs"
fi
