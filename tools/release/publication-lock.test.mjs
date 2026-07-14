import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPublicationCandidate,
  discoverPublicationArtifacts,
  discoverProductArtifacts,
  freezePublicationCandidate,
  lockedCarrierFile,
  validatePublicationCandidate,
  validatePublicationLock,
} from "./publication-lock.mjs";
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";
import { extensionDependencyRequirement } from "./package_liboliphaunt_wasix_cargo_artifacts.mjs";
import { allArtifactTargets, extensionArtifactTargets, extensionSqlName } from "./release-artifact-targets.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-publication-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tarGzip(output, cwd, member) {
  const result = spawnSync("tar", ["-czf", output, "-C", cwd, member], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tar exited ${result.status}`);
  }
}

function npmFixture(root, name, version, overrides = {}) {
  const stage = path.join(root, "npm-stage", "package");
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({
    name,
    version,
    repository: {
      type: "git",
      url: "git+https://github.com/f0rr0/oliphaunt.git",
    },
    publishConfig: {
      access: "public",
      provenance: true,
    },
    optionalDependencies: { "@oliphaunt/optional-test": version },
    ...overrides,
  }, null, 2)}\n`);
  const output = path.join(root, "package.tgz");
  tarGzip(output, path.dirname(stage), "package");
  return output;
}

function cargoFixture(root, name, version) {
  const directoryName = `${name}-${version}`;
  const stage = path.join(root, "cargo-stage", directoryName);
  mkdirSync(path.join(stage, "src"), { recursive: true });
  writeFileSync(path.join(stage, "Cargo.toml"), `[package]\nname = ${JSON.stringify(name)}\nversion = ${JSON.stringify(version)}\nedition = "2024"\n\n[dependencies]\nserde = "1"\n`);
  writeFileSync(path.join(stage, "src/lib.rs"), "pub const FIXTURE: bool = true;\n");
  const output = path.join(root, `${directoryName}.crate`);
  tarGzip(output, path.dirname(stage), directoryName);
  return output;
}

function mavenFixture(root, group, artifact, version) {
  const directory = path.join(root, "maven", ...group.split("."), artifact, version);
  mkdirSync(directory, { recursive: true });
  const pom = path.join(directory, `${artifact}-${version}.pom`);
  writeFileSync(pom, `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><dependencies><dependency><groupId>example</groupId><artifactId>dependency</artifactId><version>1</version></dependency></dependencies></project>\n`);
  writeFileSync(path.join(directory, `${artifact}-${version}.jar`), "fixture");
  return pom;
}

function jsrFixture(root, name, version) {
  const directory = path.join(root, "jsr");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "jsr.json"), `${JSON.stringify({ name, version, exports: "./mod.ts" }, null, 2)}\n`);
  writeFileSync(path.join(directory, "mod.ts"), "export const fixture = true;\n");
  return directory;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function githubReleaseFixture(root, product) {
  const directory = path.join(root, product.id, "release-assets");
  mkdirSync(directory, { recursive: true });
  const rows = allArtifactTargets({
    product: product.id,
    surface: "github-release",
    publishedOnly: true,
  }, "publication-lock.test").map((target) => ({
    target,
    name: target.asset.replaceAll("{version}", product.version),
  }));
  const checksum = rows.find((row) => row.target.kind === "checksums");
  for (const row of rows.filter((item) => item !== checksum)) {
    writeFileSync(path.join(directory, row.name), `fixture:${row.name}\n`);
  }
  const checksumLines = rows
    .filter((item) => item !== checksum)
    .map((row) => `${sha256File(path.join(directory, row.name))}  ./${row.name}\n`)
    .sort();
  writeFileSync(path.join(directory, checksum.name), checksumLines.join(""));
  return { checksum, directory, rows };
}

