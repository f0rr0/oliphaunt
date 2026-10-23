/** Check construction coverage; physical publication admission remains separate. */
import { buildShippingInputView } from '../release/bazel-shipping-inputs.mts';

type Row = Record<string, unknown>;

export interface CanonicalProduct {
  id: string;
  version: string;
  publishTargets?: string[];
}

export interface CanonicalCarrier {
  id: string;
  product: string;
  version: string;
  ecosystem: string;
  name: string;
  role: string;
  target: string | null;
  declared: boolean;
  parentCarrier?: string;
}

export interface CanonicalArtifact {
  product: string;
  version: string;
  id: string;
  role: string;
  kind: string;
  target: string;
  identity: string | null;
  name: string;
}

export interface CoverageAuthority {
  catalog: {
    schema: string;
    products: CanonicalProduct[];
    carriers: CanonicalCarrier[];
  };
  artifactRows: CanonicalArtifact[];
  // Production callers use publication-catalog.resolveActualCarrier. Keep
  // dynamic Cargo naming policy with its existing conventional authority.
  resolveCarrier: (ecosystem: string, name: string) => CanonicalCarrier;
}

export interface ConfiguredShippingCohort {
  roots: unknown[];
  aquery: unknown;
}

function object(value: unknown, context: string): Row {
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error(`${context} must be an object`);
  return value as Row;
}

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${context} must be nonempty`);
  return value;
}

function unique<T>(rows: T[], key: (row: T) => string, context: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const identity = key(row);
    if (result.has(identity)) throw new Error(`duplicate ${context}: ${identity}`);
    result.set(identity, row);
  }
  return result;
}

/**
 * Exact declared carrier/public-file coverage, backed by actual producer closures.
 * A selected product subset is explicit and cannot certify complete migration.
 * Root JSON must come from shipping.cquery.bzl; this does not authenticate supplied
 * files, consumed bytes, execution images or successful build/test results.
 */
export function checkShippingCoverage(
  authority: CoverageAuthority,
  cohorts: ConfiguredShippingCohort[],
  {
    products,
    includeReleaseInputs = false,
  }: { products?: string[]; includeReleaseInputs?: boolean } = {},
) {
  if (authority.catalog.schema !== 'oliphaunt-publication-catalog-v1')
    throw new Error('unsupported canonical publication catalog');
  const knownProducts = unique(
    authority.catalog.products,
    (product) => product.id,
    'canonical product',
  );
  const selected = products ?? [...knownProducts.keys()];
  const selectedSet = new Set(selected);
  if (!selected.length || selectedSet.size !== selected.length)
    throw new Error('coverage requires a nonempty, unique product selection');
  for (const product of selected) {
    if (!knownProducts.has(product)) throw new Error(`unknown selected product: ${product}`);
  }
  const declaredCarriers = unique(
    authority.catalog.carriers,
    (carrier) => carrier.id,
    'canonical carrier',
  );
  for (const carrier of declaredCarriers.values()) {
    const owner = knownProducts.get(carrier.product);
    if (!owner || carrier.version !== owner.version || !carrier.declared)
      throw new Error(`inconsistent canonical carrier: ${carrier.id}`);
  }
  const artifactRows = unique(
    authority.artifactRows,
    (artifact) => `${artifact.product}:${artifact.id}`,
    'canonical artifact',
  );
  for (const artifact of artifactRows.values()) {
    const owner = knownProducts.get(artifact.product);
    if (
      !owner ||
      artifact.version !== owner.version ||
      !['github-release-asset', 'github-release-metadata', 'release-input'].includes(artifact.role)
    )
      throw new Error(`inconsistent canonical artifact: ${artifact.id}`);
  }
  // The source-tag publisher consumes a frozen manifest and tree. Their lock
  // role remains release-input; candidate-only fixtures cannot replace them.
  const sourcePublicationArtifacts = new Set<string>();
  for (const product of knownProducts.values()) {
    if (
      !selectedSet.has(product.id) ||
      !product.publishTargets?.includes('swift-package-source-tag')
    )
      continue;
    for (const kind of ['swiftpm-release-manifest', 'swiftpm-release-tree']) {
      const rows = [...artifactRows.values()].filter(
        (artifact) =>
          artifact.product === product.id &&
          artifact.kind === kind &&
          artifact.role === 'release-input',
      );
      if (rows.length !== 1)
        throw new Error(`source publication requires one canonical ${kind}: ${product.id}`);
      sourcePublicationArtifacts.add(`${product.id}:${rows[0].id}`);
    }
  }
  const expectedCarriers = [...declaredCarriers.values()].filter((carrier) =>
    selectedSet.has(carrier.product),
  );
  const expectedArtifacts = [...artifactRows.values()].filter(
    (artifact) =>
      selectedSet.has(artifact.product) &&
      (includeReleaseInputs ||
        artifact.role !== 'release-input' ||
        sourcePublicationArtifacts.has(`${artifact.product}:${artifact.id}`)),
  );
  const seen = new Set<string>();
  const actualCarriers = new Map<string, CanonicalCarrier>();
  const actualArtifacts = new Set<string>();
  const representedProducts = new Set<string>();
  const labels = new Set<string>();
  const internalLabels = new Set<string>();
  let internalRoots = 0;
  let releaseInputRoots = 0;
  const constructionActions = new Set<string>();
  for (const cohort of cohorts) {
    if (!Array.isArray(cohort.roots)) throw new Error('configured cohort roots must be an array');
    const packages = cohort.roots.map((value) => {
      const root = object(value, 'configured root');
      const label = text(root.label, 'configured root label').replace(/^@@?\/\//, '//');
      if (!/^(?:@@?[^/\s:]+\/\/|\/\/)[^:\s]*:[^:\s]+$/.test(label))
        throw new Error(`invalid root label: ${label}`);
      const pkg = object(root.package, `ShippingInfo ${label}`);
      const product = text(pkg.product, 'product');
      const owner = knownProducts.get(product);
      if (!owner || !selectedSet.has(product))
        throw new Error(`unexpected shipping product: ${product}`);
      if (pkg.version !== owner.version) throw new Error(`wrong shipping version for ${product}`);
      // One publication identity has one final root. Duplicated cohort/root
      // scheduling is an error even when its resulting bytes would be equal.
      const ecosystem = text(pkg.ecosystem, 'ecosystem');
      const identity = `${ecosystem === 'github' ? `${product}:` : ''}${ecosystem}:${text(pkg.name, 'name')}${ecosystem === 'internal' ? `:${text(pkg.configuration, 'configuration')}` : ''}`;
      if (seen.has(identity))
        throw new Error(`duplicate configured shipping identity: ${identity}`);
      seen.add(identity);
      (ecosystem === 'internal' ? internalLabels : labels).add(label);
      return pkg;
    });
    const view = buildShippingInputView(
      {
        schema: 'oliphaunt-bazel-shipping-v1',
        scope: 'construction',
        packages,
      },
      cohort.aquery,
    );
    for (const product of Object.values(view.products)) {
      for (const action of product.actions) constructionActions.add(action);
    }
    for (const pkg of packages) {
      const product = text(pkg.product, 'product');
      const ecosystem = text(pkg.ecosystem, 'ecosystem');
      const name = text(pkg.name, 'name');
      const configuration = text(pkg.configuration, 'configuration');
      const role = text(pkg.role, 'role');
      if (ecosystem === 'internal') {
        internalRoots += 1;
        continue;
      }
      if (['cargo', 'npm', 'maven'].includes(ecosystem)) {
        const identity = `${ecosystem}:${name}`;
        const carrier = declaredCarriers.get(identity) ?? authority.resolveCarrier(ecosystem, name);
        if (
          carrier.id !== identity ||
          carrier.product !== product ||
          carrier.version !== pkg.version
        )
          throw new Error(`wrong carrier ownership/version: ${identity}`);
        if (carrier.target !== null && carrier.target !== configuration)
          throw new Error(`wrong carrier target for ${identity}: ${configuration}`);
        if (role !== carrier.role) throw new Error(`wrong carrier role for ${identity}: ${role}`);
        actualCarriers.set(identity, carrier);
        representedProducts.add(product);
      } else if (ecosystem === 'github' || role === 'release-input') {
        const matches = [...artifactRows.values()].filter(
          (artifact) =>
            artifact.product === product && artifact.name === name && artifact.role === role,
        );
        if (matches.length !== 1)
          throw new Error(`unexpected public artifact: ${product}:${role}:${name}`);
        const artifact = matches[0];
        if (artifact.target !== configuration)
          throw new Error(`wrong artifact target for ${artifact.id}: ${configuration}`);
        actualArtifacts.add(`${product}:${artifact.id}`);
        if (role === 'release-input') releaseInputRoots += 1;
        if (role !== 'release-input' || sourcePublicationArtifacts.has(`${product}:${artifact.id}`))
          representedProducts.add(product);
      } else {
        throw new Error(`unsupported public shipping ecosystem: ${ecosystem}`);
      }
    }
  }
  for (const carrier of actualCarriers.values()) {
    if (!carrier.declared && (!carrier.parentCarrier || !actualCarriers.has(carrier.parentCarrier)))
      throw new Error(`dynamic payload part cannot replace its declared parent: ${carrier.id}`);
  }
  const missing = [
    ...selected
      .filter((product) => !representedProducts.has(product))
      .map((product) => `product:${product}`),
    ...expectedCarriers
      .filter((carrier) => !actualCarriers.has(carrier.id))
      .map((carrier) => carrier.id),
    ...expectedArtifacts
      .filter((artifact) => !actualArtifacts.has(`${artifact.product}:${artifact.id}`))
      .map((artifact) => `${artifact.product}:${artifact.id}`),
  ].sort();
  if (missing.length)
    throw new Error(`incomplete native shipping coverage:\n${missing.join('\n')}`);
  return {
    scope: 'construction' as const,
    completeProductInventory: selectedSet.size === knownProducts.size,
    products: [...selected].sort(),
    declaredCarriers: expectedCarriers.length,
    dynamicCarriers: [...actualCarriers.values()].filter((carrier) => !carrier.declared).length,
    publicArtifacts: expectedArtifacts.filter((artifact) => artifact.role !== 'release-input')
      .length,
    sourcePublicationInputs: sourcePublicationArtifacts.size,
    releaseInputsRequired: includeReleaseInputs,
    releaseInputRoots,
    internalRoots,
    rootLabels: [...labels].sort(),
    internalRootLabels: [...internalLabels].sort(),
    constructionActionDescriptions: constructionActions.size,
    unverified: [
      'packed manifests, artifact kinds and payload identities',
      'consumed content and loaded-rule, acquisition and configuration provenance',
      'producer execution or trusted cached-result provenance',
      'consumer and runtime compatibility',
    ],
  };
}
