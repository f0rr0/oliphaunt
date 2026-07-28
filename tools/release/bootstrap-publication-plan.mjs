import { lockedCarriers } from "./publication-lock.mjs";

const BOOTSTRAP_ECOSYSTEMS = new Set(["cargo", "npm"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(message) {
  return new Error(`bootstrap-publication-plan: ${message}`);
}

function selectedProducts(lock, products) {
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

export function bootstrapPublicationPlan(lock, products) {
  const selected = selectedProducts(lock, products);
  const allCarriers = lockedCarriers(lock)
    .slice()
    .sort((left, right) => left.publishOrder - right.publishOrder || compareText(left.id, right.id));
  const allById = new Map(allCarriers.map((carrier) => [carrier.id, carrier]));
  if (allById.size !== allCarriers.length) {
    throw error("publication lock contains duplicate carrier identities");
  }
  for (const carrier of allCarriers) {
    if (
      typeof carrier.id !== "string"
      || typeof carrier.ecosystem !== "string"
      || typeof carrier.name !== "string"
      || carrier.id !== `${carrier.ecosystem}:${carrier.name}`
    ) {
      throw error(`invalid locked carrier identity ${JSON.stringify(carrier.id)}`);
    }
    if (!Array.isArray(carrier.dependencies) || carrier.dependencies.some(
      (dependency) => typeof dependency !== "string" || dependency.length === 0,
    )) {
      throw error(`${carrier.id}.dependencies must be a string list`);
    }
  }
  const carriers = allCarriers
    .filter((carrier) => selected.has(carrier.product) && BOOTSTRAP_ECOSYSTEMS.has(carrier.ecosystem))
    .slice();
  if (carriers.length === 0) {
    throw error("selected products contain no Cargo or npm identities to bootstrap");
  }

  const positions = new Map(carriers.map((carrier, index) => [carrier.id, index]));
  if (positions.size !== carriers.length) {
    throw error("bootstrap publication plan contains duplicate carrier identities");
  }
  for (const [index, carrier] of carriers.entries()) {
    if (!Number.isSafeInteger(carrier.publishOrder) || carrier.publishOrder < 0) {
      throw error(`${carrier.id} has invalid publishOrder ${JSON.stringify(carrier.publishOrder)}`);
    }
    for (const dependency of carrier.dependencies) {
      const lockedDependency = allById.get(dependency);
      if (lockedDependency === undefined) {
        throw error(`${carrier.id} refers to unknown locked dependency ${dependency}`);
      }
      // Bootstrap only pre-creates immutable-name registries. Maven and JSR
      // have no separate identity-creation phase, so a resolved dependency in
      // either non-bootstrap ecosystem remains intentionally external to this
      // plan and is handled by the normal global publication topology. Every
      // locked Cargo/npm dependency, however, must be in this exact selection.
      if (!BOOTSTRAP_ECOSYSTEMS.has(lockedDependency.ecosystem)) {
        continue;
      }
      const dependencyPosition = positions.get(dependency);
      if (dependencyPosition === undefined) {
        throw error(`${carrier.id} selection omits locked bootstrap dependency ${dependency}`);
      }
      if (dependencyPosition >= index) {
        throw error(`${carrier.id} appears before bootstrap dependency ${dependency}`);
      }
    }
  }
  return carriers.map(({ id, product, ecosystem, name, version, publishOrder, dependencies }) => ({
    id,
    product,
    ecosystem,
    name,
    version,
    publishOrder,
    dependencies: dependencies.filter((dependency) => BOOTSTRAP_ECOSYSTEMS.has(allById.get(dependency).ecosystem)),
  }));
}

export function bootstrapCheckpointBatches(plan, batchSize = 32) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128) {
    throw error("checkpoint batch size must be an integer from 1 through 128");
  }
  const batches = [];
  for (let index = 0; index < plan.length; index += batchSize) {
    batches.push(plan.slice(index, index + batchSize).map(({ id }) => id));
  }
  return batches;
}
