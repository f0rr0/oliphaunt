#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";

import {
  EXAMPLE_CARGO_REGISTRY_SOURCE,
} from "./example-cargo-registry.mjs";
import {
  EXAMPLE_CARGO_POLICIES,
  exampleCargoPolicyById,
  validateCandidateLock,
  validateCandidateRegistry,
  validateExampleManifests,
} from "./example-cargo-policy.mjs";
import {
  prepareExampleCargoCandidate,
  runExampleCargo,
  writeExampleCargoEvidence,
} from "./prepare-example-cargo-candidate.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "validate-example-cargo-candidates.mjs";
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "target/release-work/example-cargo-candidates");

function toolError(message) {
  return new Error(`${TOOL}: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateCandidateMetadata(policyId, metadata, candidatePackages) {
  const policy = exampleCargoPolicyById(policyId);
  if (metadata === null || typeof metadata !== "object" || !Array.isArray(metadata.packages)) {
    throw toolError(`${policy.id}: cargo metadata did not return a packages array`);
  }
  if (metadata.resolve === null || typeof metadata.resolve !== "object" || !Array.isArray(metadata.resolve.nodes)) {
    throw toolError(`${policy.id}: cargo metadata did not return a full resolved dependency graph`);
  }
  const resolvedIds = new Set(metadata.resolve.nodes.map((node) => node.id));
  const resolved = metadata.packages.filter((pkg) => resolvedIds.has(pkg.id));
  const byName = new Map();
  for (const pkg of resolved) {
    const entries = byName.get(pkg.name) ?? [];
    entries.push(pkg);
    byName.set(pkg.name, entries);
  }
  const failures = [];
  for (const required of policy.requiredPackages) {
    const entries = byName.get(required) ?? [];
    if (entries.length !== 1) {
      failures.push(`${policy.id}: metadata expected exactly one resolved ${required} package, found ${entries.length}`);
    }
  }
  const candidateByName = new Map(candidatePackages.map((entry) => [entry.name, entry]));
  let resolvedCandidates = 0;
  for (const [name, candidate] of candidateByName) {
    const entries = byName.get(name) ?? [];
    if (entries.length === 0) continue;
    resolvedCandidates += entries.length;
    for (const pkg of entries) {
      if (pkg.version !== candidate.vers) {
        failures.push(`${policy.id}: metadata resolved selected candidate ${name}@${pkg.version}; expected ${candidate.vers}`);
      }
      if (pkg.source !== EXAMPLE_CARGO_REGISTRY_SOURCE) {
        failures.push(`${policy.id}: metadata resolved selected candidate ${name}@${pkg.version} from ${pkg.source ?? "path"}`);
      }
      if (pkg.checksum !== null && pkg.checksum !== undefined && pkg.checksum !== candidate.cksum) {
        failures.push(`${policy.id}: metadata checksum for ${name}@${pkg.version} differs from the candidate index`);
      }
    }
  }
  if (failures.length > 0) throw toolError(failures.join("\n"));
  return {
    packages: metadata.packages.length,
    resolvedNodes: metadata.resolve.nodes.length,
    resolvedCandidates,
  };
}

function parseArgs(argv) {
  const options = {
    build: false,
    evidence: null,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    policyIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--index" || arg === "--output-root" || arg === "--policy" || arg === "--evidence") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw toolError(`${arg} requires a value`);
      index += 1;
      if (arg === "--index") options.indexDirectory = value;
      if (arg === "--output-root") options.outputRoot = value;
      if (arg === "--policy") options.policyIds.push(value);
      if (arg === "--evidence") options.evidence = value;
      continue;
    }
    if (arg === "--build") {
      options.build = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw toolError(`unknown argument ${arg}`);
  }
  return options;
}

function usage() {
  return "usage: tools/release/validate-example-cargo-candidates.mjs --index DIR [--output-root DIR] [--policy ID ...] [--build] [--evidence FILE]";
}

export function validateExampleCargoCandidates({
  indexDirectory,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  policyIds = [],
  build = false,
  evidence,
}) {
  const manifestFailures = validateExampleManifests();
  if (manifestFailures.length > 0) throw toolError(manifestFailures.join("\n"));
  const index = path.resolve(indexDirectory);
  const output = path.resolve(outputRoot);
  const registry = validateCandidateRegistry(index);
  const selected = policyIds.length === 0
    ? EXAMPLE_CARGO_POLICIES
    : policyIds.map((id) => exampleCargoPolicyById(id));
  if (new Set(selected.map((policy) => policy.id)).size !== selected.length) {
    throw toolError("each --policy may be selected only once");
  }

  const policies = [];
  const sharedCargoHome = path.join(output, "cargo-home");
  rmSync(sharedCargoHome, { recursive: true, force: true });
  for (const policy of selected) {
    process.stderr.write(`${TOOL}: preparing ${policy.id}\n`);
    const prepared = prepareExampleCargoCandidate({
      policyId: policy.id,
      indexDirectory: index,
      outputRoot: output,
      registryValidation: registry,
      cargoHome: sharedCargoHome,
      resetCargoHome: false,
    });
    const commandContext = prepared.prepared;
    runExampleCargo(["fetch", "--locked"], commandContext);
    const metadataText = runExampleCargo(
      ["metadata", "--locked", "--format-version", "1", "--all-features"],
      commandContext,
    );
    let metadata;
    try {
      metadata = JSON.parse(metadataText);
    } catch (error) {
      throw toolError(`${policy.id}: cargo metadata returned invalid JSON: ${error.message}`);
    }
    const metadataEvidence = validateCandidateMetadata(policy.id, metadata, registry.packages);
    if (build) {
      runExampleCargo(["build", "--locked", "--all-targets", "--all-features"], commandContext);
    }
    const lock = validateCandidateLock(
      policy.id,
      prepared.prepared.lockfile,
      index,
      { registryVerified: true },
    );
    if (lock.sha256 !== prepared.prepared.lockfileSha256) {
      throw toolError(`${policy.id}: Cargo.lock changed during locked fetch or metadata validation`);
    }
    policies.push({
      policy: policy.id,
      preparedEvidence: prepared.evidenceFile,
      crateDir: prepared.prepared.crateDir,
      cargoHome: prepared.prepared.cargoHome,
      cargoTargetDir: prepared.prepared.cargoTargetDir,
      manifestSha256: prepared.prepared.manifestSha256,
      lockfile: prepared.prepared.lockfile,
      lockfileSha256: lock.sha256,
      lockPackages: lock.packages,
      lockCandidatePackages: lock.candidatePackages,
      metadataSha256: sha256(metadataText),
      ...metadataEvidence,
      built: build,
    });
  }

  const result = {
    schema: 1,
    candidateRegistry: {
      index,
      packages: registry.packages.length,
      sha256: registry.sha256,
    },
    policies,
  };
  const evidenceFile = writeExampleCargoEvidence(
    evidence ?? path.join(output, "evidence.json"),
    result,
  );
  return { ...result, evidenceFile };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.indexDirectory === undefined) throw toolError(usage());
  const result = validateExampleCargoCandidates(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  try {
    main(Bun.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
