import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  EXAMPLE_CARGO_REGISTRY_INDEX,
  EXAMPLE_CARGO_REGISTRY_SOURCE,
  candidateRegistryDigest,
  candidateRegistryPackages,
  configureExampleCargoRegistry,
  verifyCandidateRegistryPackage,
} from "./example-cargo-registry.mjs";

const TOOL = "exact-cargo-candidate-consumer.mjs";

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedDependencies(dependencies) {
  if (!Array.isArray(dependencies) || dependencies.length === 0) {
    throw error("dependencies must be a non-empty list");
  }
  const normalized = dependencies.map((dependency) => {
    if (
      dependency === null
      || typeof dependency !== "object"
      || typeof dependency.name !== "string"
      || dependency.name.length === 0
      || typeof dependency.version !== "string"
      || dependency.version.length === 0
    ) {
      throw error("each dependency must declare non-empty name and version strings");
    }
    const features = dependency.features ?? [];
    if (!Array.isArray(features) || features.some((feature) => typeof feature !== "string" || feature.length === 0)) {
      throw error(`${dependency.name} features must be a string list`);
    }
    const sortedFeatures = [...features].sort(compareText);
    if (new Set(sortedFeatures).size !== sortedFeatures.length) {
      throw error(`${dependency.name} features must not contain duplicates`);
    }
    return {
      name: dependency.name,
      version: dependency.version,
      features: sortedFeatures,
      defaultFeatures: dependency.defaultFeatures ?? true,
    };
  }).sort((left, right) => compareText(left.name, right.name));
  if (new Set(normalized.map(({ name }) => name)).size !== normalized.length) {
    throw error("dependencies must not contain duplicate package names");
  }
  if (normalized.some(({ defaultFeatures }) => typeof defaultFeatures !== "boolean")) {
    throw error("dependency defaultFeatures values must be booleans");
  }
  return normalized;
}

export function renderExactCargoConsumerManifest({ packageName, dependencies }) {
  if (typeof packageName !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(packageName)) {
    throw error("packageName must be a canonical lowercase Cargo package name");
  }
  const rows = normalizedDependencies(dependencies).map((dependency) => {
    const fields = [
      `version = ${JSON.stringify(`=${dependency.version}`)}`,
      `default-features = ${dependency.defaultFeatures}`,
    ];
    if (dependency.features.length > 0) {
      fields.push(`features = [${dependency.features.map((feature) => JSON.stringify(feature)).join(", ")}]`);
    }
    return `${JSON.stringify(dependency.name)} = { ${fields.join(", ")} }`;
  });
  return [
    "[package]",
    `name = ${JSON.stringify(packageName)}`,
    'version = "0.0.0"',
    'edition = "2024"',
    "publish = false",
    "",
    "[dependencies]",
    ...rows,
    "",
    "[workspace]",
    "",
  ].join("\n");
}

function lockPackages(lockFile) {
  let data;
  try {
    data = Bun.TOML.parse(readFileSync(lockFile, "utf8"));
  } catch (cause) {
    throw error(`${lockFile} is not a valid Cargo lockfile: ${cause.message}`);
  }
  if (data.version !== 4 || !Array.isArray(data.package)) {
    throw error(`${lockFile} must be a Cargo lockfile v4 with package rows`);
  }
  return data.package;
}

export function validateExactCargoCandidateLock({ lockFile, indexDirectory }) {
  const candidates = candidateRegistryPackages(indexDirectory);
  const packages = lockPackages(lockFile);
  const candidateNames = new Set(candidates.map(({ name }) => name));
  const failures = [];
  const resolved = [];
  for (const candidate of candidates) {
    const rows = packages.filter(({ name }) => name === candidate.name);
    if (rows.length !== 1) {
      failures.push(`${candidate.name}@${candidate.vers} resolved ${rows.length} lock rows; expected exactly one`);
      continue;
    }
    const [row] = rows;
    if (row.version !== candidate.vers) {
      failures.push(`${candidate.name} resolved ${row.version}; expected ${candidate.vers}`);
    }
    if (row.source !== EXAMPLE_CARGO_REGISTRY_SOURCE) {
      failures.push(`${candidate.name}@${candidate.vers} resolved from ${row.source ?? "a path"}; expected the isolated candidate registry`);
    }
    if (row.checksum !== candidate.cksum) {
      failures.push(`${candidate.name}@${candidate.vers} lock checksum differs from the candidate index`);
    }
    resolved.push({
      name: candidate.name,
      version: candidate.vers,
      checksum: candidate.cksum,
      source: row.source,
    });
  }
  for (const row of packages) {
    if (row.source === EXAMPLE_CARGO_REGISTRY_SOURCE && !candidateNames.has(row.name)) {
      failures.push(`${row.name}@${row.version} resolved from the candidate source but is absent from its index`);
    }
  }
  if (failures.length > 0) throw error(failures.join("\n"));
  return resolved.sort((left, right) => compareText(left.name, right.name));
}

