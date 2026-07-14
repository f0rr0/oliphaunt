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

import { currentProductVersionSync } from "./release-artifact-targets.mjs";
import { buildIosCarrierManifest } from "./ios-carrier-manifest.mjs";

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

function writeManifest(root, product, body) {
  const directory = path.join(root, product);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "extension-artifacts.json");
  writeFileSync(file, `${JSON.stringify({
    schema: "oliphaunt-extension-ci-artifacts-v1",
    product,
    version: currentProductVersionSync(product, "ios-carrier-manifest.test"),
    createsExtension: true,
    dependencies: [],
    nativeDependencies: [],
    sharedPreloadLibraries: [],
    ...body,
  }, null, 2)}\n`);
  return file;
}

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
