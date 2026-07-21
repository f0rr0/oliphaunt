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
  validateCargoPayloadPartSets,
  validatePublicationCandidate,
  validatePublicationLock,
} from "./publication-lock.mjs";
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";
import { extensionDependencyRequirement } from "./package_liboliphaunt_wasix_cargo_artifacts.mjs";
import {
  allArtifactTargets,
  extensionArtifactTargets,
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import {
  buildSwiftExtensionCarrierManifest,
  swiftExtensionCarrierAssetName,
} from "./ios-carrier-manifest.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-publication-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function selectionNeutralSwiftSourceCarrier(version = "1.2.3") {
  const product = "liboliphaunt-native";
  const tag = `${product}-v${version}`;
  const assets = [
    ["base-xcframework", `liboliphaunt-${version}-apple-spm-xcframework.zip`, "zip", "liboliphaunt.xcframework", "1"],
    ["runtime-resources", `liboliphaunt-${version}-runtime-resources.tar.gz`, "tar.gz", "oliphaunt", "2"],
    ["icu-data", `liboliphaunt-${version}-icu-data.tar.gz`, "tar.gz", "share/icu", "3"],
  ].map(([role, name, format, member, digestDigit], index) => ({
    bytes: index + 1,
    format,
    member,
    name,
    role,
    sha256: digestDigit.repeat(64),
    url: `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`,
  }));
  return {
    base: { assets, product, tag, version },
    carriers: [],
    extensions: [],
    schema: "oliphaunt-react-native-ios-carrier-v1",
  };
}

