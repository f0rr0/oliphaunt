/** Preserve original authenticated constructor Files for the existing owner join. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertAuthenticatedNativeBuildOrigin,
  validateReviewedNativeProducerAssurance,
} from './authenticate-native-build-evidence.mts';
import type { ReleaseMetadata } from './bazel-release-metadata.mts';
import { canonicalShippingLabel } from './bazel-shipping-inputs.mts';
import {
  type ExtensionFinalInput,
  type ExtensionFinalInputFile,
  type NativeAppleBaseInput,
  type NativeSwiftSourceInput,
  projectNativeAppleBaseInput,
  projectNativeExtensionFinalInputs,
  projectNativeSwiftSourceInput,
} from './native-extension-final-inputs.mts';
import { fileIdentity } from './native-file-identity.mts';
import type { prepareNativeReleaseDelivery } from './native-release-preparation.mts';

type NativeFinalInputPreparation = {
  observation: Pick<
    Awaited<ReturnType<typeof prepareNativeReleaseDelivery>>['observation'],
    'authenticated'
  >;
  origins: Awaited<ReturnType<typeof prepareNativeReleaseDelivery>>['origins'];
};

/** Reviewed-main qualification remains required by release decisions. */
export function qualifiedNativeFinalInputs(
  preparation: NativeFinalInputPreparation,
  metadata: ReleaseMetadata,
) {
  for (const origin of preparation.origins.values()) {
    const build = preparation.observation.authenticated.find((row) => row.origin === origin);
    assert.ok(
      build?.producerAssurance,
      'extension imports need the original authenticated reviewed producer',
    );
    validateReviewedNativeProducerAssurance(build.producerAssurance, {
      source: build.evidence.source,
      github: origin.github,
      artifact: origin.artifact,
      evidenceDigest: origin.evidenceDigest,
      requiredTests: build.qualification.requiredTests,
    });
  }
  return constructionNativeFinalInputs(preparation, metadata);
}

/** Same-source construction imports retain actual configured provenance.
 * PR producers supply construction facts and never reviewed-main assurance. */
