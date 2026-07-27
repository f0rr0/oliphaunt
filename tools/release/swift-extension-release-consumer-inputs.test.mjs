import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { iosBaseLegalMetadata } from "./ios-carrier-manifest.mjs";
import { extensionReleaseConsumerInputs } from "./swift-extension-release-consumer-inputs.mjs";

const VERSION = "1.2.3";
const BASE_TAG = `liboliphaunt-native-v${VERSION}`;

function sourceCarrier() {
  const asset = (role, name, format, member, bytes) => ({
    bytes,
    format,
    member,
    name,
    role,
    sha256: String(bytes).padStart(64, "0"),
    url: `https://github.com/f0rr0/oliphaunt/releases/download/${BASE_TAG}/${name}`,
  });
  return {
    base: {
      assets: [
        asset("base-xcframework", `liboliphaunt-${VERSION}-apple-spm-xcframework.zip`, "zip", "liboliphaunt.xcframework", 1),
        asset("runtime-resources", `liboliphaunt-${VERSION}-runtime-resources.tar.gz`, "tar.gz", "oliphaunt", 2),
        asset("icu-data", `liboliphaunt-${VERSION}-icu-data.tar.gz`, "tar.gz", "share/icu", 3),
      ],
      product: "liboliphaunt-native",
      tag: BASE_TAG,
      version: VERSION,
    },
    carriers: [],
    extensions: [],
    legal: { base: iosBaseLegalMetadata(), extensions: [] },
    schema: "oliphaunt-react-native-ios-carrier-v1",
  };
}

function extensionCarrier(product, rows, { baseVersion = VERSION } = {}) {
  const version = product.endsWith("pgtap") ? "2.0.0" : "3.0.0";
  const tag = `${product}-v${version}`;
  return {
    base: {
      product: "liboliphaunt-native",
      tag: `liboliphaunt-native-v${baseVersion}`,
      version: baseVersion,
    },
    carriers: [],
    entries: rows.map(({ nativeModuleStem, sqlName }) => ({
      dependencyCarriers: [],
      extension: {
        nativeModuleStem,
        product,
        sqlName,
        tag,
        version,
      },
    })),
    release: { product, tag, version },
    schema: "oliphaunt-swift-extension-carrier-v1",
  };
}

function fixture(documents) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-swift-consumer-carriers-"));
  return documents.map((document, index) => {
    const file = path.join(root, `carrier-${index}.json`);
    writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
    return file;
  });
}

test("plans every repeated independent carrier against a selection-neutral source carrier", () => {
  const [source, pgtap, postgis, vector] = fixture([
    sourceCarrier(),
    extensionCarrier("oliphaunt-extension-pgtap", [{ nativeModuleStem: null, sqlName: "pgtap" }]),
    extensionCarrier("oliphaunt-extension-postgis", [{ nativeModuleStem: "postgis-3", sqlName: "postgis" }]),
    extensionCarrier("oliphaunt-extension-vector", [{ nativeModuleStem: "vector", sqlName: "vector" }]),
  ]);
  assert.deepEqual(
    extensionReleaseConsumerInputs({
      extensionCarrierFiles: [pgtap, postgis, vector],
      sourceCarrierFile: source,
    }),
    {
      extensionCarrierCount: 3,
      extensionProducts: [
        "oliphaunt-extension-pgtap",
        "oliphaunt-extension-postgis",
        "oliphaunt-extension-vector",
      ],
      extensions: ["pgtap", "postgis", "vector"],
      extensionsCsv: "pgtap,postgis,vector",
      finalLink: {
        kind: "native-extension",
        nativeExtension: "postgis",
        nativeModuleStem: "postgis-3",
        runtimeProduct: "liboliphaunt-native",
        runtimeVersion: VERSION,
      },
      schema: "oliphaunt-swift-extension-release-consumer-inputs-v1",
    },
  );
});

test("rejects an aggregate or extension-bearing source carrier", () => {
  const contaminated = sourceCarrier();
  contaminated.extensions.push({ sqlName: "vector" });
  const [source, vector] = fixture([
    contaminated,
    extensionCarrier("oliphaunt-extension-vector", [{ nativeModuleStem: "vector", sqlName: "vector" }]),
  ]);
  assert.throws(
    () => extensionReleaseConsumerInputs({ sourceCarrierFile: source, extensionCarrierFiles: [vector] }),
    /source tags are selection-neutral/u,
  );

  const [neutralSource, aggregate] = fixture([sourceCarrier(), sourceCarrier()]);
  assert.throws(
    () => extensionReleaseConsumerInputs({ sourceCarrierFile: neutralSource, extensionCarrierFiles: [aggregate] }),
    /fields must be exactly base,carriers,entries,release,schema/u,
  );
});

test("rejects base skew and repeated owners", () => {
  const [source, skewed] = fixture([
    sourceCarrier(),
    extensionCarrier(
      "oliphaunt-extension-vector",
      [{ nativeModuleStem: "vector", sqlName: "vector" }],
      { baseVersion: "1.2.4" },
    ),
  ]);
  assert.throws(
    () => extensionReleaseConsumerInputs({ sourceCarrierFile: source, extensionCarrierFiles: [skewed] }),
    /requires liboliphaunt-native-v1\.2\.4.*provides liboliphaunt-native-v1\.2\.3/u,
  );

  const [neutral, first, second] = fixture([
    sourceCarrier(),
    extensionCarrier("oliphaunt-extension-vector", [{ nativeModuleStem: "vector", sqlName: "vector" }]),
    extensionCarrier("oliphaunt-extension-vector", [{ nativeModuleStem: "vector", sqlName: "vector2" }]),
  ]);
  assert.throws(
    () => extensionReleaseConsumerInputs({ sourceCarrierFile: neutral, extensionCarrierFiles: [first, second] }),
    /repeat release product oliphaunt-extension-vector/u,
  );
});

test("plans an explicit base-runtime final-link proof for an SQL-only selection", () => {
  const [sqlSource, sqlOnly] = fixture([
    sourceCarrier(),
    extensionCarrier("oliphaunt-extension-pgtap", [{ nativeModuleStem: null, sqlName: "pgtap" }]),
  ]);
  assert.deepEqual(
    extensionReleaseConsumerInputs({ sourceCarrierFile: sqlSource, extensionCarrierFiles: [sqlOnly] }),
    {
      extensionCarrierCount: 1,
      extensionProducts: ["oliphaunt-extension-pgtap"],
      extensions: ["pgtap"],
      extensionsCsv: "pgtap",
      finalLink: {
        kind: "base-runtime",
        nativeExtension: null,
        nativeModuleStem: null,
        runtimeProduct: "liboliphaunt-native",
        runtimeVersion: VERSION,
      },
      schema: "oliphaunt-swift-extension-release-consumer-inputs-v1",
    },
  );
});
