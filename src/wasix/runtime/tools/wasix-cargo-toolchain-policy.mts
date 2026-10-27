import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCargoWorkspaceInheritance } from '../../../../tools/packaging/cargo-manifest.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CARGO_DEPENDENCY_SOURCE_KEYS = Object.freeze([
  'branch',
  'git',
  'path',
  'registry',
  'rev',
  'tag',
  'workspace',
]);

export const WASIX_TOOLCHAIN_PATH = 'src/wasix/runtime/toolchain.toml';
export const WASIX_ENGINE_SOURCES_PATH = 'src/wasix/runtime/engine/sources.json';

const REQUIRED_WASIX_TOOLCHAIN_PACKAGES = new Map([
  ['wasmer', 'wasmer'],
  ['wasmer-compiler', 'wasmer'],
  ['wasmer-derive', 'wasmer'],
  ['wasmer-types', 'wasmer'],
  ['wasmer-vm', 'wasmer'],
  ['wasmer-config', 'wasmerWasix'],
  ['wasmer-journal', 'wasmerWasix'],
  ['wasmer-package', 'wasmerWasix'],
  ['wasmer-wasix', 'wasmerWasix'],
  ['wasmer-wasix-types', 'wasmerWasix'],
  ['virtual-fs', 'wasmerWasix'],
  ['virtual-mio', 'wasmerWasix'],
  ['virtual-net', 'wasmerWasix'],
  ['webc', 'webc'],
]);

const REQUIRED_CONSUMER_PIN_POLICIES = new Map(
  [...REQUIRED_WASIX_TOOLCHAIN_PACKAGES]
    .filter(
      ([name, versionKey]) =>
        name === 'wasmer' || name === 'wasmer-types' || versionKey === 'wasmerWasix',
    )
    .map(([name, versionKey]) => [
      name,
      Object.freeze({ versionKey, defaultFeaturesDisabled: name !== 'wasmer-types' }),
    ]),
);
REQUIRED_CONSUMER_PIN_POLICIES.set(
  'webc',
  Object.freeze({ versionKey: 'webc', defaultFeaturesDisabled: false }),
);

export const REQUIRED_WASIX_CONSUMER_PINS = Object.freeze([
  ...REQUIRED_CONSUMER_PIN_POLICIES.keys(),
]);

function objectTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredString(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

export function canonicalWasixCargoToolchainVersions(root = ROOT) {
  const file = path.join(root, WASIX_TOOLCHAIN_PATH);
  let data;
  try {
    data = Bun.TOML.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`${WASIX_TOOLCHAIN_PATH} cannot be read as TOML: ${cause.message}`);
  }
  const toolchain = objectTable(data.toolchain);
  return Object.freeze({
    wasmer: requiredString(toolchain.wasmer, `${WASIX_TOOLCHAIN_PATH} toolchain.wasmer`),
    wasmerWasix: requiredString(
      toolchain['wasmer-wasix'],
      `${WASIX_TOOLCHAIN_PATH} toolchain.wasmer-wasix`,
    ),
    webc: requiredString(toolchain.webc, `${WASIX_TOOLCHAIN_PATH} toolchain.webc`),
  });
}

export function canonicalWasixEngineSourcePackages(
  root = ROOT,
  toolchainVersions = canonicalWasixCargoToolchainVersions(root),
) {
  const file = path.join(root, WASIX_ENGINE_SOURCES_PATH);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`${WASIX_ENGINE_SOURCES_PATH} cannot be read as JSON: ${cause.message}`);
  }
  const crates = objectTable(data.crates);
  for (const [name, crate] of Object.entries(crates)) {
    const versionKey = REQUIRED_WASIX_TOOLCHAIN_PACKAGES.get(name);
    const expected = toolchainVersions[versionKey];
    if (typeof expected !== 'string' || crate?.version !== expected) {
      throw new Error(
        `${WASIX_ENGINE_SOURCES_PATH} crates.${name}.version must match ${WASIX_TOOLCHAIN_PATH}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(crate?.version)}`,
      );
    }
  }
  return Object.freeze(Object.keys(crates));
}

function dependencyVersion(spec) {
  if (typeof spec === 'string') return spec;
  return typeof spec?.version === 'string' ? spec.version : null;
}

function dependencyName(key, spec) {
  return typeof spec?.package === 'string' ? spec.package : key;
}

