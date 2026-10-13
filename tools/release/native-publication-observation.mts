/** Shared observed construction for preparation and completed publication. */

import path from 'node:path';
import { type CoverageAuthority, checkShippingCoverage } from '../bazel/shipping-coverage.mts';
import {
  assureReviewedNativeBuildProducer,
  authenticateNativeBuildEvidence,
  reviewedNativeProducerUnknowns,
} from './authenticate-native-build-evidence.mts';
import { buildShippingInputView, canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import {
  type NativeBuildEvidence,
  type NativeBuildSource,
  type NativeRequiredTest,
  nativeRequiredCaptureInputs,
  validateNativeBuildEvidence,
} from './native-build-qualification.mts';
import type { NativeRoot } from './native-publication-artifacts.mts';
import { consumerDigest } from './publication-consumer-proof.mts';

type Row = Record<string, any>;
type Authenticated = {
  origin: Awaited<ReturnType<typeof authenticateNativeBuildEvidence>>;
  qualification: ReturnType<typeof validateNativeBuildEvidence>;
  evidence: NativeBuildEvidence;
  producerAssurance?: Awaited<ReturnType<typeof assureReviewedNativeBuildProducer>>['assurance'];
};
export type NativePublicationBuild = {
  evidenceRoot: string;
  expected: Parameters<typeof authenticateNativeBuildEvidence>[1];
  requiredTests: NativeRequiredTest[];
};
export type NativePublicationFile = { path: string; sha256: string; size: number };
export function assertNativePublicationBuildPlan(builds: NativePublicationBuild[]) {
  if (
    !Array.isArray(builds) ||
    !builds.length ||
    builds.some((build) => !Array.isArray(build.requiredTests) || !build.requiredTests.length)
  )
    throw new Error(
      'native observations require an explicit nonempty configured test plan for every build',
    );
}
function equal(actual: unknown, expected: unknown, context: string) {
  if (consumerDigest(actual) !== consumerDigest(expected)) throw new Error(`${context} mismatch`);
}
/** Envelope and files are prevalidated together at their exact source; no historical catalog rehydration. */
export async function observeNativePublicationConstruction(
  {
    envelope: lock,
    files,
    repository,
    bazelVersion,
    builds: requestedBuilds,
    reviewedSource,
  }: {
    envelope: Row;
    files: NativePublicationFile[];
    repository: string;
    bazelVersion: string;
    builds: NativePublicationBuild[];
    /** Explicit controller opt-in; PR/legacy observations do not assert producer discipline. */
    reviewedSource?: NativeBuildSource;
  },
  { authenticate = authenticateNativeBuildEvidence } = {},
) {
  assertNativePublicationBuildPlan(requestedBuilds);
  const authenticated = [];
  for (const build of requestedBuilds) {
    equal(build.expected.source, lock.source, 'native build/frozen source');
    equal(build.expected.github.repository, repository, 'native build repository');
    const reviewed =
      reviewedSource === undefined
        ? undefined
        : await assureReviewedNativeBuildProducer(
            build.evidenceRoot,
            {
              expected: build.expected,
              reviewedSource,
              bazelVersion,
              requiredTests: build.requiredTests,
            },
            { authenticate },
          );
    const origin = reviewed?.origin ?? (await authenticate(build.evidenceRoot, build.expected));
    const qualification =
      reviewed?.qualification ??
      validateNativeBuildEvidence(origin.evidence, {
        source: lock.source,
        github: build.expected.github,
        bazelVersion,
        requiredTests: build.requiredTests,
      });
    if (qualification.testQualification !== 'passed')
      throw new Error('completed native observations require successful configured tests');
    equal(origin.github, qualification.github, 'authenticated native build origin');
    authenticated.push({
      origin,
      qualification: reviewed
        ? { ...qualification, unverified: reviewedNativeProducerUnknowns(qualification.unverified) }
        : qualification,
      evidence: origin.evidence as NativeBuildEvidence,
      ...(reviewed ? { producerAssurance: reviewed.assurance } : {}),
    });
  }
  return projectNativePublicationConstruction({ envelope: lock, files }, authenticated);
}

/** Reuse an already observed producer set for a selected envelope. This projection
 * does not authenticate origins or grant publication authority. */
export function projectNativePublicationConstruction(
  { envelope: lock, files }: { envelope: Row; files: NativePublicationFile[] },
  authenticated: Authenticated[],
) {
  const selected = new Set(lock.products.map((product) => product.id));
  // The only conditional final input is constructed for the actual release
  // selection, after the unconditional product inventory has been qualified.
  const cohorts = authenticated
    .flatMap(({ evidence }) => evidence.cohorts)
    .map((cohort) => ({
      ...cohort,
      roots: cohort.roots.filter(
        (root) =>
          selected.has(root.package.product) &&
          !(
            lock.artifactPhase === 'pre-version' &&
            root.package.product === 'oliphaunt-swift' &&
            root.package.name === 'swiftpm-extension-consumer-fixture' &&
            root.package.role === 'release-input' &&
            root.package.configuration === 'portable'
          ),
      ),
    }))
    .filter((cohort) => cohort.roots.length > 0);
  const authority: CoverageAuthority = {
    catalog: {
      schema: lock.catalogSchema,
      products: lock.products,
      carriers: lock.carriers.filter((carrier) => carrier.declared),
    },
    artifactRows: lock.productArtifacts.map((artifact) => ({
      ...artifact,
      version: lock.products.find((product) => product.id === artifact.product).version,
    })),
    resolveCarrier: (ecosystem, name) => {
      const carrier = lock.carriers.find((row) => row.id === `${ecosystem}:${name}`);
      if (!carrier) throw new Error(`carrier absent from frozen publication: ${ecosystem}:${name}`);
      return carrier;
    },
  };
  const coverage = checkShippingCoverage(authority, cohorts, { includeReleaseInputs: true });
  const capturedFiles = (root: NativeRoot, cohort: NativeBuildEvidence['cohorts'][number]) =>
    root.package.outputs.flatMap((output) => {
      const capture = cohort.outputs.find((capture) => capture.path === output.path);
      if (!capture) throw new Error(`missing qualified output capture: ${output.path}`);
      return capture.members
        .filter((member) => member.type === 'file')
        .map((member) => ({
          ...member,
          path: member.path ? `${output.path}/${member.path}` : output.path,
        }));
    });
  const bind = (artifact: Row, product: string, roots: { root: NativeRoot; cohort: any }[]) => {
    const concrete = files.filter(
      (file) => file.path === artifact.path || file.path.startsWith(`${artifact.path}/`),
    );
    if (!concrete.length)
      throw new Error(`missing frozen concrete files: ${product}/${artifact.path}`);
    if (concrete[0].path === artifact.path) {
      equal(
        concrete,
        [{ path: artifact.path, sha256: artifact.sha256, size: artifact.size }],
        'frozen file envelope',
      );
    } else if (concrete.reduce((size, file) => size + file.size, 0) !== artifact.size) {
      throw new Error(`incomplete frozen directory file list: ${product}/${artifact.path}`);
    }
    return concrete.map((file) => {
      const suffix =
        file.path === artifact.path
          ? path.posix.basename(file.path)
          : file.path.slice(artifact.path.length + 1);
      const matches = roots.flatMap(({ root, cohort }) =>
        capturedFiles(root, cohort)
          .filter(
            (member) =>
              (file.path === artifact.path
                ? path.posix.basename(member.path) === suffix
                : root.package.outputs.some(
                    (output) => member.path === `${output.path}/${suffix}`,
                  )) &&
              member.sha256 === file.sha256 &&
              member.size === file.size,
          )
          .map((member) => ({
            label: root.label,
            path: member.path,
            sha256: member.sha256,
            size: member.size,
          })),
      );
      if (matches.length !== 1)
        throw new Error(`frozen file needs one qualified output: ${product}/${file.path}`);
      return { frozenPath: file.path, ...matches[0] };
    });
  };
  const products = lock.products.map((product) => {
    const roots = cohorts.flatMap((cohort) =>
      cohort.roots
        .filter((root) => root.package.product === product.id)
        .map((root) => ({ root, cohort })),
    );
    const carriers = lock.carriers
      .filter((carrier) => carrier.product === product.id)
      .map((carrier) => {
        const carrierRoots = roots.filter(
          ({ root }) =>
            `${root.package.ecosystem}:${root.package.name}` ===
            (carrier.parentCarrier ?? carrier.id),
        );
        return {
          ...carrier,
          qualifiedFiles: carrier.artifacts.flatMap((artifact) =>
            bind(artifact, product.id, carrierRoots),
          ),
        };
      });
    const productArtifacts = lock.productArtifacts
      .filter((artifact) => artifact.product === product.id)
      .map((artifact) => ({
        ...artifact,
        qualifiedFiles: bind(
          artifact,
          product.id,
          roots.filter(
            ({ root }) =>
              root.package.name === artifact.name && root.package.role === artifact.role,
          ),
        ),
      }));
    const construction = authenticated.flatMap(({ origin, evidence, qualification }) =>
      evidence.cohorts.flatMap((cohort, index) => {
        const selectedRoots = cohort.roots.filter((root) => root.package.product === product.id);
        if (!selectedRoots.length) return [];
        const view = buildShippingInputView(
          {
            schema: 'oliphaunt-bazel-shipping-v1',
            scope: 'construction',
            packages: selectedRoots.map((root) => root.package),
          },
          cohort.aquery,
        );
        const needed = new Set([...view.physicalInputs, ...nativeRequiredCaptureInputs(view)]);
        const analysisPaths =
          cohort.rootAnalysisInputPaths === undefined
            ? undefined
            : [
                ...new Set(
                  cohort.rootAnalysisInputPaths
                    .filter((row) =>
                      selectedRoots.some(
                        (root) => canonicalShippingLabel(root.label) === row.label,
                      ),
                    )
                    .flatMap((row) => row.paths),
                ),
              ].sort();
        return [
          {
            evidenceDigest: origin.evidenceDigest,
            invocationId: qualification.cohorts[index].invocationId,
            shippingAnalysis: cohort.producerCapture === undefined ? 'unverified' : 'bound',
            unverified: qualification.unverified,
            roots: qualification.cohorts[index].roots.filter(
              (root) => root.package.product === product.id,
            ),
            actions: view.products[product.id].actions,
            inputs: cohort.inputs.filter((input) => needed.has(input.path)),
            // Index the causal leaves in the same captured input records. Generated
            // intermediates remain evidence, but cannot stand in for source changes.
            leafInputPaths: view.products[product.id].inputs,
            ...(analysisPaths === undefined
              ? {}
              : {
                  analysisInputPaths: analysisPaths,
                  analysisInputs: cohort.analysisInputs!.filter((input) =>
                    analysisPaths.includes(input.path),
                  ),
                }),
            ...(qualification.cohorts[index].qualificationPolicy
              ? { qualificationPolicy: qualification.cohorts[index].qualificationPolicy }
              : {}),
            ...(cohort.seedConstructions?.some((receipt) => needed.has(receipt.path))
              ? {
                  seedConstructions: cohort.seedConstructions.filter((receipt) =>
                    needed.has(receipt.path),
                  ),
                }
              : {}),
          },
        ];
      }),
    );
    return {
      product: structuredClone(product),
      carriers,
      productArtifacts,
      construction,
      preEnvelopeCapture: roots.some(({ root }) => root.package.ecosystem === 'internal')
        ? 'observed'
        : 'absent',
      baselineAdmission: 'unknown' as const,
    };
  });
  return { products, authenticated, coverage };
}
