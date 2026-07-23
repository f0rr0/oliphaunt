import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateStagedSwiftSourceCarrier } from "./release-sdk-product-dry-run.mjs";
import { validateSwiftSourceReleaseContract } from "./swift-source-carrier-contract.mjs";
import { iosBaseLegalMetadata } from "./ios-carrier-manifest.mjs";

const temporaryDirectories = [];

function temporaryCarrier(document) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-swift-source-carrier-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "oliphaunt-react-native-ios-carriers.json");
  writeFileSync(file, typeof document === "string" ? document : `${JSON.stringify(document)}\n`);
  return file;
}

function selectionNeutralCarrier(version = "1.2.3") {
  const product = "liboliphaunt-native";
  const tag = `${product}-v${version}`;
  const assets = [
    ["base-xcframework", `liboliphaunt-${version}-apple-spm-xcframework.zip`, "zip", "liboliphaunt.xcframework", "a"],
    ["runtime-resources", `liboliphaunt-${version}-runtime-resources.tar.gz`, "tar.gz", "oliphaunt", "b"],
    ["icu-data", `liboliphaunt-${version}-icu-data.tar.gz`, "tar.gz", "share/icu", "c"],
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
    legal: { base: iosBaseLegalMetadata(), extensions: [] },
    schema: "oliphaunt-react-native-ios-carrier-v1",
  };
}

function releaseManifest(carrier, { checksum, url } = {}) {
  const asset = carrier.base.assets.find(({ role }) => role === "base-xcframework");
  return `.binaryTarget(\n  name: "liboliphaunt",\n  url: "${url ?? asset.url}",\n  checksum: "${checksum ?? asset.sha256}"\n)\n`;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
  }
});

test("accepts a schema-valid selection-neutral Swift source-tag carrier", () => {
  const document = selectionNeutralCarrier();
  expect(validateStagedSwiftSourceCarrier(temporaryCarrier(document))).toEqual(document);
});

test("rejects selected extensions and carrier envelopes in a Swift source tag", () => {
  const selected = selectionNeutralCarrier();
  selected.extensions.push({ sqlName: "vector" });
  expect(() => validateStagedSwiftSourceCarrier(temporaryCarrier(selected))).toThrow(
    /extensions.*selection-neutral/u,
  );

  const carrierBound = selectionNeutralCarrier();
  carrierBound.carriers.push({ name: "extension-payload.tar.gz" });
  expect(() => validateStagedSwiftSourceCarrier(temporaryCarrier(carrierBound))).toThrow(
    /carriers.*do not own extension payload carriers/u,
  );
});

test("rejects malformed Swift source-tag carrier JSON and schema shape", () => {
  expect(() => validateStagedSwiftSourceCarrier(temporaryCarrier("{not-json\n"))).toThrow(
    /is not valid JSON/u,
  );

  const missingInventory = selectionNeutralCarrier();
  delete missingInventory.carriers;
  expect(() => validateStagedSwiftSourceCarrier(temporaryCarrier(missingInventory))).toThrow(
    /fields must be exactly/u,
  );
});

test("binds the Swift source carrier to the canonical repository, native version, and binary target", () => {
  const carrier = selectionNeutralCarrier();
  expect(validateSwiftSourceReleaseContract({
    carrier,
    expectedNativeVersion: "1.2.3",
    manifestText: releaseManifest(carrier),
  }).carrier).toEqual(carrier);

  const foreign = structuredClone(carrier);
  foreign.base.assets[0].url = foreign.base.assets[0].url.replace(
    "github.com/f0rr0/oliphaunt",
    "downloads.example.invalid/f0rr0/oliphaunt",
  );
  expect(() => validateSwiftSourceReleaseContract({
    carrier: foreign,
    manifestText: releaseManifest(foreign),
  })).toThrow(/must be https:\/\/github\.com\/f0rr0\/oliphaunt/u);

  expect(() => validateSwiftSourceReleaseContract({
    carrier,
    expectedNativeVersion: "9.9.9",
    manifestText: releaseManifest(carrier),
  })).toThrow(/must match liboliphaunt-native 9\.9\.9/u);

  expect(() => validateSwiftSourceReleaseContract({
    carrier,
    manifestText: releaseManifest(carrier, { checksum: "f".repeat(64) }),
  })).toThrow(/binary target checksum.*must match carrier SHA-256/u);
});
