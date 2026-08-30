#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareText,
  exactExtensionProducts,
  extensionArtifactProductRoot,
  extensionSqlNames,
  extensionWasixAotMemberSqlNames,
} from "../../../../tools/release/release-artifact-targets.mjs";
import { assertCanonicalWasixAotManifest } from "../../../../tools/release/wasix-aot-manifest.mjs";

const PREFIX = "check-wasix-napi-build-inputs.mjs";
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  for (const required of [
    "target",
    "target-triple",
    "portable-root",
    "aot-root",
    "extension-root",
    "icu-root",
  ]) {
    if (!options[required]) fail(`--${required} is required`);
  }
  if (Boolean(options.output) === Boolean(options.check)) {
    fail("exactly one of --output or --check is required");
  }
  return options;
}

function repoPath(file, label) {
  const resolved = path.resolve(file);
  const relative = path.relative(WORKSPACE_ROOT, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} must be inside the repository: ${resolved}`);
  }
  return relative.split(path.sep).join("/");
}

function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    fail(`${label} is missing: ${repoPath(file, label)} (${error.message})`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    fail(`${label} must be a non-empty regular non-symlink file: ${repoPath(file, label)}`);
  }
  return metadata;
}

function directory(root, label) {
  let metadata;
  try {
    metadata = lstatSync(root);
  } catch (error) {
    fail(`${label} is missing: ${repoPath(root, label)} (${error.message})`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink directory: ${repoPath(root, label)}`);
  }
}

