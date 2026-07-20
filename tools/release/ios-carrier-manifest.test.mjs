#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";

import { currentProductVersionSync, extensionSqlNames } from "./release-artifact-targets.mjs";
import {
  buildIosCarrierManifest,
  buildSwiftExtensionCarrierManifest,
  iosCarrierArchiveListInvocation,
  swiftExtensionCarrierAssetName,
} from "./ios-carrier-manifest.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function archive(root, name, member, format) {
  const staging = path.join(root, `stage-${name}`);
  const leaf = path.join(staging, member);
  mkdirSync(path.extname(member) ? path.dirname(leaf) : leaf, { recursive: true });
  writeFileSync(path.extname(member) ? leaf : path.join(leaf, "payload.txt"), `${name}\n`);
  const output = path.join(root, name);
  if (format === "zip") {
    execFileSync("zip", ["-qry", output, member], { cwd: staging });
  } else {
    execFileSync("tar", ["-czf", output, "-C", staging, member]);
  }
  return output;
}

function assetRow(file, kind, identity = null) {
  return {
    family: "native",
    target: "ios-xcframework",
    kind,
    identity,
    name: path.basename(file),
    path: path.relative(ROOT, file).split(path.sep).join("/"),
    bytes: statSync(file).size,
    sha256: sha256(file),
  };
}

function compatibility(nativeRuntimeVersion = currentProductVersionSync(
  "liboliphaunt-native",
  "ios-carrier-manifest.test",
)) {
  return {
    extensionRuntimeContract: "src/shared/extension-runtime-contract/contract.toml",
    nativeRuntimeProduct: "liboliphaunt-native",
    nativeRuntimeVersion,
    postgresMajor: "18",
    wasixRuntimeProduct: "liboliphaunt-wasix",
    wasixRuntimeVersion: currentProductVersionSync(
      "liboliphaunt-wasix",
      "ios-carrier-manifest.test",
    ),
  };
}

function nextStableVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function writeManifest(root, product, body) {
  const directory = path.join(root, product);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "extension-artifacts.json");
  writeFileSync(file, `${JSON.stringify({
    schema: "oliphaunt-extension-ci-artifacts-v1",
    product,
    version: currentProductVersionSync(product, "ios-carrier-manifest.test"),
    compatibility: compatibility(),
    createsExtension: true,
    dataFiles: [],
    dependencies: [],
    extensionSqlFileNames: [],
    extensionSqlFilePrefixes: [],
    nativeDependencies: [],
    sharedPreloadLibraries: [],
    ...body,
  }, null, 2)}\n`);
  return file;
}

test("keeps drive-qualified iOS carrier listing operands local on Windows", () => {
  const directory = String.raw`D:\a\oliphaunt\oliphaunt\target\ios carriers`;
  assert.deepEqual(
    iosCarrierArchiveListInvocation(
      String.raw`D:\a\oliphaunt\oliphaunt\target\ios carriers\runtime.tar.gz`,
      "tar.gz",
      { platform: "win32", cwd: String.raw`D:\a\oliphaunt\oliphaunt` },
    ),
    {
      command: "tar",
      args: ["-tzf", "runtime.tar.gz"],
      cwd: directory,
    },
  );
  assert.deepEqual(
    iosCarrierArchiveListInvocation(
      String.raw`D:\a\oliphaunt\oliphaunt\target\ios carriers\extension.zip`,
      "zip",
      { platform: "win32", cwd: String.raw`D:\a\oliphaunt\oliphaunt` },
    ),
    {
      command: "unzip",
      args: ["-Z1", "extension.zip"],
      cwd: directory,
    },
  );
  assert.throws(
    () => iosCarrierArchiveListInvocation(String.raw`D:runtime.zip`, "zip", {
      platform: "win32",
      cwd: directory,
    }),
    /drive-relative or alternate-stream/u,
  );
});

