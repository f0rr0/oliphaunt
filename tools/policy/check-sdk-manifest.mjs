#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from 'node:fs';

const manifestPath = 'tools/policy/sdk-manifest.toml';

const expected = {
  rust: {
    classification: 'sdk',
    package_name: 'oliphaunt',
    implementation_path: 'src/sdks/rust',
    documentation_path: 'src/docs/content/sdk/rust',
    primary_targets: ['tauri', 'rust-desktop'],
    runtime_owner: true,
    runtime_boundary: 'oliphaunt',
    parity_role: 'canonical',
    available_modes: ['native-direct', 'native-broker', 'native-server'],
    unsupported_modes: [],
    artifact_resolution: 'cargo-artifact-crates',
    tool_resolution: 'split-oliphaunt-tools-cargo-crates',
    extension_resolution: 'exact-extension-cargo-crates',
    resource_override: 'OLIPHAUNT_RESOURCES_DIR',
  },
  'wasix-rust': {
    classification: 'sdk',
    package_name: 'oliphaunt-wasix',
    implementation_path: 'src/bindings/wasix-rust/crates/oliphaunt-wasix',
    documentation_path: 'src/docs/content/sdk/wasm',
    primary_targets: ['wasix', 'wasm'],
    runtime_owner: true,
    runtime_boundary: 'oliphaunt-wasix',
    parity_role: 'wasm-peer',
    available_modes: ['wasix-direct', 'wasix-server'],
    unsupported_modes: ['native-direct', 'native-broker', 'native-server'],
    unsupported_mode_reason:
      'WASIX embeds PostgreSQL as WebAssembly modules; native liboliphaunt process modes do not apply',
    artifact_resolution: 'liboliphaunt-wasix-cargo-artifact-crates',
    tool_resolution: 'optional-oliphaunt-wasix-tools-cargo-crates',
    extension_resolution: 'exact-extension-wasix-cargo-crates',
    resource_override: 'OLIPHAUNT_WASM_GENERATED_ASSETS_DIR',
  },
  swift: {
    classification: 'sdk',
    package_name: 'Oliphaunt',
    implementation_path: 'src/sdks/swift',
    documentation_path: 'src/docs/content/sdk/swift',
    primary_targets: ['ios', 'macos'],
    runtime_owner: true,
    runtime_boundary: 'Oliphaunt',
    parity_role: 'platform-peer',
    available_modes: ['native-direct'],
    unsupported_modes: ['native-broker', 'native-server'],
    unsupported_mode_reason:
      'platform broker/server adapters are not implemented yet; direct mode remains a single-session runtime',
    artifact_resolution: 'swiftpm-release-assets',
    tool_resolution: 'not-applicable-mobile-native-direct',
    extension_resolution: 'exact-extension-xcframework-artifacts',
    resource_override: 'runtimeDirectory-resourceRoot',
  },
  kotlin: {
    classification: 'sdk',
    package_name: 'oliphaunt',
    implementation_path: 'src/sdks/kotlin',
    documentation_path: 'src/docs/content/sdk/kotlin',
    primary_targets: ['android'],
    runtime_owner: true,
    runtime_boundary: 'OliphauntAndroid',
    parity_role: 'platform-peer',
    available_modes: ['native-direct'],
    unsupported_modes: ['native-broker', 'native-server'],
    unsupported_mode_reason:
      'Android broker/server adapters are not implemented yet; direct mode remains a single-session runtime',
    artifact_resolution: 'maven-runtime-artifacts',
    tool_resolution: 'not-applicable-mobile-native-direct',
    extension_resolution: 'exact-extension-maven-artifacts',
    resource_override: 'runtimeDirectory-resourceRoot',
  },
  'react-native': {
    classification: 'sdk',
    package_name: '@oliphaunt/react-native',
    implementation_path: 'src/sdks/react-native',
    documentation_path: 'src/docs/content/sdk/react-native',
    primary_targets: ['react-native-ios', 'react-native-android', 'future-react-native-macos'],
    runtime_owner: false,
    runtime_boundary: 'TurboModule adapter',
    delegates_apple_to: 'swift',
    delegates_android_to: 'kotlin',
    parity_role: 'delegating-platform-peer',
    available_modes: ['native-direct'],
    unsupported_modes: ['native-broker', 'native-server'],
    unsupported_mode_reason: 'runtime availability is delegated to Swift and Kotlin supportedModes',
    artifact_resolution: 'delegated-swiftpm-maven',
    tool_resolution: 'delegated-platform-sdk',
    extension_resolution: 'delegated-exact-extension-artifacts',
    resource_override: 'runtimeDirectory-resourceRoot',
  },
  typescript: {
    classification: 'sdk',
    package_name: '@oliphaunt/ts',
    implementation_path: 'src/sdks/js',
    documentation_path: 'src/docs/content/sdk/typescript',
    primary_targets: ['node', 'bun', 'deno', 'tauri-javascript'],
    runtime_owner: true,
    runtime_boundary: '@oliphaunt/ts',
    parity_role: 'desktop-javascript-peer',
    available_modes: ['native-direct', 'native-broker', 'native-server'],
    unsupported_modes: [],
    depends_on_rust_broker_helper: true,
    broker_helper_product: 'oliphaunt-rust',
    artifact_resolution: 'npm-optional-platform-packages',
    tool_resolution: 'split-oliphaunt-tools-npm-packages',
    extension_resolution:
      'node-bun-exact-extension-npm-packages-prepared-runtimeDirectory-validation',
    resource_override: 'libraryPath-runtimeDirectory',
  },
};

