#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadPublicationLock } from "./publication-lock.mjs";
import { compareText } from "./release-graph.mjs";
import {
  validateLockedRegistryReceipts,
  verifyLockedRegistryIntegrity,
} from "./registry-integrity.mjs";

const TOOL = "verify-release-recovery-publication.mjs";
const INVENTORY_SCHEMA = "oliphaunt-release-registry-inventory-v1";
export const RECOVERY_PUBLICATION_STATE_SCHEMA =
  "oliphaunt-release-recovery-publication-state-v1";
const SHA = /^[0-9a-f]{40}$/u;
const KIND_ECOSYSTEM = new Map([
  ["crates", "cargo"],
  ["jsr", "jsr"],
  ["maven", "maven"],
  ["npm", "npm"],
]);
const REGISTRY_ECOSYSTEMS = new Set(KIND_ECOSYSTEM.values());

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameStrings(left, right) {
  const a = [...left].sort(compareText);
  const b = [...right].sort(compareText);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function exactKeys(value, expected, context) {
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || !sameStrings(Object.keys(value), expected)
  ) {
    throw error(`${context} must contain exactly ${expected.join(", ")}`);
  }
  return value;
}

function uniqueStrings(value, context, { nonempty = true } = {}) {
  if (
    !Array.isArray(value)
    || (nonempty && value.length === 0)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw error(`${context} must be a ${nonempty ? "nonempty " : ""}unique string list`);
  }
  return value;
}

function inventoryPackage(value, context) {
  exactKeys(value, ["kind", "name", "version"], context);
  if (
    !KIND_ECOSYSTEM.has(value.kind)
    || typeof value.name !== "string"
    || value.name.length === 0
    || typeof value.version !== "string"
    || value.version.length === 0
  ) {
    throw error(`${context} has an invalid registry identity`);
  }
  return {
    ecosystem: KIND_ECOSYSTEM.get(value.kind),
    id: `${KIND_ECOSYSTEM.get(value.kind)}:${value.name}`,
    name: value.name,
    version: value.version,
  };
}

function inventoryPackageMap(packages, context) {
  if (!Array.isArray(packages)) throw error(`${context} must be a list`);
  const records = packages.map((pkg, index) => inventoryPackage(pkg, `${context}[${index}]`));
  const byId = new Map(records.map((record) => [record.id, record]));
  if (byId.size !== records.length) throw error(`${context} contains duplicate registry identities`);
  return byId;
}

