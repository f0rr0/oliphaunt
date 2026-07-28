#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const errors = [];

const legacyPackageNames = new Set([
  'oliphaunt-wasix',
  'liboliphaunt-wasix-portable',
  'oliphaunt-wasix-tools',
]);
const legacyNamePrefixes = [
  'liboliphaunt-wasix-aot-',
  'oliphaunt-wasix-tools-aot-',
];
const legacyRuntimeNames = new Set([
  'wasmer',
  'wasmer-wasix',
  'wasmer-vfs',
  'wasmer-types',
  'wasmer-headless',
]);
const legacyPathFragments = [
  'src/bindings/wasix-rust/crates/oliphaunt-wasix',
  'src/runtimes/liboliphaunt/wasix/crates/assets',
  'src/runtimes/liboliphaunt/wasix/crates/aot',
  'src/runtimes/liboliphaunt/wasix/crates/tools',
  'src/runtimes/liboliphaunt/wasix/crates/tools-aot',
];

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readToml(relativePath) {
  return Bun.TOML.parse(readText(relativePath));
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function* dependencyTables(manifest) {
  for (const tableName of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    yield [tableName, isPlainObject(manifest[tableName]) ? manifest[tableName] : {}];
  }
  const targetTables = isPlainObject(manifest.target) ? manifest.target : {};
  for (const [cfg, table] of Object.entries(targetTables)) {
    if (!isPlainObject(table)) {
      continue;
    }
    for (const tableName of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      yield [`target.${cfg}.${tableName}`, isPlainObject(table[tableName]) ? table[tableName] : {}];
    }
  }
}

function dependencyName(depKey, spec) {
  return isPlainObject(spec) && typeof spec.package === 'string' ? spec.package : depKey;
}

function dependencyPath(spec) {
  return isPlainObject(spec) && typeof spec.path === 'string' ? spec.path : null;
}

function isBlockedRustDependency(name) {
  return (
    legacyPackageNames.has(name) ||
    legacyRuntimeNames.has(name) ||
    legacyNamePrefixes.some(prefix => name.startsWith(prefix))
  );
}

function pathInsideFragment(relativePath, fragment) {
  return relativePath === fragment || relativePath.startsWith(`${fragment}/`);
}

function checkNativeRustManifest(relativePath) {
  const manifestPath = path.join(root, relativePath);
  const manifest = readToml(relativePath);
  for (const [tableName, deps] of dependencyTables(manifest)) {
    for (const [depKey, spec] of Object.entries(deps)) {
      const name = dependencyName(depKey, spec);
      if (isBlockedRustDependency(name)) {
        errors.push(`${relativePath} ${tableName}.${depKey} depends on legacy runtime resources ${JSON.stringify(name)}`);
      }
      const pathValue = dependencyPath(spec);
      if (pathValue === null) {
        continue;
      }
      const dependencyTarget = path.resolve(path.dirname(manifestPath), pathValue);
      const dependencyTargetRel = rel(dependencyTarget);
      if (legacyPathFragments.some(fragment => pathInsideFragment(dependencyTargetRel, fragment))) {
        errors.push(`${relativePath} ${tableName}.${depKey} points at legacy path ${dependencyTargetRel}`);
      }
    }
  }
}

function checkJsonManifest(relativePath) {
  const manifest = readJson(relativePath);
  for (const tableName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = isPlainObject(manifest[tableName]) ? manifest[tableName] : {};
    for (const name of Object.keys(deps)) {
      if (legacyPackageNames.has(name) || legacyNamePrefixes.some(prefix => name.startsWith(prefix))) {
        errors.push(`${relativePath} ${tableName}.${name} depends on legacy WASIX package`);
      }
    }
  }
}

function requireText(relativePath, text, message) {
  if (!readText(relativePath).includes(text)) {
    errors.push(`${relativePath}: ${message}; expected ${JSON.stringify(text)}`);
  }
}

function rejectManifestText(relativePath, patterns) {
  const text = readText(relativePath);
  for (const [label, pattern] of patterns) {
    if (new RegExp(pattern, 'i').test(text)) {
      errors.push(`${relativePath} contains blocked native-boundary reference: ${label}`);
    }
  }
}

function checkToolCrateBoundaries() {
  const manifest = readToml('tools/xtask/Cargo.toml');
  const features = isPlainObject(manifest.features) ? manifest.features : {};
  const dependencies = isPlainObject(manifest.dependencies) ? manifest.dependencies : {};

  if (JSON.stringify(features.default ?? null) !== '[]') {
    errors.push('tools/xtask/Cargo.toml must keep the default feature set empty');
  }
  for (const removedFeature of ['perf', 'legacy-oliphaunt']) {
    if (removedFeature in features) {
      errors.push(`tools/xtask/Cargo.toml must not define product-aware feature ${JSON.stringify(removedFeature)}; use tools/perf/runner`);
    }
  }

  const forbiddenXtaskDependencies = [
    'directories',
    'futures-util',
    'oliphaunt',
    'oliphaunt-wasix',
    'rusqlite',
    'sqlx',
    'tokio-postgres',
  ];
  for (const depName of forbiddenXtaskDependencies) {
    if (depName in dependencies) {
      errors.push(`tools/xtask/Cargo.toml must not depend on product/perf crate ${JSON.stringify(depName)}; use tools/perf/runner`);
    }
  }

  for (const depName of ['wasmer', 'wasmer-types', 'wasmer-wasix', 'webc', 'tokio']) {
    const spec = dependencies[depName];
    if (!isPlainObject(spec) || spec.optional !== true) {
      errors.push(`tools/xtask/Cargo.toml dependency ${JSON.stringify(depName)} must stay optional so default xtask builds do not compile template/AOT runtime support`);
    }
  }

  const perfManifest = readToml('tools/perf/runner/Cargo.toml');
  const perfFeatures = isPlainObject(perfManifest.features) ? perfManifest.features : {};
  const perfDependencies = isPlainObject(perfManifest.dependencies) ? perfManifest.dependencies : {};
  if (JSON.stringify(perfFeatures.default ?? null) !== '[]') {
    errors.push('tools/perf/runner/Cargo.toml must keep the default feature set empty');
  }
  const legacyFeature = new Set(Array.isArray(perfFeatures['legacy-oliphaunt']) ? perfFeatures['legacy-oliphaunt'] : []);
  for (const depName of ['dep:directories', 'dep:oliphaunt-wasix']) {
    if (!legacyFeature.has(depName)) {
      errors.push(`tools/perf/runner/Cargo.toml legacy-oliphaunt feature must gate ${depName}`);
    }
  }
  for (const depName of ['oliphaunt', 'rusqlite', 'sqlx', 'tokio-postgres']) {
    if (!(depName in perfDependencies)) {
      errors.push(`tools/perf/runner/Cargo.toml must own benchmark dependency ${JSON.stringify(depName)}`);
    }
  }

  const wasixRunner = new Set(Array.isArray(features['wasix-runner']) ? features['wasix-runner'] : []);
  for (const depName of ['dep:wasmer', 'dep:wasmer-wasix', 'dep:webc']) {
    if (!wasixRunner.has(depName)) {
      errors.push(`tools/xtask/Cargo.toml wasix-runner feature must explicitly gate ${depName}`);
    }
  }

  const aotSerializer = new Set(Array.isArray(features['aot-serializer']) ? features['aot-serializer'] : []);
  if (!aotSerializer.has('dep:wasmer-types')) {
    errors.push('tools/xtask/Cargo.toml aot-serializer feature must explicitly gate dep:wasmer-types');
  }
}

function checkNativeScriptBoundary() {
  requireText(
    'tools/perf/matrix/run_native_oliphaunt_matrix.sh',
    'cargo build --release -p oliphaunt-perf -p oliphaunt --bins',
    'native perf matrix must build the dedicated perf runner and native broker helper',
  );
  requireText(
    'tools/perf/matrix/run_native_oliphaunt_matrix.sh',
    'legacyWasixControls=false',
    'native perf matrix plan must classify itself as native-only',
  );
  requireText(
    'src/runtimes/liboliphaunt/native/tools/check-track.sh',
    'run src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs --check',
    'native track validation must keep the PostgreSQL patch-stack audit in the native lane',
  );
  requireText(
    'src/runtimes/liboliphaunt/native/moon.yml',
    'command: "bash src/runtimes/liboliphaunt/native/tools/check-track.sh host-smoke"',
    'liboliphaunt host-smoke validation must run the host C ABI smoke rather than workspace legacy validation',
  );
  rejectManifestText(
    'tools/policy/check-policy-tools.sh',
    [
      [
        'tools/policy/check-sdk-parity.sh',
        'policy-tools must stay a thin repository-policy aggregator; SDK parity evidence belongs to dedicated SDK/contract tasks',
      ],
    ],
  );
}

function* walkFiles(relativeRoots, suffixes) {
  const suffixSet = new Set(suffixes);
  for (const relativeRoot of relativeRoots) {
    const start = path.join(root, relativeRoot);
    if (!fs.existsSync(start)) {
      errors.push(`missing expected native boundary path: ${relativeRoot}`);
      continue;
    }
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) =>
        right.name < left.name ? -1 : right.name > left.name ? 1 : 0);
      for (const entry of entries) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(file);
        } else if (entry.isFile() && suffixSet.has(path.extname(file))) {
          yield file;
        }
      }
    }
  }
}