export function validateExactCargoMetadata({ metadata, candidates, cargoHome }) {
  if (metadata === null || typeof metadata !== "object" || !Array.isArray(metadata.packages)) {
    throw error("cargo metadata did not return package rows");
  }
  const failures = [];
  const installed = [];
  for (const candidate of candidates) {
    const rows = metadata.packages.filter(({ name }) => name === candidate.name);
    if (rows.length !== 1) {
      failures.push(`${candidate.name}@${candidate.vers} resolved ${rows.length} metadata rows; expected exactly one`);
      continue;
    }
    const [row] = rows;
    const manifestPath = row.manifest_path;
    if (
      row.version !== candidate.vers
      || row.source !== EXAMPLE_CARGO_REGISTRY_SOURCE
      || typeof manifestPath !== "string"
      || !existsSync(manifestPath)
      || !statSync(manifestPath).isFile()
      || !pathInside(cargoHome, realpathSync(manifestPath))
    ) {
      failures.push(`${candidate.name}@${candidate.vers} was not extracted from the isolated candidate registry into the clean Cargo home`);
      continue;
    }
    installed.push({
      name: candidate.name,
      version: candidate.vers,
      checksum: candidate.cksum,
      source: row.source,
      manifestSha256: sha256File(manifestPath),
    });
  }
  if (failures.length > 0) throw error(failures.join("\n"));
  return installed.sort((left, right) => compareText(left.name, right.name));
}

function runCargo(args, context) {
  const result = captureCommandOutput("cargo", args, {
    cwd: context.consumerRoot,
    env: {
      ...process.env,
      CARGO_HOME: context.cargoHome,
      CARGO_TARGET_DIR: context.cargoTarget,
      CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX: EXAMPLE_CARGO_REGISTRY_INDEX,
      CARGO_TERM_COLOR: "never",
    },
    label: `cargo ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw error(`cargo ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw error(`cargo ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

export function consumeExactCargoCandidates({
  indexDirectory,
  outputRoot,
  packageName,
  dependencies,
}) {
  const index = path.resolve(indexDirectory);
  const output = path.resolve(outputRoot);
  const consumerRoot = path.join(output, "consumer");
  const cargoHome = path.join(output, "cargo-home");
  const cargoTarget = path.join(output, "cargo-target");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(consumerRoot, "src"), { recursive: true });
  mkdirSync(cargoHome, { recursive: true });
  writeFileSync(
    path.join(consumerRoot, "Cargo.toml"),
    renderExactCargoConsumerManifest({ packageName, dependencies }),
  );
  writeFileSync(path.join(consumerRoot, "src/lib.rs"), "#![forbid(unsafe_code)]\n");

  const candidates = candidateRegistryPackages(index);
  for (const candidate of candidates) verifyCandidateRegistryPackage(index, candidate);
  configureExampleCargoRegistry({
    cargoHome,
    indexDirectory: index,
    candidatePackages: candidates,
  });
  const context = { consumerRoot, cargoHome, cargoTarget };
  runCargo(["generate-lockfile"], context);
  const lockFile = path.join(consumerRoot, "Cargo.lock");
  const locked = validateExactCargoCandidateLock({ lockFile, indexDirectory: index });
  runCargo(["fetch", "--locked"], context);
  const metadataText = runCargo(["metadata", "--locked", "--format-version", "1", "--all-features"], context);
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch (cause) {
    throw error(`cargo metadata returned invalid JSON: ${cause.message}`);
  }
  const installed = validateExactCargoMetadata({ metadata, candidates, cargoHome });
  const evidenceRoot = path.join(output, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  copyFileSync(lockFile, path.join(evidenceRoot, "Cargo.lock"));
  const evidence = {
    schema: "oliphaunt-exact-cargo-candidate-consumer-v1",
    registry: {
      index,
      packageCount: candidates.length,
      digest: candidateRegistryDigest(candidates),
    },
    dependencies: normalizedDependencies(dependencies),
    lockSha256: sha256File(lockFile),
    metadataSha256: createHash("sha256").update(metadataText).digest("hex"),
    locked,
    installed,
  };
  writeFileSync(path.join(evidenceRoot, "exact-cargo-consumer.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}