export function classifyReleaseRecoveryPublication({
  lock,
  inventory,
  products,
} = {}) {
  const selectedProducts = uniqueStrings(products, "products");
  exactKeys(inventory, ["products", "results", "schema", "source"], "registry inventory");
  if (inventory.schema !== INVENTORY_SCHEMA) {
    throw error(`registry inventory schema must be ${INVENTORY_SCHEMA}`);
  }
  exactKeys(inventory.source, ["commit"], "registry inventory source");
  if (!SHA.test(inventory.source.commit) || inventory.source.commit !== lock?.source?.commit) {
    throw error("registry inventory source must match the publication lock commit");
  }
  uniqueStrings(inventory.products, "registry inventory products");
  if (!sameStrings(inventory.products, selectedProducts)) {
    throw error("registry inventory products do not match the selected recovery products");
  }
  const lockedProducts = lock.products.map(({ id }) => id);
  if (!sameStrings(lockedProducts, selectedProducts)) {
    throw error("publication lock products do not match the selected recovery products");
  }
  if (!Array.isArray(inventory.results)) throw error("registry inventory results must be a list");
  const results = new Map();
  for (const [index, result] of inventory.results.entries()) {
    exactKeys(result, ["missing", "packages", "product", "published"], `registry result ${index}`);
    if (
      typeof result.product !== "string"
      || !selectedProducts.includes(result.product)
      || results.has(result.product)
    ) {
      throw error(`registry result ${index} has an unknown or duplicate product`);
    }
    const packages = inventoryPackageMap(result.packages, `${result.product}.packages`);
    const missing = inventoryPackageMap(result.missing, `${result.product}.missing`);
    const published = inventoryPackageMap(result.published, `${result.product}.published`);
    if (
      missing.size + published.size !== packages.size
      || [...missing].some(([id]) => published.has(id) || !packages.has(id))
      || [...published].some(([id]) => !packages.has(id))
    ) {
      throw error(`${result.product} registry state does not exactly partition its package inventory`);
    }
    for (const [id, pkg] of packages) {
      const state = missing.get(id) ?? published.get(id);
      if (stableJson(pkg) !== stableJson(state)) {
        throw error(`${result.product} registry state changes identity ${id}`);
      }
    }
    results.set(result.product, { missing, packages, published });
  }
  if (!sameStrings(results.keys(), selectedProducts)) {
    throw error("registry inventory must contain exactly one result for every selected product");
  }

  const expectedCarriers = lock.carriers
    .filter((carrier) =>
      selectedProducts.includes(carrier.product)
      && REGISTRY_ECOSYSTEMS.has(carrier.ecosystem));
  const expectedById = new Map(expectedCarriers.map((carrier) => [carrier.id, carrier]));
  if (expectedById.size !== expectedCarriers.length) {
    throw error("publication lock contains duplicate registry carrier identities");
  }
  const publicCarrierIds = [];
  const missingCarrierIds = [];
  const observed = new Set();
  for (const [product, state] of results) {
    for (const [id, pkg] of state.packages) {
      const carrier = expectedById.get(id);
      if (
        carrier === undefined
        || carrier.product !== product
        || carrier.name !== pkg.name
        || carrier.version !== pkg.version
        || carrier.ecosystem !== pkg.ecosystem
        || observed.has(id)
      ) {
        throw error(`${product} registry inventory does not match locked carrier ${id}`);
      }
      observed.add(id);
      (state.published.has(id) ? publicCarrierIds : missingCarrierIds).push(id);
    }
  }
  if (!sameStrings(observed, expectedById.keys())) {
    throw error("registry inventory does not cover every selected locked carrier exactly once");
  }
  publicCarrierIds.sort(compareText);
  missingCarrierIds.sort(compareText);
  if (publicCarrierIds.length === 0) {
    throw error(
      "same-version recovery requires at least one already-public immutable registry carrier",
    );
  }
  return {
    source: lock.source,
    lockDigest: lock.lockDigest,
    products: [...selectedProducts].sort(compareText),
    selectedCarrierCount: expectedCarriers.length,
    publicCarrierIds,
    missingCarrierIds,
    needsCargoToken: missingCarrierIds.some((id) => id.startsWith("cargo:")),
    needsNpmToken: missingCarrierIds.some((id) => id.startsWith("npm:")),
  };
}

export function releaseRecoveryPublicationReceipt(classification, receipts) {
  if (!Array.isArray(receipts)) throw error("public registry receipts must be a list");
  const receiptIds = receipts.map((receipt) => receipt?.id);
  if (
    receiptIds.some((id) => typeof id !== "string" || id.length === 0)
    || !sameStrings(receiptIds, classification.publicCarrierIds)
  ) {
    throw error("public registry receipts must prove every classified public carrier exactly once");
  }
  const record = {
    schema: RECOVERY_PUBLICATION_STATE_SCHEMA,
    source: classification.source,
    lockDigest: classification.lockDigest,
    products: classification.products,
    selectedCarrierCount: classification.selectedCarrierCount,
    publicCarrierCount: classification.publicCarrierIds.length,
    missingCarrierCount: classification.missingCarrierIds.length,
    publicCarrierIds: classification.publicCarrierIds,
    missingCarrierIds: classification.missingCarrierIds,
    needsCargoToken: classification.needsCargoToken,
    needsNpmToken: classification.needsNpmToken,
    receipts,
  };
  return {
    ...record,
    evidenceDigest: createHash("sha256").update(stableJson(record)).digest("hex"),
  };
}

