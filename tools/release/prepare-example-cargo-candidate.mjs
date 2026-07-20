#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  EXAMPLE_CARGO_REGISTRY_INDEX,
  configureExampleCargoRegistry,
  exampleCargoCandidatePatchConfig,
} from "./example-cargo-registry.mjs";
import {
  exampleCargoPolicyById,
  validateCandidateLock,
  validateCandidateRegistry,
  validateExampleManifests,
} from "./example-cargo-policy.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "prepare-example-cargo-candidate.mjs";
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "target/release-work/example-cargo-candidates");

function toolError(message) {
  return new Error(`${TOOL}: ${message}`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function assertSafeExampleScratchDestination(destination) {
  const resolved = path.resolve(destination);
  const repositoryTarget = path.join(ROOT, "target");
  if (isInside(ROOT, resolved) && !isInside(repositoryTarget, resolved)) {
    throw toolError(`scratch destination inside the repository must be below ${repositoryTarget}: ${resolved}`);
  }
  return resolved;
}

function sourceManifestIsRegistryNeutral(manifestFile) {
  const contents = readFileSync(manifestFile, "utf8");
  const manifest = Bun.TOML.parse(contents);
  if (Object.hasOwn(manifest, "patch")) {
    throw toolError(`${manifestFile} must not contain committed Cargo patches`);
  }
  const pending = [manifest];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object") continue;
    if (Object.hasOwn(value, "registry") && value.registry === "oliphaunt-local") {
      throw toolError(`${manifestFile} must use normal crates.io dependencies, not registry = "oliphaunt-local"`);
    }
    pending.push(...Object.values(value));
  }
  return contents;
}

export function copyExampleCrateToScratch({ sourceDirectory, destination, candidatePackages }) {
  const source = path.resolve(sourceDirectory);
  const scratch = assertSafeExampleScratchDestination(destination);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw toolError(`missing source example crate ${source}`);
  }
  if (isInside(source, scratch) || isInside(scratch, source)) {
    throw toolError(`source and scratch directories must not contain one another: ${source} and ${scratch}`);
  }
  const sourceManifest = path.join(source, "Cargo.toml");
  if (!existsSync(sourceManifest)) throw toolError(`missing source manifest ${sourceManifest}`);
  const originalManifest = sourceManifestIsRegistryNeutral(sourceManifest);
  const originalSha256 = sha256File(sourceManifest);

  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(path.dirname(scratch), { recursive: true });
  cpSync(source, scratch, {
    recursive: true,
    filter(file) {
      const relative = path.relative(source, file);
      if (relative === "") return true;
      const segments = relative.split(path.sep);
      return !segments.includes("target") && path.basename(file) !== "Cargo.lock";
    },
  });

  const scratchManifest = path.join(scratch, "Cargo.toml");
  const patch = exampleCargoCandidatePatchConfig(candidatePackages);
  if (patch.length === 0) throw toolError("candidate Cargo registry must contain at least one patch package");
  writeFileSync(scratchManifest, `${originalManifest.trimEnd()}\n\n${patch}`, "utf8");
  if (existsSync(path.join(scratch, "Cargo.lock"))) {
    throw toolError(`${scratch}/Cargo.lock must be generated only after candidate patches are injected`);
  }
  if (sha256File(sourceManifest) !== originalSha256) {
    throw toolError(`source manifest changed while preparing scratch crate: ${sourceManifest}`);
  }
  return {
    source,
    sourceManifestSha256: originalSha256,
    crateDir: scratch,
    manifest: scratchManifest,
    manifestSha256: sha256File(scratchManifest),
  };
}

export function runExampleCargo(args, { crateDir, cargoHome, cargoTargetDir }) {
  const result = spawnSync("cargo", args, {
    cwd: crateDir,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      CARGO_TARGET_DIR: cargoTargetDir,
      CARGO_REGISTRIES_OLIPHAUNT_LOCAL_INDEX: EXAMPLE_CARGO_REGISTRY_INDEX,
      CARGO_TERM_COLOR: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw toolError(`cargo ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw toolError(`cargo ${args.join(" ")} failed${output.length > 0 ? `:\n${output}` : ""}`);
  }
  return result.stdout;
}

export function writeExampleCargoEvidence(file, value) {
  const destination = assertSafeExampleScratchDestination(file);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, destination);
  return destination;
}

export function prepareExampleCargoCandidate({
  policyId,
  indexDirectory,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  registryValidation,
  cargoHome: cargoHomeOverride,
  resetCargoHome = true,
}) {
  const policy = exampleCargoPolicyById(policyId);
  const index = path.resolve(indexDirectory);
  const output = path.resolve(outputRoot);
  const validatedRegistry = registryValidation ?? validateCandidateRegistry(index);
  const workDir = assertSafeExampleScratchDestination(path.join(output, policy.id));
  const crateDir = path.join(workDir, "crate");
  const cargoHome = cargoHomeOverride === undefined
    ? path.join(workDir, "cargo-home")
    : assertSafeExampleScratchDestination(cargoHomeOverride);
  const cargoTargetDir = path.join(workDir, "cargo-target");

  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const copied = copyExampleCrateToScratch({
    sourceDirectory: path.join(ROOT, policy.crateDir),
    destination: crateDir,
    candidatePackages: validatedRegistry.packages,
  });
  if (resetCargoHome) rmSync(cargoHome, { recursive: true, force: true });
  rmSync(cargoTargetDir, { recursive: true, force: true });
  configureExampleCargoRegistry({ cargoHome, indexDirectory: index });

  runExampleCargo(["generate-lockfile"], { crateDir, cargoHome, cargoTargetDir });
  const lockfile = path.join(crateDir, "Cargo.lock");
  if (!existsSync(lockfile)) throw toolError(`cargo generate-lockfile did not create ${lockfile}`);
  const lock = validateCandidateLock(policy.id, lockfile, index, { registryVerified: true });
  const evidence = {
    schema: 1,
    policy: policy.id,
    sourceCrateDir: path.relative(ROOT, copied.source).split(path.sep).join("/"),
    sourceManifestSha256: copied.sourceManifestSha256,
    candidateRegistry: {
      index,
      packages: validatedRegistry.packages.length,
      sha256: validatedRegistry.sha256,
    },
    prepared: {
      workDir,
      crateDir,
      cargoHome,
      cargoTargetDir,
      manifestSha256: copied.manifestSha256,
      lockfile,
      lockfileSha256: lock.sha256,
      packages: lock.packages,
      candidatePackages: lock.candidatePackages,
    },
  };
  const evidenceFile = writeExampleCargoEvidence(path.join(workDir, "prepare-evidence.json"), evidence);
  return { ...evidence, evidenceFile };
}

function parseArgs(argv) {
  const options = { outputRoot: DEFAULT_OUTPUT_ROOT, evidence: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy" || arg === "--index" || arg === "--output-root" || arg === "--evidence") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw toolError(`${arg} requires a value`);
      index += 1;
      if (arg === "--policy") options.policyId = value;
      if (arg === "--index") options.indexDirectory = value;
      if (arg === "--output-root") options.outputRoot = value;
      if (arg === "--evidence") options.evidence = value;
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
  return "usage: tools/release/prepare-example-cargo-candidate.mjs --policy ID --index DIR [--output-root DIR] [--evidence FILE]";
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.policyId === undefined || options.indexDirectory === undefined) throw toolError(usage());
  const manifestFailures = validateExampleManifests();
  if (manifestFailures.length > 0) throw toolError(manifestFailures.join("\n"));
  const result = prepareExampleCargoCandidate(options);
  if (options.evidence !== null) writeExampleCargoEvidence(options.evidence, result);
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
