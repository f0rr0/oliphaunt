#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadPublicationLock, lockedCarriers } from "./publication-lock.mjs";
import { verifyLockedRegistryIntegrity } from "./registry-integrity.mjs";
import { ROOT, compareText } from "./release-graph.mjs";

export const BOOTSTRAP_LEDGER_SCHEMA = "oliphaunt-bootstrap-ledger-checkpoint-v1";
export const DEFAULT_BOOTSTRAP_LEDGER = path.join(ROOT, "target/release/bootstrap-ledger");

function error(message) {
  return new Error(`bootstrap-ledger: ${message}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function fileDigest(file, algorithm, encoding = "hex") {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

function assertHash(value, context) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw error(`${context} must be a lowercase SHA-256 digest`);
}

function uniqueProducts(products) {
  if (!Array.isArray(products) || products.length === 0 || products.some((item) => typeof item !== "string" || item.length === 0)) {
    throw error("products must be a non-empty product string list");
  }
  const result = [...new Set(products)].sort(compareText);
  if (result.length !== products.length) throw error("products must not contain duplicates");
  return result;
}

function publicationExpectation(carrier) {
  if (carrier.artifacts.length !== 1) {
    throw error(`${carrier.id} must freeze exactly one registry publication archive`);
  }
  const artifact = carrier.artifacts[0];
  if (carrier.ecosystem === "cargo") {
    if (!artifact.path.endsWith(".crate")) throw error(`${carrier.id} must freeze a .crate archive, not ${artifact.path}`);
    return { algorithm: "sha256", digest: artifact.sha256, source: "crates.io-version-checksum" };
  }
  if (carrier.ecosystem === "npm") {
    if (!artifact.path.endsWith(".tgz")) throw error(`${carrier.id} must freeze an npm .tgz archive, not ${artifact.path}`);
    const file = path.resolve(ROOT, artifact.path);
    let stat;
    try { stat = statSync(file); } catch { throw error(`${carrier.id} locked npm archive is unavailable: ${artifact.path}`); }
    if (!stat.isFile() || stat.size !== artifact.size || fileDigest(file, "sha256") !== artifact.sha256) {
      throw error(`${carrier.id} local npm archive does not match its frozen byte envelope`);
    }
    return { algorithm: "sha512", digest: fileDigest(file, "sha512", "base64"), source: "npm-dist-integrity" };
  }
  throw error(`${carrier.id} is not a bootstrap Cargo/npm carrier`);
}

function publicationRows(lock, products) {
  const selected = new Set(products);
  return lockedCarriers(lock)
    .filter((carrier) => selected.has(carrier.product) && ["cargo", "npm"].includes(carrier.ecosystem))
    .map((carrier) => ({
      id: carrier.id,
      product: carrier.product,
      ecosystem: carrier.ecosystem,
      name: carrier.name,
      version: carrier.version,
      role: carrier.role,
      target: carrier.target,
      publishOrder: carrier.publishOrder,
      artifacts: carrier.artifacts.map(({ sha256, size }) => ({ sha256, size })),
      registryExpectation: publicationExpectation(carrier),
    }))
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
}

function checkpointBase(lock, products) {
  const selected = uniqueProducts(products);
  const known = new Set(lock.products.map((product) => product.id));
  const unknown = selected.filter((product) => !known.has(product));
  if (unknown.length > 0) throw error(`selected products are absent from the publication lock: ${unknown.join(", ")}`);
  const publications = publicationRows(lock, selected);
  if (publications.length === 0) throw error("selected products have no Cargo or npm publication identities to bootstrap");
  return {
    schema: BOOTSTRAP_LEDGER_SCHEMA,
    lockDigest: lock.lockDigest,
    packageEnvelopeDigest: lock.packageEnvelopeDigest,
    catalogDigest: lock.catalogDigest,
    source: { commit: lock.source.commit, tree: lock.source.tree },
    products: selected,
    publications,
  };
}

function withoutDigest(checkpoint) {
  const copy = structuredClone(checkpoint);
  delete copy.checkpointDigest;
  return copy;
}

export function buildBootstrapLedger(lock, products, {
  sequence = 0,
  previousCheckpointDigest = null,
  receipts = [],
} = {}) {
  const checkpoint = {
    ...checkpointBase(lock, products),
    sequence,
    previousCheckpointDigest,
    receipts: [...receipts].sort((left, right) => compareText(left.id, right.id)),
  };
  checkpoint.complete = checkpoint.receipts.length === checkpoint.publications.length;
  checkpoint.checkpointDigest = digest(checkpoint);
  return checkpoint;
}

function validateReceipt(receipt, publication) {
  if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object") throw error("ledger receipt must be an object");
  for (const key of ["id", "product", "ecosystem", "name", "version"]) {
    if (receipt[key] !== publication[key]) throw error(`${publication.id} receipt ${key} does not match its frozen publication`);
  }
  if (stableJson(receipt.lockedArtifacts) !== stableJson(publication.artifacts)) {
    throw error(`${publication.id} receipt artifact bytes do not match the frozen publication`);
  }
  const proof = receipt.registryProof;
  const expected = publication.registryExpectation;
  if (
    proof === null || Array.isArray(proof) || typeof proof !== "object"
    || proof.algorithm !== expected.algorithm
    || proof.digest !== expected.digest
    || proof.source !== expected.source
    || typeof proof.url !== "string" || !/^https?:\/\//u.test(proof.url)
  ) {
    throw error(`${publication.id} receipt does not prove the frozen archive digest at its registry`);
  }
}

export function validateBootstrapLedger(checkpoint, lock, products) {
  if (checkpoint === null || Array.isArray(checkpoint) || typeof checkpoint !== "object") throw error("ledger checkpoint must be an object");
  if (checkpoint.schema !== BOOTSTRAP_LEDGER_SCHEMA) throw error(`ledger schema must be ${BOOTSTRAP_LEDGER_SCHEMA}`);
  assertHash(checkpoint.checkpointDigest, "ledger.checkpointDigest");
  if (checkpoint.checkpointDigest !== digest(withoutDigest(checkpoint))) throw error("ledger checkpoint digest mismatch");
  const expectedBase = checkpointBase(lock, products);
  for (const key of ["schema", "lockDigest", "packageEnvelopeDigest", "catalogDigest", "source", "products", "publications"]) {
    if (stableJson(checkpoint[key]) !== stableJson(expectedBase[key])) {
      throw error(`ledger ${key} is not bound to the active publication lock/source/package envelope`);
    }
  }
  if (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0) throw error("ledger sequence must be non-negative");
  if (!(checkpoint.previousCheckpointDigest === null || /^[0-9a-f]{64}$/u.test(checkpoint.previousCheckpointDigest))) {
    throw error("ledger previousCheckpointDigest is invalid");
  }
  if (!Array.isArray(checkpoint.receipts)) throw error("ledger receipts must be a list");
  const byId = new Map(checkpoint.publications.map((publication) => [publication.id, publication]));
  const seen = new Set();
  for (const receipt of checkpoint.receipts) {
    if (seen.has(receipt?.id) || !byId.has(receipt?.id)) throw error(`ledger has a duplicate or unknown receipt ${String(receipt?.id)}`);
    seen.add(receipt.id);
    validateReceipt(receipt, byId.get(receipt.id));
  }
  if (checkpoint.complete !== (checkpoint.receipts.length === checkpoint.publications.length)) throw error("ledger complete flag is inconsistent");
  return checkpoint;
}

function checkpointFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^checkpoint-[0-9]{6}-[0-9a-f]{64}[.]json$/u.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort(compareText);
}

export function loadBootstrapLedger(directory, lock, products, { allowEmpty = false, requireComplete = false } = {}) {
  const files = checkpointFiles(directory);
  if (files.length === 0) {
    if (allowEmpty) return null;
    throw error(`bootstrap ledger chain has no checkpoints: ${directory}`);
  }
  let previous = null;
  for (const [index, file] of files.entries()) {
    let checkpoint;
    try { checkpoint = JSON.parse(readFileSync(file, "utf8")); } catch (cause) { throw error(`cannot read ${file}: ${cause.message}`); }
    validateBootstrapLedger(checkpoint, lock, products);
    if (checkpoint.sequence !== index || checkpoint.previousCheckpointDigest !== (previous?.checkpointDigest ?? null)) {
      throw error(`${file} breaks the immutable checkpoint chain at sequence ${index}`);
    }
    const expectedName = `checkpoint-${String(index).padStart(6, "0")}-${checkpoint.checkpointDigest}.json`;
    if (path.basename(file) !== expectedName) throw error(`${file} name does not match its sequence/digest`);
    if (previous !== null) {
      const prior = new Map(previous.receipts.map((receipt) => [receipt.id, stableJson(receipt)]));
      const current = new Map(checkpoint.receipts.map((receipt) => [receipt.id, stableJson(receipt)]));
      for (const [id, bytes] of prior) {
        if (current.get(id) !== bytes) throw error(`${file} rewrites or removes immutable receipt ${id}`);
      }
    }
    previous = checkpoint;
  }
  if (requireComplete && !previous.complete) {
    throw error(`bootstrap ledger is incomplete: ${previous.receipts.length}/${previous.publications.length} receipts`);
  }
  return previous;
}

function writeCheckpoint(directory, checkpoint) {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `checkpoint-${String(checkpoint.sequence).padStart(6, "0")}-${checkpoint.checkpointDigest}.json`);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const body = `${JSON.stringify(checkpoint, null, 2)}\n`;
  let descriptor;
  try {
    try {
      descriptor = openSync(temporary, "wx", 0o644);
      writeFileSync(descriptor, body);
      // The final content-addressed name must never expose bytes that have not
      // reached stable storage. A crash before the link can leave only an
      // ignored private temp file; a crash after it can expose only the complete
      // fsynced inode.
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  } catch (cause) {
    try { unlinkSync(temporary); } catch {}
    throw cause;
  }

  let published = false;
  try {
    try {
      // Hard-link publication is atomic and has no replace semantics. Unlike
      // rename, it cannot silently overwrite an immutable prior checkpoint.
      linkSync(temporary, file);
      published = true;
    } catch (cause) {
      if (cause?.code === "EEXIST") {
        throw error(`refusing to overwrite immutable checkpoint ${file}`);
      }
      throw cause;
    }
    syncCheckpointDirectory(directory);
  } finally {
    try { unlinkSync(temporary); } catch {}
    // Persist best-effort temp-name cleanup after the final link itself has
    // already been made durable. A stale private temp remains harmless because
    // checkpoint discovery accepts only canonical final names.
    if (published) {
      try { syncCheckpointDirectory(directory); } catch {}
    }
  }
  return file;
}

function syncCheckpointDirectory(directory) {
  // The protected bootstrap route runs on Linux, where directory fsync makes
  // the new hard-link durable. Windows does not support opening directories for
  // fsync through Node; the fsynced inode plus atomic no-replace link remains
  // the strongest available local guarantee there.
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function appendBootstrapCheckpoint(directory, lock, products, receipts) {
  const previous = loadBootstrapLedger(directory, lock, products, { allowEmpty: true });
  const merged = new Map((previous?.receipts ?? []).map((receipt) => [receipt.id, receipt]));
  let added = 0;
  for (const receipt of receipts) {
    const existing = merged.get(receipt.id);
    if (existing !== undefined && stableJson(existing) !== stableJson(receipt)) {
      throw error(`registry proof for ${receipt.id} conflicts with its immutable prior checkpoint`);
    }
    if (existing === undefined) added += 1;
    merged.set(receipt.id, receipt);
  }
  if (previous !== null && added === 0) return previous;
  const checkpoint = buildBootstrapLedger(lock, products, {
    sequence: previous === null ? 0 : previous.sequence + 1,
    previousCheckpointDigest: previous?.checkpointDigest ?? null,
    receipts: [...merged.values()],
  });
  validateBootstrapLedger(checkpoint, lock, products);
  writeCheckpoint(directory, checkpoint);
  return checkpoint;
}

async function reverifyReceipts(checkpoint, lock) {
  const observed = await verifyLockedRegistryIntegrity(lock, { carrierIds: checkpoint.receipts.map(({ id }) => id) });
  const actual = new Map(observed.map((receipt) => [receipt.id, stableJson(receipt)]));
  for (const receipt of checkpoint.receipts) {
    if (actual.get(receipt.id) !== stableJson(receipt)) throw error(`${receipt.id} registry proof changed since its immutable checkpoint`);
  }
}

function parseArgs(argv) {
  const command = argv[0];
  let ledger = DEFAULT_BOOTSTRAP_LEDGER;
  let lockFile = "";
  let productsJson = "";
  let product = "";
  let ecosystem = "";
  let carrierIdsJson = "";
  let verifyRegistries = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify-registries" || arg === "--require-complete") {
      if (arg === "--verify-registries") verifyRegistries = true;
      continue;
    }
    const value = argv[index + 1] ?? "";
    if (arg === "--ledger") ledger = path.resolve(ROOT, value);
    else if (arg === "--lock") lockFile = path.resolve(ROOT, value);
    else if (arg === "--products-json") productsJson = value;
    else if (arg === "--product") product = value;
    else if (arg === "--ecosystem") ecosystem = value;
    else if (arg === "--carrier-ids-json") carrierIdsJson = value;
    else throw error(`unknown argument ${arg}`);
    index += 1;
  }
  if (!["init", "checkpoint", "seal", "verify"].includes(command) || !lockFile || !productsJson) {
    throw error("usage: bootstrap-ledger.mjs <init|checkpoint|seal|verify> --lock FILE --products-json JSON [--ledger DIR] [--product ID --ecosystem cargo|npm | --carrier-ids-json JSON] [--verify-registries]");
  }
  let products;
  try { products = JSON.parse(productsJson); } catch (cause) { throw error(`--products-json must be valid JSON: ${cause.message}`); }
  let carrierIds = [];
  if (carrierIdsJson) {
    try { carrierIds = JSON.parse(carrierIdsJson); } catch (cause) { throw error(`--carrier-ids-json must be valid JSON: ${cause.message}`); }
    if (
      !Array.isArray(carrierIds)
      || carrierIds.length === 0
      || carrierIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(carrierIds).size !== carrierIds.length
    ) {
      throw error("--carrier-ids-json must be a non-empty unique string list");
    }
  }
  if (command === "checkpoint") {
    const productCheckpoint = Boolean(product) && ["cargo", "npm"].includes(ecosystem) && carrierIds.length === 0;
    const carrierCheckpoint = !product && !ecosystem && carrierIds.length > 0;
    if (!productCheckpoint && !carrierCheckpoint) {
      throw error("checkpoint requires either --product with --ecosystem cargo|npm or --carrier-ids-json");
    }
  }
  return { command, ledger, lockFile, products, product, ecosystem, carrierIds, verifyRegistries };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const lock = loadPublicationLock(args.lockFile);
    let checkpoint;
    if (args.command === "init") {
      checkpoint = loadBootstrapLedger(args.ledger, lock, args.products, { allowEmpty: true });
      if (checkpoint === null) checkpoint = appendBootstrapCheckpoint(args.ledger, lock, args.products, []);
    } else if (args.command === "checkpoint") {
      const receipts = await verifyLockedRegistryIntegrity(lock, args.carrierIds.length > 0
        ? { carrierIds: args.carrierIds }
        : { products: [args.product], ecosystems: [args.ecosystem] });
      checkpoint = appendBootstrapCheckpoint(args.ledger, lock, args.products, receipts);
    } else if (args.command === "seal") {
      const expected = checkpointBase(lock, args.products).publications;
      const receipts = await verifyLockedRegistryIntegrity(lock, { carrierIds: expected.map(({ id }) => id) });
      checkpoint = appendBootstrapCheckpoint(args.ledger, lock, args.products, receipts);
      loadBootstrapLedger(args.ledger, lock, args.products, { requireComplete: true });
    } else {
      checkpoint = loadBootstrapLedger(args.ledger, lock, args.products, { requireComplete: true });
      if (args.verifyRegistries) await reverifyReceipts(checkpoint, lock);
    }
    console.log(`${args.command} bootstrap checkpoint ${checkpoint.sequence} (${checkpoint.receipts.length}/${checkpoint.publications.length}, ${checkpoint.checkpointDigest})`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
