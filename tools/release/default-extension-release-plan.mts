import { extensionConsumerRequirements } from './consumer-compatibility.mts';
import { resolveBuildBoundCompatibilityProducts } from './release-dependency-plan.mts';
import { productCompatibilityVersion } from './release-graph.mts';

// These associations are controller-derived contracts, not a release selector.
// Authentication and descriptor/module equivalence stay with the acquired observations.
export function snapshotCurrentExactInputs(products, value = []) {
  if (!Array.isArray(value))
    throw new Error('default-extension-release-plan: current exact inputs must be an array');
  const seen = new Set();
  return Object.freeze(
    value.map((row) => {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== 'product,sourceProduct' ||
        typeof row.product !== 'string' ||
        typeof row.sourceProduct !== 'string' ||
        !Object.hasOwn(products, row.product) ||
        !Object.hasOwn(products, row.sourceProduct) ||
        row.product === row.sourceProduct ||
        !Object.values(products[row.product].compatibility_versions ?? {}).some(
          (entry) => entry.source_product === row.sourceProduct,
        )
      )
        throw new Error(
          'default-extension-release-plan: current exact input lacks its conventional requirement',
        );
      const key = `${row.product}:${row.sourceProduct}`;
      if (seen.has(key))
        throw new Error('default-extension-release-plan: duplicate current exact input');
      seen.add(key);
      return Object.freeze({ product: row.product, sourceProduct: row.sourceProduct });
    }),
  );
}

