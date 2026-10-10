import { requireMatchingWasixRuntime } from './compatibility-version-policy.mts';
import { buildBoundCompatibilityProducts } from './release-dependency-plan.mts';
import { compareText, loadProducts, productCompatibilityVersion } from './release-graph.mts';

const EXTENSION_RUNTIMES = new Set(['liboliphaunt-native', 'liboliphaunt-wasix']);

function extensionConsumerContracts(products) {
  const consumers = [];
  for (const [product, metadata] of Object.entries(products)) {
    if (metadata.kind !== 'sdk') continue;
    const runtimeDependencies = new Set(
      Object.values(metadata.compatibility_versions ?? {})
        .map(({ source_product }) => source_product)
        .filter((source) => EXTENSION_RUNTIMES.has(source)),
    );
    if (runtimeDependencies.size === 0) continue;
    const runtime = metadata.exact_extension_runtime;
    if (runtime === false) continue;
    if (typeof runtime !== 'string' || !runtimeDependencies.has(runtime)) {
      throw new Error(
        `release-consumer-compatibility: ${product} must declare exact_extension_runtime as one of its runtime dependencies or false`,
      );
    }
    consumers.push({ product, runtime });
  }
  return consumers.sort((left, right) => compareText(left.product, right.product));
}

export function extensionConsumerRequirements(selected, products, pin, buildBound) {
  const contracts = extensionConsumerContracts(products);
  const consumers = contracts.filter(({ product }) => selected.has(product));
  for (const owner of selected) {
    // Privately compiled SDK sources use the binary's Cargo closure, not its published package.
    const dependencies = new Set(
      Object.values(products[owner].compatibility_versions ?? {})
        .filter(
          ({ source_product, public_support }) =>
            public_support !== false || !buildBound.get(owner)?.has(source_product),
        )
        .map(({ source_product }) => source_product),
    );
    for (const { product, runtime } of contracts) {
      if (dependencies.has(product)) consumers.push({ product, runtime, owner });
    }
  }
  return consumers.map((consumer) => {
    const version = consumer.owner
      ? pin(consumer.owner, consumer.product)
      : products[consumer.product].version;
    return {
      ...consumer,
      version,
      runtimeVersion: pin(consumer.product, consumer.runtime, version),
    };
  });
}

export function validateConsumerContractCoverage(products) {
  extensionConsumerContracts(products);
}

export function validateReleaseConsumerCompatibility(
  selectedProducts,
  {
    products = loadProducts(),
    readCompatibility = productCompatibilityVersion,
    buildBound = buildBoundCompatibilityProducts(products),
    prefix = 'release-consumer-compatibility',
  } = {},
) {
  validateConsumerContractCoverage(products);
  const selected = new Set(selectedProducts);
  for (const id of selected) {
    if (!products[id]) throw new Error(`${prefix}: unknown release product ${id}`);
  }
  // An unselected product is the immutable published package, even if its
  // workspace metadata has already changed in preparation for another release.
  const pin = (product, source, version = products[product].version) =>
    readCompatibility(product, source, prefix, {
      ref:
        selected.has(product) && version === products[product].version
          ? null
          : products[product].tag_prefix + version,
    });
  const consumers = extensionConsumerRequirements(selected, products, pin, buildBound);
  const failures = [];
  for (const { product, runtime, version, owner, runtimeVersion } of consumers) {
    const label = `${owner ? `${owner} through ` : ''}${product}@${version}`;
    if (
      owner &&
      Object.values(products[owner].compatibility_versions ?? {}).some(
        ({ source_product }) => source_product === runtime,
      )
    ) {
      const ownerRuntime = pin(owner, runtime);
      if (ownerRuntime !== runtimeVersion) {
        failures.push(
          `${label} targets ${runtime}@${runtimeVersion}, but ${owner} targets ${runtime}@${ownerRuntime}`,
        );
      }
    }
    if (product === 'oliphaunt-wasix-ts') {
      const napiVersion = pin(product, 'oliphaunt-wasix-napi', version);
      try {
        requireMatchingWasixRuntime(
          {
            runtimeVersion,
            napiVersion,
            napiRuntimeVersion: pin('oliphaunt-wasix-napi', runtime, napiVersion),
          },
          { prefix: label },
        );
      } catch (cause) {
        failures.push(cause.message);
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${prefix}: release consumers are incompatible:\n${[...new Set(failures)].join('\n')}\nPrepare matching independently versioned packages; workspace qualification fixtures cannot prove this release combination.`,
    );
  }
}

if (import.meta.main) {
  const selected = JSON.parse(process.argv[2] ?? 'null');
  if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string')) {
    throw new Error('usage: consumer-compatibility.mts PRODUCTS_JSON');
  }
  validateReleaseConsumerCompatibility(selected);
}
