import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CRATES_IO_SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const CARGO_DEPENDENCY_SOURCE_KEYS = Object.freeze([
  "branch",
  "git",
  "path",
  "registry",
  "rev",
  "tag",
  "workspace",
]);

export const WASIX_TOOLCHAIN_PATH = "src/sources/toolchains/wasix.toml";

const REQUIRED_WASIX_TOOLCHAIN_PACKAGES = new Map([
  ["wasmer", "wasmer"],
  ["wasmer-compiler", "wasmer"],
  ["wasmer-derive", "wasmer"],
  ["wasmer-types", "wasmer"],
  ["wasmer-vm", "wasmer"],
  ["wasmer-config", "wasmerWasix"],
  ["wasmer-journal", "wasmerWasix"],
  ["wasmer-package", "wasmerWasix"],
  ["wasmer-wasix", "wasmerWasix"],
  ["wasmer-wasix-types", "wasmerWasix"],
  ["virtual-fs", "wasmerWasix"],
  ["virtual-mio", "wasmerWasix"],
  ["virtual-net", "wasmerWasix"],
  ["webc", "webc"],
]);

const REQUIRED_CONSUMER_PIN_POLICIES = new Map(
  [...REQUIRED_WASIX_TOOLCHAIN_PACKAGES]
    .filter(([, versionKey]) => versionKey === "wasmerWasix")
    .map(([name, versionKey]) => [
      name,
      Object.freeze({ versionKey, defaultFeaturesDisabled: true }),
    ]),
);
REQUIRED_CONSUMER_PIN_POLICIES.set(
  "webc",
  Object.freeze({ versionKey: "webc", defaultFeaturesDisabled: false }),
);

export const REQUIRED_WASIX_CONSUMER_PINS = Object.freeze(
  [...REQUIRED_CONSUMER_PIN_POLICIES.keys()],
);

function objectTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function requiredString(value, context) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

export function canonicalWasixCargoToolchainVersions(root = ROOT) {
  const file = path.join(root, WASIX_TOOLCHAIN_PATH);
  let data;
  try {
    data = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`${WASIX_TOOLCHAIN_PATH} cannot be read as TOML: ${cause.message}`);
  }
  const toolchain = objectTable(data.toolchain);
  return Object.freeze({
    wasmer: requiredString(
      toolchain.wasmer,
      `${WASIX_TOOLCHAIN_PATH} toolchain.wasmer`,
    ),
    wasmerWasix: requiredString(
      toolchain["wasmer-wasix"],
      `${WASIX_TOOLCHAIN_PATH} toolchain.wasmer-wasix`,
    ),
    webc: requiredString(
      toolchain.webc,
      `${WASIX_TOOLCHAIN_PATH} toolchain.webc`,
    ),
  });
}

function dependencyVersion(spec) {
  if (typeof spec === "string") return spec;
  return typeof spec?.version === "string" ? spec.version : null;
}

function dependencyName(key, spec) {
  return typeof spec?.package === "string" ? spec.package : key;
}

export function validateWasixConsumerDependencyPins(
  manifest,
  {
    manifestPath = "src/bindings/wasix-rust/crates/oliphaunt-wasix/Cargo.toml",
    toolchainVersions,
  } = {},
) {
  const failures = [];
  const dependencies = objectTable(manifest?.dependencies);
  for (const [name, policy] of REQUIRED_CONSUMER_PIN_POLICIES) {
    const expectedVersion = toolchainVersions?.[policy.versionKey];
    if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
      failures.push(
        `${manifestPath}: missing canonical ${policy.versionKey} toolchain version for ${name}`,
      );
      continue;
    }
    const matches = Object.entries(dependencies)
      .filter(([key, spec]) => dependencyName(key, spec) === name);
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
    if (typeof spec === "object" && spec !== null && spec.optional === true) {
      failures.push(`${manifestPath} dependencies.${key} must keep ${name} non-optional`);
    }
    if (
      policy.defaultFeaturesDisabled
      && (
        typeof spec !== "object"
        || spec === null
        || spec["default-features"] !== false
      )
    ) {
      failures.push(
        `${manifestPath} dependencies.${key} must set default-features = false for ${name}`,
      );
    }
    if (typeof spec === "object" && spec !== null) {
      const sourceKeys = CARGO_DEPENDENCY_SOURCE_KEYS.filter((sourceKey) =>
        Object.hasOwn(spec, sourceKey)
      );
      if (sourceKeys.length > 0) {
        failures.push(
          `${manifestPath} dependencies.${key} must resolve ${name} from crates.io without source selectors, found ${sourceKeys.join(", ")}`,
        );
      }
    }
  }
  return failures;
}

function optionalWasixToolchainVersionKey(name) {
  if (name.startsWith("wasmer-compiler-")) return "wasmer";
  if (name.startsWith("wasmer-wasix-")) return "wasmerWasix";
  return null;
}

export function isWasixToolchainPackageName(name) {
  return (
    name === "webc"
    || name === "wasmer"
    || name.startsWith("wasmer-")
    || name.startsWith("virtual-")
  );
}

export function validateResolvedWasixToolchainPolicy(
  lockfile,
  packages,
  { toolchainVersions } = {},
) {
  const failures = [];
  const byName = new Map();
  for (const pkg of packages) {
    const rows = byName.get(pkg.name) ?? [];
    rows.push(pkg);
    byName.set(pkg.name, rows);
  }
  for (const [name, versionKey] of REQUIRED_WASIX_TOOLCHAIN_PACKAGES) {
    const entries = byName.get(name) ?? [];
    const expected = toolchainVersions?.[versionKey];
    if (entries.length !== 1) {
      failures.push(`${lockfile}: expected exactly one resolved ${name} package, found ${entries.length}`);
      continue;
    }
    if (entries[0].source !== CRATES_IO_SOURCE) {
      failures.push(`${lockfile}: ${name} must resolve from crates.io, got ${entries[0].source ?? "path"}`);
    }
    if (entries[0].version !== expected) {
      failures.push(`${lockfile}: ${name} resolved ${entries[0].version}; expected ${expected}`);
    }
  }
  for (const pkg of packages) {
    if (REQUIRED_WASIX_TOOLCHAIN_PACKAGES.has(pkg.name)) continue;
    if (!isWasixToolchainPackageName(pkg.name)) continue;
    const versionKey = optionalWasixToolchainVersionKey(pkg.name);
    if (
      (pkg.name === "wasmer" || pkg.name.startsWith("wasmer-"))
      && pkg.source !== CRATES_IO_SOURCE
    ) {
      failures.push(
        `${lockfile}: ${pkg.name} must resolve from crates.io, got ${pkg.source ?? "path"}`,
      );
    }
    if (versionKey !== null && pkg.version !== toolchainVersions?.[versionKey]) {
      failures.push(
        `${lockfile}: ${pkg.name} resolved ${pkg.version}; expected ${toolchainVersions?.[versionKey]}`,
      );
    } else if (versionKey === null) {
      failures.push(
        `${lockfile}: unexpected non-canonical WASIX toolchain package ${pkg.name}@${pkg.version}`,
      );
    }
  }
  return failures;
}