// Default installs constrain dependency requirements, not product version numbers.
export function defaultExtensionReleasePlan(products, selectedProducts, options = {}) {
  const { readCompatibility = productCompatibilityVersion } = options;
  const buildBound = resolveBuildBoundCompatibilityProducts(products, options);
  const currentExactInputs = snapshotCurrentExactInputs(products, options.currentExactInputs);
  const selected = new Set(selectedProducts);
  const required = new Set(selected);
  const requirements = new Map();
  const extensions = Object.keys(products).filter(
    (product) => products[product].extension?.class === 'external',
  );
  const sdks = Object.keys(products).filter((product) => products[product].kind === 'sdk');
  const pin = (product, source, version = products[product].version) =>
    readCompatibility(product, source, 'default-extension-release-plan', {
      ref:
        version === '0.0.0' || (selected.has(product) && version === products[product].version)
          ? null
          : products[product].tag_prefix + version,
    });
  const writeRequirement = (product, sourceProduct, version) => {
    required.add(product);
    requirements.set(`${product}:${sourceProduct}`, { product, sourceProduct, version });
  };
  const selectedConsumers = extensionConsumerRequirements(
    selected,
    products,
    pin,
    buildBound,
  ).filter(({ owner }) => !owner || products[owner].kind === 'sdk');
  const runtimes = new Set(selectedConsumers.map(({ runtime }) => runtime));
  if (extensions.some((product) => selected.has(product))) {
    for (const product of sdks) {
      const runtime = products[product].exact_extension_runtime;
      if (typeof runtime === 'string') runtimes.add(runtime);
    }
  }
  const maximum = (versions) => versions.sort(Bun.semver.order).at(-1);
  for (const runtime of runtimes) {
    const hosts = extensions.map((product) =>
      selected.has(product) && buildBound.get(product).has(runtime)
        ? products[runtime].version
        : pin(product, runtime),
    );
    let target = maximum([
      ...hosts,
      ...selectedConsumers
        .filter((consumer) => consumer.runtime === runtime)
        .map(({ runtimeVersion }) => runtimeVersion),
    ]);
    if (Bun.semver.order(target, products[runtime].version) > 0)
      throw new Error(
        `default-extension-release-plan: ${runtime}@${target} is not a candidate or published host`,
      );
    const repackage = hosts.some((host) => host !== target);
    if (repackage) {
      // Only current compiler inputs force adoption of the workspace host.
      if (
        extensions.some(
          (product) => buildBound.get(product).has(runtime) && pin(product, runtime) !== target,
        )
      )
        target = products[runtime].version;
      for (const product of extensions) {
        if (
          !buildBound.get(product).has(runtime) &&
          readCompatibility(product, runtime, 'default-extension-release-plan', { ref: null }) !==
            target
        )
          throw new Error(
            `default-extension-release-plan: ${product} retains a held ${runtime} requirement; update its conventional runtime requirement before targeting ${runtime}@${target}`,
          );
        if (pin(product, runtime) !== target || selected.has(product)) required.add(product);
      }
    }
    for (const product of sdks) {
      if (products[product].exact_extension_runtime !== runtime) continue;
      if (
        !selected.has(product) &&
        !repackage &&
        !extensions.some((extension) => selected.has(extension))
      )
        continue;
      const host = pin(product, runtime);
      if (Bun.semver.order(host, target) > 0)
        throw new Error(
          `default-extension-release-plan: cannot replace ${product}'s ${runtime}@${host} with older host ${target}`,
        );
      if (host !== target) writeRequirement(product, runtime, target);
    }
  }
  // A Node addon embeds its host; a source SDK must install that exact binary release.
  if (required.has('oliphaunt-wasix-ts')) {
    const sdk = 'oliphaunt-wasix-ts';
    const runtime = products[sdk].exact_extension_runtime;
    const target = requirements.get(`${sdk}:${runtime}`)?.version ?? pin(sdk, runtime);
    const addon = 'oliphaunt-wasix-napi';
    const version = pin(sdk, addon);
    const buildsRuntime = buildBound.get(addon)?.has(runtime);
    const currentHost =
      buildsRuntime && selected.has(addon) && version === products[addon].version
        ? products[runtime].version
        : pin(addon, runtime, version);
    if (currentHost !== target) {
      const host =
        buildsRuntime && selected.has(addon) ? products[runtime].version : pin(addon, runtime);
      if (host !== target) {
        if (!buildsRuntime)
          throw new Error(
            `default-extension-release-plan: ${addon} adopts ${runtime}@${host}; update its conventional runtime and SDK requirements before targeting ${runtime}@${target}`,
          );
        if (target !== products[runtime].version)
          throw new Error(
            `default-extension-release-plan: ${addon} cannot embed older ${runtime}@${target}`,
          );
        required.add(addon);
      }
      writeRequirement(sdk, addon, products[addon].version);
    }
  }
  // Source wrappers such as React Native follow a new platform SDK only when its
  // historical requirement no longer supports the default extension host.
  for (const owner of sdks) {
    for (const { source_product: provider } of Object.values(
      products[owner].compatibility_versions ?? {},
    )) {
      const runtime = products[provider]?.exact_extension_runtime;
      if (typeof runtime !== 'string') continue;
      if (!required.has(provider)) continue;
      const target = requirements.get(`${provider}:${runtime}`)?.version ?? pin(provider, runtime);
      const version = pin(owner, provider);
      const oldHost =
        selected.has(provider) && version === products[provider].version
          ? target
          : pin(provider, runtime, version);
      if (oldHost !== target) writeRequirement(owner, provider, products[provider].version);
    }
  }
  // A byte-qualified exact-module contract follows a new producer only when
  // both products already have necessary deliveries. ABI reachability alone
  // never adds a producer or consumer to the release set.
  for (const { product, sourceProduct } of currentExactInputs) {
    if (!selected.has(product) || !selected.has(sourceProduct)) continue;
    const version = products[sourceProduct].version;
    const previous = requirements.get(`${product}:${sourceProduct}`);
    if (previous && previous.version !== version)
      throw new Error('default-extension-release-plan: conflicting current exact requirement');
    if (pin(product, sourceProduct) !== version) writeRequirement(product, sourceProduct, version);
  }
  return { required, requirements };
}