function extensionGithubReleaseFixture(root, product) {
  const productRoot = path.join(root, "target", "extension-artifacts", product.id);
  const directory = path.join(productRoot, "release-assets");
  mkdirSync(directory, { recursive: true });
  const sqlName = extensionSqlName(product.id, "publication-lock.test");
  const generated = JSON.parse(readFileSync(path.join(import.meta.dir, "../../src/extensions/generated/sdk/react-native.json"), "utf8"));
  const extension = generated.extensions.find((row) => row["sql-name"] === sqlName);
  const nativeModuleStem = extension["native-module-stem"];
  const staticLines = readFileSync(path.join(import.meta.dir, "../../src/extensions/generated/mobile/static-extensions.tsv"), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const staticHeader = staticLines[0].split("\t");
  const staticRows = staticLines.slice(1).map((line) => Object.fromEntries(
    staticHeader.map((column, index) => [column, line.split("\t")[index] ?? ""]),
  ));
  const staticRow = staticRows.find((row) => row["sql-name"] === sqlName);
  const iosNativeDependencies = nativeModuleStem === null
    ? []
    : (staticRow?.["ios-static-dependencies"] ?? "").split(",").filter(Boolean).sort();
  const assets = [];
  for (const target of extensionArtifactTargets({ product: product.id, publishedOnly: true }, "publication-lock.test")) {
    const roles = target.family === "wasix"
      ? ["wasix-runtime"]
      : target.target === "ios-xcframework"
        ? ["runtime", ...(nativeModuleStem === null ? [] : ["ios-xcframework", ...iosNativeDependencies.map((dependency) => `ios-dependency-xcframework:${dependency}`)])]
        : target.target.startsWith("android-")
          ? ["runtime"]
          : ["runtime"];
    for (const role of roles) {
      const [kind, dependencyIdentity] = role.split(":");
      const identity = kind === "ios-xcframework"
        ? nativeModuleStem
        : kind === "ios-dependency-xcframework"
          ? dependencyIdentity
          : null;
      const name = target.family === "wasix"
        ? `${product.id}-${product.version}-wasix-portable.tar.zst`
        : kind === "ios-xcframework"
          ? `${product.id}-${product.version}-native-ios-xcframework.zip`
          : kind === "ios-dependency-xcframework"
            ? `${product.id}-${product.version}-native-ios-dependency-${identity}-xcframework.zip`
          : target.target === "ios-xcframework"
            ? `${product.id}-${product.version}-native-ios-runtime.tar.gz`
            : `${product.id}-${product.version}-native-${target.target}-runtime.tar.gz`;
      const file = path.join(directory, name);
      writeFileSync(file, `fixture:${name}\n`);
      assets.push({
        name,
        family: target.family,
        target: target.target,
        kind,
        identity,
        path: file,
        sha256: sha256File(file),
        bytes: readFileSync(file).length,
      });
    }
  }
  writeFileSync(path.join(productRoot, "extension-artifacts.json"), `${JSON.stringify({
    schema: "oliphaunt-extension-ci-artifacts-v1",
    product: product.id,
    version: product.version,
    sqlName,
    createsExtension: extension["creates-extension"] !== false,
    dependencies: [...extension["selected-extension-dependencies"]].sort(),
    nativeDependencies: [...extension["native-dependencies"]].sort(),
    nativeModuleStem,
    iosNativeDependencies,
    iosRegistration: nativeModuleStem === null ? null : {
      schema: "oliphaunt-ios-extension-registration-v1",
      sqlName,
      nativeModuleStem,
      magicSymbol: `oliphaunt_static_${nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}_Pg_magic_func`,
      initSymbol: null,
      symbols: [],
    },
    sharedPreloadLibraries: [...extension["shared-preload-libraries"]].sort(),
    assets,
  }, null, 2)}\n`);
  const manifestName = `${product.id}-${product.version}-manifest.json`;
  const propertiesName = `${product.id}-${product.version}-manifest.properties`;
  const checksumName = `${product.id}-${product.version}-release-assets.sha256`;
  writeFileSync(path.join(directory, manifestName), `${JSON.stringify({
    schema: "oliphaunt-extension-release-manifest-v1",
    product: product.id,
    version: product.version,
    assets: assets.map(({ name, family, target, kind, identity, sha256, bytes }) => ({ name, family, target, kind, identity, sha256, bytes })),
  }, null, 2)}\n`);
  writeFileSync(path.join(directory, propertiesName), `schema=oliphaunt-extension-release-manifest-v1\nproduct=${product.id}\nversion=${product.version}\n`);
  const payloadNames = [...assets.map((asset) => asset.name), manifestName, propertiesName].sort();
  writeFileSync(
    path.join(directory, checksumName),
    payloadNames.map((name) => `${sha256File(path.join(directory, name))}  ./${name}\n`).join(""),
  );
  return { assets, directory, manifestPath: path.join(productRoot, "extension-artifacts.json") };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("canonical publication catalog", () => {
  test("normalizes products and stable carriers without duplicate identities", () => {
    const catalog = loadPublicationCatalog("publication-lock.test");
    expect(catalog.products).toHaveLength(49);
    expect(catalog.carriers.length).toBeGreaterThanOrEqual(678);
    expect(new Set(catalog.carriers.map((carrier) => carrier.id)).size).toBe(catalog.carriers.length);
    expect(catalog.carriers.every((carrier) => carrier.declared && carrier.product && carrier.version)).toBe(true);
  });

  test("permits only Cargo part identities as dynamic carriers", () => {
    const catalog = loadPublicationCatalog("publication-lock.test", { products: ["liboliphaunt-native"] });
    const part = resolveActualCarrier(catalog, "cargo", "liboliphaunt-native-linux-x64-gnu-part-000");
    expect(part.declared).toBe(false);
    expect(part.parentCarrier).toBe("cargo:liboliphaunt-native-linux-x64-gnu");
    expect(() => resolveActualCarrier(catalog, "npm", "@oliphaunt/liboliphaunt-linux-x64-gnu-payload-0")).toThrow("dynamic identities are permitted only for Cargo");
  });

  test("keeps contrib WASIX dependencies exact and external dependencies patch-compatible", () => {
    expect(extensionDependencyRequirement("0.1.2", "runtime-bound")).toBe("=0.1.2");
    expect(extensionDependencyRequirement("0.3.4", "upstream-bound")).toBe(">=0.3.4,<0.4.0");
    expect(extensionDependencyRequirement("2.3.4", "upstream-bound")).toBe(">=2.3.4,<3.0.0");
  });
});

describe("publication artifact discovery and freezing", () => {
  test("publish resolution rejects regenerated paths and mutations", () => {
    const root = mkdtempSync(path.join(import.meta.dir, "../../target/publication-lock-publish-"));
    temporaryDirectories.push(root);
    const frozen = npmFixture(root, "@oliphaunt/test", "1.2.3");
    const artifact = {
      path: path.relative(path.join(import.meta.dir, "../.."), frozen).split(path.sep).join("/"),
      sha256: sha256File(frozen),
      size: readFileSync(frozen).length,
    };
    const lock = {
      carriers: [{
        id: "npm:@oliphaunt/test",
        ecosystem: "npm",
        name: "@oliphaunt/test",
        version: "1.2.3",
        artifacts: [artifact],
      }],
    };

    expect(lockedCarrierFile(lock, "npm", "@oliphaunt/test", frozen).file).toBe(frozen);
    const regenerated = path.join(root, "regenerated.tgz");
    writeFileSync(regenerated, readFileSync(frozen));
    expect(() => lockedCarrierFile(lock, "npm", "@oliphaunt/test", regenerated)).toThrow(
      "attempted to substitute",
    );
    writeFileSync(frozen, "regenerated bytes");
    expect(() => lockedCarrierFile(lock, "npm", "@oliphaunt/test", frozen)).toThrow(
      "bytes do not match",
    );
  });

  test("reads npm, Cargo, Maven, and JSR identities, bytes, and dependencies", () => {
    const root = temporaryDirectory();
    npmFixture(root, "@oliphaunt/test", "1.2.3");
    cargoFixture(root, "oliphaunt-test", "1.2.3");
    mavenFixture(root, "dev.oliphaunt", "test", "1.2.3");
    jsrFixture(root, "@oliphaunt/jsr-test", "1.2.3");
    const records = discoverPublicationArtifacts([root]);
    expect(records.map((record) => `${record.ecosystem}:${record.name}`).sort()).toEqual([
      "cargo:oliphaunt-test",
      "jsr:@oliphaunt/jsr-test",
      "maven:dev.oliphaunt:test",
      "npm:@oliphaunt/test",
    ]);
    expect(records.every((record) => record.artifacts.every((artifact) => artifact.size > 0 && artifact.sha256.length === 64))).toBe(true);
    expect(records.find((record) => record.ecosystem === "cargo").dependencies[0].name).toBe("serde");
  });

  test("rejects frozen npm tarballs that cannot use trusted publishing", () => {
    for (const [label, overrides, pattern] of [
      ["missing-repository", { repository: undefined }, /repository must be an object/u],
      [
        "wrong-repository",
        { repository: { type: "git", url: "https://github.com/example/other" } },
        /repository\.url must exactly match/u,
      ],
      [
        "provenance-disabled",
        { publishConfig: { access: "public", provenance: false } },
        /must not disable npm provenance/u,
      ],
    ]) {
      const root = temporaryDirectory();
      npmFixture(root, `@oliphaunt/${label}`, "1.2.3", overrides);
      expect(() => discoverPublicationArtifacts([root])).toThrow(pattern);
    }
  });

  test("freezes an exhaustive product carrier set and detects tampering", () => {
    const root = temporaryDirectory();
    const catalog = loadPublicationCatalog("publication-lock.test", { products: ["oliphaunt-js"] });
    const version = catalog.products[0].version;
    npmFixture(root, "@oliphaunt/ts", version);
    jsrFixture(root, "@oliphaunt/ts", version);
    const candidate = buildPublicationCandidate({
      products: ["oliphaunt-js"],
      artifactRoots: [root],
    });
    expect(candidate.missing).toEqual([]);
    expect(candidate.carriers).toHaveLength(2);
    expect(candidate.packageEnvelopeDigest).toHaveLength(64);
    const duplicateOrder = structuredClone(candidate);
    duplicateOrder.carriers[1].publishOrder = duplicateOrder.carriers[0].publishOrder;
    expect(() => validatePublicationCandidate(duplicateOrder)).toThrow(/publishOrder sequence/u);
    const unknownDependency = structuredClone(candidate);
    unknownDependency.carriers[0].dependencies = ["npm:@oliphaunt/not-frozen"];
    expect(() => validatePublicationCandidate(unknownDependency)).toThrow(/internal package dependency identities/u);
    const nonCanonicalIdentity = structuredClone(candidate);
    nonCanonicalIdentity.carriers[0].id = "npm:wrong-name";
    expect(() => validatePublicationCandidate(nonCanonicalIdentity)).toThrow(/canonical/u);
    const lock = freezePublicationCandidate(candidate);
    expect(validatePublicationLock(lock)).toBe(lock);
    const tampered = structuredClone(lock);
    tampered.carriers[0].artifacts[0].size += 1;
    expect(() => validatePublicationLock(tampered)).toThrow(/Digest mismatch|digest mismatch|packageEnvelopeDigest/u);
  });

  test("freezes exact GitHub assets and rejects tampering, missing assets, and extras", () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog("publication-lock.test", { products: ["oliphaunt-broker"] }).products[0];
    const { checksum, directory, rows } = githubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    expect(artifacts).toHaveLength(rows.length);
    expect(artifacts.every((artifact) => artifact.role === "github-release-asset" && artifact.sha256.length === 64)).toBe(true);

    const payload = rows.find((row) => row !== checksum);
    const payloadPath = path.join(directory, payload.name);
    writeFileSync(payloadPath, "tampered\n");
    expect(() => discoverProductArtifacts([root], [product])).toThrow("checksum");
    writeFileSync(payloadPath, `fixture:${payload.name}\n`);

    unlinkSync(payloadPath);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/requires exactly one|asset set mismatch/u);
    writeFileSync(payloadPath, `fixture:${payload.name}\n`);

    writeFileSync(path.join(directory, "undeclared.zip"), "extra\n");
    expect(() => discoverProductArtifacts([root], [product])).toThrow("extra");
  });

  test("freezes every declared extension OS target plus public metadata", () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog("publication-lock.test", { products: ["oliphaunt-extension-vector"] }).products[0];
    const { assets, directory, manifestPath } = extensionGithubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    expect(artifacts).toHaveLength(assets.length + 3);
    expect(new Set(artifacts.filter((artifact) => artifact.role === "github-release-asset").map((artifact) => artifact.target))).toEqual(
      new Set(extensionArtifactTargets({ product: product.id, publishedOnly: true }, "publication-lock.test").map((target) => target.target)),
    );

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const missingRole = manifest.assets.find((asset) => asset.kind === "ios-xcframework");
    manifest.assets = manifest.assets.filter((asset) => asset !== missingRole);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    unlinkSync(path.join(directory, missingRole.name));
    expect(() => discoverProductArtifacts([root], [product])).toThrow("roles");

    extensionGithubReleaseFixture(root, product);
    writeFileSync(path.join(directory, "undeclared-extension-asset.tar.gz"), "extra\n");
    expect(() => discoverProductArtifacts([root], [product])).toThrow("extra");
  });

  test("keeps SQL-only mobile extensions resource-only", () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog("publication-lock.test", { products: ["oliphaunt-extension-pgtap"] }).products[0];
    extensionGithubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    const mobile = artifacts.filter((artifact) => artifact.role === "github-release-asset" && (
      artifact.target === "ios-xcframework" || artifact.target.startsWith("android-")
    ));
    expect(mobile.every((artifact) => artifact.kind === "runtime" && artifact.identity === null)).toBe(true);
  });

  test("freezes Swift carrier tooling, source-tag input, and generated dependency-closed output", () => {
    const workspaceRoot = mkdtempSync(path.join(import.meta.dir, "../../target/publication-lock-swift-"));
    temporaryDirectories.push(workspaceRoot);
    const sdk = path.join(workspaceRoot, "sdk-artifacts/oliphaunt-swift");
    const fixture = path.join(workspaceRoot, "release/swiftpm-extension-consumer-fixture");
    mkdirSync(path.join(sdk, "extension-generator"), { recursive: true });
    mkdirSync(path.join(sdk, "release-tree/src/sdks/swift/Carriers"), { recursive: true });
    mkdirSync(path.join(fixture, "Sources/OliphauntExtensionPgtap/Resources/extension-artifact"), { recursive: true });
    writeFileSync(path.join(sdk, "Oliphaunt-source.zip"), "source archive\n");
    writeFileSync(path.join(sdk, "Package.swift.release"), "// release manifest\n");
    for (const name of ["render-extension-products.mjs", "swift-carrier-resolver.mjs", "swiftpm-extension-input.schema.json"]) {
      writeFileSync(path.join(sdk, "extension-generator", name), `${name}\n`);
    }
    writeFileSync(
      path.join(sdk, "release-tree/src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json"),
      `${JSON.stringify({ schema: "oliphaunt-react-native-ios-carrier-v1", base: {}, extensions: [{ sqlName: "pgtap" }] })}\n`,
    );
    writeFileSync(path.join(fixture, "Package.swift"), "// generated consumer\n");
    writeFileSync(path.join(fixture, "extension-products.json"), '{"schema":"oliphaunt-swiftpm-extension-products-v1"}\n');
    writeFileSync(path.join(fixture, "Sources/OliphauntExtensionPgtap/Resources/extension-artifact/pgtap.control"), "default_version='1.0'\n");

    const product = loadPublicationCatalog("publication-lock.test", { products: ["oliphaunt-swift"] }).products[0];
    const artifacts = discoverProductArtifacts([sdk, fixture], [product]);
    expect(artifacts.map(({ id }) => id).sort()).toEqual([
      "release-input:Oliphaunt-source.zip",
      "release-input:Package.swift.release",
      "release-input:oliphaunt-react-native-ios-carriers.json",
      "release-input:render-extension-products.mjs",
      "release-input:swift-carrier-resolver.mjs",
      "release-input:swiftpm-extension-consumer-fixture",
      "release-input:swiftpm-extension-input.schema.json",
      "release-input:swiftpm-release-tree",
    ]);
    const frozenFixture = artifacts.find(({ id }) => id === "release-input:swiftpm-extension-consumer-fixture");
    writeFileSync(path.join(fixture, "Sources/OliphauntExtensionPgtap/Resources/extension-artifact/pgtap.control"), "tampered\n");
    const tamperedFixture = discoverProductArtifacts([sdk, fixture], [product])
      .find(({ id }) => id === "release-input:swiftpm-extension-consumer-fixture");
    expect(tamperedFixture.sha256).not.toBe(frozenFixture.sha256);
  });
});
