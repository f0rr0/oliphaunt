/** The WASIX seed's exact consuming module is an installed contract, not compiled incorporation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import { wasixRuntimeNpmPayloadInputs } from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import { readPortableTarZstdBufferEntries } from '../packaging/portable-archive.mts';
import {
  assertAuthenticatedNativeBuildOrigin,
  validateReviewedNativeProducerAssurance,
} from './authenticate-native-build-evidence.mts';
import type { ReleaseMetadata } from './bazel-release-metadata.mts';
import {
  canonicalShippingLabel,
  validateNativeShippingSuppliers,
} from './bazel-shipping-inputs.mts';
import { fileIdentity } from './native-file-identity.mts';
import type { prepareNativeReleaseDelivery } from './native-release-preparation.mts';

type Preparation = Pick<
  Awaited<ReturnType<typeof prepareNativeReleaseDelivery>>,
  'observation' | 'origins' | 'suppliers'
>;
type Association = Readonly<{ product: string; sourceProduct: string }>;

/** Physical construction projection only. The controller below authenticates the producer inputs. */
export function inspectNativeCurrentExactInputs({
  metadata,
  observation,
  suppliers,
  readOutput,
  inputIdentity,
}: {
  metadata: ReleaseMetadata;
  observation: Preparation['observation'];
  suppliers: Preparation['suppliers']['suppliers'];
  readOutput: (file: any) => Buffer;
  inputIdentity: (supplier: any, file: any) => { size: number; sha256: string };
}): readonly Association[] {
  const declaration = metadata.databaseResourceWasixConsumer;
  assert.ok(declaration, 'WASIX admitted consumer declaration is missing');
  if (declaration.source === 'completed') return Object.freeze([]);
  assert.equal(declaration.source, 'current');
  const producer = 'liboliphaunt-wasix';
  const consumer = 'database-resources';
  assert.equal(
    declaration.version,
    metadata.products[producer].version,
    'current WASIX admitted version differs from source',
  );
  const product = observation.products.find(({ product }) => product.id === producer);
  const resources = observation.products.find(({ product }) => product.id === consumer);
  assert.ok(product && resources, 'current WASIX exact contract owners are missing');
  assert.equal(product.product.version, metadata.products[producer].version);
  assert.equal(resources.product.version, metadata.products[consumer].version);
  const archives = product.productArtifacts.filter(
    (row) =>
      row.kind === 'wasix-runtime' &&
      row.target === 'portable' &&
      row.role === 'github-release-asset',
  );
  assert.equal(
    archives.length,
    1,
    'current WASIX contract needs one actual portable public archive',
  );
  assert.equal(archives[0].qualifiedFiles.length, 1);
  const coreFile = archives[0].qualifiedFiles[0];
  const coreBytes = readOutput(coreFile);
  const core = readPortableTarZstdBufferEntries(coreBytes);
  const manifest = core.get(WASIX_PORTABLE_RELEASE_MEMBERS.manifest);
  const runtime = core.get(WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive);
  assert.ok(manifest?.isFile && runtime?.isFile, 'current WASIX portable archive is incomplete');
  const coreManifest = JSON.parse(manifest.data().toString('utf8'));
  wasixRuntimeNpmPayloadInputs({
    manifestBytes: manifest.data(),
    runtimeBytes: runtime.data(),
    label: 'qualified current resource consumer',
  });
  assert.ok(metadata.databaseResourceContract, 'WASIX resource contract is missing');
  const profiles = Object.keys(metadata.databaseResourceContract.profiles as object);
  const declarations = metadata.databaseResourceArtifacts.filter(
    (row) =>
      row.kind === 'wasix-seeds' &&
      row.target === 'portable' &&
      String(row.asset).endsWith('.json'),
  );
  assert.equal(
    declarations.length,
    profiles.length,
    'WASIX exact contract profile inventory differs',
  );
  for (const expected of declarations) {
    const descriptors = resources.productArtifacts.filter(
      (row) =>
        row.id ===
        `github-release:${String(expected.asset).replace('{version}', resources.product.version)}`,
    );
    assert.equal(
      descriptors.length,
      1,
      'WASIX exact contract lacks a qualified profile descriptor',
    );
    assert.equal(descriptors[0].qualifiedFiles.length, 1);
    const descriptorFile = descriptors[0].qualifiedFiles[0];
    const descriptor = JSON.parse(readOutput(descriptorFile).toString('utf8'));
    assert.equal(descriptor.runtime.engineFamily, 'wasix');
    assert.equal(
      descriptor.runtime.version,
      declaration.version,
      'WASIX exact descriptor does not admit the current source version',
    );
    assert.equal(
      descriptor.runtime.consumerSha256,
      coreManifest.runtime['module-sha256'],
      'WASIX descriptor admits another module',
    );
    assert.equal(descriptor.runtime.target, 'portable');
    assert.ok(profiles.includes(descriptor.catalogProfile));
    assert.ok(
      String(expected.asset).includes(`-${descriptor.catalogProfile}.json`),
      'WASIX profile descriptor is relabelled',
    );
    const supplied = suppliers.filter(
      (row) =>
        row.consumer === consumer &&
        row.product === producer &&
        canonicalShippingLabel(row.root) === canonicalShippingLabel(descriptorFile.label),
    );
    assert.equal(
      supplied.length,
      1,
      'WASIX exact descriptor lacks its own actual supplier binding',
    );
    const supplier = supplied[0];
    assert.equal(supplier.binding, 'abi-contract');
    assert.equal(
      supplier.origin.kind,
      'current-source',
      'WASIX exact adoption cannot relabel a held supplier',
    );
    assert.equal(supplier.version, declaration.version);
    assert.equal(supplier.configuration, 'portable');
    assert.equal(
      supplier.files.length,
      1,
      'WASIX exact consumer needs the entire actual portable archive File',
    );
    assert.equal(supplier.files[0].member, undefined);
    assert.deepEqual(
      inputIdentity(supplier, supplier.files[0]),
      { size: coreFile.size, sha256: coreFile.sha256 },
      'WASIX exact consumer File differs from the actual producer archive',
    );
  }
  return Object.freeze([Object.freeze({ product: consumer, sourceProduct: producer })]);
}

