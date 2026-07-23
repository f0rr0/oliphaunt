#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { cargoPackageIdentityFromCrate } from "./local-registry-publish.mjs";
import {
  compareText,
  currentProductVersionSync,
  registryPackageRows,
} from "./release-artifact-targets.mjs";
import { consumeExactCargoCandidates } from "./exact-cargo-candidate-consumer.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const TOOL = "wasix-rust-exact-candidate-consumer.mjs";
const SDK_PRODUCT = "oliphaunt-wasix-rust";
const SDK_PACKAGE = "oliphaunt-wasix";
const RUNTIME_PRODUCT = "liboliphaunt-wasix";

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function relative(file) {
  const value = path.relative(ROOT, file);
  return value.startsWith("..") || path.isAbsolute(value) ? file : value.split(path.sep).join("/");
}

function pathInside(parent, child) {
  const value = path.relative(path.resolve(parent), path.resolve(child));
  return value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value));
}

function filesUnder(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw error(`missing input directory ${root}`);
  const realRoot = realpathSync(root);
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const file = path.join(directory, entry.name);
      const metadata = lstatSync(file);
      if (metadata.isSymbolicLink()) throw error(`input directory contains forbidden symbolic link ${file}`);
      if (metadata.isDirectory()) {
        pending.push(file);
      } else if (metadata.isFile()) {
        if (!pathInside(realRoot, realpathSync(file))) throw error(`input file escapes its root: ${file}`);
        files.push(file);
      } else {
        throw error(`input directory contains unsupported entry ${file}`);
      }
    }
  }
  return files.sort(compareText);
}

function run(command, args, { timeout = 30 * 60_000 } = {}) {
  const result = captureCommandOutput(command, args, {
    cwd: ROOT,
    label: `${command} ${args.join(" ")}`,
    maxOutputBytes: 100 * 1024 * 1024,
    timeout,
  });
  if (result.error !== undefined) throw error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

export function wasixRustCandidateContract() {
  return {
    products: [RUNTIME_PRODUCT, SDK_PRODUCT],
    sdk: {
      name: SDK_PACKAGE,
      version: currentProductVersionSync(SDK_PRODUCT, TOOL),
      features: ["icu", "tools"],
    },
    runtimePackages: registryPackageRows({ product: RUNTIME_PRODUCT, packageKind: "crates" }, TOOL)
      .map(({ packageName }) => packageName)
      .sort(compareText),
  };
}

export function requireExactWasixSdkCrate(sdkRoot, contract = wasixRustCandidateContract()) {
  const crates = filesUnder(sdkRoot).filter((file) => file.endsWith(".crate"));
  if (crates.length !== 1) throw error(`expected exactly one staged ${SDK_PACKAGE} .crate, found ${crates.length}`);
  const [crate] = crates;
  const identity = cargoPackageIdentityFromCrate(crate);
  if (identity?.name !== contract.sdk.name || identity.version !== contract.sdk.version) {
    throw error(
      `staged WASIX Rust crate identity must be ${contract.sdk.name}@${contract.sdk.version}, got ${identity?.name ?? "unknown"}@${identity?.version ?? "unknown"}`,
    );
  }
  return {
    path: crate,
    name: identity.name,
    version: identity.version,
    bytes: statSync(crate).size,
    sha256: sha256File(crate),
  };
}

function packageRuntimeCandidates(runtimeAssetRoot, outputRoot, contract) {
  const outputDir = path.join(outputRoot, "generated-runtime-cargo");
  const emptyExtensionRoot = path.join(outputRoot, "empty-extension-artifacts");
  mkdirSync(emptyExtensionRoot, { recursive: true });
  run(process.execPath, [
    "tools/release/package_liboliphaunt_wasix_cargo_artifacts.mjs",
    "--version", currentProductVersionSync(RUNTIME_PRODUCT, TOOL),
    "--asset-dir", runtimeAssetRoot,
    "--output-dir", outputDir,
    "--extension-artifact-root", emptyExtensionRoot,
  ]);
  const manifestFile = path.join(outputDir, "packages.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!Array.isArray(manifest.packages)) throw error(`${manifestFile} must contain package rows`);
  const actual = manifest.packages.map(({ name }) => name).sort(compareText);
  const missing = contract.runtimePackages.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) =>
    !contract.runtimePackages.includes(name)
    && !contract.runtimePackages.some((parent) =>
      name.startsWith(`${parent}-part-`) && /^\d{3}$/u.test(name.slice(`${parent}-part-`.length))));
  if (missing.length > 0 || unexpected.length > 0) {
    throw error(`WASIX runtime Cargo candidate mismatch: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`);
  }
  return {
    outputDir,
    manifest: {
      path: relative(manifestFile),
      bytes: statSync(manifestFile).size,
      sha256: sha256File(manifestFile),
      packages: manifest.packages.map(({ name, cratePath, sha256, size }) => ({ name, cratePath, sha256, size }))
        .sort((left, right) => compareText(left.name, right.name)),
    },
  };
}

