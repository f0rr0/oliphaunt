import { loadProducts, productCompatibilityVersion } from './release-graph.mts';
import { requireMatchingWasixRuntime } from './compatibility-version-policy.mts';
import { cargoPublishedDependencies } from './check_registry_publication.mts';

// These consumers enforce exact runtime identity when loading extension carriers.
// Independent packaging versions do not establish cross-runtime compatibility.
const EXTENSION_CONSUMERS = [
  ['oliphaunt-js', 'liboliphaunt-native'],
  ['oliphaunt-kotlin', 'liboliphaunt-native'],
  ['oliphaunt-swift', 'liboliphaunt-native'],
  ['oliphaunt-wasix-rust', 'liboliphaunt-wasix'],
  ['oliphaunt-wasix-ts', 'liboliphaunt-wasix'],
];

export function extensionConsumerRequirements(selected, products, pin) {
  const consumers = EXTENSION_CONSUMERS.filter(([id]) => selected.has(id)).map(
    ([product, runtime]) => ({ product, runtime }),
  );
  for (const owner of selected) {
    const dependencies = new Set(
      Object.values(products[owner].compatibility_versions ?? {}).map(
        ({ source_product }) => source_product,
      ),
    );
    for (const [product, runtime] of EXTENSION_CONSUMERS) {
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
  const known = new Set([...EXTENSION_CONSUMERS.map(([id]) => id), 'oliphaunt-rust']);
  for (const [id, product] of Object.entries(products)) {
    if (
      product.kind === 'sdk' &&
      Object.values(product.compatibility_versions ?? {}).some(({ source_product }) =>
        ['liboliphaunt-native', 'liboliphaunt-wasix'].includes(source_product),
      ) &&
      !known.has(id)
    ) {
      throw new Error(
        `release-consumer-compatibility: ${id} must declare its extension consumer compatibility policy`,
      );
    }
  }
}

export function validateReleaseConsumerCompatibility(
  selectedProducts,
  {
    products = loadProducts(),
    readCompatibility = productCompatibilityVersion,
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
  const extensions = Object.entries(products).filter(
    ([, product]) => product.extension?.class === 'external',
  );
  const consumers = extensionConsumerRequirements(selected, products, pin);
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
    for (const [extension, metadata] of extensions) {
      const extensionRuntime = pin(extension, runtime);
      if (extensionRuntime !== runtimeVersion) {
        failures.push(
          `${label} requires ${runtime}@${runtimeVersion}, but ${extension}@${metadata.version} targets ${runtime}@${extensionRuntime}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${prefix}: release consumers are incompatible:\n${[...new Set(failures)].join('\n')}\nPrepare matching independently versioned packages; workspace qualification fixtures cannot prove this release combination.`,
    );
  }
}

export async function validatePublishedCargoExtensionConsumers(
  selectedProducts,
  { products = loadProducts(), readDependencies = cargoPublishedDependencies } = {},
) {
  const selected = new Set(selectedProducts);
  const requirements = [];
  if (selected.has('oliphaunt-rust')) {
    requirements.push(['oliphaunt-build', products['oliphaunt-rust'].version]);
  }
  if (selected.has('oliphaunt-wasix-rust')) {
    requirements.push(['oliphaunt-wasix', products['oliphaunt-wasix-rust'].version]);
  }
  if (requirements.length === 0) return;
  const failures = [];
  for (const [extension, metadata] of Object.entries(products)) {
    if (metadata.extension?.class !== 'external' || selected.has(extension)) continue;
    const dependencies = await readDependencies(extension, metadata.version);
    for (const [name, version] of requirements) {
      const matches = dependencies.filter(({ crate_id }) => crate_id === name);
      if (matches.length === 0 || matches.some(({ req }) => !Bun.semver.satisfies(version, req))) {
        failures.push(
          `${extension}@${metadata.version} requires ${name} ${matches.map(({ req }) => req).join(', ') || '<missing>'}, incompatible with the selected SDK API ${name}@${version}`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `release-consumer-compatibility: published Cargo extensions cannot resolve with the selected SDK:\n${failures.join('\n')}`,
    );
  }
}

if (import.meta.main) {
  const selected = JSON.parse(process.argv[2] ?? 'null');
  if (!Array.isArray(selected) || selected.some((id) => typeof id !== 'string')) {
    throw new Error('usage: consumer-compatibility.mts PRODUCTS_JSON');
  }
  validateReleaseConsumerCompatibility(selected);
  await validatePublishedCargoExtensionConsumers(selected);
}
