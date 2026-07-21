#!/usr/bin/env bun
import path from "node:path";

import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
  lockedCarriers,
} from "./publication-lock.mjs";
import { ROOT } from "./release-cli-utils.mjs";

const SUPPORTED_ECOSYSTEMS = new Set(["cargo", "npm", "maven", "jsr"]);
const MAVEN_UNIT = "maven:atomic-deployment";

function error(message) {
  return new Error(`normal-publication-plan: ${message}`);
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function selectedProductSet(lock, products) {
  if (
    !Array.isArray(products)
    || products.length === 0
    || products.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(products).size !== products.length
  ) {
    throw error("products must be a non-empty unique string list");
  }
  const locked = new Set((lock.products ?? []).map(({ id }) => id));
  const unknown = products.filter((product) => !locked.has(product));
  if (unknown.length > 0) {
    throw error(`selected products are absent from the publication lock: ${unknown.join(", ")}`);
  }
  return new Set(products);
}

function carrierUnitId(carrier) {
  return carrier.ecosystem === "maven" ? MAVEN_UNIT : `carrier:${carrier.id}`;
}

function validateCarrier(carrier) {
  if (typeof carrier?.id !== "string" || carrier.id !== `${carrier.ecosystem}:${carrier.name}`) {
    throw error(`invalid carrier identity ${JSON.stringify(carrier?.id)}`);
  }
  if (!SUPPORTED_ECOSYSTEMS.has(carrier.ecosystem)) {
    throw error(`${carrier.id} uses unsupported ecosystem ${JSON.stringify(carrier.ecosystem)}`);
  }
  if (!Number.isSafeInteger(carrier.publishOrder) || carrier.publishOrder < 0) {
    throw error(`${carrier.id} has invalid publishOrder ${JSON.stringify(carrier.publishOrder)}`);
  }
  if (!Array.isArray(carrier.dependencies) || carrier.dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)) {
    throw error(`${carrier.id}.dependencies must be a string list`);
  }
}

function operationEnvelope(unit) {
  const carriers = unit.carriers
    .slice()
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  const carrierIds = carriers.map(({ id }) => id);
  const products = [...new Set(carriers.map(({ product }) => product))].sort(compareText);
  const publishOrders = carriers.map(({ publishOrder }) => publishOrder);
  if (unit.id === MAVEN_UNIT) {
    return {
      id: unit.id,
      kind: "maven-atomic-deployment",
      ecosystem: "maven",
      products,
      carrierIds,
      firstPublishOrder: Math.min(...publishOrders),
      lastPublishOrder: Math.max(...publishOrders),
      dependencies: [...unit.dependencies].sort(compareText),
    };
  }
  const [carrier] = carriers;
  return {
    id: unit.id,
    kind: "carrier",
    ecosystem: carrier.ecosystem,
    product: carrier.product,
    carrierId: carrier.id,
    products,
    carrierIds,
    firstPublishOrder: carrier.publishOrder,
    lastPublishOrder: carrier.publishOrder,
    dependencies: [...unit.dependencies].sort(compareText),
  };
}

/**
 * Turn an exact frozen publication lock into the mutation sequence used by the
 * normal release. Cargo, npm, and JSR identities remain independent mutations.
 * Maven identities are one unit because Maven Central validates and publishes
 * the signed bundle atomically; dependency edges inside that bundle therefore
 * do not require separate deployments.
 */
export function normalPublicationPlan(lock, products) {
  const selected = selectedProductSet(lock, products);
  const allCarriers = lockedCarriers(lock)
    .slice()
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  const allById = new Map(allCarriers.map((carrier) => [carrier.id, carrier]));
  if (allById.size !== allCarriers.length) {
    throw error("publication lock contains duplicate carrier identities");
  }
  const carriers = allCarriers.filter((carrier) => selected.has(carrier.product));
  for (const carrier of carriers) validateCarrier(carrier);
  const selectedIds = new Set(carriers.map(({ id }) => id));
  for (const carrier of carriers) {
    const omitted = carrier.dependencies.filter((dependency) => allById.has(dependency) && !selectedIds.has(dependency));
    if (omitted.length > 0) {
      throw error(`${carrier.id} selection omits locked dependencies: ${omitted.join(", ")}`);
    }
    const unknown = carrier.dependencies.filter((dependency) => !allById.has(dependency));
    if (unknown.length > 0) {
      throw error(`${carrier.id} refers to unknown locked dependencies: ${unknown.join(", ")}`);
    }
  }

  const units = new Map();
  for (const carrier of carriers) {
    const id = carrierUnitId(carrier);
    const unit = units.get(id) ?? { id, carriers: [], dependencies: new Set() };
    unit.carriers.push(carrier);
    units.set(id, unit);
  }
  for (const unit of units.values()) {
    for (const carrier of unit.carriers) {
      for (const dependency of carrier.dependencies) {
        const dependencyUnit = carrierUnitId(allById.get(dependency));
        if (dependencyUnit !== unit.id) unit.dependencies.add(dependencyUnit);
      }
    }
  }

  const remaining = new Set(units.keys());
  const completed = new Set();
  const operations = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => operationEnvelope(units.get(id)))
      .filter((operation) => operation.dependencies.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.firstPublishOrder - right.firstPublishOrder || compareText(left.id, right.id));
    if (ready.length === 0) {
      throw error(`publication unit dependency cycle: ${[...remaining].sort(compareText).join(", ")}`);
    }
    // Select exactly one operation before recomputing readiness. An earlier
    // operation can unlock another unit whose frozen publishOrder precedes a
    // unit that was already ready; scheduling a whole readiness "wave" would
    // be topologically valid but would drift from the lock's global priority.
    const [operation] = ready;
    operations.push({ ...operation, operationOrder: operations.length });
    completed.add(operation.id);
    remaining.delete(operation.id);
  }

  const operationPosition = new Map(operations.map((operation, index) => [operation.id, index]));
  for (const [index, operation] of operations.entries()) {
    for (const dependency of operation.dependencies) {
      if ((operationPosition.get(dependency) ?? Number.POSITIVE_INFINITY) >= index) {
        throw error(`${operation.id} is scheduled before dependency unit ${dependency}`);
      }
    }
  }
  return {
    products: [...selected],
    carrierCount: carriers.length,
    operations,
  };
}

function parseArgs(argv) {
  let lockFile = DEFAULT_PUBLICATION_LOCK;
  let productsJson = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--lock") lockFile = value ?? "";
    else if (arg === "--products-json") productsJson = value ?? "";
    else throw error(`unknown argument ${arg}`);
    index += 1;
  }
  if (!lockFile || !productsJson) {
    throw error("usage: normal-publication-plan.mjs --lock FILE --products-json JSON");
  }
  let products;
  try {
    products = JSON.parse(productsJson);
  } catch (cause) {
    throw error(`--products-json must be strict JSON: ${cause.message}`);
  }
  return { lockFile: path.resolve(ROOT, lockFile), products };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    console.log(JSON.stringify(normalPublicationPlan(loadPublicationLock(args.lockFile), args.products), null, 2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
