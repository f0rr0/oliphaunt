#!/usr/bin/env bun
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterAll, expect, test } from "bun:test";

import { createDeterministicTar } from "./cargo-source-package.mjs";
import {
  stageExtensionNpmPackagesForTargets,
  stageExtensionWasixNpmPackages,
} from "./package-extension-release-carriers.mjs";
import {
  extensionNpmPackageForProduct,
  extensionNpmWasixPackageForProduct,
  extensionRegistryPackageEntries,
} from "./extension-registry-packages.mjs";
import { canonicalGzipSync } from "./portable-archive.mjs";
import {
  currentProductVersionSync,
  extensionReleaseVersion,
  extensionRegistryPackageTargetSets,
} from "./release-artifact-targets.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const directories = [];

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(name) {
  const root = mkdtempSync(path.join(os.tmpdir(), name));
  directories.push(root);
  return root;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deterministicTar(stage, archiveRoot) {
  return createDeterministicTar(stage, archiveRoot, {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  });
}

function portableExtensionBytes(root, sqlName) {
  const stage = path.join(root, "portable-members", sqlName);
  const control = path.join(stage, "postgresql", "extension", `${sqlName}.control`);
  mkdirSync(path.dirname(control), { recursive: true });
  writeFileSync(control, `comment = '${sqlName} fixture'\ndefault_version = '1.0'\n`);
  return zstdCompressSync(deterministicTar(stage, "share"));
}

function compatibility() {
  return {
    extensionRuntimeContract: "src/shared/extension-runtime-contract/contract.toml",
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion: currentProductVersionSync("liboliphaunt-native", "extension-wasix-npm-packages.test"),
    postgresMajor: "18",
    wasixRuntimeProduct: "liboliphaunt-wasix",
    wasixRuntimeVersion: currentProductVersionSync("liboliphaunt-wasix", "extension-wasix-npm-packages.test"),
  };
}

function wasixInstall(sqlName, dependencies = []) {
  return {
    schema: "oliphaunt-wasix-extension-install-v1",
    name: sqlName,
    nativeModule: null,
    nativeModules: [],
    coreExportsRequired: [],
    dependencies,
    loadOrder: [],
    lifecycle: {
      createExtension: true,
      createSchema: "pg_catalog",
      loadSql: [],
      postCreateSql: [],
      startupConfig: [],
      preloadRequired: false,
      restartRequired: false,
      sharedMemoryRequired: false,
    },
    installedFiles: [`share/postgresql/extension/${sqlName}.control`],
    unresolvedImports: [],
  };
}

function inventory(sqlName, dependencies = []) {
  return {
    sqlName,
    createsExtension: true,
    nativeModuleStem: null,
    dependencies,
    dataFiles: [],
    extensionSqlFileNames: [`${sqlName}.control`],
    extensionSqlFilePrefixes: [sqlName],
    sharedPreloadLibraries: [],
  };
}

function singletonFixture(root, { dependencies = ["plpgsql"] } = {}) {
  const product = "oliphaunt-extension-pgtap";
  const version = "9.8.7";
  const sqlName = "pgtap";
  const extensionRoot = path.join(root, product);
  const releaseAssets = path.join(extensionRoot, "release-assets");
  const name = `${product}-${version}-wasix-portable.tar.zst`;
  const archive = path.join(releaseAssets, name);
  const bytes = portableExtensionBytes(root, sqlName);
  mkdirSync(releaseAssets, { recursive: true });
  writeFileSync(archive, bytes);
  const member = inventory(sqlName, dependencies);
  member.wasixInstall = wasixInstall(sqlName, dependencies);
  const asset = {
    name,
    family: "wasix",
    target: "wasix-portable",
    kind: "wasix-runtime",
    identity: null,
    path: archive,
    sha256: sha256Bytes(bytes),
    bytes: bytes.length,
  };
  const frozenCompatibility = compatibility();
  writeFileSync(path.join(extensionRoot, "extension-artifacts.json"), `${JSON.stringify({
    schema: "oliphaunt-extension-ci-artifacts-v1",
    product,
    version,
    compatibility: frozenCompatibility,
    ...member,
    assets: [asset],
  }, null, 2)}\n`);
  writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
    schema: "oliphaunt-extension-release-manifest-v1",
    product,
    version,
    versioning: "upstream-bound",
    compatibility: frozenCompatibility,
    ...member,
    assets: [asset],
  }, null, 2)}\n`);
  return { extensionRoot, product, sqlName, version };
}

function bundleFixture(root) {
  const product = "oliphaunt-extension-contrib-pg18";
  const version = extensionReleaseVersion(product, "wasix", "extension-wasix-npm-packages.test");
  const extensionRoot = path.join(root, product);
  const releaseAssets = path.join(extensionRoot, "release-assets");
  const archiveRoot = `${product}-${version}-wasix-wasix-portable-bundle`;
  const carrierName = `${archiveRoot}.tar.gz`;
  const aggregateStage = path.join(root, "aggregate-stage");
  const members = [
    inventory("cube"),
    inventory("earthdistance", ["cube"]),
  ].map((member) => {
    const bytes = portableExtensionBytes(root, member.sqlName);
    const name = `${product}-${version}-wasix-portable.tar.zst`;
    const memberPath = `extensions/${member.sqlName}/${name}`;
    const file = path.join(aggregateStage, ...memberPath.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return {
      ...member,
      wasixInstall: wasixInstall(member.sqlName, member.dependencies),
      assets: [{
        name,
        family: "wasix",
        target: "wasix-portable",
        kind: "wasix-runtime",
        identity: null,
        path: file,
        sha256: sha256Bytes(bytes),
        bytes: bytes.length,
        carrierAsset: carrierName,
        carrierRoot: archiveRoot,
        memberPath,
      }],
    };
  });
  mkdirSync(releaseAssets, { recursive: true });
  const carrier = path.join(releaseAssets, carrierName);
  const carrierBytes = canonicalGzipSync(deterministicTar(aggregateStage, archiveRoot));
  writeFileSync(carrier, carrierBytes);
  const carrierRow = {
    name: carrierName,
    family: "wasix",
    target: "wasix-portable",
    kind: "extension-bundle",
    sha256: sha256Bytes(carrierBytes),
    bytes: carrierBytes.length,
    memberCount: members.length,
  };
  const frozenCompatibility = compatibility();
  writeFileSync(path.join(extensionRoot, "extension-artifacts.json"), `${JSON.stringify({
    schema: "oliphaunt-extension-ci-artifacts-v2",
    product,
    version,
    compatibility: frozenCompatibility,
    extensions: members,
    carrierAssets: [carrierRow],
  }, null, 2)}\n`);
  writeFileSync(path.join(releaseAssets, `${product}-${version}-manifest.json`), `${JSON.stringify({
    schema: "oliphaunt-extension-release-manifest-v2",
    product,
    version,
    versioning: "runtime-bound",
    compatibility: frozenCompatibility,
    extensions: members,
    assets: [carrierRow],
  }, null, 2)}\n`);
  return { extensionRoot, product, version };
}

function packedTarball(result) {
  const tarballs = result.staged.filter((file) => file.endsWith(".tgz"));
  expect(tarballs).toHaveLength(1);
  return path.isAbsolute(tarballs[0]) ? tarballs[0] : path.join(ROOT, tarballs[0]);
}

function extractPackage(tarball, root) {
  mkdirSync(root, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarball, "-C", root], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return path.join(root, "package");
}

function inspectDescriptorWithNode(entrypoint) {
  const script = `
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const descriptor = (await import(pathToFileURL(process.env.ENTRYPOINT).href)).default;
if (!Object.isFrozen(descriptor) || !Object.isFrozen(descriptor.carriers)) throw new Error("descriptor is mutable");
function assertDeepFrozen(value, label) {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) throw new Error(label + " is mutable");
    for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, label + "." + key);
  }
}
assertDeepFrozen(descriptor.compatibility, "compatibility");
const carriers = descriptor.carriers.map((carrier) => {
  if (!Object.isFrozen(carrier)) throw new Error("carrier is mutable");
  assertDeepFrozen(carrier.install, "carrier.install");
  const bytes = readFileSync(carrier.source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== carrier.size || sha256 !== carrier.sha256) throw new Error("carrier integrity mismatch");
  return { ...carrier, source: carrier.source.href, actualSha256: sha256, actualSize: bytes.length };
});
console.log(JSON.stringify({ descriptor: { ...descriptor, carriers }, frozen: true }));
`;
  const result = spawnSync("node", ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...process.env, ENTRYPOINT: entrypoint },
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

test("derives one explicit WASIX npm identity without renaming the native/default package", () => {
  const product = "oliphaunt-extension-pgtap";
  expect(extensionNpmPackageForProduct(product)).toBe("@oliphaunt/extension-pgtap");
  expect(extensionNpmWasixPackageForProduct(product)).toBe("@oliphaunt/extension-pgtap-wasix");
  const identities = extensionRegistryPackageEntries({
    product,
    ...extensionRegistryPackageTargetSets(product, "extension-wasix-npm-packages.test"),
  }).filter(({ kind }) => kind === "npm").map(({ name }) => name);
  expect(identities).toContain("@oliphaunt/extension-pgtap");
  expect(identities).toContain("@oliphaunt/extension-pgtap-wasix");
  expect(identities).not.toContain("@oliphaunt/extension-pgtap-native");
});

test("packs a host-neutral singleton descriptor that Node imports and verifies byte-for-byte", () => {
  const root = temporaryRoot("oliphaunt-wasix-npm-singleton-");
  const fixture = singletonFixture(root);
  const staging = path.join(root, "staging");
  const result = { staged: [], skipped: [] };
  expect(stageExtensionWasixNpmPackages([fixture.extensionRoot], staging, result)).not.toBeNull();
  expect(result.skipped).toEqual([]);

  const unpacked = extractPackage(packedTarball(result), path.join(root, "unpacked"));
  const inspected = inspectDescriptorWithNode(path.join(unpacked, "index.js"));
  expect(inspected.frozen).toBe(true);
  expect(inspected.descriptor).toMatchObject({
    schema: "oliphaunt-wasix-extension-v1",
    runtime: "wasix",
    product: fixture.product,
    version: fixture.version,
    sqlName: fixture.sqlName,
    compatibility: {
      extensionRuntimeContract: "oliphaunt-extension-runtime-contract-v1",
      postgresMajor: "18",
      wasixRuntimeProduct: "liboliphaunt-wasix",
    },
  });
  expect(inspected.descriptor.carriers.map(({ sqlName }) => sqlName)).toEqual(["pgtap"]);
  expect(inspected.descriptor.carriers[0].source).toMatch(/\/extensions\/pgtap\/extension[.]tar[.]zst$/u);
  expect(inspected.descriptor.carriers[0].actualSize).toBeGreaterThan(0);
  expect(inspected.descriptor.carriers[0].install).toMatchObject({
    schema: "oliphaunt-wasix-extension-install-v1",
    dependencies: ["plpgsql"],
    installedFiles: ["share/postgresql/extension/pgtap.control"],
  });

  const packageJson = JSON.parse(readFileSync(path.join(unpacked, "package.json"), "utf8"));
  expect(packageJson.name).toBe("@oliphaunt/extension-pgtap-wasix");
  expect(packageJson.version).toBe(fixture.version);
  expect(packageJson.exports["."].types).toBe("./index.d.ts");

  const repeated = { staged: [], skipped: [] };
  stageExtensionWasixNpmPackages(
    [fixture.extensionRoot],
    path.join(root, "staging-repeated"),
    repeated,
  );
  expect(readFileSync(packedTarball(repeated))).toEqual(readFileSync(packedTarball(result)));
});

test("stages one physical WASIX leaf across the complete native target set", () => {
  const root = temporaryRoot("oliphaunt-wasix-npm-target-set-");
  const fixture = singletonFixture(root);
  const targets = [
    "linux-arm64-gnu",
    "linux-x64-gnu",
    "macos-arm64",
    "windows-x64-msvc",
  ];
  const result = { staged: [], skipped: [] };
  const staged = stageExtensionNpmPackagesForTargets(
    [fixture.extensionRoot],
    path.join(root, "staging"),
    targets,
    result,
  );
  expect(Object.keys(staged.nativeRoots)).toEqual(targets);
  expect(Object.values(staged.nativeRoots).every((value) => value === null)).toBe(true);
  expect(staged.wasixRoot).not.toBeNull();
  expect(result.staged.filter((file) => file.endsWith(".tgz"))).toHaveLength(1);

  const unpacked = extractPackage(packedTarball(result), path.join(root, "unpacked"));
  const packageJson = JSON.parse(readFileSync(path.join(unpacked, "package.json"), "utf8"));
  expect(packageJson.name).toBe("@oliphaunt/extension-pgtap-wasix");
  const readme = readFileSync(path.join(unpacked, "README.md"), "utf8");
  expect(readme).toContain("import Oliphaunt from '@oliphaunt/wasix-ts';");
  expect(readme).toContain("import pgtap from '@oliphaunt/extension-pgtap-wasix';");
  expect(readme).toContain("extensions: [pgtap]");
  expect(readme).toContain("This carrier is selected by the binding");
});

test("contrib subpath imports carry their exact transitive dependency closure", () => {
  const root = temporaryRoot("oliphaunt-wasix-npm-bundle-");
  const fixture = bundleFixture(root);
  const staging = path.join(root, "staging");
  const result = { staged: [], skipped: [] };
  stageExtensionWasixNpmPackages([fixture.extensionRoot], staging, result);
  const unpacked = extractPackage(packedTarball(result), path.join(root, "unpacked"));

  const earthdistance = inspectDescriptorWithNode(
    path.join(unpacked, "descriptors", "earthdistance.js"),
  ).descriptor;
  expect(earthdistance.sqlName).toBe("earthdistance");
  expect(earthdistance.carriers.map(({ sqlName }) => sqlName)).toEqual(["cube", "earthdistance"]);
  expect(earthdistance.carriers.every(({ actualSha256, sha256 }) => actualSha256 === sha256)).toBe(true);

  const cube = inspectDescriptorWithNode(path.join(unpacked, "descriptors", "cube.js")).descriptor;
  expect(cube.carriers.map(({ sqlName }) => sqlName)).toEqual(["cube"]);
  const packageJson = JSON.parse(readFileSync(path.join(unpacked, "package.json"), "utf8"));
  expect(packageJson.exports["."]).toBeUndefined();
  expect(Object.keys(packageJson.exports).sort()).toEqual(["./cube", "./earthdistance", "./package.json"]);
  expect(packageJson.oliphaunt.memberExports).toEqual({
    cube: "./cube",
    earthdistance: "./earthdistance",
  });
  const readme = readFileSync(path.join(unpacked, "README.md"), "utf8");
  expect(readme).toContain(`import cube from '${packageJson.name}/cube';`);
  expect(readme).toContain(
    `import earthdistance from '${packageJson.name}/earthdistance';`,
  );
  expect(readme).toContain("extensions: [cube, earthdistance]");
});

test("fails closed instead of publishing an incomplete cross-product descriptor", () => {
  const root = temporaryRoot("oliphaunt-wasix-npm-cross-product-");
  const fixture = singletonFixture(root, { dependencies: ["vector"] });
  expect(() => stageExtensionWasixNpmPackages(
    [fixture.extensionRoot],
    path.join(root, "staging"),
    { staged: [], skipped: [] },
  )).toThrow(/unsupported cross-product or unavailable WASIX dependency "vector"/u);
});
