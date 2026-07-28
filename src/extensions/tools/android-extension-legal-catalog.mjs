#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extensionCarrierLegalContract,
  extensionCarrierLegalFileInventory,
} from "../../../tools/release/extension-upstream-licenses.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const INPUT = path.join(ROOT, "src/extensions/generated/sdk/kotlin.json");
const OUTPUT = path.join(
  ROOT,
  "src/sdks/kotlin/oliphaunt-android-gradle-plugin/src/main/resources/dev/oliphaunt/android/extension-legal-catalog.json",
);
const SCHEMA = "oliphaunt-android-extension-legal-catalog-v1";
const TARGETS = Object.freeze(["android-arm64-v8a", "android-x86_64"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message) {
  throw new Error(`android-extension-legal-catalog: ${message}`);
}

function canonicalMetadata(metadata) {
  if (
    metadata === null
    || typeof metadata !== "object"
    || Array.isArray(metadata)
    || metadata.consumer !== "kotlin"
    || typeof metadata["extension-catalog-sha256"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(metadata["extension-catalog-sha256"])
    || !Array.isArray(metadata.extensions)
    || metadata.extensions.length === 0
  ) {
    fail("generated Kotlin metadata is malformed");
  }
  const rows = metadata.extensions.map((row, index) => {
    const sqlName = row?.["sql-name"];
    const product = row?.["release-product"];
    if (
      typeof sqlName !== "string"
      || !/^[A-Za-z0-9._-]{1,128}$/u.test(sqlName)
      || typeof product !== "string"
      || !/^oliphaunt-extension-[A-Za-z0-9._-]+$/u.test(product)
      || row.public !== true
      || row.stable !== true
      || row["mobile-release-ready"] !== true
    ) {
      fail(`generated Kotlin extension row ${index} is not one public mobile contract`);
    }
    return Object.freeze({ sqlName, product });
  });
  const sorted = [...rows].sort((left, right) => compareText(left.sqlName, right.sqlName));
  if (
    JSON.stringify(rows) !== JSON.stringify(sorted)
    || new Set(rows.map(({ sqlName }) => sqlName)).size !== rows.length
  ) {
    fail("generated Kotlin extension rows must be sorted and unique by SQL name");
  }
  return Object.freeze({
    sourceCatalogSha256: metadata["extension-catalog-sha256"],
    rows: Object.freeze(rows),
  });
}

function legalMembers(product, sqlNames, target, scope) {
  const files = extensionCarrierLegalFileInventory(product, sqlNames, {
    family: "native",
    target,
  });
  return files.map((file) => Object.freeze({
    path: scope === "leaf" && file.path.startsWith("share/licenses/")
      ? `files/${file.path}`
      : file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    mode: file.mode,
  })).sort((left, right) => compareText(left.path, right.path));
}

function contract(scope, identity, product, sqlNames, target) {
  const legal = extensionCarrierLegalContract(product, sqlNames, {
    family: "native",
    target,
  });
  return Object.freeze({
    scope,
    identity,
    product,
    target,
    profile: legal.profile,
    licenseFiles: [...legal.licenseFiles],
    members: legalMembers(product, sqlNames, target, scope),
  });
}

export function androidExtensionLegalCatalog(metadata) {
  const checked = canonicalMetadata(metadata);
  const products = new Map();
  for (const row of checked.rows) {
    const members = products.get(row.product) ?? [];
    members.push(row.sqlName);
    products.set(row.product, members);
  }

  const contracts = [];
  for (const [product, sqlNames] of [...products].sort(([left], [right]) => compareText(left, right))) {
    for (const target of TARGETS) {
      contracts.push(contract("aggregate", product, product, sqlNames, target));
    }
  }
  for (const { sqlName, product } of checked.rows) {
    for (const target of TARGETS) {
      contracts.push(contract("leaf", sqlName, product, [sqlName], target));
    }
  }
  contracts.sort((left, right) => compareText(
    `${left.scope}\0${left.identity}\0${left.target}`,
    `${right.scope}\0${right.identity}\0${right.target}`,
  ));
  return Object.freeze({
    schema: SCHEMA,
    sourceCatalogSha256: checked.sourceCatalogSha256,
    contracts: Object.freeze(contracts),
  });
}

export function androidExtensionLegalCatalogText(metadata) {
  return `${JSON.stringify(androidExtensionLegalCatalog(metadata), null, 2)}\n`;
}

export function readAndroidExtensionLegalCatalogMetadata() {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(INPUT, "utf8"));
  } catch (cause) {
    fail(`cannot read ${path.relative(ROOT, INPUT)}: ${cause.message}`);
  }
  return metadata;
}

export function checkAndroidExtensionLegalCatalog({ write = false } = {}) {
  const expected = androidExtensionLegalCatalogText(readAndroidExtensionLegalCatalogMetadata());
  if (write) {
    const temporary = `${OUTPUT}.tmp-${process.pid}`;
    try {
      writeFileSync(temporary, expected, { encoding: "utf8", mode: 0o644 });
      renameSync(temporary, OUTPUT);
    } finally {
      rmSync(temporary, { force: true });
    }
    return;
  }
  let actual;
  try {
    actual = readFileSync(OUTPUT, "utf8");
  } catch (cause) {
    fail(`${path.relative(ROOT, OUTPUT)} is missing: ${cause.message}`);
  }
  if (actual !== expected) {
    const expectedDigest = createHash("sha256").update(expected).digest("hex");
    const actualDigest = createHash("sha256").update(actual).digest("hex");
    fail(
      `${path.relative(ROOT, OUTPUT)} is stale (expected ${expectedDigest}, got ${actualDigest}); `
      + "run tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --write",
    );
  }
}

function parseArgs(argv) {
  if (argv.length > 1 || (argv.length === 1 && !["--check", "--write"].includes(argv[0]))) {
    fail("usage: android-extension-legal-catalog.mjs [--check|--write]");
  }
  return { write: argv[0] === "--write" };
}

if (import.meta.main) {
  try {
    checkAndroidExtensionLegalCatalog(parseArgs(Bun.argv.slice(2)));
    console.log("Android extension legal catalog is current");
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}