test("produces exact local and GitHub carrier envelopes for SQL-only and dependency-closed native extensions", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "ios-carrier-test-"));
  try {
    const version = currentProductVersionSync("liboliphaunt-native", "ios-carrier-manifest.test");
    const base = path.join(root, "base");
    mkdirSync(base, { recursive: true });
    archive(base, `liboliphaunt-${version}-apple-spm-xcframework.zip`, "liboliphaunt.xcframework", "zip");
    archive(base, `liboliphaunt-${version}-runtime-resources.tar.gz`, "oliphaunt", "tar.gz");
    archive(base, `liboliphaunt-${version}-icu-data.tar.gz`, "share/icu", "tar.gz");

    const pgtapRuntime = archive(root, "pgtap-runtime.tar.gz", "oliphaunt", "tar.gz");
    const pgtap = writeManifest(root, "oliphaunt-extension-pgtap", {
      sqlName: "pgtap",
      extensionSqlFileNames: ["uninstall_pgtap.sql"],
      extensionSqlFilePrefixes: ["pgtap-core", "pgtap-schema"],
      nativeModuleStem: null,
      iosNativeDependencies: [],
      iosRegistration: null,
      assets: [assetRow(pgtapRuntime, "runtime")],
    });

    const postgisRuntime = archive(root, "postgis-runtime.tar.gz", "oliphaunt", "tar.gz");
    const postgisPrimary = archive(root, "postgis-primary.zip", "liboliphaunt_extension_postgis-3.xcframework", "zip");
    const postgisGeos = archive(root, "postgis-geos.zip", "liboliphaunt_dependency_geos.xcframework", "zip");
    const postgis = writeManifest(root, "oliphaunt-extension-postgis", {
      sqlName: "postgis",
      nativeModuleStem: "postgis-3",
      iosNativeDependencies: ["geos"],
      iosRegistration: {
        schema: "oliphaunt-ios-extension-registration-v1",
        sqlName: "postgis",
        nativeModuleStem: "postgis-3",
        magicSymbol: "oliphaunt_static_postgis_3_Pg_magic_func",
        initSymbol: "oliphaunt_static_postgis_3__PG_init",
        symbols: [],
      },
      assets: [
        assetRow(postgisRuntime, "runtime"),
        assetRow(postgisPrimary, "ios-xcframework", "postgis-3"),
        assetRow(postgisGeos, "ios-dependency-xcframework", "geos"),
      ],
    });

    const local = buildIosCarrierManifest({
      baseAssetDir: base,
      extensionManifests: [postgis, pgtap],
      localUrls: true,
    });
    assert.deepEqual(local.base.assets.map(({ role }) => role), ["base-xcframework", "runtime-resources", "icu-data"]);
    assert.deepEqual(local.extensions.map(({ sqlName }) => sqlName), ["pgtap", "postgis"]);
    const sqlOnly = local.extensions[0];
    assert.equal(sqlOnly.nativeModuleStem, null);
    assert.equal(sqlOnly.registration, null);
    assert.deepEqual(sqlOnly.dataFiles, []);
    assert.deepEqual(sqlOnly.extensionSqlFileNames, ["uninstall_pgtap.sql"]);
    assert.deepEqual(sqlOnly.extensionSqlFilePrefixes, ["pgtap-core", "pgtap-schema"]);
    assert.deepEqual(sqlOnly.assets.map(({ role }) => role), ["runtime-resources"]);
    const native = local.extensions[1];
    assert.deepEqual(native.nativeDependencies, ["geos"]);
    assert.deepEqual(native.assets.map(({ role }) => role).sort(), ["dependency-xcframework", "extension-xcframework", "runtime-resources"]);
    assert.ok(local.base.assets.every(({ url }) => url.startsWith("file:")));

    const publicManifest = buildIosCarrierManifest({
      baseAssetDir: base,
      extensionManifests: [pgtap],
      repository: "f0rr0/oliphaunt",
    });
    assert.ok(publicManifest.base.assets.every(({ url }) => url.startsWith(`https://github.com/f0rr0/oliphaunt/releases/download/liboliphaunt-native-v${version}/`)));

    const swiftCarrier = buildSwiftExtensionCarrierManifest({
      extensionManifest: pgtap,
      nativeRuntimeVersion: version,
    });
    const pgtapVersion = currentProductVersionSync("oliphaunt-extension-pgtap", "ios-carrier-manifest.test");
    assert.equal(swiftCarrier.schema, "oliphaunt-swift-extension-carrier-v1");
    assert.deepEqual(swiftCarrier.release, {
      product: "oliphaunt-extension-pgtap",
      tag: `oliphaunt-extension-pgtap-v${pgtapVersion}`,
      version: pgtapVersion,
    });
    assert.equal(swiftCarrier.entries.length, 1);
    assert.equal(swiftCarrier.entries[0].extension.sqlName, "pgtap");
    assert.deepEqual(swiftCarrier.entries[0].dependencyCarriers, []);
    assert.equal(
      swiftExtensionCarrierAssetName("oliphaunt-extension-pgtap", pgtapVersion),
      `oliphaunt-extension-pgtap-${pgtapVersion}-swift-extension-carrier.json`,
    );

    const canonicalPgtap = JSON.parse(readFileSync(pgtap, "utf8"));
    for (const [label, mutate, pattern] of [
      [
        "self dependency",
        (document) => { document.dependencies = ["pgtap"]; },
        /dependencies must not include itself/u,
      ],
      [
        "dot-bearing SQL prefix",
        (document) => { document.extensionSqlFilePrefixes = ["pgtap.core"]; },
        /dot-free portable SQL basename prefix/u,
      ],
      [
        "non-portable SQL name",
        (document) => { document.extensionSqlFileNames = ["foreign name.sql"]; },
        /portable identifier/u,
      ],
      [
        "non-canonical SQL-name order",
        (document) => { document.extensionSqlFileNames = ["z.sql", "a.sql"]; },
        /sorted in ordinal order/u,
      ],
    ]) {
      const candidate = structuredClone(canonicalPgtap);
      mutate(candidate);
      writeFileSync(pgtap, `${JSON.stringify(candidate, null, 2)}\n`);
      assert.throws(
        () => buildIosCarrierManifest({
          baseAssetDir: base,
          extensionManifests: [pgtap],
          localUrls: true,
        }),
        pattern,
        label,
      );
    }
    writeFileSync(pgtap, `${JSON.stringify(canonicalPgtap, null, 2)}\n`);

    const incompatibleVersion = nextStableVersion(version);
    assert.throws(
      () => buildSwiftExtensionCarrierManifest({
        extensionManifest: pgtap,
        nativeRuntimeVersion: incompatibleVersion,
      }),
      new RegExp(`pins liboliphaunt-native ${version.replaceAll(".", "\\.")}, but caller supplied ${incompatibleVersion.replaceAll(".", "\\.")}`, "u"),
    );
    const incompatiblePgtap = JSON.parse(readFileSync(pgtap, "utf8"));
    incompatiblePgtap.compatibility.nativeRuntimeVersion = incompatibleVersion;
    writeFileSync(pgtap, `${JSON.stringify(incompatiblePgtap, null, 2)}\n`);
    assert.throws(
      () => buildIosCarrierManifest({
        baseAssetDir: base,
        extensionManifests: [pgtap],
        localUrls: true,
      }),
      new RegExp(`pins liboliphaunt-native ${incompatibleVersion.replaceAll(".", "\\.")}, but the selected base carrier is ${version.replaceAll(".", "\\.")}`, "u"),
    );

    const malformed = JSON.parse(readFileSync(postgis, "utf8"));
    malformed.iosNativeDependencies = ["geos", "proj"];
    writeFileSync(postgis, `${JSON.stringify(malformed, null, 2)}\n`);
    assert.throws(
      () => buildIosCarrierManifest({ baseAssetDir: base, extensionManifests: [postgis], localUrls: true }),
      /dependency assets do not match/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle carriers separate one outer envelope from exact nested member locators and reject repacked skew", () => {
  mkdirSync(path.join(ROOT, "target"), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, "target", "ios-bundle-carrier-test-"));
  try {
    const product = "oliphaunt-extension-contrib-pg18";
    const version = currentProductVersionSync(product, "ios-carrier-manifest.test");
    const sqlNames = extensionSqlNames(product, "ios-carrier-manifest.test");
    const carrierRoot = `${product}-${version}-native-ios-xcframework-bundle`;
    const carrierName = `${carrierRoot}.tar.gz`;
    const carrierStage = path.join(root, "carrier-stage", carrierRoot);
    const extensions = [];
    for (const sqlName of sqlNames) {
      const logicalRoot = path.join(root, "logical", sqlName);
      mkdirSync(logicalRoot, { recursive: true });
      const logicalName = `${product}-${version}-native-ios-runtime.tar.gz`;
      const logicalFile = archive(logicalRoot, logicalName, "oliphaunt", "tar.gz");
      const memberPath = `extensions/${sqlName}/${logicalName}`;
      const nested = path.join(carrierStage, ...memberPath.split("/"));
      mkdirSync(path.dirname(nested), { recursive: true });
      writeFileSync(nested, readFileSync(logicalFile));
      extensions.push({
        sqlName,
        createsExtension: true,
        dataFiles: [],
        dependencies: [],
        extensionSqlFileNames: [],
        extensionSqlFilePrefixes: [],
        nativeDependencies: [],
        nativeModuleStem: null,
        iosNativeDependencies: [],
        iosRegistration: null,
        sharedPreloadLibraries: [],
        mobileReleaseReady: true,
        desktopReleaseReady: true,
        assets: [{
          family: "native",
          target: "ios-xcframework",
          kind: "runtime",
          identity: null,
          name: logicalName,
          path: path.relative(ROOT, logicalFile).split(path.sep).join("/"),
          bytes: statSync(logicalFile).size,
          sha256: sha256(logicalFile),
          carrierAsset: carrierName,
          carrierRoot,
          memberPath,
        }],
      });
    }
    writeFileSync(path.join(carrierStage, "bundle-manifest.json"), "{}\n");
    const releaseAssets = path.join(root, "release-assets");
    mkdirSync(releaseAssets, { recursive: true });
    const carrierFile = path.join(releaseAssets, carrierName);
    execFileSync("tar", ["--format=ustar", "-czf", carrierFile, "-C", path.dirname(carrierStage), carrierRoot]);
    const manifestFile = path.join(root, "extension-artifacts.json");
    const writeBundle = () => writeFileSync(manifestFile, `${JSON.stringify({
      schema: "oliphaunt-extension-ci-artifacts-v2",
      product,
      version,
      compatibility: compatibility(),
      extensions,
      carrierAssets: [{
        name: carrierName,
        path: path.relative(ROOT, carrierFile).split(path.sep).join("/"),
        sha256: sha256(carrierFile),
        bytes: statSync(carrierFile).size,
        family: "native",
        target: "ios-xcframework",
        kind: "extension-bundle",
        memberCount: sqlNames.length,
      }],
    }, null, 2)}\n`);
    writeBundle();

    const carrier = buildSwiftExtensionCarrierManifest({
      extensionManifest: manifestFile,
      localUrls: true,
    });
    assert.equal(carrier.carriers.length, 1);
    assert.equal(carrier.entries.length, sqlNames.length);
    assert.ok(carrier.entries.every(({ extension }) =>
      extension.product === product
      && extension.assets.length === 1
      && extension.assets[0].carrier === carrierName
      && extension.assets[0].path.startsWith(`${carrierRoot}/extensions/${extension.sqlName}/`)));

    const tampered = path.join(carrierStage, "extensions", sqlNames[0], extensions[0].assets[0].name);
    writeFileSync(tampered, "repacked bytes that do not match the logical row\n");
    execFileSync("tar", ["--format=ustar", "-czf", carrierFile, "-C", path.dirname(carrierStage), carrierRoot]);
    writeBundle();
    assert.throws(
      () => buildSwiftExtensionCarrierManifest({ extensionManifest: manifestFile, localUrls: true }),
      /nested payload .* does not match its declared bytes\/SHA-256/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
