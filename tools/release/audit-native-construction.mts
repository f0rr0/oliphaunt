/** Check the complete shipping construction after its source jobs succeed.
 * This diagnostic never selects products or admits a publication candidate. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  removeOwnedDirectory,
  requireSafeDirectoryChain,
} from '../packaging/release-directory-safety.mts';
import { assertAuthenticatedNativeBuildOrigin } from './authenticate-native-build-evidence.mts';
import type { NativeBuildSource } from './native-build-qualification.mts';
import { acquireObservedCompletedSuppliers } from './native-freeze-publication-candidate.mts';
import { observeNativePublicationConstruction } from './native-publication-observation.mts';
import {
  acquireNativePublicationBuilds,
  stageNativePublicationConstruction,
} from './native-release-preparation.mts';
import { projectNativeBuildBoundSuppliers } from './native-shipping-suppliers.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import { consumerDigest } from './publication-consumer-proof.mts';
import { lockedPublicationFiles, sourceIdentity } from './publication-lock.mts';
import { ROOT } from './release-graph.mts';

const equal = (actual: unknown, expected: unknown, message: string) =>
  assert.equal(consumerDigest(actual), consumerDigest(expected), message);

/** Structural audit assertions return facts only; the caller authenticates every origin. */
export function assertNativeConstructionAudit({
  source,
  candidate,
  observation,
  suppliers,
  expectedProducts,
}: {
  source: NativeBuildSource;
  candidate: ReturnType<typeof stageNativePublicationConstruction>['candidate'];
  observation: Awaited<ReturnType<typeof observeNativePublicationConstruction>>;
  suppliers: Awaited<ReturnType<typeof projectNativeBuildBoundSuppliers>>;
  expectedProducts: ReturnType<typeof loadPublicationCatalog>['products'];
}) {
  assert.equal(candidate.scope, 'construction', 'native audit requires construction scope');
  equal(candidate.source, source, 'native audit candidate source differs');
  assert.equal(
    candidate.artifactPhase,
    'pre-version',
    'native audit requires preparation inventory',
  );
  equal(candidate.products, expectedProducts, 'native audit requires every canonical product');
  assert.deepEqual(candidate.missing, [], 'native audit has missing physical carriers');
  equal(
    observation.products.map(({ product }) => product),
    expectedProducts,
    'native audit observed products differ',
  );
  assert.equal(
    observation.coverage.completeProductInventory,
    true,
    'native audit has incomplete configured inventory',
  );
  assert.equal(
    observation.coverage.releaseInputsRequired,
    true,
    'native audit requires preparation inputs',
  );
  assert.ok(observation.authenticated.length, 'native audit requires original producing builds');
  const versions = new Map(expectedProducts.map(({ id, version }) => [id, version]));
  const covered = new Set<string>();
  let configuredRoots = 0;
  for (const build of observation.authenticated) {
    equal(build.evidence.source, source, 'native audit producer source differs');
    equal(build.qualification.source, source, 'native audit qualified source differs');
    for (const cohort of build.qualification.cohorts) {
      for (const root of cohort.roots) {
        assert.ok(
          versions.has(root.package.product),
          'native audit has an unknown configured owner',
        );
        covered.add(root.package.product);
        configuredRoots++;
      }
    }
  }
  assert.deepEqual(
    [...covered].sort(),
    [...versions.keys()].sort(),
    'native audit lacks a configured owner',
  );
  for (const product of observation.products) {
    assert.ok(product.construction.length, 'native audit lacks captured causal construction');
    for (const view of product.construction)
      for (const field of ['leafInputPaths', 'analysisInputPaths'] as const)
        assert.ok(
          Array.isArray(view[field]) &&
            view[field].every((file) => typeof file === 'string' && file.length),
          `native audit lacks captured ${field}`,
        );
  }
  assert.equal(suppliers.scope, 'construction', 'native audit suppliers exceed construction scope');
  equal(suppliers.source, source, 'native audit supplier source differs');
  assert.deepEqual(suppliers.unknowns, [], 'native audit has unknown supplier bytes or origins');
  assert.ok(suppliers.buildBound, 'native audit lacks a complete configured supplier map');
  assert.deepEqual(
    [...suppliers.buildBound.keys()].sort(),
    [...versions.keys()].sort(),
    'native audit supplier inventory differs',
  );
  for (const [consumer, producers] of suppliers.buildBound) {
    assert.ok(producers instanceof Set, 'native audit supplier rows must be configured sets');
    for (const producer of producers)
      assert.ok(
        producer !== consumer && versions.has(producer),
        'native audit has an unknown or self supplier',
      );
  }
  return {
    scope: 'construction' as const,
    source: structuredClone(source),
    products: [...versions.keys()].sort(),
    configuredRoots,
    supplierBindings: suppliers.suppliers.length,
  };
}