export function validateWasixConsumerDependencyPins(
  manifest,
  {
    manifestPath = 'src/wasix/sdks/rust/Cargo.toml',
    toolchainVersions,
    engineSourcePackages = canonicalWasixEngineSourcePackages(ROOT, toolchainVersions),
    workspace,
  } = {},
) {
  if (workspace) manifest = resolveCargoWorkspaceInheritance(manifest, workspace);
  const failures = [];
  const targets = objectTable(manifest?.target);
  for (const [selector, target] of Object.entries(targets)) {
    if (selector === 'cfg(windows)' || selector === 'cfg(not(windows))') continue;
    for (const [key, spec] of Object.entries(objectTable(target?.dependencies))) {
      const name = dependencyName(key, spec).replace(/^oliphaunt-/u, '');
      if (REQUIRED_CONSUMER_PIN_POLICIES.has(key) || REQUIRED_CONSUMER_PIN_POLICIES.has(name)) {
        failures.push(
          `${manifestPath} target.${selector}.dependencies.${key} must declare toolchain pins in cfg(windows) or cfg(not(windows))`,
        );
      }
    }
  }
  for (const windows of [false, true]) {
    const selector = windows ? 'cfg(windows)' : 'cfg(not(windows))';
    const renamedPackages = new Set(windows ? engineSourcePackages : []);
    const sdkVersion = manifest?.package?.version;
    if (windows && (typeof sdkVersion !== 'string' || sdkVersion.length === 0)) {
      failures.push(
        `${manifestPath} must declare its SDK package version for the Windows engine family`,
      );
    }
    const tables = [
      ['dependencies', objectTable(manifest?.dependencies)],
      [`target.${selector}.dependencies`, objectTable(targets[selector]?.dependencies)],
    ];
    validateDependencyTable(tables, renamedPackages, sdkVersion, windows);
  }
  return failures;

  function validateDependencyTable(tables, renamedPackages, sdkVersion, windows) {
    for (const [name, policy] of REQUIRED_CONSUMER_PIN_POLICIES) {
      const expectedPackage = renamedPackages.has(name) ? `oliphaunt-${name}` : name;
      const expectedVersion = renamedPackages.has(name)
        ? sdkVersion
        : toolchainVersions?.[policy.versionKey];
      if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
        failures.push(
          `${manifestPath}: missing canonical ${policy.versionKey} toolchain version for ${name}`,
        );
        continue;
      }
      const matches = tables.flatMap(([tablePath, dependencies]) =>
        Object.entries(dependencies)
          .filter(
            ([key, spec]) =>
              key === name || [name, expectedPackage].includes(dependencyName(key, spec)),
          )
          .map(([key, spec]) => [tablePath, key, spec]),
      );
      if (matches.length !== 1) {
        failures.push(
          `${manifestPath} ${windows ? 'Windows' : 'non-Windows'} must declare non-optional ${name} exactly once, found ${matches.length}`,
        );
        continue;
      }
      const [[tablePath, key, spec]] = matches;
      const context = `${manifestPath} ${tablePath}.${key}`;
      if (key !== name || dependencyName(key, spec) !== expectedPackage) {
        failures.push(`${context} must use alias ${name} for package ${expectedPackage}`);
      }
      const actualVersion = dependencyVersion(spec);
      if (actualVersion !== `=${expectedVersion}`) {
        failures.push(
          `${context} must pin ${expectedPackage} exactly to =${expectedVersion}, got ${JSON.stringify(actualVersion)}`,
        );
      }
      if (typeof spec === 'object' && spec !== null && spec.optional === true) {
        failures.push(`${context} must keep ${expectedPackage} non-optional`);
      }
      if (
        policy.defaultFeaturesDisabled &&
        (typeof spec !== 'object' || spec === null || spec['default-features'] !== false)
      ) {
        failures.push(`${context} must set default-features = false for ${expectedPackage}`);
      }
      if (typeof spec === 'object' && spec !== null) {
        const sourceKeys = CARGO_DEPENDENCY_SOURCE_KEYS.filter((sourceKey) =>
          Object.hasOwn(spec, sourceKey),
        );
        if (sourceKeys.length > 0) {
          failures.push(
            `${context} must resolve ${expectedPackage} from crates.io without source selectors, found ${sourceKeys.join(', ')}`,
          );
        }
      }
      const requiredFeatures =
        name === 'wasmer'
          ? windows
            ? ['v8', 'headless']
            : ['sys', 'headless', 'compiler', 'wasmer-artifact-load']
          : name === 'wasmer-wasix'
            ? ['sys-minimal', 'sys-poll', 'host-vnet', 'time', ...(windows ? ['v8'] : [])]
            : [];
      const features = Array.isArray(spec?.features) ? spec.features : [];
      const missingFeatures = requiredFeatures.filter((feature) => !features.includes(feature));
      if (missingFeatures.length > 0) {
        failures.push(
          `${context} must enable features ${missingFeatures.join(', ')} for ${expectedPackage}`,
        );
      }
      const forbiddenFeatures = windows
        ? name === 'wasmer'
          ? ['compiler', 'llvm', 'cranelift', 'singlepass']
          : []
        : ['v8'];
      const conflictingFeatures = forbiddenFeatures.filter((feature) => features.includes(feature));
      if (conflictingFeatures.length > 0) {
        failures.push(
          `${context} must not enable features ${conflictingFeatures.join(', ')} for ${expectedPackage}`,
        );
      }
    }
  }
}