function tarGzip(output, cwd, member) {
  const result = spawnSync("tar", ["--format=ustar", "-czf", output, "-C", cwd, member], { encoding: "utf8" });
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
  writeFileSync(pom, `<project><modelVersion>4.0.0</modelVersion><groupId>${group}</groupId><artifactId>${artifact}</artifactId><version>${version}</version><name>Fixture</name><description>Fixture publication</description><url>https://github.com/f0rr0/oliphaunt</url><licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses><developers><developer><name>Fixture Maintainer</name><url>https://github.com/f0rr0</url></developer></developers><scm><connection>scm:git:https://github.com/f0rr0/oliphaunt.git</connection><developerConnection>scm:git:ssh://git@github.com/f0rr0/oliphaunt.git</developerConnection><url>https://github.com/f0rr0/oliphaunt</url></scm><dependencies><dependency><groupId>example</groupId><artifactId>dependency</artifactId><version>1</version></dependency></dependencies></project>\n`);
  writeFileSync(path.join(directory, `${artifact}-${version}.jar`), "fixture");
  writeFileSync(path.join(directory, `${artifact}-${version}-sources.jar`), "fixture sources");
  writeFileSync(path.join(directory, `${artifact}-${version}-javadoc.jar`), "fixture javadocs");
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
  const sqlNames = extensionSqlNames(product.id, "publication-lock.test");
  const bundled = sqlNames.length > 1;
  const releaseMetadata = extensionMetadata(product.id, "publication-lock.test");
  const compatibility = releaseMetadata.compatibility;
  const generated = JSON.parse(readFileSync(path.join(import.meta.dir, "../../src/extensions/generated/sdk/react-native.json"), "utf8"));
  const staticLines = readFileSync(path.join(import.meta.dir, "../../src/extensions/generated/mobile/static-extensions.tsv"), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const staticHeader = staticLines[0].split("\t");
  const staticRows = staticLines.slice(1).map((line) => Object.fromEntries(
    staticHeader.map((column, index) => [column, line.split("\t")[index] ?? ""]),
  ));
  const assets = [];
  const extensions = [];
  for (const sqlName of sqlNames) {
    const extension = generated.extensions.find((row) => row["sql-name"] === sqlName);
    const nativeModuleStem = extension["native-module-stem"];
    const staticRow = staticRows.find((row) => row["sql-name"] === sqlName);
    const iosNativeDependencies = nativeModuleStem === null
      ? []
      : (staticRow?.["ios-static-dependencies"] ?? "").split(",").filter(Boolean).sort();
    const memberAssets = [];
    for (const target of extensionArtifactTargets({ product: product.id, publishedOnly: true }, "publication-lock.test")
      .filter((row) => row.sqlName === sqlName)) {
      const roles = target.family === "wasix"
        ? ["wasix-runtime"]
        : target.target === "ios-xcframework"
          ? ["runtime", ...(nativeModuleStem === null ? [] : ["ios-xcframework", ...iosNativeDependencies.map((dependency) => `ios-dependency-xcframework:${dependency}`)])]
          : ["runtime"];
      for (const role of roles) {
        const [kind, dependencyIdentity] = role.split(":");
        const identity = kind === "ios-xcframework"
          ? nativeModuleStem
          : kind === "ios-dependency-xcframework"
            ? dependencyIdentity
            : null;
        const prefix = `${product.id}-${product.version}`;
        const name = target.family === "wasix"
          ? `${prefix}-wasix-portable.tar.zst`
          : kind === "ios-xcframework"
            ? `${prefix}-native-ios-xcframework.zip`
            : kind === "ios-dependency-xcframework"
              ? `${prefix}-native-ios-dependency-${identity}-xcframework.zip`
              : target.target === "ios-xcframework"
                ? `${prefix}-native-ios-runtime.tar.gz`
                : `${prefix}-native-${target.target}-runtime.tar.gz`;
        const file = path.join(
          bundled ? path.join(productRoot, "member-assets", sqlName) : directory,
          name,
        );
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, `fixture:${name}\n`);
        const asset = {
          name,
          family: target.family,
          target: target.target,
          kind,
          identity,
          path: file,
          sha256: sha256File(file),
          bytes: readFileSync(file).length,
        };
        assets.push(asset);
        memberAssets.push(asset);
      }
    }
    extensions.push({
      sqlName,
      createsExtension: extension["creates-extension"] !== false,
      dependencies: [...extension["selected-extension-dependencies"]].sort(),
      dataFiles: [...extension["runtime-share-data-files"]].sort(),
      extensionSqlFileNames: [...extension["extension-sql-file-names"]].sort(),
      extensionSqlFilePrefixes: [...extension["extension-sql-file-prefixes"]].sort(),
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
      mobileReleaseReady: extension["mobile-release-ready"] === true,
      desktopReleaseReady: extension["desktop-release-ready"] === true,
      assets: memberAssets,
    });
  }
  const carrierAssets = [];
  if (bundled) {
    const groups = new Map();
    for (const extension of extensions) {
      for (const asset of extension.assets) {
        const key = `${asset.family}\0${asset.target}`;
        const group = groups.get(key) ?? { family: asset.family, target: asset.target, rows: [] };
        group.rows.push({ sqlName: extension.sqlName, asset });
        groups.set(key, group);
      }
    }
    for (const group of [...groups.values()].sort((left, right) =>
      `${left.family}\0${left.target}`.localeCompare(`${right.family}\0${right.target}`))) {
      const archiveRoot = `${product.id}-${product.version}-${group.family}-${group.target}-bundle`;
      const stage = path.join(productRoot, "bundle-stage", archiveRoot);
      const manifestMembers = [];
      for (const { sqlName, asset } of group.rows.sort((left, right) =>
        `${left.sqlName}\0${left.asset.kind}\0${left.asset.identity ?? ""}`.localeCompare(
          `${right.sqlName}\0${right.asset.kind}\0${right.asset.identity ?? ""}`,
        ))) {
        const memberPath = `extensions/${sqlName}/${asset.name}`;
        const destination = path.join(stage, ...memberPath.split("/"));
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(asset.path));
        asset.carrierAsset = `${archiveRoot}.tar.gz`;
        asset.carrierRoot = archiveRoot;
        asset.memberPath = memberPath;
        manifestMembers.push({
          sqlName,
          kind: asset.kind,
          identity: asset.identity,
          path: memberPath,
          sha256: asset.sha256,
          bytes: asset.bytes,
        });
      }
      writeFileSync(path.join(stage, "bundle-manifest.json"), `${JSON.stringify({
        schema: "oliphaunt-extension-bundle-v1",
        product: product.id,
        version: product.version,
        compatibility,
        family: group.family,
        target: group.target,
        members: manifestMembers,
      }, null, 2)}\n`);
      const output = path.join(directory, `${archiveRoot}.tar.gz`);
      tarGzip(output, path.dirname(stage), archiveRoot);
      carrierAssets.push({
        name: path.basename(output),
        path: output,
        sha256: sha256File(output),
        bytes: readFileSync(output).length,
        family: group.family,
        target: group.target,
        kind: "extension-bundle",
        memberCount: sqlNames.length,
      });
    }
  }
  const extensionManifestPath = path.join(productRoot, "extension-artifacts.json");
  const extensionManifest = bundled
    ? {
        schema: "oliphaunt-extension-ci-artifacts-v2",
        product: product.id,
        version: product.version,
        compatibility,
        extensions,
        carrierAssets,
      }
    : {
        schema: "oliphaunt-extension-ci-artifacts-v1",
        product: product.id,
        version: product.version,
        compatibility,
        ...extensions[0],
      };
  writeFileSync(extensionManifestPath, `${JSON.stringify(extensionManifest, null, 2)}\n`);
  const manifestName = `${product.id}-${product.version}-manifest.json`;
  const propertiesName = `${product.id}-${product.version}-manifest.properties`;
  const swiftCarrierName = swiftExtensionCarrierAssetName(product.id, product.version);
  const checksumName = `${product.id}-${product.version}-release-assets.sha256`;
  const directAssets = bundled ? carrierAssets : assets;
  writeFileSync(path.join(directory, manifestName), `${JSON.stringify({
    schema: bundled ? "oliphaunt-extension-release-manifest-v2" : "oliphaunt-extension-release-manifest-v1",
    product: product.id,
    version: product.version,
    extensionClass: releaseMetadata.class,
    versioning: releaseMetadata.versioning,
    sourceIdentity: extensionSourceIdentity(product.id, "publication-lock.test"),
    compatibility,
    ...(bundled
      ? {
          extensions: extensions.map((row) => ({
            ...row,
            assets: row.assets.map(({
              name,
              family,
              target,
              kind,
              identity,
              sha256,
              bytes,
              carrierAsset,
              carrierRoot,
              memberPath,
            }) => ({
              name,
              family,
              target,
              kind,
              identity,
              sha256,
              bytes,
              carrierAsset,
              carrierRoot,
              memberPath,
            })),
          })),
          assets: carrierAssets.map(({ name, family, target, kind, sha256, bytes, memberCount }) => ({
            name,
            family,
            target,
            kind,
            sha256,
            bytes,
            memberCount,
          })),
        }
      : {
          sqlName: extensions[0].sqlName,
          createsExtension: extensions[0].createsExtension,
          dependencies: extensions[0].dependencies,
          dataFiles: extensions[0].dataFiles,
          extensionSqlFileNames: extensions[0].extensionSqlFileNames,
          extensionSqlFilePrefixes: extensions[0].extensionSqlFilePrefixes,
          nativeDependencies: extensions[0].nativeDependencies,
          nativeModuleStem: extensions[0].nativeModuleStem,
          iosNativeDependencies: extensions[0].iosNativeDependencies,
          iosRegistration: extensions[0].iosRegistration,
          sharedPreloadLibraries: extensions[0].sharedPreloadLibraries,
          mobileReleaseReady: extensions[0].mobileReleaseReady,
          desktopReleaseReady: extensions[0].desktopReleaseReady,
          assets: assets.map(({ name, family, target, kind, identity, sha256, bytes }) => ({
            name,
            family,
            target,
            kind,
            identity,
            sha256,
            bytes,
          })),
        }),
  }, null, 2)}\n`);
  writeFileSync(path.join(directory, propertiesName), `schema=oliphaunt-extension-release-manifest-v${bundled ? "2" : "1"}\nproduct=${product.id}\nversion=${product.version}\n`);
  writeFileSync(
    path.join(directory, swiftCarrierName),
    `${JSON.stringify(buildSwiftExtensionCarrierManifest({
      extensionManifest: extensionManifestPath,
      verifyMembers: false,
    }), null, 2)}\n`,
  );
  const payloadNames = [...directAssets.map((asset) => asset.name), manifestName, propertiesName, swiftCarrierName].sort();
  writeFileSync(
    path.join(directory, checksumName),
    payloadNames.map((name) => `${sha256File(path.join(directory, name))}  ./${name}\n`).join(""),
  );
  return { assets: directAssets, directory, manifestPath: extensionManifestPath, swiftCarrierName };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe("canonical publication catalog", () => {
  test("normalizes products and stable carriers without duplicate identities", () => {
    const catalog = loadPublicationCatalog("publication-lock.test");
    expect(catalog.products).toHaveLength(18);
    expect(catalog.carriers).toHaveLength(186);
    expect(catalog.carriers.reduce((counts, { ecosystem }) => ({
      ...counts,
      [ecosystem]: (counts[ecosystem] ?? 0) + 1,
    }), {})).toEqual({ cargo: 103, npm: 59, maven: 23, jsr: 1 });
    expect(new Set(catalog.carriers.map((carrier) => carrier.id)).size).toBe(catalog.carriers.length);
    expect(catalog.carriers.every((carrier) => carrier.declared && carrier.product && carrier.version)).toBe(true);
  });

  test("permits only Cargo part identities as dynamic carriers", () => {
    const catalog = loadPublicationCatalog("publication-lock.test", { products: ["liboliphaunt-native"] });
    const part = resolveActualCarrier(catalog, "cargo", "liboliphaunt-native-linux-x64-gnu-part-001");
    expect(part.declared).toBe(false);
    expect(part.parentCarrier).toBe("cargo:liboliphaunt-native-linux-x64-gnu");
    expect(part.part).toBe(1);
    expect(() => resolveActualCarrier(catalog, "cargo", "liboliphaunt-native-linux-x64-gnu-part-000")).toThrow("1-based");
    expect(() => resolveActualCarrier(catalog, "cargo", "liboliphaunt-native-linux-x64-gnu-part-1000")).toThrow("is not a Cargo payload part crate");
    expect(() => resolveActualCarrier(catalog, "npm", "@oliphaunt/liboliphaunt-linux-x64-gnu-payload-0")).toThrow("dynamic identities are permitted only for Cargo");
  });

  test("requires every split carrier to use one complete contiguous 1-based part set", () => {
    const parent = {
      id: "cargo:fixture-linux-x64-gnu",
      ecosystem: "cargo",
      name: "fixture-linux-x64-gnu",
      role: "platform-leaf",
      declared: true,
      packageDependencies: [
        { ecosystem: "cargo", name: "fixture-linux-x64-gnu-part-001" },
        { ecosystem: "cargo", name: "fixture-linux-x64-gnu-part-002" },
      ],
    };
    const part = (number) => ({
      id: `cargo:fixture-linux-x64-gnu-part-${String(number).padStart(3, "0")}`,
      ecosystem: "cargo",
      name: `fixture-linux-x64-gnu-part-${String(number).padStart(3, "0")}`,
      role: "payload-part",
      declared: false,
      parentCarrier: parent.id,
      part: number,
      packageDependencies: [],
    });
    expect(() => validateCargoPayloadPartSets([part(1), part(2), parent])).not.toThrow();
    expect(() => validateCargoPayloadPartSets([part(1), part(3), {
      ...parent,
      packageDependencies: [
        { ecosystem: "cargo", name: "fixture-linux-x64-gnu-part-001" },
        { ecosystem: "cargo", name: "fixture-linux-x64-gnu-part-003" },
      ],
    }])).toThrow("contiguous from part-001");
    expect(() => validateCargoPayloadPartSets([part(1), parent])).toThrow(
      "exactly its complete Cargo payload part set",
    );
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

  test("projects broad artifact roots through the full catalog onto selected products", () => {
    const root = temporaryDirectory();
    const selectedCatalog = loadPublicationCatalog("publication-lock.test", {
      products: ["oliphaunt-js"],
    });
    const selectedVersion = selectedCatalog.products[0].version;
    npmFixture(root, "@oliphaunt/ts", selectedVersion);
    jsrFixture(root, "@oliphaunt/ts", selectedVersion);

    const fullCatalog = loadPublicationCatalog("publication-lock.test");
    const unselected = fullCatalog.carriers.find((carrier) =>
      carrier.ecosystem === "cargo"
      && carrier.product === "oliphaunt-rust"
      && carrier.name === "oliphaunt");
    expect(unselected).toBeDefined();
    cargoFixture(root, unselected.name, unselected.version);
    cargoFixture(root, unselected.name, "999.0.0");
    const unselectedNpm = fullCatalog.carriers.find((carrier) =>
      carrier.ecosystem === "npm"
      && carrier.product === "oliphaunt-broker");
    expect(unselectedNpm).toBeDefined();
    npmFixture(
      path.join(root, "unselected-a"),
      unselectedNpm.name,
      unselectedNpm.version,
      { description: "first unselected carrier bytes" },
    );
    npmFixture(
      path.join(root, "unselected-b"),
      unselectedNpm.name,
      unselectedNpm.version,
      { description: "second unselected carrier bytes" },
    );

    const candidate = buildPublicationCandidate({
      products: ["oliphaunt-js"],
      artifactRoots: [root],
    });
    expect(candidate.carriers.map((carrier) => `${carrier.ecosystem}:${carrier.name}`)).toEqual([
      "npm:@oliphaunt/ts",
      "jsr:@oliphaunt/ts",
    ]);
    expect(candidate.carriers.every((carrier) => carrier.product === "oliphaunt-js")).toBe(true);

    const conflictingSelected = npmFixture(
      path.join(root, "selected-conflict"),
      "@oliphaunt/ts",
      selectedVersion,
      { description: "ambiguous selected carrier bytes" },
    );
    expect(() => buildPublicationCandidate({
      products: ["oliphaunt-js"],
      artifactRoots: [root],
    })).toThrow(/duplicate artifact identity npm:@oliphaunt\/ts@.+ conflicting candidate bytes/u);
    unlinkSync(conflictingSelected);

    cargoFixture(root, "undeclared-publication-carrier", "1.2.3");
    expect(() => buildPublicationCandidate({
      products: ["oliphaunt-js"],
      artifactRoots: [root],
    })).toThrow(/artifact identity cargo:undeclared-publication-carrier is not declared/u);
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
    const { assets, directory, manifestPath, swiftCarrierName } = extensionGithubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    expect(artifacts).toHaveLength(assets.length + 4);
    expect(new Set(artifacts.filter((artifact) => artifact.role === "github-release-asset").map((artifact) => artifact.target))).toEqual(
      new Set(extensionArtifactTargets({ product: product.id, publishedOnly: true }, "publication-lock.test").map((target) => target.target)),
    );

    const swiftCarrierPath = path.join(directory, swiftCarrierName);
    const incompatibleCarrier = JSON.parse(readFileSync(swiftCarrierPath, "utf8"));
    incompatibleCarrier.base.version = "9.9.9";
    incompatibleCarrier.base.tag = "liboliphaunt-native-v9.9.9";
    writeFileSync(swiftCarrierPath, `${JSON.stringify(incompatibleCarrier, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow("compatible native base");

    extensionGithubReleaseFixture(root, product);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const missingRole = manifest.assets.find((asset) => asset.kind === "ios-xcframework");
    manifest.assets = manifest.assets.filter((asset) => asset !== missingRole);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    unlinkSync(path.join(directory, missingRole.name));
    expect(() => discoverProductArtifacts([root], [product])).toThrow("roles");

    extensionGithubReleaseFixture(root, product);
    writeFileSync(path.join(directory, "undeclared-extension-asset.tar.gz"), "extra\n");
    expect(() => discoverProductArtifacts([root], [product])).toThrow("extra");

    extensionGithubReleaseFixture(root, product);
    const publicManifestPath = path.join(directory, `${product.id}-${product.version}-manifest.json`);
    const forgedPublicManifest = JSON.parse(readFileSync(publicManifestPath, "utf8"));
    forgedPublicManifest.versioning = "independent";
    forgedPublicManifest.sourceIdentity = { kind: "external", name: "forged", url: "https://invalid.example", branch: "main", commit: "0".repeat(40) };
    writeFileSync(publicManifestPath, `${JSON.stringify(forgedPublicManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/canonical extension identity/u);

    extensionGithubReleaseFixture(root, product);
    const forgedCiManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    forgedCiManifest.compatibility.nativeRuntimeVersion = "9.9.9";
    writeFileSync(manifestPath, `${JSON.stringify(forgedCiManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/does not describe/u);

    extensionGithubReleaseFixture(root, product);
    const forgedInventoryManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    forgedInventoryManifest.dataFiles = [...forgedInventoryManifest.dataFiles, "undeclared/foreign.sql"].sort();
    writeFileSync(manifestPath, `${JSON.stringify(forgedInventoryManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/semantic extension metadata is not canonical generated metadata/u);
  });

  test("freezes the exact contrib bundle member set under one release owner", { timeout: 20_000 }, () => {
    const root = temporaryDirectory();
    const product = loadPublicationCatalog("publication-lock.test", { products: ["oliphaunt-extension-contrib-pg18"] }).products[0];
    const { assets, manifestPath } = extensionGithubReleaseFixture(root, product);
    const artifacts = discoverProductArtifacts([root], [product]);
    expect(artifacts).toHaveLength(assets.length + 4);
    expect(assets.every(({ name }) => /^oliphaunt-extension-contrib-pg18-[^-]+/u.test(name))).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.extensions.pop();
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow("exact sorted bundle member set");

    extensionGithubReleaseFixture(root, product);
    const forgedMemberInventory = JSON.parse(readFileSync(manifestPath, "utf8"));
    forgedMemberInventory.extensions[0].extensionSqlFilePrefixes = [
      ...forgedMemberInventory.extensions[0].extensionSqlFilePrefixes,
      "undeclared-prefix",
    ].sort();
    writeFileSync(manifestPath, `${JSON.stringify(forgedMemberInventory, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/semantic extension metadata is not canonical generated metadata/u);

    extensionGithubReleaseFixture(root, product);
    const publicManifestPath = path.join(path.dirname(manifestPath), "release-assets", `${product.id}-${product.version}-manifest.json`);
    const forgedPublicManifest = JSON.parse(readFileSync(publicManifestPath, "utf8"));
    forgedPublicManifest.compatibility.wasixRuntimeVersion = "9.9.9";
    writeFileSync(publicManifestPath, `${JSON.stringify(forgedPublicManifest, null, 2)}\n`);
    expect(() => discoverProductArtifacts([root], [product])).toThrow(/frozen aggregate member\/carrier inventory/u);
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

  test("freezes a selection-neutral Swift source carrier and separately composed dependency-closed output", () => {
    const workspaceRoot = mkdtempSync(path.join(import.meta.dir, "../../target/publication-lock-swift-"));
    temporaryDirectories.push(workspaceRoot);
    const sdk = path.join(workspaceRoot, "sdk-artifacts/oliphaunt-swift");
    const fixture = path.join(workspaceRoot, "release/swiftpm-extension-consumer-fixture");
    mkdirSync(path.join(sdk, "extension-generator"), { recursive: true });
    mkdirSync(path.join(sdk, "release-tree/src/sdks/swift/Carriers"), { recursive: true });
    mkdirSync(path.join(fixture, "Sources/OliphauntExtensionPgtap/Resources/extension-artifact"), { recursive: true });
    writeFileSync(path.join(sdk, "Oliphaunt-source.zip"), "source archive\n");
    writeFileSync(path.join(sdk, "Package.swift.release"), "// release manifest fixture\n");
    for (const name of [
      "extension-owner-catalog.json",
      "extension-resource-inventory.mjs",
      "render-extension-products.mjs",
      "swift-carrier-resolver.mjs",
      "swiftpm-extension-input.schema.json",
    ]) {
      writeFileSync(
        path.join(sdk, "extension-generator", name),
        name === "extension-owner-catalog.json"
          ? readFileSync(path.join(import.meta.dir, "../../src/extensions/generated/sdk/swift.json"))
          : name === "extension-resource-inventory.mjs"
            ? readFileSync(path.join(import.meta.dir, "../../src/sdks/swift/tools/extension-resource-inventory.mjs"))
            : `${name}\n`,
      );
    }
    const sourceCarrier = path.join(
      sdk,
      "release-tree/src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json",
    );
    const canonicalSourceCarrier = selectionNeutralSwiftSourceCarrier("0.0.0");
    writeFileSync(sourceCarrier, `${JSON.stringify(canonicalSourceCarrier)}\n`);
    const baseXcframework = canonicalSourceCarrier.base.assets.find(({ role }) => role === "base-xcframework");
    writeFileSync(
      path.join(sdk, "Package.swift.release"),
      `.binaryTarget(\n    name: "liboliphaunt",\n    url: "${baseXcframework.url}",\n    checksum: "${baseXcframework.sha256}"\n)\n`,
    );
    writeFileSync(path.join(fixture, "Package.swift"), "// generated consumer\n");
    writeFileSync(path.join(fixture, "extension-products.json"), '{"schema":"oliphaunt-swiftpm-extension-products-v1"}\n');
    writeFileSync(path.join(fixture, "Sources/OliphauntExtensionPgtap/Resources/extension-artifact/pgtap.control"), "default_version='1.0'\n");

    const catalog = loadPublicationCatalog("publication-lock.test", {
      products: ["oliphaunt-swift", "oliphaunt-extension-pgtap"],
    });
    const product = catalog.products.find(({ id }) => id === "oliphaunt-swift");
    const extensionProduct = catalog.products.find(({ id }) => id === "oliphaunt-extension-pgtap");
    expect(product).toBeDefined();
    expect(extensionProduct).toBeDefined();
    const { manifestPath } = extensionGithubReleaseFixture(workspaceRoot, extensionProduct);
    const extensionRoot = path.dirname(manifestPath);
    const selectedRoots = [sdk, fixture, extensionRoot];

    expect(() => discoverProductArtifacts([sdk, fixture], [product])).toThrow(
      /selects no extension products and requires no frozen Swift consumer fixture/u,
    );
    expect(() => discoverProductArtifacts([sdk, extensionRoot], catalog.products)).toThrow(
      /selects extension products and requires exactly one frozen Swift consumer fixture/u,
    );

    const artifacts = discoverProductArtifacts(selectedRoots, catalog.products);
    const swiftArtifacts = artifacts.filter((artifact) => artifact.product === product.id);
    expect(swiftArtifacts.map(({ id }) => id).sort()).toEqual([
      "release-input:Oliphaunt-source.zip",
      "release-input:Package.swift.release",
      "release-input:extension-owner-catalog.json",
      "release-input:extension-resource-inventory.mjs",
      "release-input:oliphaunt-react-native-ios-carriers.json",
      "release-input:render-extension-products.mjs",
      "release-input:swift-carrier-resolver.mjs",
      "release-input:swiftpm-extension-consumer-fixture",
      "release-input:swiftpm-extension-input.schema.json",
      "release-input:swiftpm-release-tree",
    ]);
    const frozenFixture = swiftArtifacts.find(({ id }) => id === "release-input:swiftpm-extension-consumer-fixture");
    writeFileSync(path.join(fixture, "Sources/OliphauntExtensionPgtap/Resources/extension-artifact/pgtap.control"), "tampered\n");
    const tamperedFixture = discoverProductArtifacts(selectedRoots, catalog.products)
      .find(({ id, product: artifactProduct }) =>
        artifactProduct === product.id
        && id === "release-input:swiftpm-extension-consumer-fixture");
    expect(tamperedFixture.sha256).not.toBe(frozenFixture.sha256);

    const selectedSourceCarrier = structuredClone(canonicalSourceCarrier);
    selectedSourceCarrier.extensions.push({ sqlName: "pgtap" });
    writeFileSync(sourceCarrier, `${JSON.stringify(selectedSourceCarrier)}\n`);
    expect(() => discoverProductArtifacts(selectedRoots, catalog.products)).toThrow(
      /ios-carriers\.json\.extensions.*selection-neutral/u,
    );

    const malformedSourceCarrier = structuredClone(canonicalSourceCarrier);
    delete malformedSourceCarrier.carriers;
    writeFileSync(sourceCarrier, `${JSON.stringify(malformedSourceCarrier)}\n`);
    expect(() => discoverProductArtifacts(selectedRoots, catalog.products)).toThrow(
      /ios-carriers\.json.*fields must be exactly/u,
    );
    writeFileSync(sourceCarrier, `${JSON.stringify(canonicalSourceCarrier)}\n`);

    writeFileSync(
      path.join(sdk, "extension-generator/extension-resource-inventory.mjs"),
      "// forged inventory validator\n",
    );
    expect(() => discoverProductArtifacts(selectedRoots, catalog.products)).toThrow(
      /frozen extension-resource-inventory\.mjs must exactly match/u,
    );
  });
});
