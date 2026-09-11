import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CARGO_DEPENDENCY_SOURCE_KEYS = Object.freeze([
  'branch',
  'git',
  'path',
  'registry',
  'rev',
  'tag',
  'workspace',
]);

export const WASIX_TOOLCHAIN_PATH = 'runtimes/liboliphaunt-wasix/toolchain.toml';

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
    .filter(([, versionKey]) => versionKey === 'wasmerWasix')
    .map(([name, versionKey]) => [
      name,
      Object.freeze({ versionKey, defaultFeaturesDisabled: true }),
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

function dependencyVersion(spec) {
  if (typeof spec === 'string') return spec;
  return typeof spec?.version === 'string' ? spec.version : null;
}

function dependencyName(key, spec) {
  return typeof spec?.package === 'string' ? spec.package : key;
}

export function validateWasixConsumerDependencyPins(
  manifest,
  { manifestPath = 'sdks/rust-wasix/Cargo.toml', toolchainVersions } = {},
) {
  const failures = [];
  const dependencies = objectTable(manifest?.dependencies);
  for (const [name, policy] of REQUIRED_CONSUMER_PIN_POLICIES) {
    const expectedVersion = toolchainVersions?.[policy.versionKey];
    if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
      failures.push(
        `${manifestPath}: missing canonical ${policy.versionKey} toolchain version for ${name}`,
      );
      continue;
    }
    const matches = Object.entries(dependencies).filter(
      ([key, spec]) => dependencyName(key, spec) === name,
    );
    if (matches.length !== 1) {
      failures.push(
        `${manifestPath} must declare non-optional ${name} exactly once, found ${matches.length}`,
      );
      continue;
    }
    const [[key, spec]] = matches;
    const actualVersion = dependencyVersion(spec);
    if (actualVersion !== `=${expectedVersion}`) {
      failures.push(
        `${manifestPath} dependencies.${key} must pin ${name} exactly to =${expectedVersion}, got ${JSON.stringify(actualVersion)}`,
      );
    }
    if (typeof spec === 'object' && spec !== null && spec.optional === true) {
      failures.push(`${manifestPath} dependencies.${key} must keep ${name} non-optional`);
    }
    if (
      policy.defaultFeaturesDisabled &&
      (typeof spec !== 'object' || spec === null || spec['default-features'] !== false)
    ) {
      failures.push(
        `${manifestPath} dependencies.${key} must set default-features = false for ${name}`,
      );
    }
    if (typeof spec === 'object' && spec !== null) {
      const sourceKeys = CARGO_DEPENDENCY_SOURCE_KEYS.filter((sourceKey) =>
        Object.hasOwn(spec, sourceKey),
      );
      if (sourceKeys.length > 0) {
        failures.push(
          `${manifestPath} dependencies.${key} must resolve ${name} from crates.io without source selectors, found ${sourceKeys.join(', ')}`,
        );
      }
    }
  }
  return failures;
}
