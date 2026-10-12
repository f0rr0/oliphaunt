/** Read physical native envelopes; this remains construction evidence. */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { NativeLegalSourceBasis } from '../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import {
  type ConfiguredShippingCohort,
  type CoverageAuthority,
  checkShippingCoverage,
} from '../bazel/shipping-coverage.mts';
import type { NativeShippingSupplier } from './bazel-shipping-inputs.mts';
import {
  assertWasixPublicationPackages,
  discoverProductArtifacts,
  discoverPublicationArtifacts,
  expectedProductArtifactRows,
  validateCargoPayloadPartSets,
} from './publication-lock.mts';

export interface PhysicalShippingCohort extends ConfiguredShippingCohort {
  executionRoot: string;
}

export type NativeRoot = {
  label: string;
  package: {
    product: string;
    version: string;
    ecosystem: string;
    name: string;
    configuration: string;
    role: string;
    outputs: { path: string; owner: string }[];
    supplierInputs?: NativeShippingSupplier[];
  };
};

export function nativeOutputPath(executionRoot: string, relative: unknown) {
  if (
    typeof relative !== 'string' ||
    !relative.startsWith('bazel-out/') ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`unsafe native output path: ${JSON.stringify(relative)}`);
  const absolute = path.join(executionRoot, relative);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new Error(`native output is not a physical file or directory: ${absolute}`);
  const physicalRoot = realpathSync(path.join(executionRoot, 'bazel-out'));
  const physicalOutput = realpathSync(absolute);
  if (
    !physicalRoot.startsWith(`${executionRoot}${path.sep}`) ||
    !physicalOutput.startsWith(`${physicalRoot}${path.sep}`)
  )
    throw new Error(`native output escapes its captured executionRoot: ${absolute}`);
  return absolute;
}

/**
 * Query rows must come from the same configured cohort as their captured execroot.
 * Archive readers supply identities, versions, dependencies, hashes and sizes;
 * ShippingInfo declarations cannot substitute for those physical observations.
 * Successful reading does not prove build provenance, qualification or baseline
 * equivalence, and cannot select a release or authorize publication.
 */
export function readNativePublicationArtifacts(
  authority: CoverageAuthority,
  cohorts: PhysicalShippingCohort[],
  {
    products,
    nativeSourceBasis,
    artifactPhase = 'final',
  }: {
    products?: string[];
    nativeSourceBasis?: NativeLegalSourceBasis;
    artifactPhase?: 'pre-version' | 'final';
  } = {},
) {
  const phaseAuthority =
    artifactPhase === 'final'
      ? authority
      : {
          ...authority,
          artifactRows: expectedProductArtifactRows(authority.catalog.products, { artifactPhase }),
        };
  const coverage = checkShippingCoverage(phaseAuthority, cohorts, {
    products,
    includeReleaseInputs: true,
  });
  const roots = cohorts.flatMap((cohort) => {
    if (!path.isAbsolute(cohort.executionRoot ?? ''))
      throw new Error('each physical cohort requires its captured absolute executionRoot');
    const executionRoot = realpathSync(cohort.executionRoot);
    return cohort.roots.flatMap((raw) => {
      const root = raw as NativeRoot;
      if (root.package.ecosystem === 'internal') return [];
      return [
        {
          ...root,
          paths: root.package.outputs.map((output) => nativeOutputPath(executionRoot, output.path)),
        },
      ];
    });
  });
  const registryRoots = roots.filter(({ package: pkg }) =>
    ['cargo', 'npm', 'maven'].includes(pkg.ecosystem),
  );
  const registryArtifacts = registryRoots.length
    ? discoverPublicationArtifacts([...new Set(registryRoots.flatMap(({ paths }) => paths))])
    : [];
  const isRootOutput = (root, artifactPath) => {
    const actualPath = realpathSync(path.resolve(import.meta.dir, '../..', artifactPath));
    return root.paths.some((output) => {
      const expectedPath = realpathSync(output);
      return actualPath === expectedPath || actualPath.startsWith(`${expectedPath}${path.sep}`);
    });
  };
  for (const root of registryRoots) {
    const identity = `${root.package.ecosystem}:${root.package.name}`;
    const records = registryArtifacts.filter((record) =>
      record.artifacts.some((artifact) => isRootOutput(root, artifact.path)),
    );
    if (!records.some((record) => `${record.ecosystem}:${record.name}` === identity))
      throw new Error(`${root.label} physical output does not contain ${identity}`);
    for (const record of records) {
      if (record.artifacts.some((artifact) => !isRootOutput(root, artifact.path)))
        throw new Error(`${root.label} physical registry file is not a declared output`);
      const actual = authority.resolveCarrier(record.ecosystem, record.name);
      if (
        actual.product !== root.package.product ||
        actual.version !== record.version ||
        (actual.id !== identity && actual.parentCarrier !== identity) ||
        record.qualificationOnly
      )
        throw new Error(
          `${root.label} physical carrier does not match its canonical identity: ${actual.id}@${record.version}`,
        );
    }
  }
  assertWasixPublicationPackages(registryArtifacts);
  validateCargoPayloadPartSets(
    registryArtifacts.map((record) => ({
      ...authority.resolveCarrier(record.ecosystem, record.name),
      packageDependencies: record.dependencies,
    })),
  );
  const selected = new Set(coverage.products);
  const productArtifacts = discoverProductArtifacts(
    [...new Set(roots.flatMap(({ paths }) => paths))],
    authority.catalog.products.filter(({ id }) => selected.has(id)),
    { nativeSourceBasis, artifactPhase },
  );
  const expectedIds = phaseAuthority.artifactRows
    .filter(({ product }) => selected.has(product))
    .map(({ product, id }) => `${product}:${id}`)
    .sort();
  const actualIds = productArtifacts.map(({ product, id }) => `${product}:${id}`).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds))
    throw new Error('physical native product artifact inventory is incomplete');
  for (const artifact of productArtifacts) {
    const declared = phaseAuthority.artifactRows.find(
      (row) => row.product === artifact.product && row.id === artifact.id,
    );
    if (
      !declared ||
      ['role', 'kind', 'target', 'identity', 'name'].some((key) => declared[key] !== artifact[key])
    )
      throw new Error(
        `physical native product artifact does not match canonical inventory: ${artifact.product}:${artifact.id}`,
      );
    const root = roots.find(
      ({ package: pkg }) =>
        pkg.product === artifact.product &&
        pkg.name === artifact.name &&
        pkg.role === artifact.role,
    );
    const actualPath = realpathSync(path.resolve(import.meta.dir, '../..', artifact.path));
    if (
      !root?.paths.some((output) => {
        const expectedPath = realpathSync(output);
        return actualPath === expectedPath || actualPath.startsWith(`${expectedPath}${path.sep}`);
      })
    )
      throw new Error(
        `physical native artifact is not an output of its declared root: ${artifact.product}:${artifact.id}`,
      );
  }
  return {
    ...coverage,
    artifactRoots: [...new Set(roots.flatMap(({ paths }) => paths))].sort(),
    registryArtifacts,
    productArtifacts,
    unverified: [
      ...coverage.unverified.filter(
        (fact) => fact !== 'packed manifests, artifact kinds and payload identities',
      ),
      'frozen source and completed-publication construction equivalence',
    ],
  };
}
