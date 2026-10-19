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
  type NativeCurrentArtifact,
  type NativeSwiftSourceInput,
  projectNativeAppleBaseInput,
  projectNativeCurrentArtifacts,
  projectNativeExtensionFinalInputs,
  projectNativeSwiftSourceInput,
} from './native-extension-final-inputs.mts';
import { fileIdentity } from './native-file-identity.mts';
import type { prepareNativeReleaseDelivery } from './native-release-preparation.mts';
import { resolveActualCarrier } from './publication-catalog.mts';
import { discoverPublicationArtifacts, validateCargoPayloadPartSets } from './publication-lock.mts';

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
  return collectNativeFinalInputs(preparation, metadata, false);
}

/** Same-source construction imports retain actual configured provenance.
 * PR producers supply construction facts and never reviewed-main assurance. */
export function constructionNativeFinalInputs(
  preparation: NativeFinalInputPreparation,
  metadata: ReleaseMetadata,
) {
  return collectNativeFinalInputs(preparation, metadata, true);
}

/** Physical classification only; collection still requires the authenticated original producer. */
export function isNativeCurrentCargoRoot(
  root: {
    package: {
      product: string;
      ecosystem: string;
      configuration: string;
      name: string;
      outputs: readonly { owner: string }[];
    };
  },
  metadata: ReleaseMetadata,
  extensionConstructors: ReadonlySet<string>,
) {
  const pkg = root.package;
  return (
    pkg.ecosystem === 'cargo' &&
    pkg.configuration !== 'source' &&
    metadata.publicationCarriers.some(
      (row) => row.product === pkg.product && row.ecosystem === 'cargo' && row.name === pkg.name,
    ) &&
    // NAPI embeds the original core/contrib crates while the extension tuple
    // retains its own final installed-consumer inputs from the same constructor.
    (pkg.product === 'liboliphaunt-wasix' ||
      !pkg.outputs.some((output) =>
        extensionConstructors.has(canonicalShippingLabel(output.owner)),
      ))
  );
}

function collectNativeFinalInputs(
  preparation: NativeFinalInputPreparation,
  metadata: ReleaseMetadata,
  currentArtifacts: boolean,
) {
  const inputs: ExtensionFinalInput[] = [];
  const current = new Map<string, NativeCurrentArtifact>();
  const catalog = {
    carriers: metadata.publicationCarriers.map((row) => ({
      ...row,
      id: `${row.ecosystem}:${row.name}`,
      declared: true,
    })),
  };
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
      const frozenRoots = cohort.roots.filter(
        (root) => root.package.role === 'extension-release-frozen-input',
      );
      const extensionConstructors = new Set(
        frozenRoots.flatMap((root) =>
          root.package.outputs.map((output) => canonicalShippingLabel(output.owner)),
        ),
      );
      if (currentArtifacts) {
        for (const root of cohort.roots) {
          const pkg = root.package;
          const cargo = isNativeCurrentCargoRoot(root, metadata, extensionConstructors);
          const github =
            pkg.ecosystem === 'github' &&
            pkg.role === 'github-release-asset' &&
            [
              ...metadata.nativeRuntimeArtifacts,
              ...metadata.nativeHelperArtifacts,
              ...metadata.wasixArtifacts,
            ].some(
              (row) =>
                row.product === pkg.product &&
                typeof row.asset === 'string' &&
                row.asset.replaceAll('{version}', pkg.version) === pkg.name,
            );
          if (!(cargo || github)) continue;
          assert.equal(
            pkg.version,
            metadata.products[pkg.product]?.version,
            'current carrier version differs from source owner',
          );
          const files = records(root);
          const retain = (artifact: string, file: ExtensionFinalInputFile) => {
            const key = `${pkg.product}/${pkg.version}/${artifact}`;
            const row: NativeCurrentArtifact = {
              product: pkg.product,
              version: pkg.version,
              artifact,
              configuration: pkg.configuration,
              source: { ...build.evidence.source },
              file,
            };
            const prior = current.get(key);
            if (prior)
              assert.deepEqual(prior, row, 'current carrier has conflicting original producers');
            else current.set(key, row);
          };
          if (pkg.ecosystem === 'github') {
            const selected = files.filter((file) => path.basename(file.path) === pkg.name);
            assert.equal(
              selected.length,
              1,
              'current GitHub carrier needs its exact original regular File',
            );
            retain(`github-release:${pkg.name}`, selected[0]);
            continue;
          }
          const crates = files.filter((file) => file.path.endsWith('.crate'));
          assert.ok(crates.length, 'current Cargo carrier lacks its original package Files');
          const index = files.filter((file) => path.basename(file.path) === 'packages.json');
          let indexed: Record<string, any>[] | undefined;
          if (files.some((file) => file.member !== undefined)) {
            assert.equal(
              index.length,
              1,
              'current Cargo Tree needs its original package inventory',
            );
            const document = JSON.parse(readFileSync(index[0].path, 'utf8'));
            assert.equal(document.schema, 'oliphaunt-liboliphaunt-cargo-artifacts-v1');
            assert.ok(Array.isArray(document.packages));
            indexed = document.packages;
            assert.deepEqual(
              indexed.map((row) => path.basename(row.cratePath)).sort(),
              crates.map((file) => path.basename(file.path)).sort(),
              'current Cargo Tree differs from its original package inventory',
            );
          }
          const published = [];
          for (const file of crates) {
            const discovered = discoverPublicationArtifacts([file.path]);
            assert.equal(
              discovered.length,
              1,
              'current Cargo File needs exactly one package identity',
            );
            const record = discovered[0];
            assert.equal(record.ecosystem, 'cargo');
            assert.equal(record.version, pkg.version, 'current Cargo package version differs');
            assert.equal(
              path.basename(file.path),
              `${record.name}-${record.version}.crate`,
              'current Cargo package filename differs',
            );
            const carrier = resolveActualCarrier(catalog, 'cargo', record.name);
            assert.equal(carrier.product, pkg.product, 'current Cargo package owner differs');
            if (indexed) {
              const rows = indexed.filter(
                (row) => path.basename(row.cratePath) === path.basename(file.path),
              );
              assert.equal(rows.length, 1);
              assert.equal(rows[0].name, record.name, 'current Cargo inventory name differs');
              assert.equal(
                rows[0].role,
                carrier.role === 'payload-part' ? 'part' : 'aggregator',
                'current Cargo inventory role differs',
              );
            }
            published.push({ ...carrier, packageDependencies: record.dependencies });
            retain(carrier.id, file);
          }
          assert.deepEqual(
            published.filter((row) => row.declared).map((row) => row.name),
            [pkg.name],
            'current Cargo Tree differs from its declared parent identity',
          );
          validateCargoPayloadPartSets(published);
        }
      }
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
  if (current.size)
    projectNativeCurrentArtifacts([...current.values()], [...current.values()][0].source);
  const nativeAppleBase = Object.keys(apple).length ? (apple as NativeAppleBaseInput) : undefined;
  if (nativeAppleBase) projectNativeAppleBaseInput(nativeAppleBase);
  const nativeSwiftSource = Object.keys(swift).length
    ? (swift as NativeSwiftSourceInput)
    : undefined;
  if (nativeSwiftSource) projectNativeSwiftSourceInput(nativeSwiftSource);
  return {
    extensionFinalInputs: inputs,
    ...(currentArtifacts ? { nativeCurrentArtifacts: [...current.values()] } : {}),
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
