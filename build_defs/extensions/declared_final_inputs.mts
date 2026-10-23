/** Check actual imported final Files; authentication stays with the original controller. */
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { composeExtensionReleaseDocuments } from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import {
  frozenExtensionMemberInventory,
  frozenExtensionCompatibility,
  frozenExtensionPublicMetadata,
} from '../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import { assertWasixExtensionMemberInstall } from '../../src/extensions/contracts/wasix-extension-install.mts';
import { buildIosCarrierManifest } from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { validateSelectionNeutralSwiftSourceCarrier } from '../../src/native/sdks/swift/tools/swift-native-carrier-contract.mts';
import type {
  ExtensionFinalInput,
  NativeAppleBaseInput,
} from '../../tools/release/native-extension-final-inputs.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';

/** Read the original qualified/completed owner's metadata without rebuilding its carriers. */
export function declaredWasixDependencyManifest(record) {
  const actual = fileIdentity(realpathSync(record.file.path));
  assert.deepEqual(
    { size: actual.size, sha256: actual.sha256 },
    { size: record.file.size, sha256: record.file.sha256 },
    'original WASIX dependency manifest bytes differ',
  );
  const document = JSON.parse(readFileSync(record.file.path, 'utf8'));
  const prefix =
    record.kind === 'public'
      ? 'oliphaunt-extension-release-manifest'
      : record.kind === 'frozen'
        ? 'oliphaunt-extension-ci-artifacts'
        : null;
  assert(
    prefix && [`${prefix}-v1`, `${prefix}-v2`].includes(document.schema),
    'unknown original WASIX dependency manifest schema',
  );
  assert.equal(document.product, record.product);
  assert.equal(document.version, record.version);
  assert.equal(document.releaseProduct ?? document.product, record.owner);
  assert.equal(document.family, 'wasix');
  const compatibility = frozenExtensionCompatibility(document.compatibility, record.product);
  assert.equal(compatibility.wasixRuntimeProduct, record.owner);
  assert.equal(compatibility.wasixRuntimeVersion, record.version);
  const members = document.schema.endsWith('-v2') ? document.extensions : [document];
  assert(
    Array.isArray(members) && members.length > 0,
    'original WASIX dependency manifest lacks members',
  );
  assert.equal(new Set(members.map((member) => member.sqlName)).size, members.length);
  if (record.kind === 'public') {
    const metadata = frozenExtensionPublicMetadata(
      { id: record.product, version: record.version },
      document,
      document,
      members,
    );
    assert.equal(metadata.extensionClass, 'contrib');
  }
  return {
    product: record.product,
    version: record.version,
    members: members.map((member) => ({
      sqlName: member.sqlName,
      wasixInstall: assertWasixExtensionMemberInstall(member, {
        label: `${record.product}/${member.sqlName} original WASIX dependency`,
      }),
    })),
  };
}

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
  assert(
    ['oliphaunt-extension-ci-artifacts-v1', 'oliphaunt-extension-ci-artifacts-v2'].includes(
      frozen.schema,
    ),
    'unknown frozen extension schema',
  );
  const version = frozen.schema.endsWith('-v2') ? 2 : 1;
  const members = version === 2 ? frozen.extensions : [frozen];
  assert(Array.isArray(members) && members.length > 0, 'imported extension document lacks members');
  assert.equal(
    new Set(members.map((member) => member.sqlName)).size,
    members.length,
    'imported extension members repeat',
  );
  assert.equal(manifest.schema, `oliphaunt-extension-release-manifest-v${version}`);
  for (const document of [frozen, manifest]) {
    assert.equal(document.product, input.product);
    assert.equal(document.releaseProduct ?? document.product, input.owner);
    assert.equal(document.version, input.version);
    if (document.family !== undefined)
      assert.equal(
        document.family,
        input.family,
        'selected constructor document belongs to another family',
      );
  }
  assert.deepEqual(members.map((member) => member.sqlName).sort(), [...canonical.sqlNames].sort());
  for (const member of members) frozenExtensionMemberInventory(member);
  const metadata = frozenExtensionPublicMetadata(
    { id: input.product, version: input.version },
    frozen,
    manifest,
    members,
  );
  const assets = version === 2 ? frozen.carrierAssets : members[0].assets;
  assert(
    Array.isArray(assets) && assets.length > 0,
    'imported extension document lacks direct assets',
  );
  const releaseData = composeExtensionReleaseDocuments({
    product: input.product,
    releaseProduct: input.owner,
    family: frozen.family ?? null,
    version: input.version,
    schema: frozen.schema,
    members,
    directAssets: assets,
    releaseMetadata: {
      class: metadata.extensionClass,
      versioning: metadata.versioning,
      sourceIdentity: metadata.sourceIdentity,
      compatibility: metadata.compatibility,
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
  for (const member of members) {
    assert(
      Array.isArray(member.assets) && member.assets.length > 0,
      'imported extension member lacks assets',
    );
    const roles = member.assets.map(
      (asset) => `${asset.family}\0${asset.target}\0${asset.kind}\0${asset.identity ?? ''}`,
    );
    assert.equal(new Set(roles).size, roles.length, 'imported extension member roles repeat');
    for (const asset of member.assets) {
      assert.equal(asset.family, input.family);
      assert(canonical.targets.includes(asset.target), 'imported member target is undeclared');
      // A portable WASIX constructor owns its portable and configured AOT
      // envelopes. Native constructors each own exactly one target cohort.
      if (input.family === 'native') assert.equal(asset.target, input.target);
    }
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
