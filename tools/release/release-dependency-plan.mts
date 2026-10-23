import {
  compatibilityVersionEntries,
  compatibilityVersionValue,
  declaredSharedSourceImpacts,
} from './release-graph.mts';

// Derive compiled inputs from the same Cargo closure used for release ownership.
export function buildBoundCompatibilityProducts(products) {
  const inputs = new Map(Object.keys(products).map((id) => [id, new Set()]));
  for (const impact of declaredSharedSourceImpacts(products)) {
    for (const owner of impact.products) {
      for (const file of impact.source_paths) inputs.get(owner).add(file);
    }
  }
  return new Map(
    Object.entries(products).map(([id, product]) => [
      id,
      new Set(
        Object.entries(products)
          .filter(
            ([producer, metadata]) =>
              producer !== id &&
              (product.embedded_payload_products?.includes(producer) ||
                (product.extension?.class === 'external' &&
                  ['liboliphaunt-native', 'liboliphaunt-wasix'].includes(producer)) ||
                inputs.get(id).has(`${metadata.path}/Cargo.toml`)),
          )
          .map(([producer]) => producer),
      ),
    ]),
  );
}

// Structural per-run input only; this map does not establish configured or authenticated coverage.
export function resolveBuildBoundCompatibilityProducts(products, options = {}) {
  const ids = Object.keys(products);
  const buildBound = Object.hasOwn(options, 'buildBound')
    ? options.buildBound
    : buildBoundCompatibilityProducts(products);
  if (
    !(buildBound instanceof Map) ||
    buildBound.size !== ids.length ||
    [...buildBound.keys()].some(
      (consumer) => typeof consumer !== 'string' || !Object.hasOwn(products, consumer),
    )
  )
    throw new Error('release-dependency-plan: buildBound must be a complete product Map');
  const snapshot = new Map();
  for (const consumer of ids) {
    const producers = buildBound.get(consumer);
    if (!(producers instanceof Set))
      throw new Error(`release-dependency-plan: buildBound ${consumer} must be a Set`);
    for (const producer of producers)
      if (
        typeof producer !== 'string' ||
        !Object.hasOwn(products, producer) ||
        producer === consumer
      )
        throw new Error(
          `release-dependency-plan: buildBound ${consumer} has an unknown or self producer`,
        );
    snapshot.set(consumer, new Set(producers));
  }
  return snapshot;
}

export function releaseDependencyPlan(products, selectedProducts, options = {}) {
  const buildBound = resolveBuildBoundCompatibilityProducts(products, options);
  const {
    entries = compatibilityVersionEntries(products, { requireSourceProduct: true }),
    readValue = compatibilityVersionValue,
  } = options;
  const selected = new Set(selectedProducts);
  return entries.map((entry) => {
    const compiled =
      selected.has(entry.product) && buildBound.get(entry.product)?.has(entry.sourceProduct);
    return {
      ...entry,
      version: compiled ? products[entry.sourceProduct].version : readValue(entry),
      binding: compiled ? 'compiled-input' : 'declared-requirement',
    };
  });
}

export function requirePublicSupportTransition({
  product,
  before,
  after,
  previousSupport,
  nextSupport,
}) {
  if (before === '0.0.0' || previousSupport === nextSupport) return;
  const prior = before.split('.').map(Number);
  const next = after.split('.').map(Number);
  const breaking = prior[0] === 0 ? next[0] > 0 || next[1] > prior[1] : next[0] > prior[0];
  if (!breaking)
    throw new Error(
      `${product} removes exact public support ${previousSupport}; ${before} -> ${after} must satisfy the repository's breaking-version policy`,
    );
}
