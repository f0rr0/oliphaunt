/** Canonical controller metadata; it is never a shipping payload or admission. */
import { deepStrictEqual } from 'node:assert';
import { validateReviewedNativeProducerAssurance } from './authenticate-native-build-evidence.mts';
import { canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import { validateNativeSeedConstructions } from './native-build-qualification.mts';
import { validateNativeVersionSourceBridge } from './native-version-source.mts';

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
      ...(Object.hasOwn(value, 'publicationQualification') ? ['publicationQualification'] : []),
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
  if (Object.hasOwn(value, 'publicationQualification'))
    validateNativePublicationQualification(value.publicationQualification, value);
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
        ...(Object.hasOwn(build, 'producerAssurance') ? ['producerAssurance'] : []),
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
    if (Object.hasOwn(build, 'producerAssurance'))
      validateReviewedNativeProducerAssurance(build.producerAssurance, {
        source: value.source,
        github: build.github,
        artifact: build.artifact,
        evidenceDigest: build.evidenceDigest,
        requiredTests: build.requiredTests,
      });
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
    // Earlier construction observations did not retain this projection. Their
    // causal leaves remain unknown; never infer them from generated input names.
    if (Object.hasOwn(observation, 'leafInputPaths')) {
      const paths = observation.leafInputPaths;
      if (
        !Array.isArray(paths) ||
        paths.some(
          (name) =>
            typeof name !== 'string' ||
            name.startsWith('bazel-out/') ||
            !observation.inputs.some((input) => input.path === name),
        )
      )
        throw new Error('native metadata causal leaf is not a captured source input');
      deepStrictEqual(paths, [...new Set(paths)].sort(), 'native metadata causal leaf order');
    }
    if (Object.hasOwn(observation, 'seedConstructions'))
      validateNativeSeedConstructions(
        observation.seedConstructions,
        observation.inputs,
        observation.actions,
      );
    if (
      Object.hasOwn(observation, 'analysisInputPaths') ||
      Object.hasOwn(observation, 'analysisInputs')
    ) {
      if (
        !Array.isArray(observation.analysisInputPaths) ||
        !Array.isArray(observation.analysisInputs)
      )
        throw new Error('native metadata loaded-file mapping is incomplete');
      const paths = observation.analysisInputPaths;
      deepStrictEqual(paths, [...new Set(paths)].sort(), 'native metadata loaded-file path order');
      deepStrictEqual(
        observation.analysisInputs.map((input) => input.path).sort(),
        paths,
        'native metadata loaded-file capture coverage',
      );
      for (const input of observation.analysisInputs) {
        fields(input, ['path', 'members'], 'native metadata loaded-file capture');
        if (
          typeof input.path !== 'string' ||
          input.path.startsWith('/') ||
          input.path.startsWith('bazel-out/') ||
          input.path.startsWith('external/') ||
          /[\\\u0000-\u001f\u007f]/u.test(input.path) ||
          input.path.split('/').some((part) => !part || part === '.' || part === '..') ||
          !Array.isArray(input.members) ||
          input.members.length !== 1
        )
          throw new Error('native metadata loaded input is not a workspace File');
        const member = input.members[0];
        fields(
          member,
          ['path', 'type', 'mode', 'size', 'sha256'],
          'native metadata loaded-file content',
        );
        if (
          member.path !== '' ||
          member.type !== 'file' ||
          !Number.isInteger(member.mode) ||
          member.mode < 0 ||
          member.mode > 0o777 ||
          !Number.isSafeInteger(member.size) ||
          member.size < 0 ||
          !/^[a-f0-9]{64}$/u.test(member.sha256)
        )
          throw new Error('native metadata loaded-file identity differs');
      }
    }
    if (Object.hasOwn(observation, 'qualificationPolicy')) {
      const policy = observation.qualificationPolicy;
      fields(
        policy,
        [
          'owner',
          'configuration',
          'roots',
          'requiredTests',
          ...(Object.hasOwn(policy, 'rootConfigurations') ? ['rootConfigurations'] : []),
          ...(Object.hasOwn(policy, 'policies') ? ['policies'] : []),
        ],
        'native metadata owner policy',
      );
      if (
        typeof policy.owner !== 'string' ||
        !policy.owner.startsWith('//') ||
        !/^[a-f0-9]{64}$/u.test(policy.configuration) ||
        !Array.isArray(policy.roots) ||
        !policy.roots.length ||
        policy.roots.some((label) => typeof label !== 'string' || !label.startsWith('//')) ||
        new Set(policy.roots).size !== policy.roots.length ||
        !Array.isArray(policy.requiredTests)
      )
        throw new Error('native metadata owner policy identity is invalid');
      const build = value.builds.find(
        (build) => build.evidenceDigest === observation.evidenceDigest,
      );
      for (const test of policy.requiredTests) {
        fields(test, ['label', 'configuration'], 'native metadata owner policy test');
        if (
          typeof test.label !== 'string' ||
          !test.label.startsWith('//') ||
          !/^[a-f0-9]{64}$/u.test(test.configuration) ||
          !build?.requiredTests.some(
            (required) =>
              required.label === test.label && required.configuration === test.configuration,
          )
        )
          throw new Error('native metadata owner policy test has no qualified build result');
      }
      if (
        new Set(policy.requiredTests.map((test) => test.label)).size !==
          policy.requiredTests.length ||
        observation.roots.some(
          (root) =>
            !policy.roots.includes(canonicalShippingLabel(root.label)) ||
            !/^[a-f0-9]{64}$/u.test(root.configuration),
        )
      )
        throw new Error('native metadata owner policy differs from configured shipping roots');
      if (Object.hasOwn(policy, 'rootConfigurations')) {
        if (
          !Array.isArray(policy.rootConfigurations) ||
          new Set(policy.rootConfigurations.map((root) => root.label)).size !==
            policy.rootConfigurations.length
        )
          throw new Error('native metadata owner policy configured roots are invalid');
        for (const root of policy.rootConfigurations) {
          fields(root, ['label', 'configuration'], 'native metadata policy configured root');
          if (!policy.roots.includes(root.label) || !/^[a-f0-9]{64}$/u.test(root.configuration))
            throw new Error('native metadata owner policy configured root identity differs');
        }
        deepStrictEqual(
          policy.rootConfigurations.map((root) => root.label).sort(),
          [...policy.roots].sort(),
          'native metadata policy configured root coverage',
        );
        if (
          observation.roots.some(
            (root) =>
              !policy.rootConfigurations.some(
                (configured) =>
                  configured.label === canonicalShippingLabel(root.label) &&
                  configured.configuration === root.configuration,
              ),
          )
        )
          throw new Error('native metadata owner policy has a different configured shipping root');
      }
      if (Object.hasOwn(policy, 'policies')) {
        if (
          !Array.isArray(policy.policies) ||
          !policy.policies.length ||
          new Set(policy.policies.map((owner) => owner.owner)).size !== policy.policies.length
        )
          throw new Error('native metadata source owner policies are invalid');
        for (const owner of policy.policies) {
          fields(owner, ['owner', 'roots', 'requiredTests'], 'native metadata source owner policy');
          if (
            typeof owner.owner !== 'string' ||
            !owner.owner.startsWith('//') ||
            !Array.isArray(owner.roots) ||
            !owner.roots.length ||
            owner.roots.some((root) => !policy.roots.includes(root)) ||
            !Array.isArray(owner.requiredTests)
          )
            throw new Error('native metadata source owner policy identity differs');
          for (const test of owner.requiredTests)
            if (
              !policy.requiredTests.some(
                (required) =>
                  required.label === test.label && required.configuration === test.configuration,
              )
            )
              throw new Error('native metadata source owner policy has a foreign test');
        }
        deepStrictEqual(
          policy.policies.flatMap((owner) => owner.roots).sort(),
          [...policy.roots].sort(),
          'native metadata source owner root coverage',
        );
        deepStrictEqual(
          [
            ...new Set(
              policy.policies.flatMap((owner) =>
                owner.requiredTests.map((test) => JSON.stringify(test)),
              ),
            ),
          ].sort(),
          [...new Set(policy.requiredTests.map((test) => JSON.stringify(test)))].sort(),
          'native metadata source owner test coverage',
        );
      }
    }
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

/** Durable description of the authenticated post-version controller. Parsing
 * this record cannot grant fresh freeze authority or authorize publication. */
export function validateNativePublicationQualification(qualification: any, metadata: any) {
  fields(
    qualification,
    ['source', 'prepare', 'bridge', 'selectedProducts', 'producer', 'inventory'],
    'native publication qualification',
  );
  deepStrictEqual(qualification.source, metadata.source, 'native publication qualification source');
  validateNativeVersionSourceBridge(qualification.bridge);
  const prepare = qualification.prepare;
  fields(
    prepare,
    ['runId', 'runAttempt', 'artifact', 'codeSource', 'preparedSource'],
    'native publication Prepare origin',
  );
  fields(prepare.artifact, ['id', 'name', 'digest', 'size'], 'native publication Prepare artifact');
  deepStrictEqual(
    prepare.codeSource,
    qualification.bridge.source,
    'native publication bridge source',
  );
  fields(prepare.preparedSource, ['commit', 'tree'], 'native publication prepared source');
  if (
    ![prepare.preparedSource.commit, prepare.preparedSource.tree].every((sha) =>
      /^[a-f0-9]{40}$/u.test(sha),
    ) ||
    prepare.preparedSource.tree !== metadata.source.tree ||
    prepare.artifact.name !== 'native-release-inputs' ||
    !/^sha256:[a-f0-9]{64}$/u.test(prepare.artifact.digest)
  )
    throw new Error('native publication Prepare artifact or prepared tree differs');
  const producer = qualification.producer;
  fields(
    producer,
    ['runId', 'runAttempt', 'event', 'ref', 'workflowPath'],
    'native publication producer',
  );
  if (
    !['push', 'workflow_dispatch'].includes(producer.event) ||
    producer.ref !== 'refs/heads/main' ||
    producer.workflowPath !== '.github/workflows/bazel.yml'
  )
    throw new Error('native publication producer is not exact main qualification');
  for (const number of [
    prepare.runId,
    prepare.runAttempt,
    prepare.artifact.id,
    prepare.artifact.size,
    producer.runId,
    producer.runAttempt,
  ])
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new Error('native publication origin requires positive IDs and sizes');
  const inventory = qualification.inventory;
  fields(
    inventory,
    ['products', 'artifactPhase', 'packageEnvelopeDigest'],
    'native publication complete inventory',
  );
  const selection = qualification.selectedProducts;
  for (const ids of [selection, inventory.products]) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(id))
    )
      throw new Error('native publication scope requires canonical product IDs');
    deepStrictEqual(ids, [...new Set(ids)].sort(), 'native publication scope order');
  }
  if (
    !selection.includes(metadata.product.id) ||
    selection.some((id) => !inventory.products.includes(id)) ||
    inventory.artifactPhase !== 'pre-version' ||
    !/^[a-f0-9]{64}$/u.test(inventory.packageEnvelopeDigest)
  )
    throw new Error('native publication selection or complete inventory differs');
  for (const build of metadata.builds)
    if (
      build.github.runId !== producer.runId ||
      !Number.isSafeInteger(build.github.runAttempt) ||
      build.github.runAttempt <= 0 ||
      build.github.runAttempt > producer.runAttempt
    )
      throw new Error('native publication producing run differs from observed builds');
  return qualification;
}