/** All producer jobs have finished; the workflow and its Required job may still run. */
export async function auditNativeConstruction({
  source,
  runId,
  ref,
  directory,
  publicationInputs,
}: {
  source: NativeBuildSource;
  runId: number;
  ref: string;
  directory: string;
  publicationInputs: string;
}) {
  const snapshot = JSON.parse(readFileSync(publicationInputs, 'utf8'));
  equal(snapshot.source, source, 'native audit input snapshot source differs');
  const destination = path.resolve(directory);
  requireSafeDirectoryChain(path.dirname(destination), {
    create: true,
    label: 'native construction audit',
  });
  assert.ok(!existsSync(destination), 'native audit requires a new owned directory');
  mkdirSync(destination);
  let staging: string | undefined;
  let keepDiagnostic = false;
  try {
    const acquisition = await acquireNativePublicationBuilds({
      source,
      runId,
      ref,
      directory: path.join(destination, 'producers'),
    });
    for (const origin of acquisition.origins.values()) assertAuthenticatedNativeBuildOrigin(origin);
    const parent = requireSafeDirectoryChain(path.join(ROOT, 'target/native-construction-audit'), {
      create: true,
      label: 'native audit staging',
    });
    staging = mkdtempSync(path.join(parent, `${runId}-`));
    const { candidate, bazelVersion } = stageNativePublicationConstruction({
      source,
      runId,
      ...acquisition,
      directory: path.join(staging, 'construction'),
    });
    const authenticate = async (evidenceRoot: string, expected) => {
      const origin = acquisition.origins.get(evidenceRoot);
      const build = acquisition.builds.find((row) => row.evidenceRoot === evidenceRoot);
      assert.ok(origin && build, 'native audit cannot import an unacquired producer');
      equal(expected, build.expected, 'native audit producer constraints changed');
      origin.finalFiles?.assertUnchanged();
      return assertAuthenticatedNativeBuildOrigin(origin);
    };
    // No reviewedSource: PR and feature sources remain construction observations.
    const observation = await observeNativePublicationConstruction(
      {
        envelope: candidate,
        files: lockedPublicationFiles(candidate),
        repository: 'f0rr0/oliphaunt',
        bazelVersion,
        builds: acquisition.builds,
      },
      { authenticate },
    );
    const completed = await acquireObservedCompletedSuppliers(
      observation,
      path.join(destination, 'held'),
      snapshot.supplierArtifacts ?? [],
    );
    const suppliers = await projectNativeBuildBoundSuppliers({
      products: Object.fromEntries(candidate.products.map((product) => [product.id, product])),
      source,
      observation,
      completed,
    });
    const result = assertNativeConstructionAudit({
      source,
      candidate,
      observation,
      suppliers,
      expectedProducts: loadPublicationCatalog('native construction audit').products,
    });
    for (const origin of acquisition.origins.values()) origin.finalFiles?.assertUnchanged();
    writeFileSync(
      path.join(destination, 'native-construction-audit.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: 'wx' },
    );
    keepDiagnostic = true;
    return result;
  } finally {
    if (staging) removeOwnedDirectory(staging);
    // Only the small diagnostic survives; producer artifacts remain retained upstream.
    for (const child of ['producers', 'held']) removeOwnedDirectory(path.join(destination, child));
    if (!keepDiagnostic) removeOwnedDirectory(destination);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      'run-id': { type: 'string' },
      ref: { type: 'string' },
      'output-directory': { type: 'string' },
    },
    strict: true,
  });
  assert.ok(
    values['run-id'] && /^[1-9][0-9]*$/u.test(values['run-id']),
    'native audit requires an exact positive run ID',
  );
  assert.ok(
    values.ref && values['output-directory'],
    'usage: audit-native-construction.mts --run-id ID --ref REF --output-directory DIR',
  );
  assert.ok(
    process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS,
    'native audit requires source-bound native inputs',
  );
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
    '',
    'native audit requires a clean source checkout',
  );
  const result = await auditNativeConstruction({
    source: sourceIdentity('HEAD'),
    runId: Number(values['run-id']),
    ref: values.ref,
    directory: values['output-directory'],
    publicationInputs: process.env.OLIPHAUNT_NATIVE_PUBLICATION_INPUTS,
  });
  console.log(JSON.stringify(result));
}
