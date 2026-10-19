import { extensionConsumerRequirements } from './consumer-compatibility.mts';
import { buildBoundCompatibilityProducts } from './release-dependency-plan.mts';
import { productCompatibilityVersion } from './release-graph.mts';

// Default installs constrain dependency requirements, not product version numbers.
export function defaultExtensionReleasePlan(
  products,
  selectedProducts,
  {
    readCompatibility = productCompatibilityVersion,
    buildBound = buildBoundCompatibilityProducts(products),
  } = {},
) {
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
  ).filter(({ product, owner }) => !owner || products[owner].kind === 'sdk');
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
      selected.has(product) ? products[runtime].version : pin(product, runtime),
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
      // Extension producers cannot recreate an older host with current compiler inputs.
      target = products[runtime].version;
      for (const product of extensions) {
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
    const currentHost =
      selected.has(addon) && version === products[addon].version
        ? products[runtime].version
        : pin(addon, runtime, version);
    if (currentHost !== target) {
      const host = selected.has(addon) ? products[runtime].version : pin(addon, runtime);
      if (host !== target) {
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
  return { required, requirements };
}