checkNativeRustManifest('src/sdks/rust/Cargo.toml');
checkJsonManifest('src/sdks/react-native/package.json');
checkJsonManifest('src/sdks/react-native/examples/expo/package.json');
checkToolCrateBoundaries();
checkNativeScriptBoundary();

const manifestTextPatterns = [
  ['oliphaunt-wasix package', String.raw`\boliphaunt-wasix\b`],
  ['WASIX runtime', String.raw`\bwasix\b`],
  ['Wasmer runtime', String.raw`\bwasmer\b`],
];
for (const manifestPath of [
  'src/sdks/swift/Package.swift',
  'src/sdks/react-native/OliphauntReactNative.podspec',
  'src/sdks/kotlin/build.gradle.kts',
  'src/sdks/kotlin/oliphaunt/build.gradle.kts',
  'src/sdks/react-native/android/build.gradle',
  'src/sdks/react-native/android/settings.gradle',
]) {
  rejectManifestText(manifestPath, manifestTextPatterns);
}

const sourcePatterns = [
  ['Rust import of legacy crate', String.raw`\b(use|extern\s+crate)\s+oliphaunt_wasix\b`],
  ['Rust path to legacy crate', String.raw`\boliphaunt_wasix::`],
  ['JavaScript import of legacy package', String.raw`\b(import|require)\s*(?:.+?\s+from\s*)?['"]oliphaunt-wasix['"]`],
  ['Swift/Kotlin legacy module import', String.raw`\bimport\s+OliphauntWasm\b`],
];
for (const filePath of walkFiles(
  [
    'src/sdks/rust/src',
    'src/sdks/rust/tests',
    'src/runtimes/liboliphaunt/native/include',
    'src/runtimes/liboliphaunt/native/src',
    'src/sdks/swift/Sources',
    'src/sdks/swift/Tests',
    'src/sdks/kotlin/oliphaunt/src',
    'src/sdks/react-native/src',
    'src/sdks/react-native/ios',
    'src/sdks/react-native/android/src',
  ],
  ['.rs', '.c', '.h', '.swift', '.kt', '.java', '.ts', '.tsx', '.m', '.mm', '.cpp'],
)) {
  const text = fs.readFileSync(filePath, 'utf8');
  for (const [label, pattern] of sourcePatterns) {
    if (new RegExp(pattern).test(text)) {
      errors.push(`${rel(filePath)} contains blocked native-boundary code reference: ${label}`);
    }
  }
}