export function validateReleaseRecoveryPublicationReceipt({
  lock,
  receipt,
  products,
  validateReceipts = validateLockedRegistryReceipts,
} = {}) {
  const fields = [
    "evidenceDigest",
    "lockDigest",
    "missingCarrierCount",
    "missingCarrierIds",
    "needsCargoToken",
    "needsNpmToken",
    "products",
    "publicCarrierCount",
    "publicCarrierIds",
    "receipts",
    "schema",
    "selectedCarrierCount",
    "source",
  ];
  exactKeys(receipt, fields, "recovery publication receipt");
  const selectedProducts = uniqueStrings(products, "products");
  uniqueStrings(receipt.products, "receipt products");
  if (
    receipt.schema !== RECOVERY_PUBLICATION_STATE_SCHEMA
    || stableJson(receipt.source) !== stableJson(lock.source)
    || receipt.lockDigest !== lock.lockDigest
    || !sameStrings(receipt.products, selectedProducts)
  ) {
    throw error("recovery publication receipt is not bound to the selected publication lock");
  }
  uniqueStrings(receipt.publicCarrierIds, "receipt publicCarrierIds");
  uniqueStrings(receipt.missingCarrierIds, "receipt missingCarrierIds", { nonempty: false });
  const selectedCarriers = lock.carriers.filter((carrier) =>
    selectedProducts.includes(carrier.product) && REGISTRY_ECOSYSTEMS.has(carrier.ecosystem));
  const selectedIds = selectedCarriers.map(({ id }) => id);
  if (
    receipt.publicCarrierCount !== receipt.publicCarrierIds.length
    || receipt.publicCarrierCount < 1
    || receipt.missingCarrierCount !== receipt.missingCarrierIds.length
    || receipt.selectedCarrierCount !== selectedCarriers.length
    || !sameStrings(
      [...receipt.publicCarrierIds, ...receipt.missingCarrierIds],
      selectedIds,
    )
    || receipt.needsCargoToken
      !== receipt.missingCarrierIds.some((id) => id.startsWith("cargo:"))
    || receipt.needsNpmToken
      !== receipt.missingCarrierIds.some((id) => id.startsWith("npm:"))
  ) {
    throw error("recovery publication receipt carrier partition is inconsistent");
  }
  validateReceipts(lock, {
    carrierIds: receipt.publicCarrierIds,
    receipts: receipt.receipts,
  });
  const unsigned = { ...receipt };
  delete unsigned.evidenceDigest;
  const expectedDigest = createHash("sha256").update(stableJson(unsigned)).digest("hex");
  if (receipt.evidenceDigest !== expectedDigest) {
    throw error("recovery publication receipt evidenceDigest mismatch");
  }
  return receipt;
}

function appendGitHubOutputs(file, receipt) {
  if (!file) return;
  appendFileSync(
    file,
    [
      `needs_cargo_token=${receipt.needsCargoToken}`,
      `needs_npm_token=${receipt.needsNpmToken}`,
      `public_carrier_count=${receipt.publicCarrierCount}`,
      `missing_carrier_count=${receipt.missingCarrierCount}`,
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    githubOutput: "",
    inventory: "",
    lock: "",
    output: "",
    productsJson: "",
    verifyReceipt: "",
  };
  const flags = new Map([
    ["--github-output", "githubOutput"],
    ["--inventory", "inventory"],
    ["--lock", "lock"],
    ["--output", "output"],
    ["--products-json", "productsJson"],
    ["--verify-receipt", "verifyReceipt"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = flags.get(argv[index]);
    if (key === undefined) throw error(`unknown argument ${argv[index]}`);
    options[key] = argv[index + 1] ?? "";
    index += 1;
  }
  if (
    !options.lock
    || !options.productsJson
    || Boolean(options.verifyReceipt) === Boolean(options.inventory || options.output)
    || (!options.verifyReceipt && (!options.inventory || !options.output))
  ) {
    throw error(
      "usage: verify-release-recovery-publication.mjs "
        + "--lock FILE --products-json JSON "
        + "(--inventory FILE --output FILE | --verify-receipt FILE) "
        + "[--github-output FILE]",
    );
  }
  try {
    options.products = JSON.parse(options.productsJson);
  } catch (cause) {
    throw error(`--products-json is invalid JSON: ${cause.message}`);
  }
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(Bun.argv.slice(2));
    const lock = loadPublicationLock(path.resolve(options.lock));
    if (options.verifyReceipt) {
      const receipt = validateReleaseRecoveryPublicationReceipt({
        lock,
        receipt: JSON.parse(readFileSync(path.resolve(options.verifyReceipt), "utf8")),
        products: options.products,
      });
      appendGitHubOutputs(options.githubOutput, receipt);
      console.log(
        `verified retained recovery proof for ${receipt.publicCarrierCount} public carrier(s)`,
      );
      process.exit(0);
    }
    const inventory = JSON.parse(readFileSync(path.resolve(options.inventory), "utf8"));
    const classification = classifyReleaseRecoveryPublication({
      lock,
      inventory,
      products: options.products,
    });
    const receipts = await verifyLockedRegistryIntegrity(lock, {
      carrierIds: classification.publicCarrierIds,
    });
    const receipt = releaseRecoveryPublicationReceipt(classification, receipts);
    const output = path.resolve(options.output);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    appendGitHubOutputs(options.githubOutput, receipt);
    console.log(
      `verified ${receipt.publicCarrierCount} already-public immutable carrier(s); `
        + `${receipt.missingCarrierCount} carrier(s) remain absent`,
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
