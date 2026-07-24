import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  extensionCarrierLegalContract,
  extensionCarrierLegalFileInventory,
} from "../../../../tools/release/extension-upstream-licenses.mjs";
import { canonicalGzipSync } from "../../../../tools/release/portable-archive.mjs";
import { stageReleaseNotices } from "../../../../tools/release/release-notices.mjs";

const SCRIPT = fileURLToPath(new URL("./mobile-extension-artifact-paths.mjs", import.meta.url));
const repositoryResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: path.dirname(SCRIPT),
  encoding: "utf8",
});
assert.equal(repositoryResult.status, 0, repositoryResult.stderr);
const REPOSITORY_ROOT = repositoryResult.stdout.trim();
const VERSION = "1.2.3";
const NATIVE_RUNTIME_VERSION = readFileSync(
  path.join(REPOSITORY_ROOT, "src/runtimes/liboliphaunt/native/VERSION"),
  "utf8",
).trim();
const WASIX_RUNTIME_VERSION = readFileSync(
  path.join(REPOSITORY_ROOT, "src/runtimes/liboliphaunt/wasix/VERSION"),
  "utf8",
).trim();
const REACT_NATIVE_EXTENSIONS = JSON.parse(readFileSync(
  path.join(REPOSITORY_ROOT, "src/extensions/generated/sdk/react-native.json"),
  "utf8",
)).extensions;
const REACT_NATIVE_EXTENSION_BY_SQL_NAME = new Map(
  REACT_NATIVE_EXTENSIONS.map((row) => [row["sql-name"], row]),
);
const STATIC_EXTENSION_LINES = readFileSync(
  path.join(REPOSITORY_ROOT, "src/extensions/generated/mobile/static-extensions.tsv"),
  "utf8",
).split(/\r?\n/u).filter((line) => line.length > 0 && !line.startsWith("#"));
const STATIC_EXTENSION_HEADER = STATIC_EXTENSION_LINES[0].split("\t");
const STATIC_SQL_INDEX = STATIC_EXTENSION_HEADER.indexOf("sql-name");
const STATIC_IOS_DEPENDENCY_INDEX = STATIC_EXTENSION_HEADER.indexOf("ios-static-dependencies");
assert(STATIC_SQL_INDEX >= 0 && STATIC_IOS_DEPENDENCY_INDEX >= 0);
const IOS_DEPENDENCIES_BY_SQL_NAME = new Map(
  STATIC_EXTENSION_LINES.slice(1).map((line) => {
    const fields = line.split("\t");
    return [
      fields[STATIC_SQL_INDEX],
      (fields[STATIC_IOS_DEPENDENCY_INDEX] ?? "").split(",").filter(Boolean).sort(),
    ];
  }),
);
const COMPATIBILITY = {
  extensionRuntimeContract: "src/shared/extension-runtime-contract/contract.toml",
  nativeRuntimeProduct: "liboliphaunt-native",
  nativeRuntimeVersion: NATIVE_RUNTIME_VERSION,
  postgresMajor: "18",
  wasixRuntimeProduct: "liboliphaunt-wasix",
  wasixRuntimeVersion: WASIX_RUNTIME_VERSION,
};
const CONTRIB = "oliphaunt-extension-contrib-pg18";
const VECTOR = "oliphaunt-extension-vector";
const TARGETS = ["android-arm64-v8a", "android-x86_64", "ios-xcframework"];
const CONTRIB_SQL_NAMES = REACT_NATIVE_EXTENSIONS
  .filter((row) => row["release-product"] === CONTRIB)
  .map((row) => row["sql-name"])
  .sort();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function tarPathParts(archivePath) {
  if (Buffer.byteLength(archivePath) <= 100) {
    return { name: archivePath, prefix: "" };
  }
  const parts = archivePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`fixture path is too long for ustar: ${archivePath}`);
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  assert(bytes.length <= length, `fixture ustar field overflow: ${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const text = value.toString(8);
  assert(text.length <= length - 1, `fixture ustar octal overflow: ${value}`);
  writeTarString(buffer, offset, length, `${text.padStart(length - 1, "0")}\0`);
}

function tarHeader(archivePath, size) {
  const header = Buffer.alloc(512);
  const { name, prefix } = tarPathParts(archivePath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarString(header, 156, 1, "0");
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 345, 155, prefix);
  const checksum = [...header].reduce((total, byte) => total + byte, 0).toString(8);
  assert(checksum.length <= 6);
  writeTarString(header, 148, 8, `${checksum.padStart(6, "0")}\0 `);
  return header;
}

function writeCanonicalTarGzip(output, stage, archiveNames) {
  const chunks = [];
  for (const archiveName of [...archiveNames].sort()) {
    const data = readFileSync(path.join(stage, ...archiveName.split("/")));
    chunks.push(tarHeader(archiveName, data.length), data);
    const remainder = data.length % 512;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(512 - remainder));
    }
  }
  chunks.push(Buffer.alloc(1024));
  writeFileSync(output, canonicalGzipSync(Buffer.concat(chunks)));
}

function rewriteFirstTarMode(output, mode) {
  const tar = gunzipSync(readFileSync(output));
  writeTarOctal(tar, 100, 8, mode);
  tar.fill(0x20, 148, 156);
  const checksum = [...tar.subarray(0, 512)].reduce((total, byte) => total + byte, 0).toString(8);
  assert(checksum.length <= 6);
  writeTarString(tar, 148, 8, `${checksum.padStart(6, "0")}\0 `);
  writeFileSync(output, canonicalGzipSync(tar));
}

function extensionMember(sqlName, stagesIos = true) {
  const row = REACT_NATIVE_EXTENSION_BY_SQL_NAME.get(sqlName);
  assert(row, `missing generated React Native fixture metadata for ${sqlName}`);
  const nativeModuleStem = row["native-module-stem"];
  const generatedIosDependencies = [...row["ios-static-dependencies"]].sort();
  assert.deepEqual(
    generatedIosDependencies,
    IOS_DEPENDENCIES_BY_SQL_NAME.get(sqlName) ?? [],
    `${sqlName} generated RN and mobile-static iOS dependency contracts must agree`,
  );
  const iosNativeDependencies = stagesIos && nativeModuleStem !== null
    ? generatedIosDependencies
    : [];
  const prefix = nativeModuleStem === null
    ? null
    : `oliphaunt_static_${nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  return {
    sqlName,
    createsExtension: row["creates-extension"],
    dependencies: [...row["selected-extension-dependencies"]].sort(),
    dataFiles: [...row["runtime-share-data-files"]].sort(),
    extensionSqlFileNames: [...row["extension-sql-file-names"]].sort(),
    extensionSqlFilePrefixes: [...row["extension-sql-file-prefixes"]].sort(),
    nativeDependencies: [...row["native-dependencies"]].sort(),
    nativeModuleStem,
    iosNativeDependencies,
    iosRegistration: nativeModuleStem === null || !stagesIos
      ? null
      : {
          initSymbol: null,
          magicSymbol: `${prefix}_Pg_magic_func`,
          nativeModuleStem,
          schema: "oliphaunt-ios-extension-registration-v1",
          sqlName,
          symbols: [],
        },
    sharedPreloadLibraries: [...row["shared-preload-libraries"]].sort(),
    mobileReleaseReady: row["mobile-release-ready"],
    desktopReleaseReady: row["desktop-release-ready"],
    assets: [],
  };
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-mobile-extension-artifacts-"));
  const artifactRoot = path.join(root, "extension-artifacts");
  const materializeRoot = path.join(root, "materialized");
  mkdirSync(artifactRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  function productRoot(product) {
    return path.join(artifactRoot, product);
  }

  function manifestPath(product) {
    return path.join(productRoot(product), "extension-artifacts.json");
  }

  function writeManifest(product, value) {
    writeJson(manifestPath(product), value);
  }

  function run({ extensions, assetKind, assetTarget, required = "1", extraArgs = [] }) {
    return spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--root", REPOSITORY_ROOT,
        "--artifact-root", artifactRoot,
        "--materialize-root", materializeRoot,
        "--extensions", extensions,
        "--asset-kind", assetKind,
        "--asset-target", assetTarget,
        "--required", required,
        ...extraArgs,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  function installAggregate({
    targets = TARGETS,
    embeddedMutator = (value) => value,
    tamperNested = null,
    tamperLegal = null,
    omitLegal = null,
    extraArchiveMember = null,
    duplicatePhysicalRolePath = false,
  } = {}) {
    const members = CONTRIB_SQL_NAMES.map((sqlName) =>
      extensionMember(sqlName, targets.includes("ios-xcframework"))
    );
    const manifest = {
      schema: "oliphaunt-extension-ci-artifacts-v2",
      product: CONTRIB,
      version: VERSION,
      compatibility: COMPATIBILITY,
      extensions: members,
      carrierAssets: [],
    };
    const carriersByTarget = new Map();
    const declaredContents = new Map();

    for (const target of targets) {
      const carrierRoot = `${CONTRIB}-${VERSION}-native-${target}-bundle`;
      const carrierName = `${carrierRoot}.tar.gz`;
      const rows = [];
      const stage = path.join(root, "bundle-stage", target);
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage, { recursive: true });

      for (const member of members) {
        const roles = [
          { identity: null, kind: "runtime" },
          ...(target === "ios-xcframework" && member.nativeModuleStem !== null
            ? [
                { identity: member.nativeModuleStem, kind: "ios-xcframework" },
                ...member.iosNativeDependencies.map((identity) => ({
                  identity,
                  kind: "ios-dependency-xcframework",
                })),
              ]
            : []),
        ];
        for (const { identity, kind } of roles) {
          const duplicatesRuntimePath = duplicatePhysicalRolePath
            && target === "ios-xcframework"
            && member.sqlName === "cube"
            && kind === "ios-xcframework";
          const name = kind === "runtime" || duplicatesRuntimePath
            ? target === "ios-xcframework"
              ? `${CONTRIB}-${VERSION}-native-ios-runtime.tar.gz`
              : `${CONTRIB}-${VERSION}-native-${target}-runtime.tar.gz`
            : kind === "ios-xcframework"
              ? `${CONTRIB}-${VERSION}-native-ios-xcframework.zip`
              : `${CONTRIB}-${VERSION}-native-ios-dependency-${identity}-xcframework.zip`;
          const memberPath = `extensions/${member.sqlName}/${name}`;
          const declaredKind = duplicatesRuntimePath ? "runtime" : kind;
          const declared = Buffer.from(`declared:${target}:${member.sqlName}:${declaredKind}\n`);
          const nestedKey = `${target}:${member.sqlName}:${kind}` +
            (kind === "ios-dependency-xcframework" ? `:${identity}` : "");
          const archived = tamperNested === nestedKey
            ? Buffer.from(`tampered:${target}:${member.sqlName}:${kind}\n`)
            : declared;
          const asset = {
            name,
            path: `target/extension-artifacts/${CONTRIB}/member-assets/${member.sqlName}/${name}`,
            source: `target/extensions/native/release-assets/${target}/${name}`,
            sha256: sha256(declared),
            bytes: declared.length,
            family: "native",
            kind,
            target,
            identity,
            carrierAsset: carrierName,
            carrierRoot,
            memberPath,
          };
          member.assets.push(asset);
          rows.push({
            sqlName: member.sqlName,
            kind,
            identity,
            path: memberPath,
            sha256: asset.sha256,
            bytes: asset.bytes,
          });
          declaredContents.set(nestedKey, declared);
          const stagedMember = path.join(stage, carrierRoot, ...memberPath.split("/"));
          mkdirSync(path.dirname(stagedMember), { recursive: true });
          writeFileSync(stagedMember, archived);
        }
      }

      rows.sort((left, right) => {
        const leftKey = `${left.sqlName}\0${left.kind}\0${left.identity ?? ""}`;
        const rightKey = `${right.sqlName}\0${right.kind}\0${right.identity ?? ""}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      const legal = extensionCarrierLegalContract(CONTRIB, CONTRIB_SQL_NAMES, {
        family: "native",
        target,
      });
      const embedded = embeddedMutator({
        schema: "oliphaunt-extension-bundle-v1",
        product: CONTRIB,
        version: VERSION,
        compatibility: COMPATIBILITY,
        family: "native",
        target,
        licenseProfile: legal.profile,
        licenseFiles: legal.licenseFiles,
        members: rows,
      }, target);
      const embeddedPath = path.join(stage, carrierRoot, "bundle-manifest.json");
      mkdirSync(path.dirname(embeddedPath), { recursive: true });
      writeFileSync(embeddedPath, canonicalJson(embedded));
      stageReleaseNotices(path.join(stage, carrierRoot), { profile: legal.profile });
      const legalFiles = extensionCarrierLegalFileInventory(CONTRIB, CONTRIB_SQL_NAMES, {
        family: "native",
        target,
      });
      if (tamperLegal !== null) {
        const legalPath = path.join(stage, carrierRoot, ...tamperLegal.split("/"));
        const bytes = readFileSync(legalPath);
        assert(bytes.length > 0, `${tamperLegal} fixture must not be empty`);
        bytes[0] ^= 0xff;
        writeFileSync(legalPath, bytes);
      }
      if (extraArchiveMember !== null) {
        const extraPath = path.join(stage, carrierRoot, ...extraArchiveMember.split("/"));
        mkdirSync(path.dirname(extraPath), { recursive: true });
        writeFileSync(extraPath, "undeclared bundle member\n");
      }

      const releaseAssets = path.join(productRoot(CONTRIB), "release-assets");
      mkdirSync(releaseAssets, { recursive: true });
      const carrierPath = path.join(releaseAssets, carrierName);
      const archiveNames = [
        `${carrierRoot}/bundle-manifest.json`,
        ...rows.map((row) => `${carrierRoot}/${row.path}`),
        ...legalFiles.map((file) => `${carrierRoot}/${file.path}`),
        ...(extraArchiveMember === null ? [] : [`${carrierRoot}/${extraArchiveMember}`]),
      ].filter((name) => name !== `${carrierRoot}/${omitLegal}`);
      const uniqueArchiveNames = [...new Set(archiveNames)].sort();
      writeCanonicalTarGzip(carrierPath, stage, uniqueArchiveNames);
      const carrier = {
        name: carrierName,
        path: `target/extension-artifacts/${CONTRIB}/release-assets/${carrierName}`,
        sha256: sha256File(carrierPath),
        bytes: statSync(carrierPath).size,
        family: "native",
        target,
        kind: "extension-bundle",
        memberCount: members.length,
      };
      manifest.carrierAssets.push(carrier);
      carriersByTarget.set(target, { carrier, carrierPath });
      rmSync(stage, { recursive: true, force: true });
    }
    rmSync(path.join(root, "bundle-stage"), { recursive: true, force: true });
    writeManifest(CONTRIB, manifest);
    return { manifest, carriersByTarget, declaredContents };
  }

  function installLeaf() {
    const assets = [];
    const contents = new Map();
    const releaseAssets = path.join(productRoot(VECTOR), "release-assets");
    mkdirSync(releaseAssets, { recursive: true });
    for (const target of TARGETS) {
      const kinds = target === "ios-xcframework" ? ["runtime", "ios-xcframework"] : ["runtime"];
      for (const kind of kinds) {
        const name = kind === "runtime"
          ? target === "ios-xcframework"
            ? `${VECTOR}-${VERSION}-native-ios-runtime.tar.gz`
            : `${VECTOR}-${VERSION}-native-${target}-runtime.tar.gz`
          : `${VECTOR}-${VERSION}-native-ios-xcframework.zip`;
        const file = path.join(releaseAssets, name);
        const content = Buffer.from(`leaf:${target}:${kind}\n`);
        writeFileSync(file, content);
        assets.push({
          name,
          path: `target/extension-artifacts/${VECTOR}/release-assets/${name}`,
          source: `target/extensions/native/release-assets/${target}/${name}`,
          sha256: sha256(content),
          bytes: content.length,
          family: "native",
          kind,
          target,
          identity: kind === "runtime" ? null : "vector",
        });
        contents.set(`${target}:${kind}`, content);
      }
    }
    const manifest = {
      schema: "oliphaunt-extension-ci-artifacts-v1",
      product: VECTOR,
      version: VERSION,
      compatibility: COMPATIBILITY,
      ...extensionMember("vector"),
      assets,
    };
    writeManifest(VECTOR, manifest);
    return { manifest, contents, releaseAssets };
  }

  return {
    artifactRoot,
    installAggregate,
    installLeaf,
    manifestPath,
    materializeRoot,
    productRoot,
    root,
    run,
    writeManifest,
  };
}

function outputPaths(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

function assertContents(files, expected) {
  assert.equal(files.length, expected.length);
  for (const [index, file] of files.entries()) {
    assert.deepEqual(readFileSync(file), expected[index]);
  }
}

test("materializes aggregate and singleton assets into immutable content-addressed paths", (t) => {
  const value = fixture(t);
  const aggregate = value.installAggregate();
  const leaf = value.installLeaf();
  assert.equal(existsSync(path.join(value.productRoot(CONTRIB), "member-assets")), false);

  for (const target of ["android-arm64-v8a", "android-x86_64"]) {
    const files = outputPaths(value.run({
      extensions: "amcheck,cube,vector",
      assetKind: "runtime",
      assetTarget: target,
    }));
    assertContents(files, [
      aggregate.declaredContents.get(`${target}:amcheck:runtime`),
      aggregate.declaredContents.get(`${target}:cube:runtime`),
      leaf.contents.get(`${target}:runtime`),
    ]);
    assert(files[0].startsWith(value.materializeRoot));
    assert(files[1].startsWith(value.materializeRoot));
    assert(files[2].startsWith(value.materializeRoot));
    assert(!files[2].startsWith(path.join(value.productRoot(VECTOR), "release-assets")));
    assert(files.every((file) => !file.includes("member-assets")));
    const directAsset = leaf.manifest.assets.find((asset) =>
      asset.target === target && asset.kind === "runtime");
    writeFileSync(path.join(leaf.releaseAssets, directAsset.name), "mutated published source\n");
    assert.deepEqual(
      readFileSync(files[2]),
      leaf.contents.get(`${target}:runtime`),
      "resolved singleton path must not alias mutable release-assets input",
    );
  }

  const iosRuntime = outputPaths(value.run({
    extensions: "amcheck,cube,vector",
    assetKind: "runtime",
    assetTarget: "ios-xcframework",
  }));
  assertContents(iosRuntime, [
    aggregate.declaredContents.get("ios-xcframework:amcheck:runtime"),
    aggregate.declaredContents.get("ios-xcframework:cube:runtime"),
    leaf.contents.get("ios-xcframework:runtime"),
  ]);

  const iosFrameworks = outputPaths(value.run({
    extensions: "cube,vector",
    assetKind: "ios-xcframework",
    assetTarget: "ios-xcframework",
  }));
  assertContents(iosFrameworks, [
    aggregate.declaredContents.get("ios-xcframework:cube:ios-xcframework"),
    leaf.contents.get("ios-xcframework:ios-xcframework"),
  ]);
});

test("rejects outer and nested carrier tampering independently", (t) => {
  const outer = fixture(t);
  const outerAggregate = outer.installAggregate({ targets: ["android-arm64-v8a"] });
  appendFileSync(outerAggregate.carriersByTarget.get("android-arm64-v8a").carrierPath, "tamper");
  const outerResult = outer.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(outerResult.status, 1);
  assert.match(outerResult.stderr, /aggregate carrier .* does not match its frozen size\/digest/u);

  const nested = fixture(t);
  nested.installAggregate({
    targets: ["android-arm64-v8a"],
    tamperNested: "android-arm64-v8a:amcheck:runtime",
  });
  const nestedResult = nested.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(nestedResult.status, 1);
  assert.match(nestedResult.stderr, /member .* does not match its canonical SHA-256/u);
});

test("binds the production bundle manifest and exact legal-file closure", (t) => {
  const valid = fixture(t);
  valid.installAggregate({ targets: ["android-arm64-v8a"] });
  outputPaths(valid.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  }));

  const tampered = fixture(t);
  tampered.installAggregate({
    targets: ["android-arm64-v8a"],
    tamperLegal: "LICENSE",
  });
  const tamperedResult = tampered.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(tamperedResult.status, 1);
  assert.match(tamperedResult.stderr, /LICENSE.*does not match its canonical SHA-256/u);

  const missing = fixture(t);
  missing.installAggregate({
    targets: ["android-arm64-v8a"],
    omitLegal: "THIRD_PARTY_NOTICES.md",
  });
  const missingResult = missing.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /exact two-block ustar marker/u);

  const extra = fixture(t);
  extra.installAggregate({
    targets: ["android-arm64-v8a"],
    extraArchiveMember: "UNDECLARED-LEGAL.txt",
  });
  const extraResult = extra.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(extraResult.status, 1);
  assert.match(extraResult.stderr, /UNDECLARED-LEGAL\.txt.*undeclared/u);

  const staleManifest = fixture(t);
  staleManifest.installAggregate({
    targets: ["android-arm64-v8a"],
    embeddedMutator: (value) => {
      const { licenseProfile: _licenseProfile, ...legacy } = value;
      return legacy;
    },
  });
  const staleManifestResult = staleManifest.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(staleManifestResult.status, 1);
  assert.match(staleManifestResult.stderr, /bundle-manifest\.json.*wrong ustar size/u);
});

test("rejects unsupported outer and embedded bundle schemas", (t) => {
  const outer = fixture(t);
  outer.writeManifest("bad-extension", {
    schema: "oliphaunt-extension-ci-artifacts-v3",
    product: "bad-extension",
    version: VERSION,
    compatibility: COMPATIBILITY,
    sqlName: "bad",
    assets: [],
  });
  const outerResult = outer.run({
    extensions: "bad",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(outerResult.status, 1);
  assert.match(outerResult.stderr, /unsupported extension artifact schema/u);

  const embedded = fixture(t);
  embedded.installAggregate({
    targets: ["android-arm64-v8a"],
    embeddedMutator: (value) => ({ ...value, schema: "oliphaunt-extension-bundle-v2" }),
  });
  const embeddedResult = embedded.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(embeddedResult.status, 1);
  assert.match(embeddedResult.stderr, /bundle-manifest\.json.*canonical SHA-256/u);
});

test("rejects noncanonical public evidence-envelope key sets", (t) => {
  const bundleRoot = fixture(t);
  const bundleRootAggregate = bundleRoot.installAggregate({ targets: ["android-arm64-v8a"] });
  bundleRootAggregate.manifest.unexpected = true;
  bundleRoot.writeManifest(CONTRIB, bundleRootAggregate.manifest);
  const bundleRootResult = bundleRoot.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(bundleRootResult.status, 1);
  assert.match(bundleRootResult.stderr, /fields must be exactly .* got .*unexpected/u);

  const bundleMember = fixture(t);
  const bundleMemberAggregate = bundleMember.installAggregate({ targets: ["android-arm64-v8a"] });
  delete bundleMemberAggregate.manifest.extensions[0].desktopReleaseReady;
  bundleMember.writeManifest(CONTRIB, bundleMemberAggregate.manifest);
  const bundleMemberResult = bundleMember.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(bundleMemberResult.status, 1);
  assert.match(bundleMemberResult.stderr, /extension member 0 fields must be exactly/u);

  const bundleAsset = fixture(t);
  const bundleAssetAggregate = bundleAsset.installAggregate({ targets: ["android-arm64-v8a"] });
  bundleAssetAggregate.manifest.extensions[0].assets[0].unexpected = "value";
  bundleAsset.writeManifest(CONTRIB, bundleAssetAggregate.manifest);
  const bundleAssetResult = bundleAsset.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(bundleAssetResult.status, 1);
  assert.match(bundleAssetResult.stderr, /extension member 0 asset 0 fields must be exactly/u);

  const bundleCarrier = fixture(t);
  const bundleCarrierAggregate = bundleCarrier.installAggregate({ targets: ["android-arm64-v8a"] });
  delete bundleCarrierAggregate.manifest.carrierAssets[0].memberCount;
  bundleCarrier.writeManifest(CONTRIB, bundleCarrierAggregate.manifest);
  const bundleCarrierResult = bundleCarrier.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(bundleCarrierResult.status, 1);
  assert.match(bundleCarrierResult.stderr, /aggregate carrier 0 fields must be exactly/u);

  const directRoot = fixture(t);
  const directRootLeaf = directRoot.installLeaf();
  directRootLeaf.manifest.unexpected = true;
  directRoot.writeManifest(VECTOR, directRootLeaf.manifest);
  const directRootResult = directRoot.run({
    extensions: "vector",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(directRootResult.status, 1);
  assert.match(directRootResult.stderr, /fields must be exactly .* got .*unexpected/u);

  const directAsset = fixture(t);
  const directAssetLeaf = directAsset.installLeaf();
  directAssetLeaf.manifest.assets[0].unexpected = "value";
  directAsset.writeManifest(VECTOR, directAssetLeaf.manifest);
  const directAssetResult = directAsset.run({
    extensions: "vector",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(directAssetResult.status, 1);
  assert.match(directAssetResult.stderr, /asset 0 fields must be exactly/u);
});

test("rejects duplicate extension, carrier, and nested member identities", (t) => {
  const extensionDuplicate = fixture(t);
  const duplicateManifest = {
    schema: "oliphaunt-extension-ci-artifacts-v2",
    product: CONTRIB,
    version: VERSION,
    compatibility: COMPATIBILITY,
    extensions: [extensionMember("amcheck", false), extensionMember("amcheck", false)],
    carrierAssets: [],
  };
  extensionDuplicate.writeManifest(CONTRIB, duplicateManifest);
  const extensionResult = extensionDuplicate.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(extensionResult.status, 1);
  assert.match(extensionResult.stderr, /repeats an extension SQL identity/u);

  const carrierDuplicate = fixture(t);
  const carrierAggregate = carrierDuplicate.installAggregate({ targets: ["android-arm64-v8a"] });
  carrierAggregate.manifest.carrierAssets.push({ ...carrierAggregate.manifest.carrierAssets[0] });
  carrierDuplicate.writeManifest(CONTRIB, carrierAggregate.manifest);
  const carrierResult = carrierDuplicate.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(carrierResult.status, 1);
  assert.match(carrierResult.stderr, /exactly one native extension-bundle carrier/u);

  const memberDuplicate = fixture(t);
  const memberAggregate = memberDuplicate.installAggregate({ targets: ["android-arm64-v8a"] });
  const amcheck = memberAggregate.manifest.extensions.find((member) => member.sqlName === "amcheck");
  amcheck.assets.push({ ...amcheck.assets[0] });
  memberDuplicate.writeManifest(CONTRIB, memberAggregate.manifest);
  const memberResult = memberDuplicate.run({
    extensions: "cube",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(memberResult.status, 1);
  assert.match(memberResult.stderr, /mobile artifact roles are not exact and dependency-closed/u);

  const physicalPathDuplicate = fixture(t);
  physicalPathDuplicate.installAggregate({
    targets: ["ios-xcframework"],
    duplicatePhysicalRolePath: true,
  });
  const physicalPathResult = physicalPathDuplicate.run({
    extensions: "cube",
    assetKind: "ios-xcframework",
    assetTarget: "ios-xcframework",
  });
  assert.equal(physicalPathResult.status, 1);
  assert.match(physicalPathResult.stderr, /repeats nested member path/u);
});

test("binds aggregate ownership and compatibility to generated repository metadata", (t) => {
  const subset = fixture(t);
  const subsetAggregate = subset.installAggregate({ targets: ["android-arm64-v8a"] });
  subsetAggregate.manifest.extensions.pop();
  subset.writeManifest(CONTRIB, subsetAggregate.manifest);
  const subsetResult = subset.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(subsetResult.status, 1);
  assert.match(subsetResult.stderr, /member set must exactly match generated owner/u);

  const compatibility = fixture(t);
  const compatibilityAggregate = compatibility.installAggregate({ targets: ["android-arm64-v8a"] });
  compatibilityAggregate.manifest.compatibility = {
    ...compatibilityAggregate.manifest.compatibility,
    nativeRuntimeVersion: "9.9.9",
  };
  compatibility.writeManifest(CONTRIB, compatibilityAggregate.manifest);
  const compatibilityResult = compatibility.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(compatibilityResult.status, 1);
  assert.match(compatibilityResult.stderr, /compatibility metadata must exactly match/u);

  const semantics = fixture(t);
  const semanticsAggregate = semantics.installAggregate({ targets: ["android-arm64-v8a"] });
  semanticsAggregate.manifest.extensions.find(({ sqlName }) => sqlName === "amcheck")
    .dataFiles.push("forged/catalog.dat");
  semantics.writeManifest(CONTRIB, semanticsAggregate.manifest);
  const semanticsResult = semantics.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(semanticsResult.status, 1);
  assert.match(semanticsResult.stderr, /\.dataFiles must exactly match generated React Native extension metadata/u);

  for (const [field, forgedValue] of [
    ["extensionSqlFileNames", "forged-install.sql"],
    ["extensionSqlFilePrefixes", "forged-prefix"],
  ]) {
    const sqlOwnership = fixture(t);
    const sqlOwnershipAggregate = sqlOwnership.installAggregate({ targets: ["android-arm64-v8a"] });
    sqlOwnershipAggregate.manifest.extensions
      .find(({ sqlName }) => sqlName === "amcheck")[field].push(forgedValue);
    sqlOwnership.writeManifest(CONTRIB, sqlOwnershipAggregate.manifest);
    const sqlOwnershipResult = sqlOwnership.run({
      extensions: "amcheck",
      assetKind: "runtime",
      assetTarget: "android-arm64-v8a",
    });
    assert.equal(sqlOwnershipResult.status, 1);
    assert.match(
      sqlOwnershipResult.stderr,
      new RegExp(`\\.${field} must exactly match generated React Native extension metadata`, "u"),
    );
  }

  const dependencyClosure = fixture(t);
  const dependencyAggregate = dependencyClosure.installAggregate({ targets: ["ios-xcframework"] });
  const pgcrypto = dependencyAggregate.manifest.extensions.find(({ sqlName }) => sqlName === "pgcrypto");
  assert.deepEqual(pgcrypto.iosNativeDependencies, ["openssl"]);
  pgcrypto.assets = pgcrypto.assets.filter((asset) =>
    !(asset.kind === "ios-dependency-xcframework" && asset.identity === "openssl"));
  dependencyClosure.writeManifest(CONTRIB, dependencyAggregate.manifest);
  const dependencyResult = dependencyClosure.run({
    extensions: "pgcrypto",
    assetKind: "runtime",
    assetTarget: "ios-xcframework",
  });
  assert.equal(dependencyResult.status, 1);
  assert.match(dependencyResult.stderr, /mobile artifact roles are not exact and dependency-closed/u);

  const registration = fixture(t);
  const registrationAggregate = registration.installAggregate({ targets: ["ios-xcframework"] });
  registrationAggregate.manifest.extensions.find(({ sqlName }) => sqlName === "cube")
    .iosRegistration.schema = "unfrozen-registration-v2";
  registration.writeManifest(CONTRIB, registrationAggregate.manifest);
  const registrationResult = registration.run({
    extensions: "cube",
    assetKind: "ios-xcframework",
    assetTarget: "ios-xcframework",
  });
  assert.equal(registrationResult.status, 1);
  assert.match(registrationResult.stderr, /does not match canonical native module identity/u);
});

test("rejects cache path escapes, noncanonical ustar metadata, and invalid CLI flags", (t) => {
  const escape = fixture(t);
  const escapeAggregate = escape.installAggregate({ targets: ["android-arm64-v8a"] });
  const escapeCarrier = escapeAggregate.manifest.carrierAssets[0];
  const escapedName = `${CONTRIB}-${VERSION}-native-..-bundle.tar.gz`;
  escapeCarrier.target = "..";
  escapeCarrier.name = escapedName;
  escapeCarrier.path = `target/extension-artifacts/${CONTRIB}/release-assets/${escapedName}`;
  for (const member of escapeAggregate.manifest.extensions) {
    for (const asset of member.assets) {
      asset.target = "..";
      asset.carrierAsset = escapedName;
      asset.carrierRoot = escapedName.replace(/\.tar\.gz$/u, "");
    }
  }
  escape.writeManifest(CONTRIB, escapeAggregate.manifest);
  const escapeResult = escape.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "*",
  });
  assert.equal(escapeResult.status, 1);
  assert.match(escapeResult.stderr, /aggregate carrier target must be a safe non-empty path component/u);

  const canonical = fixture(t);
  const canonicalAggregate = canonical.installAggregate({ targets: ["android-arm64-v8a"] });
  const canonicalCarrier = canonicalAggregate.carriersByTarget.get("android-arm64-v8a");
  rewriteFirstTarMode(canonicalCarrier.carrierPath, 0o600);
  canonicalCarrier.carrier.bytes = statSync(canonicalCarrier.carrierPath).size;
  canonicalCarrier.carrier.sha256 = sha256File(canonicalCarrier.carrierPath);
  canonical.writeManifest(CONTRIB, canonicalAggregate.manifest);
  const canonicalResult = canonical.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(canonicalResult.status, 1);
  assert.match(canonicalResult.stderr, /must use mode=0644 uid=0 gid=0 mtime=0/u);

  const gzip = fixture(t);
  const gzipAggregate = gzip.installAggregate({ targets: ["android-arm64-v8a"] });
  const gzipCarrier = gzipAggregate.carriersByTarget.get("android-arm64-v8a");
  const gzipBytes = readFileSync(gzipCarrier.carrierPath);
  gzipBytes[9] = 0;
  writeFileSync(gzipCarrier.carrierPath, gzipBytes);
  gzipCarrier.carrier.bytes = statSync(gzipCarrier.carrierPath).size;
  gzipCarrier.carrier.sha256 = sha256File(gzipCarrier.carrierPath);
  gzip.writeManifest(CONTRIB, gzipAggregate.manifest);
  const gzipResult = gzip.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(gzipResult.status, 1);
  assert.match(gzipResult.stderr, /canonical gzip method, flags, mtime, XFL, and OS header/u);

  const oversized = fixture(t);
  const oversizedLeaf = oversized.installLeaf();
  oversizedLeaf.manifest.assets.find((asset) =>
    asset.target === "android-arm64-v8a" && asset.kind === "runtime").bytes =
      2 * 1024 * 1024 * 1024 + 1;
  oversized.writeManifest(VECTOR, oversizedLeaf.manifest);
  const oversizedResult = oversized.run({
    extensions: "vector",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(oversizedResult.status, 1);
  assert.match(oversizedResult.stderr, /exceeds the maximum supported size/u);

  const flags = fixture(t);
  const unknownFlag = flags.run({
    extensions: "missing",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
    extraArgs: ["--unknown", "value"],
  });
  assert.equal(unknownFlag.status, 2);
  assert.match(unknownFlag.stderr, /unknown option: --unknown/u);
  const duplicateFlag = flags.run({
    extensions: "missing",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
    extraArgs: ["--required", "1"],
  });
  assert.equal(duplicateFlag.status, 2);
  assert.match(duplicateFlag.stderr, /duplicate option: --required/u);
});

test("rejects pre-existing materialization-cache symlink redirection", (t) => {
  const component = fixture(t);
  component.installAggregate({ targets: ["android-arm64-v8a"] });
  const redirected = path.join(component.root, "redirected-component");
  mkdirSync(component.materializeRoot, { recursive: true });
  mkdirSync(redirected, { recursive: true });
  symlinkSync(redirected, path.join(component.materializeRoot, CONTRIB), "dir");
  const componentResult = component.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(componentResult.status, 1);
  assert.match(componentResult.stderr, /cache path component must be a real directory, not a symlink/u);
  assert.deepEqual(readdirSync(redirected), [], "a rejected cache symlink must not receive materialized bytes");

  const rootLink = fixture(t);
  rootLink.installAggregate({ targets: ["android-arm64-v8a"] });
  const redirectedRoot = path.join(rootLink.root, "redirected-root");
  mkdirSync(redirectedRoot, { recursive: true });
  symlinkSync(redirectedRoot, rootLink.materializeRoot, "dir");
  const rootResult = rootLink.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(rootResult.status, 1);
  assert.match(rootResult.stderr, /cache root must be a real directory, not a symlink/u);
  assert.deepEqual(readdirSync(redirectedRoot), [], "a rejected cache-root symlink must not receive extraction state");

  const direct = fixture(t);
  const leaf = direct.installLeaf();
  const asset = leaf.manifest.assets.find((row) =>
    row.kind === "runtime" && row.target === "android-arm64-v8a");
  const destination = path.join(
    direct.materializeRoot,
    VECTOR,
    "direct",
    "native",
    "android-arm64-v8a",
    asset.sha256,
    "vector",
    asset.name,
  );
  const redirectedFile = path.join(direct.root, "redirected-direct-file");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(redirectedFile, "must remain unchanged\n");
  symlinkSync(redirectedFile, destination, "file");
  const directResult = direct.run({
    extensions: "vector",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
  });
  assert.equal(directResult.status, 1);
  assert.match(directResult.stderr, /cache destination must not be a symlink/u);
  assert.equal(readFileSync(redirectedFile, "utf8"), "must remain unchanged\n");
});

test("preserves optional missing-artifact exit status", (t) => {
  const value = fixture(t);
  const result = value.run({
    extensions: "missing",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
    required: "0",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /missing exact-extension artifact\(s\): missing: package/u);

  const carrier = fixture(t);
  const aggregate = carrier.installAggregate({ targets: ["android-arm64-v8a"] });
  rmSync(aggregate.carriersByTarget.get("android-arm64-v8a").carrierPath);
  const carrierResult = carrier.run({
    extensions: "amcheck",
    assetKind: "runtime",
    assetTarget: "android-arm64-v8a",
    required: "0",
  });
  assert.equal(carrierResult.status, 3);
  assert.match(carrierResult.stderr, /missing exact-extension artifact\(s\): oliphaunt-extension-contrib-pg18:/u);
});
