/** Canonical controller metadata; it is never a shipping payload or admission. */
import { deepStrictEqual } from 'node:assert';

export const NATIVE_PUBLICATION_METADATA_SCHEMA = 'oliphaunt-native-publication-metadata-v1';
export const NATIVE_PUBLICATION_METADATA_KIND = 'native-baseline';
// The real 17-root tools projection contains 20.21 MiB of construction facts.
// This bounded headroom is not proof that every future product/cohort will fit.
export const NATIVE_PUBLICATION_METADATA_MAX_BYTES = 64 * 1024 * 1024;
export function nativePublicationMetadataArtifactRow(product: { id: string; version: string }) {
  if (
    !/^[a-z0-9][a-z0-9-]*$/u.test(product?.id) ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(product?.version)
  )
    throw new Error('native metadata requires a canonical product/version');
  const name = `${product.id}-${product.version}-native-baseline.json`;
  return {
    product: product.id,
    version: product.version,
    id: `github-release:${name}`,
    role: 'github-release-metadata',
    kind: NATIVE_PUBLICATION_METADATA_KIND,
    target: 'portable',
    identity: null,
    name,
  };
}
/** Explicit controller opt-in; ordinary publication inventories remain unchanged. */
export function nativePublicationMetadataArtifactRows(
  products: { id: string; version: string }[],
  selected: string[] = [],
) {
  if (
    !Array.isArray(selected) ||
    selected.some((id) => typeof id !== 'string') ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !products.some((product) => product.id === id))
  )
    throw new Error('native metadata selection must contain unique selected product IDs');
  return products
    .filter((product) => selected.includes(product.id))
    .map(nativePublicationMetadataArtifactRow);
}
function fields(value: any, expected: string[], context: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${context} must be an object`);
  deepStrictEqual(Object.keys(value).sort(), expected.slice().sort(), `${context} fields`);
}
export function validateNativePublicationMetadata(
  value: any,
  expected: {
    repository?: string;
    product?: { id: string; version: string };
    source?: { commit: string; tree: string };
  } = {},
) {
  fields(
    value,
    [
      'schema',
      'scope',
      'repository',
      'source',
      'product',
      'builds',
      'carriers',
      'productArtifacts',
      'construction',
      'preEnvelopeCapture',
      'baselineAdmission',
      'releaseDecision',
      'unverified',
    ],
    'native metadata',
  );
  if (
    value.schema !== NATIVE_PUBLICATION_METADATA_SCHEMA ||
    value.scope !== 'construction' ||
    value.baselineAdmission !== 'unknown' ||
    value.releaseDecision !== 'unverified'
  )
    throw new Error('native metadata cannot grant admission or a release decision');
  if (typeof value.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(value.repository))
    throw new Error('native metadata repository identity is missing');
  fields(value.source, ['commit', 'tree'], 'native metadata source');
  if (![value.source.commit, value.source.tree].every((sha) => /^[a-f0-9]{40}$/u.test(sha)))
    throw new Error('native metadata source must be exact');
  const product = value.product;
  nativePublicationMetadataArtifactRow(product);
  if (
    !Array.isArray(value.carriers) ||
    !Array.isArray(value.productArtifacts) ||
    !Array.isArray(value.builds) ||
    !value.builds.length ||
    !Array.isArray(value.construction) ||
    !value.construction.length ||
    !Array.isArray(value.unverified) ||
    !value.unverified.length ||
    !['observed', 'absent'].includes(value.preEnvelopeCapture)
  )
    throw new Error('native metadata inventory/builds/limitations are incomplete');
  for (const build of value.builds) {
    fields(
      build,
      [
        'github',
        'artifact',
        'evidenceDigest',
        'shippingAnalysis',
        'unverified',
        'testQualification',
        'requiredTests',
      ],
      'native metadata build',
    );
    if (
      build.testQualification !== 'passed' ||
      !Array.isArray(build.requiredTests) ||
      !build.requiredTests.length ||
      !/^sha256:[a-f0-9]{64}$/u.test(build.evidenceDigest)
    )
      throw new Error(
        'native metadata requires observed successful configured tests and exact evidence',
      );
    if (
      !['bound', 'unverified'].includes(build.shippingAnalysis) ||
      !Array.isArray(build.unverified) ||
      !build.unverified.length
    )
      throw new Error('native metadata must preserve construction qualification limitations');
  }
  for (const row of [...value.carriers, ...value.productArtifacts]) {
    if (
      row.product !== product.id ||
      (row.version !== undefined && row.version !== product.version)
    )
      throw new Error('native metadata inventory owner/version differs');
    if (row.kind === 'checksums' || row.kind === NATIVE_PUBLICATION_METADATA_KIND)
      throw new Error('native metadata must exclude itself and outer checksum artifacts');
  }
  for (const observation of value.construction) {
    if (
      !Array.isArray(observation.roots) ||
      !observation.roots.length ||
      observation.roots.some(
        (root) => root.package.product !== product.id || root.package.version !== product.version,
      ) ||
      !Array.isArray(observation.actions) ||
      !Array.isArray(observation.inputs)
    )
      throw new Error('native metadata construction owner/closure differs');
  }
  if (expected.repository !== undefined)
    deepStrictEqual(value.repository, expected.repository, 'native metadata repository');
  if (expected.source !== undefined)
    deepStrictEqual(value.source, expected.source, 'native metadata source');
  if (expected.product !== undefined)
    deepStrictEqual(
      { id: product.id, version: product.version },
      expected.product,
      'native metadata product',
    );
  return value;
}
