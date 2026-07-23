#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  extensionMetadata,
  extensionSourceIdentity,
  extensionSqlNames,
} from "./release-artifact-targets.mjs";
import { assertCanonicalExtensionReleaseIdentity } from "./verify_github_release_attestations.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");
const generated = JSON.parse(readFileSync(path.join(ROOT, "src/extensions/generated/sdk/react-native.json"), "utf8"));
const staticLines = readFileSync(path.join(ROOT, "src/extensions/generated/mobile/static-extensions.tsv"), "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.length > 0 && !line.startsWith("#"));
const staticHeader = staticLines.shift().split("\t");
const staticRows = new Map(staticLines.map((line) => {
  const cells = line.split("\t");
  const row = Object.fromEntries(staticHeader.map((key, index) => [key, cells[index] ?? ""]));
  return [row["sql-name"], row];
}));

function member(product, sqlName) {
  const row = generated.extensions.find((candidate) => candidate["sql-name"] === sqlName);
  const nativeModuleStem = row["native-module-stem"];
  const prefix = nativeModuleStem === null
    ? null
    : `oliphaunt_static_${nativeModuleStem.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`;
  return {
    sqlName,
    createsExtension: row["creates-extension"] !== false,
    dependencies: [...row["selected-extension-dependencies"]].sort(),
    dataFiles: [...row["runtime-share-data-files"]].sort(),
    extensionSqlFileNames: [...row["extension-sql-file-names"]].sort(),
    extensionSqlFilePrefixes: [...row["extension-sql-file-prefixes"]].sort(),
    nativeDependencies: [...row["native-dependencies"]].sort(),
    nativeModuleStem,
    iosNativeDependencies: nativeModuleStem === null
      ? []
      : (staticRows.get(sqlName)?.["ios-static-dependencies"] ?? "").split(",").filter(Boolean).sort(),
    iosRegistration: nativeModuleStem === null ? null : {
      schema: "oliphaunt-ios-extension-registration-v1",
      sqlName,
      nativeModuleStem,
      magicSymbol: `${prefix}_Pg_magic_func`,
      initSymbol: null,
      symbols: [],
    },
    sharedPreloadLibraries: [...row["shared-preload-libraries"]].sort(),
    mobileReleaseReady: row["mobile-release-ready"] === true,
    desktopReleaseReady: row["desktop-release-ready"] === true,
    assets: [],
  };
}

function manifest(product, version = "1.2.3") {
  const metadata = extensionMetadata(product, "verify-extension-release-identity.test");
  const members = extensionSqlNames(product, "verify-extension-release-identity.test")
    .map((sqlName) => member(product, sqlName));
  const root = {
    product,
    version,
    extensionClass: metadata.class,
    versioning: metadata.versioning,
    sourceIdentity: extensionSourceIdentity(product, "verify-extension-release-identity.test"),
    compatibility: metadata.compatibility,
  };
  return members.length === 1
    ? { schema: "oliphaunt-extension-release-manifest-v1", ...root, ...members[0] }
    : { schema: "oliphaunt-extension-release-manifest-v2", ...root, extensions: members, assets: [] };
}

describe("canonical extension release identity", () => {
  for (const product of ["oliphaunt-extension-pgtap", "oliphaunt-extension-contrib-pg18"]) {
    test(`${product} rejects forged root compatibility`, () => {
      const value = manifest(product);
      expect(() => assertCanonicalExtensionReleaseIdentity(product, value.version, value)).not.toThrow();
      value.compatibility.wasixRuntimeVersion = "9.9.9";
      expect(() => assertCanonicalExtensionReleaseIdentity(product, value.version, value)).toThrow(/compatibility differs/u);
    });
  }

  test("rejects forged source, versioning, and semantic member metadata", () => {
    const product = "oliphaunt-extension-contrib-pg18";
    const value = manifest(product);
    value.sourceIdentity.sha256 = "0".repeat(64);
    expect(() => assertCanonicalExtensionReleaseIdentity(product, value.version, value)).toThrow(/sourceIdentity differs/u);

    const forgedVersioning = manifest(product);
    forgedVersioning.versioning = "independent";
    expect(() => assertCanonicalExtensionReleaseIdentity(product, forgedVersioning.version, forgedVersioning)).toThrow(/versioning differs/u);

    const forgedMember = manifest(product);
    forgedMember.extensions[0].desktopReleaseReady = !forgedMember.extensions[0].desktopReleaseReady;
    expect(() => assertCanonicalExtensionReleaseIdentity(product, forgedMember.version, forgedMember)).toThrow(/desktopReleaseReady differs/u);

    const forgedInventory = manifest(product);
    forgedInventory.extensions[0].dataFiles = [...forgedInventory.extensions[0].dataFiles, "undeclared/foreign.sql"].sort();
    expect(() => assertCanonicalExtensionReleaseIdentity(product, forgedInventory.version, forgedInventory)).toThrow(/dataFiles differs/u);

    const unsortedInventory = manifest("oliphaunt-extension-postgis");
    unsortedInventory.extensionSqlFilePrefixes.reverse();
    expect(() => assertCanonicalExtensionReleaseIdentity(
      "oliphaunt-extension-postgis",
      unsortedInventory.version,
      unsortedInventory,
    )).toThrow(/extensionSqlFilePrefixes differs/u);
  });
});
