/** Preserve original authenticated constructor Files for the existing owner join. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateReviewedNativeProducerAssurance } from './authenticate-native-build-evidence.mts';
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

export function qualifiedNativeFinalInputs(
  preparation: Pick<
    Awaited<ReturnType<typeof prepareNativeReleaseDelivery>>,
    'observation' | 'origins'
  >,
  metadata: ReleaseMetadata,
) {
  const inputs: ExtensionFinalInput[] = [];
  let nativeAppleBase: NativeAppleBaseInput | undefined;
  const swift: Partial<NativeSwiftSourceInput> = {};
  for (const [evidenceRoot, origin] of preparation.origins) {
    const build = preparation.observation.authenticated.find(
      (value) =>
        value.origin.evidenceDigest === origin.evidenceDigest &&
        value.origin.artifact.id === origin.artifact.id,
    );
    assert.ok(
      build?.producerAssurance && origin.finalFiles,
      'extension imports need the original authenticated reviewed producer',
    );
    validateReviewedNativeProducerAssurance(build.producerAssurance, {
      source: build.evidence.source,
      github: origin.github,
      artifact: origin.artifact,
      evidenceDigest: origin.evidenceDigest,
      requiredTests: build.qualification.requiredTests,
    });
    const finalFiles = origin.finalFiles;
    finalFiles.assertUnchanged?.();
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
      const appleRoots = cohort.roots.filter(
        (root) => root.package.role === 'apple-base-ios-manifest-input',
      );
      const swiftNames = {
        'Oliphaunt-source.zip': 'archive',
        'oliphaunt-react-native-ios-carriers.json': 'carrier',
        'extension-owner-catalog.json': 'ownerCatalog',
      } as const;
      for (const root of cohort.roots) {
        if (
          root.package.product !== 'oliphaunt-swift' ||
          root.package.role !== 'release-input' ||
          !Object.hasOwn(swiftNames, root.package.name)
        )
          continue;
        assert.equal(root.package.ecosystem, 'github');
        assert.equal(root.package.configuration, 'portable');
        assert.equal(
          root.package.version,
          metadata.products['oliphaunt-swift'].version,
          'original Swift source version differs from constructor source',
        );
        const group = swiftNames[root.package.name];
        assert.equal(swift[group], undefined, 'original Swift source File repeats');
        const files = records(root).filter(
          (file) => path.basename(file.path) === root.package.name,
        );
        assert.equal(files.length, 1, 'original Swift source/control needs its exact File');
        swift[group] = files[0];
        swift.owner = 'oliphaunt-swift';
        swift.version = root.package.version;
      }
      for (const root of appleRoots) {
        assert.equal(nativeAppleBase, undefined, 'original Apple base constructor repeats');
        assert.equal(root.package.ecosystem, 'internal');
        assert.equal(root.package.product, 'liboliphaunt-native');
        assert.equal(root.package.version, metadata.products['liboliphaunt-native'].version);
        assert.equal(root.package.configuration, 'ios-xcframework');
        assert.equal(root.package.name, 'ios.json');
        const files = records(root);
        assert.equal(files.length, 1, 'original Apple base manifest requires its one regular File');
        assert.equal(files[0].member, undefined);
        nativeAppleBase = {
          owner: 'liboliphaunt-native',
          version: root.package.version,
          file: files[0],
        };
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
