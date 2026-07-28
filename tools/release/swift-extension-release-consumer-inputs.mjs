#!/usr/bin/env bun

import { readFileSync } from "node:fs";

import { validateSelectionNeutralSwiftSourceCarrier } from "./swift-source-carrier-contract.mjs";

const PREFIX = "swift-extension-release-consumer-inputs.mjs";
const EXTENSION_CARRIER_SCHEMA = "oliphaunt-swift-extension-carrier-v1";
const PRODUCT = /^oliphaunt-extension-[A-Za-z0-9._-]+$/u;
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9._-]+$/u;
const STABLE_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`${PREFIX}: ${message}`);
}

function object(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort(compareText);
  const canonical = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    fail(`${label} fields must be exactly ${canonical.join(",")}; got ${actual.join(",")}`);
  }
  return value;
}

function stableVersion(value, label) {
  if (typeof value !== "string" || !STABLE_SEMVER.test(value)) {
    fail(`${label} must be a stable SemVer X.Y.Z version`);
  }
  return value;
}

function releaseReference(value, label) {
  const row = exactKeys(value, ["product", "tag", "version"], label);
  if (typeof row.product !== "string" || !PRODUCT.test(row.product)) {
    fail(`${label}.product must be an exact-extension product id`);
  }
  stableVersion(row.version, `${label}.version`);
  const expectedTag = `${row.product}-v${row.version}`;
  if (row.tag !== expectedTag) {
    fail(`${label}.tag must be ${expectedTag}`);
  }
  return row;
}

function baseReference(value, label) {
  const row = exactKeys(value, ["product", "tag", "version"], label);
  if (row.product !== "liboliphaunt-native") {
    fail(`${label}.product must be liboliphaunt-native`);
  }
  stableVersion(row.version, `${label}.version`);
  const expectedTag = `${row.product}-v${row.version}`;
  if (row.tag !== expectedTag) {
    fail(`${label}.tag must be ${expectedTag}`);
  }
  return row;
}

function readJson(file, label) {
  if (typeof file !== "string" || file.length === 0) {
    fail(`${label} path must be a non-empty string`);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    fail(`cannot read ${label} ${file}: ${cause.message}`);
  }
}

export function extensionReleaseConsumerInputs({ sourceCarrierFile, extensionCarrierFiles }) {
  const sourceCarrier = readJson(sourceCarrierFile, "source carrier");
  try {
    validateSelectionNeutralSwiftSourceCarrier(sourceCarrier, sourceCarrierFile);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  if (
    !Array.isArray(extensionCarrierFiles)
    || extensionCarrierFiles.length === 0
    || extensionCarrierFiles.some((file) => typeof file !== "string" || file.length === 0)
  ) {
    fail("at least one independent extension carrier file is required");
  }
  if (new Set(extensionCarrierFiles).size !== extensionCarrierFiles.length) {
    fail("independent extension carrier paths must not repeat");
  }

  const releaseProducts = new Set();
  const extensions = [];
  for (const file of extensionCarrierFiles) {
    const carrier = exactKeys(
      readJson(file, "extension carrier"),
      ["base", "carriers", "entries", "release", "schema"],
      file,
    );
    if (carrier.schema !== EXTENSION_CARRIER_SCHEMA) {
      fail(`${file}.schema must be ${EXTENSION_CARRIER_SCHEMA}`);
    }
    const base = baseReference(carrier.base, `${file}.base`);
    if (
      base.product !== sourceCarrier.base.product
      || base.version !== sourceCarrier.base.version
      || base.tag !== sourceCarrier.base.tag
    ) {
      fail(`${file} requires ${base.tag}, but the selection-neutral source carrier provides ${sourceCarrier.base.tag}`);
    }
    const release = releaseReference(carrier.release, `${file}.release`);
    if (releaseProducts.has(release.product)) {
      fail(`independent extension carriers repeat release product ${release.product}`);
    }
    releaseProducts.add(release.product);
    if (!Array.isArray(carrier.entries) || carrier.entries.length === 0) {
      fail(`${file}.entries must be a non-empty array`);
    }
    for (const [index, rawEntry] of carrier.entries.entries()) {
      const entry = exactKeys(rawEntry, ["dependencyCarriers", "extension"], `${file}.entries[${index}]`);
      if (!Array.isArray(entry.dependencyCarriers)) {
        fail(`${file}.entries[${index}].dependencyCarriers must be an array`);
      }
      const extension = object(entry.extension, `${file}.entries[${index}].extension`);
      if (typeof extension.sqlName !== "string" || !PORTABLE_IDENTIFIER.test(extension.sqlName)) {
        fail(`${file}.entries[${index}].extension.sqlName must be a portable identifier`);
      }
      if (
        extension.nativeModuleStem !== null
        && (typeof extension.nativeModuleStem !== "string" || !PORTABLE_IDENTIFIER.test(extension.nativeModuleStem))
      ) {
        fail(`${file}.entries[${index}].extension.nativeModuleStem must be null or a portable identifier`);
      }
      if (
        extension.product !== release.product
        || extension.version !== release.version
        || extension.tag !== release.tag
      ) {
        fail(`${file}.entries[${index}].extension must be owned by ${release.tag}`);
      }
      extensions.push({
        nativeModuleStem: extension.nativeModuleStem,
        product: extension.product,
        sqlName: extension.sqlName,
      });
    }
  }

  extensions.sort((left, right) => compareText(left.sqlName, right.sqlName));
  if (new Set(extensions.map(({ sqlName }) => sqlName)).size !== extensions.length) {
    fail("independent extension carriers repeat an extension SQL name");
  }
  const native = extensions.filter(({ nativeModuleStem }) => nativeModuleStem !== null);
  const selectedNative = native.find(({ sqlName }) => sqlName === "postgis")
    ?? native.find(({ sqlName }) => sqlName === "vector")
    ?? native[0];
  return {
    extensionCarrierCount: extensionCarrierFiles.length,
    extensionProducts: [...releaseProducts].sort(compareText),
    extensions: extensions.map(({ sqlName }) => sqlName),
    extensionsCsv: extensions.map(({ sqlName }) => sqlName).join(","),
    finalLink: {
      kind: selectedNative === undefined ? "base-runtime" : "native-extension",
      nativeExtension: selectedNative?.sqlName ?? null,
      nativeModuleStem: selectedNative?.nativeModuleStem ?? null,
      runtimeProduct: sourceCarrier.base.product,
      runtimeVersion: sourceCarrier.base.version,
    },
    schema: "oliphaunt-swift-extension-release-consumer-inputs-v1",
  };
}

function parseArgs(argv) {
  const args = { extensionCarrierFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `usage: ${PREFIX} --source-carrier FILE --extension-carrier FILE [--extension-carrier FILE ...]`,
      );
      process.exit(0);
    }
    if (arg !== "--source-carrier" && arg !== "--extension-carrier") {
      fail(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--source-carrier") {
      if (args.sourceCarrierFile !== undefined) fail("--source-carrier must be passed exactly once");
      args.sourceCarrierFile = value;
    } else {
      args.extensionCarrierFiles.push(value);
    }
  }
  if (args.sourceCarrierFile === undefined) fail("--source-carrier is required");
  return args;
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(extensionReleaseConsumerInputs(parseArgs(Bun.argv.slice(2))))}\n`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