const sdkManifest = readToml('tools/policy/sdk-manifest.toml');
const expectedPaths = {
  rust: 'src/sdks/rust',
  swift: 'src/sdks/swift',
  kotlin: 'src/sdks/kotlin',
  'react-native': 'src/sdks/react-native',
};
const seenPaths = new Map();
const sdkSections = isPlainObject(sdkManifest.sdks) ? sdkManifest.sdks : {};
for (const [sdk, expectedPath] of Object.entries(expectedPaths)) {
  const section = sdkSections[sdk];
  if (!isPlainObject(section)) {
    errors.push(`tools/policy/sdk-manifest.toml is missing [sdks.${sdk}]`);
    continue;
  }
  const actualPath = section.implementation_path;
  if (actualPath !== expectedPath) {
    errors.push(`tools/policy/sdk-manifest.toml [sdks.${sdk}].implementation_path is ${JSON.stringify(actualPath)}; expected ${JSON.stringify(expectedPath)}`);
  }
  if (seenPaths.has(actualPath)) {
    errors.push(`tools/policy/sdk-manifest.toml shares implementation_path ${JSON.stringify(actualPath)} between ${seenPaths.get(actualPath)} and ${sdk}`);
  }
  seenPaths.set(actualPath, sdk);
}

const reactNative = isPlainObject(sdkSections['react-native']) ? sdkSections['react-native'] : {};
if (reactNative.runtime_owner !== false) {
  errors.push('React Native SDK must stay a delegating adapter with runtime_owner = false');
}
if (reactNative.delegates_apple_to !== 'swift') {
  errors.push('React Native Apple runtime delegation must point at the Swift SDK');
}
if (reactNative.delegates_android_to !== 'kotlin') {
  errors.push('React Native Android runtime delegation must point at the Kotlin SDK');
}

if (errors.length > 0) {
  console.error('native product boundary violations:');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log('native product boundaries ok');
