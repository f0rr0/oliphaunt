import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inventoryOutputRoot,
  observeRegistryIdentities,
  parseArgs,
  offlineRegistryCarrierRunner,
  qualificationProducts,
  qualifyOfflineRegistryCarriers,
} from "./offline-registry-carrier-qualification.mjs";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  currentProductVersionSync,
  exactExtensionProducts,
  registryPackageRows,
} from "./release-artifact-targets.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import { canonicalGzipSync } from "./portable-archive.mjs";
import { renderMavenArtifactPom } from "./maven-artifact-staging.mjs";
import { runBunProductDryRun } from "./release-product-dry-run.mjs";
import { WASIX_CARGO_ARTIFACT_SCHEMA } from "./wasix-cargo-artifact-contract.mjs";

const FIXTURE_PRODUCT = "oliphaunt-extension-vector";

function fixtureRoots(root) {
  return {
    cargo: path.join(root, "cargo"),
    npm: path.join(root, "npm"),
    maven: path.join(root, "maven"),
  };
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function archiveFixture(sourceRoot, output, archiveRoot, members) {
  const stage = mkdtempSync(path.join(sourceRoot, "archive-"));
  try {
    for (const [name, contents] of Object.entries(members)) {
      const file = path.join(stage, ...name.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(
      output,
      canonicalGzipSync(createDeterministicTar(stage, archiveRoot, {
        fail(message) {
          throw new Error(message);
        },
        fixedFileMode: 0o644,
      })),
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return output;
}

function writeCargoCrate(sourceRoot, output, name, version, dependencies = []) {
  return archiveFixture(sourceRoot, output, `${name}-${version}`, {
    "Cargo.toml": [
      "[package]",
      `name = ${JSON.stringify(name)}`,
      `version = ${JSON.stringify(version)}`,
      'edition = "2024"',
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "",
      "[build-dependencies]",
      ...dependencies.map((dependency) =>
        `${JSON.stringify(dependency)} = { version = ${JSON.stringify(`=${version}`)} }`),
      "",
      "[workspace]",
      "",
    ].join("\n"),
    "src/lib.rs": "#![deny(unsafe_code)]\n",
  });
}

function writeNpmTarball(sourceRoot, output, name, version) {
  return archiveFixture(sourceRoot, output, "package", {
    "package.json": `${JSON.stringify({ name, version })}\n`,
    "README.md": `# ${name}\n`,
  });
}

function writeWasixManifest(fixture) {
  const packages = [...fixture.wasixCrates.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, cratePath]) => ({
      name,
      target: name.includes("-aot-") ? "fixture-aot-target" : "wasix-portable",
      kind: name.includes("-aot-") ? "wasix-extension-aot" : "wasix-extension",
      role: "artifact",
      manifestPath: path.join(fixture.sourceRoot, `${name}.Cargo.toml`),
      cratePath,
      size: readFileSync(cratePath).length,
      sha256: digest(cratePath),
    }));
  writeFileSync(fixture.wasixManifest, `${JSON.stringify({
    schema: WASIX_CARGO_ARTIFACT_SCHEMA,
    product: "liboliphaunt-wasix",
    packages,
  }, null, 2)}\n`);
}

function materializeCanonicalFixture(product, roots) {
  const fixtureRoot = path.dirname(roots.cargo);
  const sourceRoot = path.join(fixtureRoot, "source");
  mkdirSync(sourceRoot, { recursive: true });
  for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });
  const version = currentProductVersionSync(product, "offline-registry-carrier-qualification.test");
  const rows = registryPackageRows({ product }, "offline-registry-carrier-qualification.test");
  const fixture = {
    cargoCrates: new Map(),
    npmTarballs: new Map(),
    roots,
    sourceRoot,
    version,
    wasixCrates: new Map(),
    wasixManifest: path.join(roots.cargo, "wasix", "packages.json"),
  };
  mkdirSync(path.dirname(fixture.wasixManifest), { recursive: true });

  for (const { packageKind, packageName } of rows) {
    if (packageKind === "crates") {
      const wasix = packageName === `${product}-wasix` || packageName.startsWith(`${product}-aot-`);
      const directory = wasix ? path.dirname(fixture.wasixManifest) : path.join(roots.cargo, "base");
      const output = path.join(directory, `${packageName}-${version}.crate`);
      writeCargoCrate(sourceRoot, output, packageName, version);
      fixture.cargoCrates.set(packageName, output);
      if (wasix) fixture.wasixCrates.set(packageName, output);
    } else if (packageKind === "npm") {
      const prefix = packageName.replace(/^@/u, "").replace("/", "-");
      const output = path.join(roots.npm, "tarballs", prefix, `${prefix}-${version}.tgz`);
      writeNpmTarball(sourceRoot, output, packageName, version);
      fixture.npmTarballs.set(packageName, output);
    } else if (packageKind === "maven") {
      const [groupId, artifactId] = packageName.split(":");
      const directory = path.join(roots.maven, ...groupId.split("."), artifactId, version);
      const prefix = `${artifactId}-${version}`;
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${prefix}.tar.gz`), "fixture carrier\n");
      writeFileSync(path.join(directory, `${prefix}-sources.jar`), "fixture sources\n");
      writeFileSync(path.join(directory, `${prefix}-javadoc.jar`), "fixture javadoc\n");
      writeFileSync(path.join(directory, `${prefix}.pom`), renderMavenArtifactPom({
        artifactId,
        description: `Fixture for ${packageName}`,
        groupId,
        licenses: [{
          name: "MIT License",
          url: "https://example.invalid/MIT",
          distribution: "repo",
        }],
        licenseSpdx: "MIT",
        name: packageName,
        runtimeProduct: null,
        runtimeVersion: null,
        version,
      }));
    }
  }
  writeWasixManifest(fixture);
  return fixture;
}

test("normal release dry-run and offline qualification share one carrier runner", () => {
  expect(offlineRegistryCarrierRunner).toBe(runBunProductDryRun);
});

test("native qualification accepts only the native runtime product", () => {
  expect(qualificationProducts("native")).toEqual(["liboliphaunt-native"]);
  expect(qualificationProducts("native", '["liboliphaunt-native"]')).toEqual([
    "liboliphaunt-native",
  ]);
  expect(() => qualificationProducts("native", '["oliphaunt-extension-postgis"]'))
    .toThrow(/accepts only/u);
});

test("extension qualification is canonical, duplicate-free, and retains PostGIS", () => {
  const all = exactExtensionProducts("offline-registry-carrier-qualification.test");
  const reversed = [...all].reverse();
  expect(qualificationProducts("extensions", JSON.stringify(reversed))).toEqual(all);
  expect(qualificationProducts("extensions", JSON.stringify(all))).toContain(
    "oliphaunt-extension-postgis",
  );
  expect(() => qualificationProducts("extensions", "[]")).toThrow(/at least one/u);
  expect(() => qualificationProducts("extensions", '["oliphaunt-extension-postgis","oliphaunt-extension-postgis"]'))
    .toThrow(/duplicate/u);
  expect(() => qualificationProducts("extensions", '["extension-deferred"]'))
    .toThrow(/non-public or unknown/u);
});

test("argument parser accepts planner JSON from the environment", () => {
  expect(parseArgs(["--scope", "extensions"], {
    OLIPHAUNT_REGISTRY_CARRIER_PRODUCTS_JSON: '["oliphaunt-extension-postgis"]',
  })).toEqual({
    help: false,
    productsJson: '["oliphaunt-extension-postgis"]',
    scope: "extensions",
  });
});

test("qualification binds a canonical physical carrier fixture with fresh offline caches", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-evidence-"));
  const evidenceRoot = path.join(root, "evidence");
  const roots = fixtureRoots(root);
  const products = [FIXTURE_PRODUCT];
  const calls = [];
  const priorNpmToken = process.env.NPM_TOKEN;
  delete process.env.NPM_TOKEN;
  try {
    const evidence = await qualifyOfflineRegistryCarriers({
      scope: "extensions",
      productsJson: JSON.stringify(products),
      evidenceRoot,
      outputRootsForProduct: () => roots,
      runProductDryRun: async (product, options) => {
        calls.push({
          cargoHome: path.basename(process.env.CARGO_HOME),
          cargoHomeEntries: readdirSync(process.env.CARGO_HOME),
          cargoOffline: process.env.CARGO_NET_OFFLINE,
          npmOffline: process.env.npm_config_offline,
          options,
          product,
        });
        materializeCanonicalFixture(product, roots);
      },
    });
    expect(calls).toEqual([{
      cargoHome: FIXTURE_PRODUCT,
      cargoHomeEntries: [],
      cargoOffline: "true",
      npmOffline: "true",
      options: { allowDirty: true },
      product: FIXTURE_PRODUCT,
    }]);
    expect(evidence.networkPolicy).toEqual({
      cargo: "offline-with-a-fresh-empty-per-product-CARGO_HOME",
      gradle: "not-invoked",
      maven: "deterministic-local-staging",
      npm: "offline-local-pack-only",
      registryCredentials: "forbidden",
      registryMutation: "forbidden",
    });
    expect(evidence.products[0].observedRegistryIdentities)
      .toEqual(evidence.products[0].expectedRegistryIdentities);
  } finally {
    if (priorNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = priorNpmToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("arbitrary non-carrier files cannot satisfy offline registry qualification", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-arbitrary-"));
  const roots = fixtureRoots(root);
  const priorNpmToken = process.env.NPM_TOKEN;
  delete process.env.NPM_TOKEN;
  try {
    await expect(qualifyOfflineRegistryCarriers({
      scope: "extensions",
      productsJson: JSON.stringify([FIXTURE_PRODUCT]),
      evidenceRoot: path.join(root, "evidence"),
      outputRootsForProduct: () => roots,
      runProductDryRun: async () => {
        for (const output of Object.values(roots)) {
          mkdirSync(output, { recursive: true });
          writeFileSync(path.join(output, "carrier"), "not a carrier\n");
        }
      },
    })).rejects.toThrow(/missing declared base identities|outside a POM-bound coordinate/u);
  } finally {
    if (priorNpmToken === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = priorNpmToken;
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed carrier closure rejects missing and duplicate physical identities", () => {
  const missingRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-missing-"));
  const duplicateRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-duplicate-"));
  try {
    const missing = materializeCanonicalFixture(FIXTURE_PRODUCT, fixtureRoots(missingRoot));
    const missingName = `${FIXTURE_PRODUCT}-linux-arm64-gnu`;
    rmSync(missing.cargoCrates.get(missingName));
    expect(() => observeRegistryIdentities(FIXTURE_PRODUCT, missing.roots))
      .toThrow(new RegExp(`missing declared base identities:.*${missingName}`, "u"));

    const duplicate = materializeCanonicalFixture(FIXTURE_PRODUCT, fixtureRoots(duplicateRoot));
    const duplicateName = `${FIXTURE_PRODUCT}-linux-x64-gnu`;
    const original = duplicate.cargoCrates.get(duplicateName);
    const copy = path.join(duplicate.roots.cargo, "duplicate", path.basename(original));
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(original, copy);
    expect(() => observeRegistryIdentities(FIXTURE_PRODUCT, duplicate.roots))
      .toThrow(new RegExp(`duplicate physical Cargo identity ${duplicateName}`, "u"));
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
    rmSync(duplicateRoot, { recursive: true, force: true });
  }
});

test("observed carrier closure rejects undeclared extras and omitted WASIX AOT bases", () => {
  const extraRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-extra-"));
  const aotRoot = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-aot-"));
  try {
    const extra = materializeCanonicalFixture(FIXTURE_PRODUCT, fixtureRoots(extraRoot));
    writeCargoCrate(
      extra.sourceRoot,
      path.join(extra.roots.cargo, "base", `undeclared-carrier-${extra.version}.crate`),
      "undeclared-carrier",
      extra.version,
    );
    expect(() => observeRegistryIdentities(FIXTURE_PRODUCT, extra.roots))
      .toThrow(/artifact identity cargo:undeclared-carrier is not declared/u);

    const aot = materializeCanonicalFixture(FIXTURE_PRODUCT, fixtureRoots(aotRoot));
    const omitted = `${FIXTURE_PRODUCT}-aot-linux-x64`;
    rmSync(aot.cargoCrates.get(omitted));
    aot.cargoCrates.delete(omitted);
    aot.wasixCrates.delete(omitted);
    writeWasixManifest(aot);
    expect(() => observeRegistryIdentities(FIXTURE_PRODUCT, aot.roots))
      .toThrow(new RegExp(`missing declared base identities:.*${omitted}`, "u"));
  } finally {
    rmSync(extraRoot, { recursive: true, force: true });
    rmSync(aotRoot, { recursive: true, force: true });
  }
});

test("Cargo payload parts are physical, manifest-bound, contiguous, and parent-bound", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-parts-"));
  try {
    const fixture = materializeCanonicalFixture(FIXTURE_PRODUCT, fixtureRoots(root));
    const parent = `${FIXTURE_PRODUCT}-aot-linux-x64`;
    const partOne = `${parent}-part-001`;
    const parentCrate = fixture.cargoCrates.get(parent);
    writeCargoCrate(fixture.sourceRoot, parentCrate, parent, fixture.version, [partOne]);
    const partOneCrate = path.join(path.dirname(fixture.wasixManifest), `${partOne}-${fixture.version}.crate`);
    writeCargoCrate(fixture.sourceRoot, partOneCrate, partOne, fixture.version);
    fixture.wasixCrates.set(partOne, partOneCrate);
    writeWasixManifest(fixture);
    expect(observeRegistryIdentities(FIXTURE_PRODUCT, fixture.roots).observedRegistryIdentities)
      .toContain(`crates:${partOne}`);

    const partThree = `${parent}-part-003`;
    const partThreeCrate = path.join(path.dirname(fixture.wasixManifest), `${partThree}-${fixture.version}.crate`);
    writeCargoCrate(fixture.sourceRoot, partThreeCrate, partThree, fixture.version);
    fixture.wasixCrates.set(partThree, partThreeCrate);
    writeCargoCrate(fixture.sourceRoot, parentCrate, parent, fixture.version, [partOne, partThree]);
    writeWasixManifest(fixture);
    expect(() => observeRegistryIdentities(FIXTURE_PRODUCT, fixture.roots))
      .toThrow(/must be contiguous from part-001/u);

    fixture.wasixCrates.delete(partThree);
    rmSync(partThreeCrate);
    writeCargoCrate(fixture.sourceRoot, parentCrate, parent, fixture.version, [partOne]);
    writeWasixManifest(fixture);
    const manifest = JSON.parse(readFileSync(fixture.wasixManifest, "utf8"));
    manifest.packages.find(({ name }) => name === partOne).sha256 = "0".repeat(64);
    writeFileSync(fixture.wasixManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => observeRegistryIdentities(FIXTURE_PRODUCT, fixture.roots))
      .toThrow(/SHA-256 mismatch/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification fails closed when registry credentials are present", async () => {
  const previous = process.env.NPM_TOKEN;
  process.env.NPM_TOKEN = "must-not-be-consumed";
  try {
    await expect(qualifyOfflineRegistryCarriers({
      scope: "native",
      runProductDryRun: async () => {
        throw new Error("must not run");
      },
    })).rejects.toThrow(/registry credentials are forbidden.*NPM_TOKEN/u);
  } finally {
    if (previous === undefined) delete process.env.NPM_TOKEN;
    else process.env.NPM_TOKEN = previous;
  }
});

test("carrier evidence records intentional empty payload members but rejects all-zero roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-inventory-"));
  try {
    mkdirSync(path.join(root, "runtime", "share"), { recursive: true });
    writeFileSync(path.join(root, "runtime", "payload.bin"), "payload\n");
    writeFileSync(path.join(root, "runtime", "share", "no-op.sql"), "");
    expect(inventoryOutputRoot(root)).toMatchObject({
      bytes: 8,
      emptyFiles: ["runtime/share/no-op.sql"],
      files: 2,
    });

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    writeFileSync(path.join(root, "no-op.sql"), "");
    expect(() => inventoryOutputRoot(root)).toThrow(/contains no non-empty files/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("carrier evidence rejects symlinks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-symlink-"));
  try {
    writeFileSync(path.join(root, "payload"), "payload\n");
    symlinkSync("payload", path.join(root, "linked-payload"));
    expect(() => inventoryOutputRoot(root)).toThrow(/must not contain symlink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("carrier evidence rejects special filesystem entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-offline-carrier-special-"));
  try {
    writeFileSync(path.join(root, "payload"), "payload\n");
    execFileSync("mkfifo", [path.join(root, "named-pipe")]);
    expect(() => inventoryOutputRoot(root)).toThrow(/non-portable special entry/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
