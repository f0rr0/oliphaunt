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
const expectedExports = ['.', './package.json'];
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
for (const key of ['liboliphauntVersion', 'brokerVersion', 'nodeDirectAddon']) {
  if (typeof pkg.oliphaunt?.[key] !== 'string' || pkg.oliphaunt[key].length === 0) {
    throw new Error('TypeScript SDK package metadata must define oliphaunt.' + key);
  }
}
" "$package_dir/package.json"
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