export function constructionNativeFinalInputs(
  preparation: NativeFinalInputPreparation,
  metadata: ReleaseMetadata,
) {
  const inputs: ExtensionFinalInput[] = [];
  const apple: Partial<NativeAppleBaseInput> = {};
  const swift: Partial<NativeSwiftSourceInput> = {};
  for (const [evidenceRoot, origin] of preparation.origins) {
    const build = preparation.observation.authenticated.find(
      (value) =>
        value.origin.evidenceDigest === origin.evidenceDigest &&
        value.origin.artifact.id === origin.artifact.id,
    );
    assertAuthenticatedNativeBuildOrigin(origin);
    assert.ok(
      build && build.origin === origin && origin.finalFiles,
      'extension imports need the actual acquired original producer',
    );
    assert.deepEqual(
      build.evidence,
      origin.evidence,
      'extension import evidence differs from acquired producer',
    );
    assert.deepEqual(
      build.qualification.source,
      build.evidence.source,
      'extension import source differs',
    );
    assert.deepEqual(
      build.qualification.github,
      origin.github,
      'extension import GitHub context differs',
    );
    assert.equal(build.qualification.testQualification, 'passed');
    assert.equal(build.qualification.shippingAnalysis, 'bound');
    assert.equal(build.qualification.qualificationPolicy, 'bound');
    assert.ok(
      build.qualification.requiredTests.length,
      'extension imports require actual configured mandatory tests',
    );
    const finalFiles = origin.finalFiles;
    for (const [cohortIndex, cohort] of build.evidence.cohorts.entries()) {
      const records = (
        root: (typeof cohort.roots)[number],
        producerLabel?: string,
      ): ExtensionFinalInputFile[] => {
        const configuration = cohort.rootConfigurations.filter(
          (value) => value.label === root.label,
        );
        assert.equal(
          configuration.length,
          1,
          'extension File needs its original configured shipping root',
        );
        return root.package.outputs.flatMap((declared) => {
          if (producerLabel)
            assert.equal(
              canonicalShippingLabel(declared.owner),
              producerLabel,
              'extension root mixes different constructors',
            );
          const outputs = cohort.outputs.filter((output) => output.path === declared.path);
          assert.equal(
            outputs.length,
            1,
            'extension declared output is absent from original capture',
          );
          return outputs[0].members
            .filter((member) => member.type === 'file')
            .map((member) => {
              const relative = member.path ? `${declared.path}/${member.path}` : declared.path;
              const captured = finalFiles.files.filter(
                (file) => file.cohort === cohortIndex && file.path === relative,
              );
              assert.equal(
                captured.length,
                1,
                'extension File is absent from retained authenticated transport',
              );
              assert.deepEqual(
                { size: captured[0].size, sha256: captured[0].sha256 },
                { size: member.size, sha256: member.sha256 },
              );
              const source = path.join(evidenceRoot, 'files', String(cohortIndex), relative);
              assert.ok(
                finalFiles.artifactRoots?.filter(
                  (file) => path.resolve(file) === path.resolve(source),
                ).length === 1,
                'extension source File is not the actual retained original transport',
              );
              const identity = fileIdentity(source);
              assert.deepEqual(
                { size: identity.size, sha256: identity.sha256 },
                { size: captured[0].size, sha256: captured[0].sha256 },
                'extension original File changed',
              );
              return {
                path: source,
                size: identity.size,
                sha256: identity.sha256,
                producer: {
                  evidenceDigest: origin.evidenceDigest,
                  invocationId: build.qualification.cohorts[cohortIndex].invocationId,
                  root: canonicalShippingLabel(root.label),
                  configuration: configuration[0].configuration,
                  output: declared.path,
                },
                ...(member.path ? { member: member.path } : {}),
              };
            });
        });
      };
      const nativeVersion = metadata.products['liboliphaunt-native'].version;
      const appleNames = {
        'ios.json': [
          'file',
          'internal',
          'apple-base-ios-manifest-input',
          'ios-xcframework',
          '//src/native/runtime:apple_ios_manifest_shipping',
        ],
        [`liboliphaunt-${nativeVersion}-apple-spm-xcframework.zip`]: [
          'framework',
          'github',
          'github-release-asset',
          'apple-spm-xcframework',
          '//src/native/runtime:apple_swiftpm_shipping',
        ],
        [`liboliphaunt-${nativeVersion}-runtime-resources-ios-datum64.tar.gz`]: [
          'resources',
          'github',
          'github-release-asset',
          'ios-datum64',
          '//src/native/runtime:apple_resources_shipping',
        ],
      } as const;
      const swiftNames = {
        'Oliphaunt-source.zip': 'archive',
        'oliphaunt-react-native-ios-carriers.json': 'carrier',
        'extension-owner-catalog.json': 'ownerCatalog',
        [`oliphaunt-swift-${metadata.products['oliphaunt-swift'].version}-bindings.xcframework.zip`]:
          'bindingsArchive',
      } as const;
      for (const root of cohort.roots) {
        if (
          root.package.product !== 'oliphaunt-swift' ||
          !Object.hasOwn(swiftNames, root.package.name)
        )
          continue;
        assert.equal(root.package.ecosystem, 'github');
        const group = swiftNames[root.package.name];
        assert.equal(
          root.package.role,
          group === 'bindingsArchive' ? 'github-release-asset' : 'release-input',
        );
        assert.equal(
          root.package.configuration,
          group === 'bindingsArchive' ? 'apple-xcframework' : 'portable',
        );
        assert.equal(
          root.package.version,
          metadata.products['oliphaunt-swift'].version,
          'original Swift source version differs from constructor source',
        );
        assert.equal(swift[group], undefined, 'original Swift source File repeats');
        const files = records(root).filter(
          (file) => path.basename(file.path) === root.package.name,
        );
        assert.equal(files.length, 1, 'original Swift source/control needs its exact File');
        swift[group] = files[0];
        swift.owner = 'oliphaunt-swift';
        swift.version = root.package.version;
      }
      for (const root of cohort.roots) {
        if (
          root.package.product !== 'liboliphaunt-native' ||
          !Object.hasOwn(appleNames, root.package.name)
        )
          continue;
        const [group, ecosystem, role, configuration, label] = appleNames[root.package.name];
        assert.equal(apple[group], undefined, 'original Apple constructor File repeats');
        assert.equal(root.package.ecosystem, ecosystem);
        assert.equal(root.package.role, role);
        assert.equal(root.package.version, nativeVersion);
        assert.equal(root.package.configuration, configuration);
        assert.equal(canonicalShippingLabel(root.label), label);
        const files = records(root);
        assert.equal(files.length, 1, 'original Apple base manifest requires its one regular File');
        assert.equal(files[0].member, undefined);
        apple[group] = files[0];
        apple.owner = 'liboliphaunt-native';
        apple.version = root.package.version;
      }
      const frozenRoots = cohort.roots.filter(
        (root) => root.package.role === 'extension-release-frozen-input',
      );
      for (const frozenRoot of frozenRoots) {
        assert.equal(
          frozenRoot.package.outputs.length,
          1,
          'extension constructor needs one frozen document',
        );
        const producerLabel = canonicalShippingLabel(frozenRoot.package.outputs[0].owner);
        const frozen = records(frozenRoot, producerLabel);
        assert.equal(frozen.length, 1);
        const document = JSON.parse(readFileSync(frozen[0].path, 'utf8'));
        const members = document.extensions ?? [document];
        const families = new Set(
          members.flatMap((member) => member.assets.map((asset) => asset.family)),
        );
        assert.equal(families.size, 1, 'selected constructor cannot invent another owner family');
        const family = [...families][0] as 'native' | 'wasix';
        assert.ok(['native', 'wasix'].includes(family));
        const canonical = metadata.extensionReleaseMetadata.filter(
          (row) => row.artifactProduct === document.product,
        );
        assert.ok(
          canonical.length > 0,
          'extension frozen document names an undeclared distribution',
        );
        const compatibility = canonical[0].compatibility as Record<string, string>;
        const owner =
          canonical[0].class === 'contrib'
            ? compatibility[family === 'native' ? 'nativeRuntimeProduct' : 'wasixRuntimeProduct']
            : (canonical[0].product as string);
        assert.equal(
          frozenRoot.package.product,
          owner,
          'extension frozen document belongs to another conventional owner',
        );
        assert.equal(document.version, frozenRoot.package.version);
        assert.equal(metadata.products[owner]?.version, document.version);
        assert.deepEqual(
          members.map((member) => member.sqlName).sort(),
          canonical.map((row) => row.sqlName).sort(),
          'extension constructor omits or substitutes canonical members',
        );
        const siblings = cohort.roots.filter(
          (root) =>
            root.package.product === owner &&
            root.package.version === document.version &&
            root.package.outputs.some(
              (output) => canonicalShippingLabel(output.owner) === producerLabel,
            ),
        );
        const group = (name: string) => {
          const files = siblings
            .filter((root) => root.package.ecosystem === name)
            .flatMap((root) => {
              const output = records(root, producerLabel);
              if (name !== 'github') return output;
              // A mobile Tree may back several declared GitHub identities. Each
              // leaf keeps the root that actually declares its own public name.
              const selected = output.filter(
                (file) => path.basename(file.path) === root.package.name,
              );
              assert.equal(
                selected.length,
                1,
                'GitHub identity needs its actual original regular archive File',
              );
              return selected;
            });
          const unique = new Map<string, ExtensionFinalInputFile>();
          for (const file of files) {
            const prior = unique.get(file.path);
            if (prior)
              assert.deepEqual(
                { size: prior.size, sha256: prior.sha256 },
                { size: file.size, sha256: file.sha256 },
              );
            else unique.set(file.path, file);
          }
          return [...unique.values()];
        };
        const manifests = siblings
          .filter((root) => root.package.role === 'extension-release-manifest-input')
          .flatMap((root) => records(root, producerLabel));
        assert.equal(
          manifests.length,
          1,
          'extension constructor needs its original selected-target public manifest',
        );
        inputs.push({
          product: document.product,
          owner,
          version: document.version,
          family,
          target: frozenRoot.package.configuration,
          github: group('github'),
          npm: group('npm'),
          cargo: group('cargo'),
          manifest: manifests[0],
          frozen: frozen[0],
        });
      }
    }
    finalFiles.assertUnchanged?.();
  }
  projectNativeExtensionFinalInputs(inputs);
  const nativeAppleBase = Object.keys(apple).length ? (apple as NativeAppleBaseInput) : undefined;
  if (nativeAppleBase) projectNativeAppleBaseInput(nativeAppleBase);
  const nativeSwiftSource = Object.keys(swift).length
    ? (swift as NativeSwiftSourceInput)
    : undefined;
  if (nativeSwiftSource) projectNativeSwiftSourceInput(nativeSwiftSource);
  return {
    extensionFinalInputs: inputs,
    ...(nativeAppleBase ? { nativeAppleBase } : {}),
    ...(nativeSwiftSource ? { nativeSwiftSource } : {}),
  };
}

export function qualifiedNativeExtensionFinalInputs(
  preparation: Parameters<typeof qualifiedNativeFinalInputs>[0],
  metadata: ReleaseMetadata,
) {
  return qualifiedNativeFinalInputs(preparation, metadata).extensionFinalInputs;
}