const expectedSdkIds = Object.keys(expected);
const errors = [];

function fail(message) {
  console.error(`check-sdk-manifest.mjs: ${message}`);
  process.exit(1);
}

function usage() {
  console.log('usage: tools/policy/check-sdk-manifest.mjs [--list] [--json]');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      sameValue(leftKeys, rightKeys) &&
      leftKeys.every((key) => sameValue(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

function formatValue(value) {
  return JSON.stringify(value);
}

function requireDirectory(path, sdkId, field) {
  if (!existsSync(path)) {
    errors.push(`[sdks.${sdkId}].${field} points at missing path ${formatValue(path)}`);
    return;
  }
  if (!statSync(path).isDirectory()) {
    errors.push(`[sdks.${sdkId}].${field} must point at a directory: ${formatValue(path)}`);
  }
}

function sorted(value) {
  return [...value].sort((left, right) => left.localeCompare(right));
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  usage();
  process.exit(0);
}
if (args.length > 1) {
  fail(`expected at most one option, got ${args.join(' ')}`);
}
const mode = args[0] ?? 'check';
if (!['check', '--list', '--json'].includes(mode)) {
  fail(`unknown option: ${mode}`);
}

const manifest = Bun.TOML.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.schema_version !== 1) {
  errors.push(`schema_version is ${formatValue(manifest.schema_version)}; expected 1`);
}
if (!isPlainObject(manifest.sdks)) {
  errors.push('manifest must contain an [sdks] table');
}

const sdks = isPlainObject(manifest.sdks) ? manifest.sdks : {};
const actualSdkIds = Object.keys(sdks);
if (!sameValue(sorted(actualSdkIds), sorted(expectedSdkIds))) {
  errors.push(
    `SDK ids are ${formatValue(sorted(actualSdkIds))}; expected ${formatValue(sorted(expectedSdkIds))}`,
  );
}

const seenImplementationPaths = new Map();
for (const sdkId of expectedSdkIds) {
  const actual = sdks[sdkId];
  const contract = expected[sdkId];
  if (!isPlainObject(actual)) {
    errors.push(`missing [sdks.${sdkId}]`);
    continue;
  }

  const actualFields = Object.keys(actual).sort();
  const expectedFields = Object.keys(contract).sort();
  if (!sameValue(actualFields, expectedFields)) {
    errors.push(
      `[sdks.${sdkId}] fields are ${formatValue(actualFields)}; expected ${formatValue(expectedFields)}`,
    );
  }

  for (const [field, expectedValue] of Object.entries(contract)) {
    if (!sameValue(actual[field], expectedValue)) {
      errors.push(
        `[sdks.${sdkId}].${field} is ${formatValue(actual[field])}; expected ${formatValue(
          expectedValue,
        )}`,
      );
    }
  }

  if (typeof actual.implementation_path === 'string') {
    if (seenImplementationPaths.has(actual.implementation_path)) {
      errors.push(
        `[sdks.${sdkId}].implementation_path duplicates [sdks.${seenImplementationPaths.get(
          actual.implementation_path,
        )}] path ${formatValue(actual.implementation_path)}`,
      );
    }
    seenImplementationPaths.set(actual.implementation_path, sdkId);
    requireDirectory(actual.implementation_path, sdkId, 'implementation_path');
  }
  if (typeof actual.documentation_path === 'string') {
    requireDirectory(actual.documentation_path, sdkId, 'documentation_path');
  }

  if (Array.isArray(actual.unsupported_modes) && actual.unsupported_modes.length > 0) {
    if (
      typeof actual.unsupported_mode_reason !== 'string' ||
      actual.unsupported_mode_reason.length === 0
    ) {
      errors.push(`[sdks.${sdkId}] must explain unsupported modes`);
    }
  }
}

for (const sdkId of expectedSdkIds) {
  const actual = sdks[sdkId];
  if (!isPlainObject(actual)) {
    continue;
  }
  for (const delegateField of ['delegates_apple_to', 'delegates_android_to']) {
    const delegate = actual[delegateField];
    if (delegate === undefined) {
      continue;
    }
    if (!expectedSdkIds.includes(delegate)) {
      errors.push(`[sdks.${sdkId}].${delegateField} points at unknown SDK ${formatValue(delegate)}`);
      continue;
    }
    if (sdks[delegate]?.runtime_owner !== true) {
      errors.push(`[sdks.${sdkId}].${delegateField} must point at a runtime-owning SDK`);
    }
  }
}

if (sdks.typescript?.depends_on_rust_broker_helper === true) {
  if (sdks.typescript.broker_helper_product !== 'oliphaunt-rust') {
    errors.push('[sdks.typescript].broker_helper_product must remain oliphaunt-rust');
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`check-sdk-manifest.mjs: ${error}`);
  }
  process.exit(1);
}

if (mode === '--json') {
  const summary = {
    schemaVersion: manifest.schema_version,
    sdkCount: expectedSdkIds.length,
    sdks: Object.fromEntries(
      expectedSdkIds.map((sdkId) => [
        sdkId,
        {
          packageName: sdks[sdkId].package_name,
          runtimeOwner: sdks[sdkId].runtime_owner,
          availableModes: sdks[sdkId].available_modes,
          unsupportedModes: sdks[sdkId].unsupported_modes,
          artifactResolution: sdks[sdkId].artifact_resolution,
          toolResolution: sdks[sdkId].tool_resolution,
          extensionResolution: sdks[sdkId].extension_resolution,
        },
      ]),
    ),
  };
  console.log(JSON.stringify(summary, null, 2));
} else if (mode === '--list') {
  for (const sdkId of expectedSdkIds) {
    const sdk = sdks[sdkId];
    console.log(
      `${sdkId}: modes=${sdk.available_modes.join(',')} unsupported=${
        sdk.unsupported_modes.length > 0 ? sdk.unsupported_modes.join(',') : 'none'
      } artifact=${sdk.artifact_resolution} tools=${sdk.tool_resolution} extensions=${
        sdk.extension_resolution
      }`,
    );
  }
} else {
  console.log(`SDK manifest contract verified (${expectedSdkIds.length} SDKs).`);
}