function readJson(file, label) {
  regularFile(file, label);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256(file) {
  return sha256Bytes(readFileSync(file));
}

function safeMember(value, label) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    fail(`${label} must be a non-empty relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized !== value
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label} is not a canonical portable path: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateDigestFile(file, expected, label) {
  const metadata = regularFile(file, label);
  if (!SHA256.test(expected ?? "")) fail(`${label} manifest digest is not lowercase SHA-256`);
  const actual = sha256(file);
  if (actual !== expected) fail(`${label} digest mismatch: expected ${expected}, got ${actual}`);
  return metadata;
}

function portableInputs(portableRoot) {
  directory(portableRoot, "portable WASIX artifact root");
  const manifestFile = path.join(portableRoot, "manifest.json");
  const manifest = readJson(manifestFile, "portable WASIX manifest");
  if (manifest?.["format-version"] !== 2) fail("portable WASIX manifest must use format-version 2");
  if (typeof manifest["source-fingerprint"] !== "string" || !manifest["source-fingerprint"]) {
    fail("portable WASIX manifest must contain a source-fingerprint");
  }
  const runtimeArchive = safeMember(manifest.runtime?.archive, "portable runtime archive");
  validateDigestFile(
    path.join(portableRoot, runtimeArchive),
    manifest.runtime?.sha256,
    "portable WASIX runtime archive",
  );
  regularFile(path.join(portableRoot, "bin/initdb.wasix.wasm"), "portable WASIX initdb module");

  for (const profile of ["standard", "icu"]) {
    const seed = manifest["cluster-seeds"]?.[profile];
    if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
      fail(`portable WASIX manifest is missing ${profile} cluster seed metadata`);
    }
    const archive = safeMember(seed.archive, `${profile} cluster seed archive`);
    const seedManifest = safeMember(seed.manifest, `${profile} cluster seed manifest`);
    validateDigestFile(
      path.join(portableRoot, archive),
      seed.sha256,
      `${profile} cluster seed archive`,
    );
    regularFile(path.join(portableRoot, seedManifest), `${profile} cluster seed manifest`);
  }

  const portableTools = [
    ["pg_dump", "bin/pg_dump.wasix.wasm"],
    ["psql", "bin/psql.wasix.wasm"],
  ].map(([name, relative]) => {
    const file = path.join(portableRoot, relative);
    regularFile(file, `portable WASIX ${name} module`);
    return { name, path: repoPath(file, `portable WASIX ${name} module`), sha256: sha256(file) };
  });

  return {
    manifest,
    provenance: {
      portableManifest: {
        path: repoPath(manifestFile, "portable WASIX manifest"),
        sha256: sha256(manifestFile),
      },
      portableTools,
    },
  };
}

function validateAotManifest(file, targetTriple, sourceFingerprint, label, namePredicate) {
  const manifest = readJson(file, label);
  try {
    assertCanonicalWasixAotManifest(manifest, {
      context: repoPath(file, label),
      expectedTarget: targetTriple,
    });
  } catch (error) {
    fail(error.message);
  }
  if (manifest["source-fingerprint"] !== sourceFingerprint) {
    fail(`${label} source-fingerprint does not match the portable WASIX runtime`);
  }
  const names = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const name = artifact?.name;
    if (typeof name !== "string" || !namePredicate(name)) {
      fail(`${label} artifact ${index} has an unexpected name ${JSON.stringify(name)}`);
    }
    if (names.has(name)) fail(`${label} repeats artifact ${name}`);
    names.add(name);
    const relative = safeMember(artifact.path, `${label} artifact ${name}`);
    validateDigestFile(path.join(path.dirname(file), relative), artifact.sha256, `${label} artifact ${name}`);
  }
  return { manifest, names };
}

function runtimeAotInputs(aotRoot, targetTriple, sourceFingerprint) {
  directory(aotRoot, "WASIX AOT artifact root");
  const targetRoot = path.basename(path.resolve(aotRoot)) === targetTriple
    ? path.resolve(aotRoot)
    : path.join(aotRoot, targetTriple);
  const manifestFile = path.join(targetRoot, "manifest.json");
  const { names } = validateAotManifest(
    manifestFile,
    targetTriple,
    sourceFingerprint,
    "host WASIX AOT manifest",
    (name) => !name.startsWith("extension:"),
  );
  for (const tool of ["tool:pg_dump", "tool:psql"]) {
    if (!names.has(tool)) fail(`host WASIX AOT manifest is missing ${tool}`);
  }
  if (![...names].some((name) => !name.startsWith("tool:"))) {
    fail("host WASIX AOT manifest contains tools but no core runtime artifacts");
  }
  return {
    targetTriple,
    path: repoPath(manifestFile, "host WASIX AOT manifest"),
    sha256: sha256(manifestFile),
  };
}

function manifestMembers(manifest, product) {
  if (manifest.schema === "oliphaunt-extension-ci-artifacts-v1") return [manifest];
  if (manifest.schema === "oliphaunt-extension-ci-artifacts-v2" && Array.isArray(manifest.extensions)) {
    return manifest.extensions;
  }
  fail(`${product} has an unsupported extension-artifacts schema ${JSON.stringify(manifest.schema)}`);
}

function extensionInputs(extensionRoot, target, targetTriple, sourceFingerprint) {
  directory(extensionRoot, "WASIX extension artifact root");
  return exactExtensionProducts(PREFIX).map((product) => {
    const productRoot = extensionArtifactProductRoot(product, "wasix", extensionRoot, PREFIX);
    const manifestFile = path.join(productRoot, "extension-artifacts.json");
    const manifest = readJson(manifestFile, `${product} extension artifact manifest`);
    if (manifest.product !== product) fail(`${repoPath(manifestFile, product)} identifies ${manifest.product}`);
    const members = manifestMembers(manifest, product);
    const expectedSqlNames = extensionSqlNames(product, PREFIX).sort(compareText);
    const actualSqlNames = members.map((member) => member?.sqlName).sort(compareText);
    if (JSON.stringify(actualSqlNames) !== JSON.stringify(expectedSqlNames)) {
      fail(`${product} extension member inventory is not exact`);
    }
    const portableArchives = members.map((member) => {
      const matches = Array.isArray(member.assets)
        ? member.assets.filter((asset) =>
            asset?.family === "wasix"
            && asset.target === "wasix-portable"
            && asset.kind === "wasix-runtime"
          )
        : [];
      if (matches.length !== 1) fail(`${product}/${member.sqlName} must have one portable WASIX asset`);
      const asset = matches[0];
      const file = manifest.schema === "oliphaunt-extension-ci-artifacts-v2"
        ? path.join(productRoot, "member-assets", member.sqlName, asset.name)
        : path.join(productRoot, "release-assets", asset.name);
      const metadata = validateDigestFile(file, asset.sha256, `${product}/${member.sqlName} portable archive`);
      if (metadata.size !== asset.bytes) fail(`${product}/${member.sqlName} portable archive size changed`);
      return {
        sqlName: member.sqlName,
        path: repoPath(file, `${product}/${member.sqlName} portable archive`),
        sha256: asset.sha256,
      };
    }).sort((left, right) => compareText(left.sqlName, right.sqlName));

    const aotManifests = extensionWasixAotMemberSqlNames(product, PREFIX).map((sqlName) => {
      const targetRoot = path.join(productRoot, "wasix-aot", target);
      const file = manifest.schema === "oliphaunt-extension-ci-artifacts-v2"
        ? path.join(targetRoot, sqlName, "manifest.json")
        : path.join(targetRoot, "manifest.json");
      const { names } = validateAotManifest(
        file,
        targetTriple,
        sourceFingerprint,
        `${product}/${sqlName} AOT manifest`,
        (name) => name === `extension:${sqlName}` || name.startsWith(`extension:${sqlName}:`),
      );
      if (names.size === 0) fail(`${product}/${sqlName} AOT manifest has no artifacts`);
      return {
        sqlName,
        targetTriple,
        path: repoPath(file, `${product}/${sqlName} AOT manifest`),
        sha256: sha256(file),
      };
    }).sort((left, right) => compareText(left.sqlName, right.sqlName));

    return {
      product,
      manifest: {
        path: repoPath(manifestFile, `${product} extension artifact manifest`),
        sha256: sha256(manifestFile),
      },
      portableArchives,
      aotManifests,
    };
  }).sort((left, right) => compareText(left.product, right.product));
}

function visitRegularFiles(root, files = []) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`ICU input contains a symlink: ${repoPath(file, "ICU input")}`);
    if (entry.isDirectory()) visitRegularFiles(file, files);
    else if (entry.isFile()) files.push(file);
    else fail(`ICU input contains a non-regular entry: ${repoPath(file, "ICU input")}`);
  }
  return files;
}

function icuInput(icuRoot) {
  directory(icuRoot, "ICU data root");
  const files = visitRegularFiles(icuRoot);
  if (files.length === 0) fail("ICU data root must not be empty");
  const records = files.map((file) => {
    const relative = path.relative(icuRoot, file).split(path.sep).join("/");
    return `${sha256(file)}  ${relative}\n`;
  });
  return {
    path: repoPath(icuRoot, "ICU data root"),
    sha256: sha256Bytes(Buffer.from(records.join(""), "utf8")),
    fileCount: files.length,
  };
}

function buildInventory(options) {
  const portableRoot = path.resolve(options["portable-root"]);
  const aotRoot = path.resolve(options["aot-root"]);
  const extensionRoot = path.resolve(options["extension-root"]);
  const icuRoot = path.resolve(options["icu-root"]);
  const portable = portableInputs(portableRoot);
  return {
    schema: "oliphaunt-wasix-napi-build-inputs-v1",
    target: options.target,
    targetTriple: options["target-triple"],
    inputs: {
      ...portable.provenance,
      runtimeAotManifest: runtimeAotInputs(
        aotRoot,
        options["target-triple"],
        portable.manifest["source-fingerprint"],
      ),
      extensionArtifacts: extensionInputs(
        extensionRoot,
        options.target,
        options["target-triple"],
        portable.manifest["source-fingerprint"],
      ),
      icuData: icuInput(icuRoot),
    },
  };
}

function main() {
  const options = parseArguments(Bun.argv.slice(2));
  const rendered = `${JSON.stringify(buildInventory(options), null, 2)}\n`;
  const destination = path.resolve(options.output ?? options.check);
  repoPath(destination, options.output ? "build input inventory output" : "build input inventory check");
  if (options.output) {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, rendered, { encoding: "utf8", mode: 0o600 });
  } else {
    regularFile(destination, "recorded build input inventory");
    if (readFileSync(destination, "utf8") !== rendered) {
      fail("WASIX build inputs changed while compiling the Node-API addon");
    }
  }
  console.log(`WASIX Node-API build inputs validated: ${repoPath(destination, "build input inventory")}`);
}

try {
  main();
} catch (error) {
  console.error(`${PREFIX}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