/** Only the actual retained reviewed producer capabilities can feed the RP controller. */
export function deriveQualifiedNativeCurrentExactInputs(
  preparation: Preparation,
  metadata: ReleaseMetadata,
): readonly Association[] {
  assert.ok(
    preparation.suppliers.buildBound && !preparation.suppliers.unknowns.length,
    'current exact contracts require complete physical supplier coverage',
  );
  const observed = preparation.observation.authenticated;
  assert.ok(observed.length, 'current exact contracts need producing evidence');
  const source = observed[0].evidence.source;
  for (const origin of preparation.origins.values()) {
    assertAuthenticatedNativeBuildOrigin(origin);
    const matches = observed.filter((build) => build.origin === origin);
    assert.equal(
      matches.length,
      1,
      'current exact contracts need the same acquired observed producer',
    );
    const build = matches[0];
    assert.deepEqual(build.evidence.source, source, 'current exact producer source differs');
    assert.deepEqual(
      build.qualification.source,
      source,
      'current exact qualification source differs',
    );
    assert.deepEqual(build.evidence, origin.evidence, 'current exact producer evidence changed');
    assert.ok(
      build.producerAssurance && origin.finalFiles,
      'current exact contract needs original reviewed qualification and retained Files',
    );
    validateReviewedNativeProducerAssurance(build.producerAssurance, {
      source: build.evidence.source,
      github: origin.github,
      artifact: origin.artifact,
      evidenceDigest: origin.evidenceDigest,
      requiredTests: build.qualification.requiredTests,
    });
    assert.equal(build.qualification.qualificationPolicy, 'bound');
    origin.finalFiles.assertUnchanged?.();
  }
  assert.equal(
    observed.length,
    preparation.origins.size,
    'current exact contract imported an unacquired producer',
  );
  const locate = (file: any) => {
    const roots = [...preparation.origins].flatMap(([directory, origin]) =>
      origin.evidence.cohorts.flatMap((cohort, index) =>
        cohort.roots
          .filter(
            (root) =>
              canonicalShippingLabel(root.label) === canonicalShippingLabel(file.label) &&
              root.package.outputs.some(
                ({ path }) => file.path === path || file.path.startsWith(`${path}/`),
              ),
          )
          .map(() => ({ directory, origin, cohort, index })),
      ),
    );
    assert.equal(roots.length, 1, 'current exact File needs one original configured root');
    const { directory, origin, index } = roots[0];
    assert.ok(origin.finalFiles, 'current exact File has no retained transport');
    const captured = origin.finalFiles.files.filter(
      (row) => row.cohort === index && row.path === file.path,
    );
    assert.equal(captured.length, 1, 'current exact File is absent from retained transport');
    const expected = { size: file.size, sha256: file.sha256 };
    assert.deepEqual({ size: captured[0].size, sha256: captured[0].sha256 }, expected);
    const absolute = path.join(directory, 'files', String(index), file.path);
    const actual = fileIdentity(absolute);
    assert.deepEqual(
      { size: actual.size, sha256: actual.sha256 },
      expected,
      'current exact original output changed',
    );
    return absolute;
  };
  const associations = inspectNativeCurrentExactInputs({
    metadata,
    observation: preparation.observation,
    suppliers: preparation.suppliers.suppliers,
    readOutput: (file) => readFileSync(locate(file)),
    inputIdentity: (supplier, file) => {
      const cohorts = observed
        .flatMap(({ evidence }) => evidence.cohorts)
        .filter((cohort) =>
          cohort.rootConfigurations.some(
            ({ label, configuration }) =>
              canonicalShippingLabel(label) === supplier.root &&
              configuration === supplier.rootConfiguration,
          ),
        );
      assert.equal(cohorts.length, 1, 'current exact supplier has ambiguous configured provenance');
      const roots = cohorts[0].roots.filter(
        (root) => canonicalShippingLabel(root.label) === supplier.root,
      );
      assert.equal(roots.length, 1, 'current exact supplier needs its original ShippingInfo root');
      const { product, version, configuration, binding, origin, files } = supplier;
      const declaration = { product, version, configuration, binding, origin, files };
      const supplied = validateNativeShippingSuppliers(roots[0].package.supplierInputs);
      assert.equal(
        supplied.filter((row) => isDeepStrictEqual(row, declaration)).length,
        1,
        'current exact supplier differs from original captured ShippingInfo',
      );
      const captures = cohorts[0].inputs.filter((input) => input.path === file.path);
      assert.equal(captures.length, 1, 'current exact supplier File is not captured');
      assert.equal(captures[0].members.length, 1);
      const member = captures[0].members[0];
      assert.equal(member.path, '');
      assert.equal(member.type, 'file');
      return { size: member.size, sha256: member.sha256 };
    },
  });
  for (const origin of preparation.origins.values()) origin.finalFiles?.assertUnchanged?.();
  return associations;
}
