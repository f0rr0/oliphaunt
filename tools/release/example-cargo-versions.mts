import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './release-graph.mts';
import { cargoManifestPaths } from './release-please-transition.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';

const TOOL = 'example-cargo-versions';
const TABLES = ['dependencies', 'dev-dependencies', 'build-dependencies'];

// The manifest owns dependency names, scopes and aliases. The release catalog
// supplies versions; it must not impose a second, handwritten dependency graph.
export function exampleCargoPolicy(file, manifest) {
  const crateDir = path.posix.dirname(file);
  const dependencyBindings = [];
  const collect = (table, parts) => {
    for (const [name, spec] of Object.entries(table ?? {})) {
      const packageName = typeof spec === 'object' ? (spec.package ?? name) : name;
      if (!/^(?:oliphaunt(?:-|$)|liboliphaunt-)/u.test(packageName)) continue;
      // Local/workspace and external-source dependencies retain their own semantics.
      if (
        typeof spec === 'object' &&
        ['path', 'workspace', 'git', 'registry'].some((key) => Object.hasOwn(spec, key))
      )
        continue;
      dependencyBindings.push({ name, packageName, entryParts: [...parts, name] });
    }
  };
  for (const table of TABLES) collect(manifest[table], [table]);
  for (const [target, config] of Object.entries(manifest.target ?? {})) {
    for (const table of TABLES) collect(config[table], ['target', target, table]);
  }
  const runtime = manifest.package?.metadata?.oliphaunt?.runtime;
  return {
    id: crateDir,
    crateDir,
    dependencyBindings,
    ...(runtime === undefined
      ? {}
      : {
          runtime: {
            product: runtime,
            productParts: ['package', 'metadata', 'oliphaunt', 'runtime'],
            versionParts: ['package', 'metadata', 'oliphaunt', 'runtime-version'],
          },
        }),
  };
}

export function exampleCargoPolicies() {
  return cargoManifestPaths().flatMap((file) => {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (!relative.startsWith('examples/')) return [];
    return [exampleCargoPolicy(relative, Bun.TOML.parse(readFileSync(file, 'utf8')))];
  });
}

export function exampleCargoReleaseVersionBindings() {
  const catalog = loadPublicationCatalog(TOOL);
  const initialVersion = JSON.parse(
    readFileSync(path.join(ROOT, 'release-please-config.json'), 'utf8'),
  )['initial-version'];
  const effectiveVersion = (version) => (version === '0.0.0' ? initialVersion : version);
  const bindings = [];
  for (const policy of exampleCargoPolicies()) {
    const file = `${policy.crateDir}/Cargo.toml`;
    for (const { name, packageName, entryParts } of policy.dependencyBindings) {
      const carrier = resolveActualCarrier(catalog, 'cargo', packageName, TOOL);
      bindings.push({
        kind: 'dependency',
        policyId: policy.id,
        file,
        name,
        entryParts,
        versionPaths: [entryParts, [...entryParts, 'version']],
        sourceProduct: carrier.product,
        expected: `=${effectiveVersion(carrier.version)}`,
        wrapped: true,
      });
    }
    if (policy.runtime !== undefined) {
      const products = catalog.products.filter(({ id }) => id === policy.runtime.product);
      if (products.length !== 1)
        throw new Error(`${TOOL}: unknown runtime ${policy.runtime.product}`);
      const entryParts = policy.runtime.versionParts;
      bindings.push({
        kind: 'runtime',
        policyId: policy.id,
        file,
        name: 'runtime-version',
        entryParts,
        versionPaths: [entryParts],
        sourceProduct: policy.runtime.product,
        expected: effectiveVersion(products[0].version),
        wrapped: false,
      });
    }
  }
  return bindings;
}
