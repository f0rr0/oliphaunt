/** Physical native providers adapted to the existing candidate; authority stays construction. */
import type { NativeLegalSourceBasis } from '../../src/native/sdks/swift/tools/native-legal-source-basis.mts';
import {
  readNativePublicationArtifacts,
  type PhysicalShippingCohort,
} from './native-publication-artifacts.mts';
import { loadPublicationCatalog, resolveActualCarrier } from './publication-catalog.mts';
import { captureNativePublicationOutputs } from './native-publication-staging.mts';
import { captureNativePreEnvelopePayloads } from './native-publication-payloads.mts';
import {
  buildPublicationCandidate,
  expectedProductArtifactRows,
  sourceIdentity,
} from './publication-lock.mts';

export interface NativeCandidateCohort extends PhysicalShippingCohort {
  source: { commit: string; tree: string };
}

export function buildNativePublicationCandidate({
  cohorts,
  products,
  headRef = 'HEAD',
  nativeSourceBasis,
}: {
  cohorts: NativeCandidateCohort[];
  products?: string[];
  headRef?: string;
  nativeSourceBasis?: NativeLegalSourceBasis;
}) {
  const source = sourceIdentity(headRef);
  if (!Array.isArray(cohorts) || !cohorts.length)
    throw new Error('native candidate requires actual configured physical cohorts');
  for (const cohort of cohorts)
    if (cohort.source?.commit !== source.commit || cohort.source?.tree !== source.tree)
      throw new Error('native cohort does not match the exact frozen candidate source');
  const outputs = captureNativePublicationOutputs(cohorts, { sourceCommit: source.commit });
  const catalog = loadPublicationCatalog('native-publication-candidate');
  const selected = new Set(products ?? catalog.products.map(({ id }) => id));
  const payloads = captureNativePreEnvelopePayloads(cohorts, {
    source,
    products: catalog.products.filter(({ id }) => selected.has(id)),
  });
  const authority = {
    catalog,
    artifactRows: expectedProductArtifactRows(
      catalog.products.filter(({ id }) => selected.has(id)),
    ),
    resolveCarrier: (ecosystem: string, name: string) =>
      resolveActualCarrier(catalog, ecosystem, name, 'native-publication-candidate'),
  };
  const physical = readNativePublicationArtifacts(authority, cohorts, {
    products,
    nativeSourceBasis,
  });
  const candidate = buildPublicationCandidate({
    products,
    artifactRoots: outputs.stage(),
    headRef: source.commit,
    nativeSourceBasis,
  });
  if (candidate.source.commit !== source.commit || candidate.source.tree !== source.tree)
    throw new Error('native candidate source changed after its physical cohorts were captured');
  payloads.assertUnchanged();
  return {
    ...candidate,
    scope: 'construction' as const,
    nativePayloads: payloads.payloads,
    unverified: physical.unverified,
  };
}
