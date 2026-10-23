/** Check actual imported final Files; authentication stays with the original controller. */
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { composeExtensionReleaseDocuments } from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { buildIosCarrierManifest } from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { validateSelectionNeutralSwiftSourceCarrier } from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import type {
  ExtensionFinalInput,
  NativeAppleBaseInput,
} from '../../tools/release/native-extension-final-inputs.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';

export function validateDeclaredNativeAppleBase(
  input:
    | NativeAppleBaseInput
    | { owner: 'oliphaunt-swift'; version: string; file: NativeAppleBaseInput['file'] },
  version: string,
) {
  if (input.owner === 'liboliphaunt-native') {
    assert.equal(input.version, version);
    assert.equal(path.basename(input.file.path), 'ios.json');
    assert.equal(input.file.producer.root, '//src/native/runtime:apple_ios_manifest_shipping');
    assert.equal(input.file.member, undefined);
  } else {
    assert.equal(input.owner, 'oliphaunt-swift');
    assert.match(input.version, /^\d+\.\d+\.\d+$/u);
    assert.equal(path.basename(input.file.path), 'oliphaunt-react-native-ios-carriers.json');
    assert.equal(
      input.file.producer.root,
      '//src/native/sdks/swift:shipping_oliphaunt-react-native-ios-carriers_json',
    );
    assert.equal(
      input.file.member,
      'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
    );
  }
  const actual = fileIdentity(realpathSync(input.file.path));
  assert.deepEqual(
    { size: actual.size, sha256: actual.sha256 },
    { size: input.file.size, sha256: input.file.sha256 },
    'imported Apple base original File bytes differ',
  );
  const manifest = JSON.parse(readFileSync(input.file.path, 'utf8'));
  validateSelectionNeutralSwiftSourceCarrier(manifest, 'original native Apple base');
  assert.equal(manifest.base.version, version);
  assert.equal(manifest.base.tag, `liboliphaunt-native-v${version}`);
  return input;
}

/** Construct from retained completed-publication Files when no original
 * document exists. The original document, if supplied, must match those bytes. */
export function declaredNativeAppleBaseManifest(
  input,
  version,
  archives = {},
  localCurrent = false,
) {
  if (localCurrent) {
    assert.equal(input.owner, 'liboliphaunt-native');
    assert.equal(input.version, version);
    assert.deepEqual(Object.keys(archives).sort(), ['base-xcframework', 'runtime-resources']);
    archives = Object.fromEntries(
      Object.entries(archives).map(([role, file]) => [
        role,
        { ...fileIdentity(realpathSync(file.path)), path: realpathSync(file.path) },
      ]),
    );
  } else if (input && Object.keys(input).length) validateDeclaredNativeAppleBase(input, version);
  if (Object.keys(archives).length) {
    return buildIosCarrierManifest({
      baseRuntimeVersion: version,
      // The rule supplies declared Files through Bazel's repository aliases.
      // Preserve expected byte identities; resolve only their outer transport.
      baseArchiveInputs: Object.fromEntries(
        Object.entries(archives).map(([role, file]) => [
          role,
          { ...file, path: realpathSync(file.path) },
        ]),
      ),
      baseCarrierManifest: input?.file ? realpathSync(input.file.path) : undefined,
      baseTag: `liboliphaunt-native-v${version}`,
      declaredProducts: {},
      extensionManifests: [],
    });
  }
  assert(input?.owner, `missing original Apple base inputs at declared version ${version}`);
  return JSON.parse(readFileSync(input.file.path, 'utf8'));
}

export function validateDeclaredExtensionFinalInput(
  input: ExtensionFinalInput,
  canonical: {
    owner: string;
    version: string;
    sqlNames: string[];
    sourceIdentity: unknown;
    compatibility: unknown;
    extensionClass: string;
    versioning: string;
    targets: string[];
  },
) {
  assert.equal(input.owner, canonical.owner);
  assert.equal(input.version, canonical.version);
  const files = [...input.github, ...input.npm, ...input.cargo, input.manifest, input.frozen];
  for (const file of files) {
    // Bazel supplies declared repository aliases through its input symlink forest.
    const actual = fileIdentity(realpathSync(file.path));
    assert.deepEqual(
      { size: actual.size, sha256: actual.sha256 },
      { size: file.size, sha256: file.sha256 },
      'imported extension original File bytes differ',
    );
  }
  const frozen = JSON.parse(readFileSync(input.frozen.path, 'utf8'));
  const manifest = JSON.parse(readFileSync(input.manifest.path, 'utf8'));
  const members = frozen.extensions ?? [frozen];
  const version = members.length > 1 ? 2 : 1;
  assert.equal(frozen.schema, `oliphaunt-extension-ci-artifacts-v${version}`);
  assert.equal(manifest.schema, `oliphaunt-extension-release-manifest-v${version}`);
  for (const document of [frozen, manifest]) {
    assert.equal(document.product, input.product);
    assert.equal(document.releaseProduct ?? document.product, input.owner);
    assert.equal(document.version, input.version);
    assert.deepEqual(document.compatibility, canonical.compatibility);
    if (document.family !== undefined)
      assert.equal(
        document.family,
        input.family,
        'selected constructor document belongs to another family',
      );
  }
  assert.deepEqual(manifest.sourceIdentity, canonical.sourceIdentity);
  assert.deepEqual(members.map((member) => member.sqlName).sort(), [...canonical.sqlNames].sort());
  const assets = frozen.carrierAssets ?? members[0].assets;
  const releaseData = composeExtensionReleaseDocuments({
    product: input.product,
    releaseProduct: input.owner,
    family: frozen.family ?? null,
    version: input.version,
    members,
    directAssets: assets,
    releaseMetadata: {
      class: canonical.extensionClass,
      versioning: canonical.versioning,
      sourceIdentity: canonical.sourceIdentity,
      compatibility: canonical.compatibility,
    },
  }).releaseData;
  assert.deepEqual(
    manifest,
    JSON.parse(JSON.stringify(releaseData)),
    'selected public manifest differs from its frozen member/assets contract',
  );
  const github = new Map(input.github.map((file) => [path.basename(file.path), file]));
  assert.equal(github.size, input.github.length, 'imported GH File names repeat');
  assert.deepEqual(
    [...github.keys()].sort(),
    assets.map((asset) => asset.name).sort(),
    'imported GH Files differ from their frozen asset set',
  );
  for (const member of members)
    for (const asset of member.assets) {
      assert.equal(asset.family, input.family);
      assert(canonical.targets.includes(asset.target), 'imported member target is undeclared');
      // A portable WASIX constructor owns its portable and configured AOT
      // envelopes. Native constructors each own exactly one target cohort.
      if (input.family === 'native') assert.equal(asset.target, input.target);
    }
  for (const asset of assets) {
    assert.equal(asset.family, input.family);
    assert(canonical.targets.includes(asset.target), 'imported carrier target is undeclared');
    const file = github.get(asset.name)!;
    assert.equal(asset.sha256, file.sha256);
    assert.equal(asset.bytes, file.size);
  }
  return input;
}

if (import.meta.main) {
  const [specification, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  const { input, archives, canonical, localCurrent } = JSON.parse(
    readFileSync(specification, 'utf8'),
  );
  if (canonical.kind === 'native-apple-base') {
    const manifest = declaredNativeAppleBaseManifest(
      input,
      canonical.version,
      archives,
      localCurrent,
    );
    if (input?.owner && !Object.keys(archives ?? {}).length) copyFileSync(input.file.path, output);
    else writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
  } else
    writeFileSync(output, JSON.stringify(validateDeclaredExtensionFinalInput(input, canonical)));
}