function assembleRegistry(sdkRoot, runtimeCandidates, outputRoot, contract) {
  const registryRoot = path.join(outputRoot, "candidate-registry");
  run(process.execPath, [
    "tools/release/local-registry-publish.mjs",
    "publish",
    "--surface", "cargo",
    "--strict",
    "--exact-artifacts",
    "--products-json", JSON.stringify(contract.products),
    "--artifact-root", sdkRoot,
    "--artifact-root", runtimeCandidates.outputDir,
    "--registry-root", registryRoot,
  ]);
  return registryRoot;
}

export function runWasixRustExactCandidateConsumer({
  candidateSha,
  sdkRoot,
  runtimeAssetRoot,
  outputRoot,
}) {
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) throw error("candidateSha must be a full lowercase Git object ID");
  const checkoutSha = run("git", ["rev-parse", "HEAD"]).trim();
  if (checkoutSha !== candidateSha) throw error(`checkout SHA ${checkoutSha} differs from candidate ${candidateSha}`);
  const output = path.resolve(outputRoot);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(output, "evidence"), { recursive: true });
  const contract = wasixRustCandidateContract();

  const sdkCandidate = requireExactWasixSdkCrate(path.resolve(sdkRoot), contract);
  console.log("OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=sdk-frozen-crate");

  const runtimeCandidates = packageRuntimeCandidates(path.resolve(runtimeAssetRoot), output, contract);
  console.log("OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=runtime-cargo-candidates");

  const registryRoot = assembleRegistry(path.resolve(sdkRoot), runtimeCandidates, output, contract);
  console.log("OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=local-registry");

  const cargo = consumeExactCargoCandidates({
    indexDirectory: path.join(registryRoot, "cargo/index"),
    outputRoot: path.join(output, "cargo-consumer"),
    packageName: "oliphaunt-wasix-rust-exact-candidate-consumer",
    dependencies: [{
      name: contract.sdk.name,
      version: contract.sdk.version,
      defaultFeatures: false,
      features: contract.sdk.features,
    }],
  });
  const expected = new Set([contract.sdk.name, ...contract.runtimePackages]);
  const installedNames = new Set(cargo.installed.map(({ name }) => name));
  const missing = [...expected].filter((name) => !installedNames.has(name)).sort(compareText);
  if (missing.length > 0) throw error(`clean WASIX Rust consumer omitted required local registry packages: ${missing.join(", ")}`);
  console.log("OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_STAGE_PASS stage=clean-fetch");

  const evidence = {
    schema: "oliphaunt-wasix-rust-exact-candidate-consumer-v1",
    candidate: {
      sha: candidateSha,
      tree: run("git", ["rev-parse", "HEAD^{tree}"]).trim(),
    },
    contract,
    sdkCandidate: { ...sdkCandidate, path: relative(sdkCandidate.path) },
    runtimeCandidates: runtimeCandidates.manifest,
    cargo,
  };
  writeFileSync(path.join(output, "evidence/exact-candidate.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(
    path.join(output, "evidence/local-registry-report.json"),
    readFileSync(path.join(registryRoot, "report.json")),
  );
  console.log("OLIPHAUNT_WASIX_RUST_EXACT_CANDIDATE_CONSUMER_PASS");
  return evidence;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--candidate-sha", "--sdk-root", "--runtime-asset-root", "--output-root"].includes(option)) {
      throw error(`unknown argument ${option}`);
    }
    if (values.has(option)) throw error(`${option} may be specified only once`);
    values.set(option, requiredValue(argv, ++index, option));
  }
  for (const option of ["--candidate-sha", "--sdk-root", "--runtime-asset-root", "--output-root"]) {
    if (!values.has(option)) throw error(`${option} is required`);
  }
  return {
    candidateSha: values.get("--candidate-sha"),
    sdkRoot: path.resolve(ROOT, values.get("--sdk-root")),
    runtimeAssetRoot: path.resolve(ROOT, values.get("--runtime-asset-root")),
    outputRoot: path.resolve(ROOT, values.get("--output-root")),
  };
}

if (import.meta.main) {
  try {
    runWasixRustExactCandidateConsumer(parseArgs(Bun.argv.slice(2)));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
