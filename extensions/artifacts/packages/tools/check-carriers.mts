import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  buildSwiftExtensionCarrierManifest,
  swiftExtensionCarrierAssetName,
} from '../../../../sdks/swift/tools/ios-carrier-manifest.mts';
import {
  portableMemberName,
  readFileOnlyTarGzipEntries,
} from '../../../../tools/packaging/portable-archive.mts';
import {
  archiveTarNames,
  archiveZipNames,
  fail,
  isFile,
  PREFIX,
  readJson,
  readPropertiesText,
  rel,
  sha256File,
} from '../../../../tools/packaging/release-carrier.mts';
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
} from '../../../../tools/packaging/release-notices.mts';
import {
  compareText,
  exactExtensionProducts,
  extensionArtifactProductRoot,
  extensionArtifactTargets,
  extensionMetadata,
  extensionReleaseProduct,
  extensionReleaseVersion,
  extensionSourceIdentity,
  extensionSqlNames,
  ROOT,
} from '../../../../tools/release/release-artifact-targets.mts';
import { assertWasixExtensionMemberInstall } from '../../../contracts/wasix-extension-install.mts';
import {
  assertExtensionUpstreamLicensesInArchive,
  extensionCarrierLegalContract,
} from '../../../tools/extension-upstream-licenses.mts';
import { extensionRuntimeAssetContract } from './extension-runtime-asset-contract.mts';

export const EXTENSION_ROOT = path.resolve(
  ROOT,
  process.env.OLIPHAUNT_EXTENSION_ARTIFACT_ROOT ?? 'target/extension-artifacts',
);

if (path.relative(ROOT, EXTENSION_ROOT).startsWith('..')) {
  throw new Error('extension artifact root must stay inside the repository');
}

const PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS = new Set([
  'schema',
  'product',
  'version',
  'sqlName',
  'extensionClass',
  'versioning',
  'sourceIdentity',
  'compatibility',
  'createsExtension',
  'dependencies',
  'dataFiles',
  'extensionSqlFileNames',
  'extensionSqlFilePrefixes',
  'nativeModuleStem',
  'iosNativeDependencies',
  'iosRegistration',
  'wasixInstall',
  'sharedPreloadLibraries',
  'assets',
]);

const PUBLIC_EXTENSION_BUNDLE_RELEASE_MANIFEST_KEYS = new Set([
  'schema',
  'product',
  'version',
  'extensionClass',
  'versioning',
  'sourceIdentity',
  'compatibility',
  'extensions',
  'assets',
]);

const EXTENSION_BUNDLE_MEMBER_KEYS = new Set([
  'sqlName',
  'createsExtension',
  'dependencies',
  'dataFiles',
  'extensionSqlFileNames',
  'extensionSqlFilePrefixes',
  'nativeModuleStem',
  'iosNativeDependencies',
  'iosRegistration',
  'wasixInstall',
  'sharedPreloadLibraries',
  'assets',
]);

const PUBLIC_EXTENSION_RELEASE_ASSET_KEYS = new Set([
  'name',
  'family',
  'target',
  'kind',
  'identity',
  'sha256',
  'bytes',
]);

const PUBLIC_EXTENSION_RELEASE_ASSET_KEY_ORDER = [
  'name',
  'family',
  'target',
  'kind',
  'identity',
  'sha256',
  'bytes',
];

const PUBLIC_EXTENSION_BUNDLE_MEMBER_ASSET_KEYS = new Set([
  ...PUBLIC_EXTENSION_RELEASE_ASSET_KEY_ORDER,
  'carrierAsset',
  'carrierRoot',
  'memberPath',
]);

const PUBLIC_EXTENSION_BUNDLE_CARRIER_ASSET_KEYS = new Set([
  'name',
  'family',
  'target',
  'kind',
  'sha256',
  'bytes',
  'memberCount',
]);

const INTERNAL_EXTENSION_BUNDLE_ROOT_KEYS = new Set([
  'schema',
  'product',
  'version',
  'compatibility',
  'extensions',
  'carrierAssets',
]);

const INTERNAL_EXTENSION_BUNDLE_MEMBER_ASSET_KEYS = new Set([
  'name',
  'path',
  'source',
  'sha256',
  'bytes',
  'family',
  'kind',
  'target',
  'identity',
  'carrierAsset',
  'carrierRoot',
  'memberPath',
]);

const INTERNAL_EXTENSION_BUNDLE_CARRIER_ASSET_KEYS = new Set([
  'name',
  'path',
  'sha256',
  'bytes',
  'family',
  'target',
  'kind',
  'memberCount',
]);

function bundleTarEntries(file) {
  let archiveEntries;
  try {
    archiveEntries = readFileOnlyTarGzipEntries(file, { fileMode: 0o644 });
  } catch (error) {
    fail(`${rel(file)} is not a consumer-compatible bundle: ${error.message}`);
  }
  const entries = new Map();
  for (const [name, entry] of archiveEntries) {
    entries.set(name, Buffer.from(entry.data()));
  }
  if (entries.size === 0) {
    fail(`${rel(file)} must contain at least one regular file and a canonical tar end marker`);
  }
  return entries;
}

function validateZstdArchiveMagic(file) {
  if (
    !readFileSync(file)
      .subarray(0, 4)
      .equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  ) {
    fail(`${rel(file)} is not a zstd archive`);
  }
}

function validateReleaseArchivePayload(file) {
  if (file.endsWith('.tar.gz') || file.endsWith('.tgz') || file.endsWith('.crate')) {
    if (archiveTarNames(file).length === 0) {
      fail(`${rel(file)} must contain at least one file`);
    }
    return;
  }
  if (file.endsWith('.zip') || file.endsWith('.aar') || file.endsWith('.jar')) {
    if (archiveZipNames(file).length === 0) {
      fail(`${rel(file)} must contain at least one file`);
    }
    return;
  }
  if (file.endsWith('.tar.zst')) {
    validateZstdArchiveMagic(file);
  }
}

function extensionArtifactKindAllowed(family, target, kind) {
  if (family === 'wasix') {
    return target === 'wasix-portable' && kind === 'wasix-runtime';
  }
  if (family !== 'native') {
    return false;
  }
  if (target === 'ios-xcframework') {
    return new Set(['runtime', 'ios-xcframework', 'ios-dependency-xcframework']).has(kind);
  }
  if (target.startsWith('android-')) {
    return kind === 'runtime';
  }
  return kind === 'runtime';
}

function publicExtensionAsset(asset) {
  return extensionRuntimeAssetContract(asset);
}

function requireExactKeys(value, expected, context) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    fail(`${context} must be an object`);
  }
  const actual = new Set(Object.keys(value));
  if (!setEquals(actual, expected)) {
    fail(
      `${context} keys must be ${JSON.stringify([...expected].sort(compareText))}, got ${JSON.stringify([...actual].sort(compareText))}`,
    );
  }
}

function requireSortedUniqueStrings(value, context) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || !item) ||
    new Set(value).size !== value.length ||
    JSON.stringify(value) !== JSON.stringify([...value].sort(compareText))
  ) {
    fail(`${context} must be a sorted unique string list`);
  }
}

function validateMemberWasixInstall(member, context) {
  try {
    assertWasixExtensionMemberInstall(member, { label: context });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function publicExtensionBundleMember(member) {
  return {
    ...Object.fromEntries(Object.entries(member).filter(([key]) => key !== 'assets')),
    assets: member.assets.map(publicExtensionAsset),
  };
}

function publicExtensionBundleCarrier(asset) {
  return extensionRuntimeAssetContract(asset);
}

export function expectedExtensionBundleManifest({ product, version, data, carrier, rows }) {
  const legal = extensionCarrierLegalContract(
    product,
    [...new Set(rows.map(({ member }) => member.sqlName))].sort(compareText),
    { family: carrier.family, target: carrier.target },
  );
  return {
    schema: 'oliphaunt-extension-bundle-v1',
    product,
    version,
    compatibility: data.compatibility,
    family: carrier.family,
    target: carrier.target,
    licenseProfile: legal.profile,
    licenseFiles: legal.licenseFiles,
    members: rows.map(({ member, asset }) => ({
      sqlName: member.sqlName,
      kind: asset.kind,
      identity: asset.identity,
      path: asset.memberPath,
      sha256: asset.sha256,
      bytes: asset.bytes,
    })),
  };
}

function expectedExtensionRoles(member, targets) {
  const roles = [];
  const nativeStem =
    typeof member.nativeModuleStem === 'string' && member.nativeModuleStem
      ? member.nativeModuleStem
      : null;
  for (const target of [...targets].sort(compareText)) {
    if (target === 'wasix-portable') {
      roles.push(`wasix:${target}:wasix-runtime:`);
      continue;
    }
    roles.push(`native:${target}:runtime:`);
    if (target === 'ios-xcframework' && nativeStem !== null) {
      roles.push(`native:${target}:ios-xcframework:${nativeStem}`);
      for (const dependency of member.iosNativeDependencies) {
        roles.push(`native:${target}:ios-dependency-xcframework:${dependency}`);
      }
    }
  }
  return roles.sort(compareText);
}

function validateBundleMemberMetadata(member, manifest, stagedTargets) {
  requireExactKeys(
    member,
    EXTENSION_BUNDLE_MEMBER_KEYS,
    `${rel(manifest)} member ${JSON.stringify(member?.sqlName)}`,
  );
  if (typeof member.sqlName !== 'string' || !member.sqlName) {
    fail(`${rel(manifest)} bundle member must declare sqlName`);
  }
  if (typeof member.createsExtension !== 'boolean') {
    fail(`${rel(manifest)} member ${member.sqlName} createsExtension must be boolean`);
  }
  for (const field of [
    'dependencies',
    'dataFiles',
    'extensionSqlFileNames',
    'extensionSqlFilePrefixes',
    'iosNativeDependencies',
    'sharedPreloadLibraries',
  ]) {
    requireSortedUniqueStrings(member[field], `${rel(manifest)} member ${member.sqlName}.${field}`);
  }
  if (
    !(
      member.nativeModuleStem === null ||
      (typeof member.nativeModuleStem === 'string' && member.nativeModuleStem)
    )
  ) {
    fail(
      `${rel(manifest)} member ${member.sqlName}.nativeModuleStem must be null or a non-empty string`,
    );
  }
  validateMemberWasixInstall(member, `${rel(manifest)} member ${member.sqlName}`);
  const stagesIos = stagedTargets.has('ios-xcframework');
  if (member.nativeModuleStem === null) {
    if (member.iosNativeDependencies.length > 0 || member.iosRegistration !== null) {
      fail(
        `${rel(manifest)} SQL-only member ${member.sqlName} must not declare iOS native metadata`,
      );
    }
  } else if (stagesIos) {
    if (
      member.iosRegistration === null ||
      Array.isArray(member.iosRegistration) ||
      typeof member.iosRegistration !== 'object'
    ) {
      fail(
        `${rel(manifest)} native member ${member.sqlName} must include build-derived iOS registration metadata`,
      );
    }
    if (
      member.iosRegistration.sqlName !== member.sqlName ||
      member.iosRegistration.nativeModuleStem !== member.nativeModuleStem
    ) {
      fail(
        `${rel(manifest)} iOS registration metadata does not match ${member.sqlName}/${member.nativeModuleStem}`,
      );
    }
  } else if (member.iosNativeDependencies.length > 0 || member.iosRegistration !== null) {
    fail(
      `${rel(manifest)} member ${member.sqlName} must not claim iOS metadata without an iOS carrier`,
    );
  }
}

function checkExtensionArtifactInventory(root, expectedPaths) {
  const inventory = path.join(root, 'artifacts.txt');
  if (!isFile(inventory)) {
    fail(`${rel(root)} must contain artifacts.txt`);
  }
  const actual = readFileSync(inventory, 'utf8').split(/\r?\n/u).filter(Boolean);
  if (new Set(actual).size !== actual.length) {
    fail(`${rel(inventory)} must not contain duplicate upload paths`);
  }
  const normalizedExpected = [...new Set(expectedPaths)];
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    fail(
      `${rel(inventory)} must enumerate direct publish artifacts exactly: expected=${JSON.stringify(normalizedExpected)}, actual=${JSON.stringify(actual)}`,
    );
  }
}

async function checkExtensionBundleProduct(
  product,
  root,
  manifest,
  data,
  { family, requireFullTargets },
) {
  const releaseProduct = extensionReleaseProduct(product, family ?? 'native', PREFIX);
  const ownership = releaseProduct === product ? {} : { releaseProduct, family };
  requireExactKeys(
    data,
    new Set([...INTERNAL_EXTENSION_BUNDLE_ROOT_KEYS, ...Object.keys(ownership)]),
    rel(manifest),
  );
  const version = extensionReleaseVersion(product, family ?? 'native', PREFIX);
  if (
    data.product !== product ||
    data.version !== version ||
    Object.entries(ownership).some(([key, value]) => data[key] !== value)
  ) {
    fail(`${rel(manifest)} must describe ${product}@${version}`);
  }
  const releaseMetadata = extensionMetadata(product, PREFIX);
  if (!deepEqual(data.compatibility, releaseMetadata.compatibility)) {
    fail(`${rel(manifest)} has stale compatibility metadata`);
  }
  const expectedSqlNames = extensionSqlNames(product, PREFIX);
  if (!Array.isArray(data.extensions)) {
    fail(`${rel(manifest)} must declare extensions`);
  }
  const actualSqlNames = data.extensions.map((member) => member?.sqlName);
  if (JSON.stringify(actualSqlNames) !== JSON.stringify(expectedSqlNames)) {
    fail(
      `${rel(manifest)} bundle members must exactly match release metadata: expected=${JSON.stringify(expectedSqlNames)}, actual=${JSON.stringify(actualSqlNames)}`,
    );
  }

  const targetRows = extensionArtifactTargets({ product }, PREFIX).filter(
    (row) => family === null || row.family === family,
  );
  const allowedTargetFamilies = new Map();
  for (const row of targetRows) {
    const current = allowedTargetFamilies.get(row.target);
    if (current !== undefined && current !== row.family) {
      fail(`${product} release metadata maps ${row.target} to multiple artifact families`);
    }
    allowedTargetFamilies.set(row.target, row.family);
  }
  const allowedTargets = new Set(allowedTargetFamilies.keys());
  if (!Array.isArray(data.carrierAssets) || data.carrierAssets.length === 0) {
    fail(`${rel(manifest)} must declare at least one aggregate carrier`);
  }
  const carriersByName = new Map();
  const carrierEntries = new Map();
  const carrierLegal = new Map();
  const seenCarrierRoles = new Set();
  const stagedTargets = new Set();
  for (const carrier of data.carrierAssets) {
    requireExactKeys(
      carrier,
      INTERNAL_EXTENSION_BUNDLE_CARRIER_ASSET_KEYS,
      `${rel(manifest)} carrier ${JSON.stringify(carrier?.name)}`,
    );
    const { name, path: pathValue, family, target, kind, sha256, bytes, memberCount } = carrier;
    if (
      ![name, pathValue, family, target, kind, sha256].every(
        (value) => typeof value === 'string' && value,
      )
    ) {
      fail(`${rel(manifest)} contains an incomplete aggregate carrier: ${JSON.stringify(carrier)}`);
    }
    if (kind !== 'extension-bundle' || memberCount !== expectedSqlNames.length) {
      fail(
        `${rel(manifest)} carrier ${name} must be an exact ${expectedSqlNames.length}-member extension-bundle`,
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(sha256) || !Number.isInteger(bytes) || bytes <= 0) {
      fail(`${rel(manifest)} carrier ${name} must declare a positive byte count and SHA-256`);
    }
    if (allowedTargetFamilies.get(target) !== family) {
      fail(`${rel(manifest)} carrier ${name} uses undeclared family/target ${family}/${target}`);
    }
    const role = `${family}:${target}`;
    if (seenCarrierRoles.has(role) || carriersByName.has(name)) {
      fail(`${rel(manifest)} repeats aggregate carrier ${role} or name ${name}`);
    }
    seenCarrierRoles.add(role);
    carriersByName.set(name, carrier);
    stagedTargets.add(target);
    const expectedName = `${product}-${version}-${family}-${target}-bundle.tar.gz`;
    if (name !== expectedName) {
      fail(`${rel(manifest)} carrier ${name} must use canonical name ${expectedName}`);
    }
    const carrierPath = path.join(ROOT, pathValue);
    if (
      path.dirname(carrierPath) !== path.join(root, 'release-assets') ||
      path.basename(carrierPath) !== name
    ) {
      fail(
        `${rel(manifest)} aggregate carrier ${name} must live directly under ${rel(path.join(root, 'release-assets'))}`,
      );
    }
    if (
      !isFile(carrierPath) ||
      statSync(carrierPath).size !== bytes ||
      sha256File(carrierPath) !== sha256
    ) {
      fail(
        `${rel(manifest)} aggregate carrier ${name} is missing or does not match its outer size/digest`,
      );
    }
    const legal = extensionCarrierLegalContract(product, expectedSqlNames, { family, target });
    const carrierRoot = name.replace(/\.tar\.gz$/u, '');
    assertReleaseNoticesInArchive(carrierPath, {
      prefix: carrierRoot,
      profile: legal.profile,
    });
    if (legal.upstreamMembers.length > 0) {
      assertExtensionUpstreamLicensesInArchive(legal.upstreamMembers, carrierPath, {
        prefix: carrierRoot,
      });
    }
    carrierLegal.set(name, legal);
    carrierEntries.set(name, bundleTarEntries(carrierPath));
  }
  if (requireFullTargets) {
    const missing = [...allowedTargets]
      .filter((target) => !stagedTargets.has(target))
      .sort(compareText);
    if (missing.length > 0) {
      fail(`${product} is missing aggregate carriers for declared targets: ${missing.join(', ')}`);
    }
  }

  const allMemberAssets = [];
  for (const member of data.extensions) {
    validateBundleMemberMetadata(member, manifest, stagedTargets);
    if (!Array.isArray(member.assets) || member.assets.length === 0) {
      fail(`${rel(manifest)} member ${member.sqlName} must declare assets`);
    }
    const roles = new Set();
    const memberTargets = new Set();
    for (const asset of member.assets) {
      requireExactKeys(
        asset,
        INTERNAL_EXTENSION_BUNDLE_MEMBER_ASSET_KEYS,
        `${rel(manifest)} member ${member.sqlName} asset ${JSON.stringify(asset?.name)}`,
      );
      const {
        name,
        path: pathValue,
        source,
        family,
        target,
        kind,
        identity,
        sha256,
        bytes,
        carrierAsset,
        carrierRoot,
        memberPath,
      } = asset;
      if (
        ![
          name,
          pathValue,
          source,
          family,
          target,
          kind,
          sha256,
          carrierAsset,
          carrierRoot,
          memberPath,
        ].every((value) => typeof value === 'string' && value)
      ) {
        fail(`${rel(manifest)} member ${member.sqlName} contains an incomplete nested asset`);
      }
      if (!/^[0-9a-f]{64}$/u.test(sha256) || !Number.isInteger(bytes) || bytes <= 0) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} must declare a positive byte count and SHA-256`,
        );
      }
      if (!(identity === null || (typeof identity === 'string' && identity))) {
        fail(`${rel(manifest)} member ${member.sqlName} asset ${name} has invalid identity`);
      }
      if (kind === 'ios-dependency-xcframework' && identity === null) {
        fail(
          `${rel(manifest)} member ${member.sqlName} iOS dependency ${name} must declare identity`,
        );
      }
      if (
        kind !== 'ios-dependency-xcframework' &&
        kind !== 'ios-xcframework' &&
        identity !== null
      ) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} must not declare identity for kind=${kind}`,
        );
      }
      if (
        allowedTargetFamilies.get(target) !== family ||
        !extensionArtifactKindAllowed(family, target, kind)
      ) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} uses invalid family/target/kind ${family}/${target}/${kind}`,
        );
      }
      const role = `${family}:${target}:${kind}:${identity ?? ''}`;
      if (roles.has(role)) {
        fail(`${rel(manifest)} member ${member.sqlName} repeats artifact role ${role}`);
      }
      roles.add(role);
      memberTargets.add(target);
      const carrier = carriersByName.get(carrierAsset);
      if (carrier === undefined || carrier.family !== family || carrier.target !== target) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} references the wrong aggregate carrier ${carrierAsset}`,
        );
      }
      const expectedCarrierRoot = carrierAsset.replace(/\.tar\.gz$/u, '');
      const expectedMemberPath = `extensions/${member.sqlName}/${name}`;
      if (carrierRoot !== expectedCarrierRoot || memberPath !== expectedMemberPath) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} has a noncanonical nested locator`,
        );
      }
      const composedPath = `${carrierRoot}/${memberPath}`;
      if (
        portableMemberName(
          composedPath,
          'file',
          path.join(root, 'release-assets', carrierAsset),
        ) !== composedPath
      ) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} has an unsafe nested locator`,
        );
      }
      const localPath = path.join(ROOT, pathValue);
      const expectedLocalDir = path.join(root, 'member-assets', member.sqlName);
      if (path.dirname(localPath) !== expectedLocalDir || path.basename(localPath) !== name) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} must be staged under ${rel(expectedLocalDir)}`,
        );
      }
      if (
        !isFile(localPath) ||
        statSync(localPath).size !== bytes ||
        sha256File(localPath) !== sha256
      ) {
        fail(
          `${rel(manifest)} member ${member.sqlName} local asset ${name} is missing or does not match its size/digest`,
        );
      }
      // bundleTarEntries also applies this contract to every key in
      // the archive before any nested member is looked up.
      const inner = carrierEntries.get(carrierAsset)?.get(composedPath);
      if (
        inner === undefined ||
        inner.length !== bytes ||
        createHash('sha256').update(inner).digest('hex') !== sha256
      ) {
        fail(
          `${rel(manifest)} member ${member.sqlName} asset ${name} is missing or has wrong bytes inside ${carrierAsset}`,
        );
      }
      allMemberAssets.push({ member, asset });
    }
    if (!setEquals(memberTargets, stagedTargets)) {
      fail(
        `${rel(manifest)} member ${member.sqlName} must be present in every staged aggregate target`,
      );
    }
    const expectedRoles = expectedExtensionRoles(member, stagedTargets);
    const actualRoles = [...roles].sort(compareText);
    if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
      fail(
        `${rel(manifest)} member ${member.sqlName} artifact roles are not dependency-closed: expected=${JSON.stringify(expectedRoles)}, actual=${JSON.stringify(actualRoles)}`,
      );
    }
  }

  for (const carrier of data.carrierAssets) {
    const carrierRoot = carrier.name.replace(/\.tar\.gz$/u, '');
    const rows = allMemberAssets
      .filter(({ asset }) => asset.carrierAsset === carrier.name)
      .sort((left, right) =>
        compareText(
          `${left.member.sqlName}\0${left.asset.kind}\0${left.asset.identity ?? ''}`,
          `${right.member.sqlName}\0${right.asset.kind}\0${right.asset.identity ?? ''}`,
        ),
      );
    const memberNames = [...new Set(rows.map(({ member }) => member.sqlName))].sort(compareText);
    if (JSON.stringify(memberNames) !== JSON.stringify(expectedSqlNames)) {
      fail(`${rel(manifest)} carrier ${carrier.name} does not contain every exact bundle member`);
    }
    const expectedBundleManifest = expectedExtensionBundleManifest({
      product,
      version,
      data,
      carrier,
      rows,
    });
    const entries = carrierEntries.get(carrier.name);
    const manifestName = `${carrierRoot}/bundle-manifest.json`;
    const manifestBytes = entries.get(manifestName);
    if (manifestBytes === undefined) {
      fail(`${carrier.name} is missing ${manifestName}`);
    }
    const expectedManifestBytes = Buffer.from(
      `${JSON.stringify(sortValue(expectedBundleManifest), null, 2)}\n`,
    );
    if (!manifestBytes.equals(expectedManifestBytes)) {
      fail(
        `${carrier.name} bundle-manifest.json must use its exact canonical nested member and legal bytes`,
      );
    }
    let actualBundleManifest;
    try {
      actualBundleManifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
      fail(`${carrier.name} has invalid bundle-manifest.json: ${error.message}`);
    }
    if (!deepEqual(actualBundleManifest, expectedBundleManifest)) {
      fail(
        `${carrier.name} bundle-manifest.json does not exactly describe its nested member bytes`,
      );
    }
    const expectedArchiveNames = [
      manifestName,
      ...rows.map(({ asset }) => `${carrierRoot}/${asset.memberPath}`),
      ...releaseNoticeRows({ profile: carrierLegal.get(carrier.name).profile }).map(
        ({ member }) => `${carrierRoot}/${member}`,
      ),
      ...carrierLegal.get(carrier.name).licenseFiles.map((member) => `${carrierRoot}/${member}`),
    ].sort(compareText);
    const actualArchiveNames = [...entries.keys()].sort(compareText);
    if (JSON.stringify(actualArchiveNames) !== JSON.stringify(expectedArchiveNames)) {
      fail(`${carrier.name} contents do not exactly match its declared members`);
    }
  }

  const releaseManifest = path.join(root, 'release-assets', `${product}-${version}-manifest.json`);
  const releaseData = readJson(releaseManifest);
  requireExactKeys(
    releaseData,
    new Set([...PUBLIC_EXTENSION_BUNDLE_RELEASE_MANIFEST_KEYS, ...Object.keys(ownership)]),
    rel(releaseManifest),
  );
  const expectedReleaseData = {
    schema: 'oliphaunt-extension-release-manifest-v2',
    product,
    ...ownership,
    version,
    extensionClass: releaseMetadata.class,
    versioning: releaseMetadata.versioning,
    sourceIdentity: extensionSourceIdentity(product, PREFIX),
    compatibility: releaseMetadata.compatibility,
    extensions: data.extensions.map(publicExtensionBundleMember),
    assets: data.carrierAssets.map(publicExtensionBundleCarrier),
  };
  if (!deepEqual(releaseData, expectedReleaseData)) {
    fail(`${rel(releaseManifest)} must exactly match stable metadata and nested staged artifacts`);
  }
  for (const member of releaseData.extensions) {
    requireExactKeys(
      member,
      EXTENSION_BUNDLE_MEMBER_KEYS,
      `${rel(releaseManifest)} member ${member?.sqlName}`,
    );
    for (const asset of member.assets) {
      requireExactKeys(
        asset,
        PUBLIC_EXTENSION_BUNDLE_MEMBER_ASSET_KEYS,
        `${rel(releaseManifest)} member ${member.sqlName} asset ${asset?.name}`,
      );
    }
  }
  for (const carrier of releaseData.assets) {
    requireExactKeys(
      carrier,
      PUBLIC_EXTENSION_BUNDLE_CARRIER_ASSET_KEYS,
      `${rel(releaseManifest)} carrier ${carrier?.name}`,
    );
  }

  const stagesIos = stagedTargets.has('ios-xcframework');
  const swiftCarrier = path.join(
    root,
    'release-assets',
    swiftExtensionCarrierAssetName(product, version),
  );
  if (stagesIos) {
    if (!isFile(swiftCarrier)) {
      fail(`${product} must stage independently consumable Swift iOS carrier ${rel(swiftCarrier)}`);
    }
    let expectedCarrier;
    try {
      expectedCarrier = buildSwiftExtensionCarrierManifest({
        extensionManifest: manifest,
        nativeRuntimeVersion: releaseMetadata.compatibility.nativeRuntimeVersion,
      });
    } catch (error) {
      fail(
        `${rel(swiftCarrier)} cannot be derived from exact staged bundle artifacts: ${error.message}`,
      );
    }
    if (!deepEqual(readJson(swiftCarrier), expectedCarrier)) {
      fail(
        `${rel(swiftCarrier)} must exactly describe every bundle member and its compatible native base`,
      );
    }
  } else if (isFile(swiftCarrier)) {
    fail(`${product} must not stage a Swift carrier without an iOS aggregate carrier`);
  }

  const propertiesManifest = path.join(
    root,
    'release-assets',
    `${product}-${version}-manifest.properties`,
  );
  if (!isFile(propertiesManifest)) {
    fail(`${product} must stage properties manifest ${rel(propertiesManifest)}`);
  }
  const expectedProperties = {
    schema: 'oliphaunt-extension-release-manifest-v2',
    product,
    ...(releaseProduct === product ? {} : { releaseProduct, carrierFamily: family }),
    version: String(version),
    extensionClass: String(releaseData.extensionClass),
    versioning: String(releaseData.versioning),
    sourceKind: String(releaseData.sourceIdentity.kind),
    extensions: expectedSqlNames.join(','),
  };
  for (const member of data.extensions) {
    const prefix = `extension.${member.sqlName}`;
    expectedProperties[`${prefix}.createsExtension`] = member.createsExtension ? 'true' : 'false';
    expectedProperties[`${prefix}.dependencies`] = member.dependencies.join(',');
    expectedProperties[`${prefix}.dataFiles`] = member.dataFiles.join(',');
    expectedProperties[`${prefix}.extensionSqlFileNames`] = member.extensionSqlFileNames.join(',');
    expectedProperties[`${prefix}.extensionSqlFilePrefixes`] =
      member.extensionSqlFilePrefixes.join(',');
    expectedProperties[`${prefix}.nativeModuleStem`] = member.nativeModuleStem ?? '';
    expectedProperties[`${prefix}.iosNativeDependencies`] = member.iosNativeDependencies.join(',');
    expectedProperties[`${prefix}.sharedPreloadLibraries`] =
      member.sharedPreloadLibraries.join(',');
    for (const asset of member.assets) {
      const identity = asset.identity === null ? '' : `.${asset.identity}`;
      expectedProperties[
        `asset.${member.sqlName}.${asset.family}.${asset.target}.${asset.kind}${identity}`
      ] = `${asset.carrierAsset}:${asset.memberPath}:${asset.sha256}:${asset.bytes}`;
    }
  }
  for (const carrier of data.carrierAssets) {
    expectedProperties[`carrier.${carrier.family}.${carrier.target}.${carrier.kind}`] =
      carrier.name;
  }
  const actualProperties = readPropertiesText(readFileSync(propertiesManifest, 'utf8'));
  if (!deepEqual(actualProperties, expectedProperties)) {
    fail(
      `${rel(propertiesManifest)} must exactly describe every aggregate carrier and nested member locator`,
    );
  }

  const checksumManifest = path.join(
    root,
    'release-assets',
    `${product}-${version}-release-assets.sha256`,
  );
  if (!isFile(checksumManifest)) {
    fail(`${product} must stage checksum manifest ${rel(checksumManifest)}`);
  }
  validateChecksumManifest(checksumManifest, path.join(root, 'release-assets'));
  checkExtensionArtifactInventory(root, [
    ...data.carrierAssets.map((asset) => asset.path),
    rel(releaseManifest),
    rel(propertiesManifest),
    ...(stagesIos ? [rel(swiftCarrier)] : []),
    rel(checksumManifest),
  ]);
  console.log(
    `validated exact-extension bundle artifacts: ${product} (${expectedSqlNames.length} members, ${data.carrierAssets.length} carriers)`,
  );
  return true;
}

async function checkExtensionProductVariant(
  product,
  root,
  manifest,
  data,
  { family, requireFullTargets },
) {
  if (data.schema === 'oliphaunt-extension-ci-artifacts-v2') {
    return checkExtensionBundleProduct(product, root, manifest, data, {
      family,
      requireFullTargets,
    });
  }
  const releaseProduct = extensionReleaseProduct(product, family ?? 'native', PREFIX);
  const ownership = releaseProduct === product ? {} : { releaseProduct, family };
  const expected = {
    schema: 'oliphaunt-extension-ci-artifacts-v1',
    product,
    ...ownership,
    version: extensionReleaseVersion(product, family ?? 'native', PREFIX),
  };
  const metadata = extensionMetadata(product, PREFIX);
  for (const [key, value] of Object.entries(expected)) {
    if (data[key] !== value) {
      fail(
        `${rel(manifest)} has ${key}=${JSON.stringify(data[key])}, expected ${JSON.stringify(value)}`,
      );
    }
  }
  if (!deepEqual(data.compatibility, metadata.compatibility)) {
    fail(`${rel(manifest)} has stale compatibility metadata`);
  }
  const sqlNames = extensionSqlNames(product, PREFIX);
  if (sqlNames.length !== 1) {
    fail(`${product} singleton artifact manifest requires exactly one SQL name`);
  }
  const [expectedSqlName] = sqlNames;
  if (data.sqlName !== expectedSqlName) {
    fail(
      `${rel(manifest)} has sqlName=${JSON.stringify(data.sqlName)}, expected ${JSON.stringify(expectedSqlName)}`,
    );
  }
  if (typeof data.createsExtension !== 'boolean') {
    fail(`${rel(manifest)}.createsExtension must be boolean`);
  }
  for (const field of [
    'dependencies',
    'dataFiles',
    'extensionSqlFileNames',
    'extensionSqlFilePrefixes',
    'sharedPreloadLibraries',
  ]) {
    requireSortedUniqueStrings(data[field], `${rel(manifest)}.${field}`);
  }
  const assets = data.assets;
  if (!Array.isArray(assets) || assets.length === 0) {
    fail(`${rel(manifest)} must declare at least one asset`);
  }
  const seenNames = new Set();
  const seenRoles = new Set();
  const stagedTargets = new Set();
  const allowedTargets = new Set(
    extensionArtifactTargets({ product }, PREFIX).map((target) => target.target),
  );
  for (const asset of assets) {
    if (asset === null || Array.isArray(asset) || typeof asset !== 'object') {
      fail(`${rel(manifest)} contains a non-object asset entry`);
    }
    const { family, target, kind, identity, name, path: pathValue, sha256, bytes } = asset;
    if (
      ![family, target, kind, name, pathValue, sha256].every(
        (value) => typeof value === 'string' && value,
      )
    ) {
      fail(`${rel(manifest)} contains an incomplete asset entry: ${JSON.stringify(asset)}`);
    }
    if (!Number.isInteger(bytes) || bytes <= 0) {
      fail(`${rel(manifest)} asset ${name} must declare positive bytes`);
    }
    if (seenNames.has(name)) {
      fail(`${rel(manifest)} declares duplicate asset name ${name}`);
    }
    seenNames.add(name);
    if (!(identity === null || (typeof identity === 'string' && identity.length > 0))) {
      fail(`${rel(manifest)} asset ${name} identity must be null or a non-empty string`);
    }
    if (kind === 'ios-dependency-xcframework' && identity === null) {
      fail(`${rel(manifest)} iOS dependency XCFramework ${name} must declare its identity`);
    }
    if (kind !== 'ios-dependency-xcframework' && kind !== 'ios-xcframework' && identity !== null) {
      fail(`${rel(manifest)} asset ${name} must not declare identity for kind=${kind}`);
    }
    const role = `${family}:${target}:${kind}:${identity ?? ''}`;
    if (seenRoles.has(role)) {
      fail(`${rel(manifest)} repeats artifact role ${role}`);
    }
    seenRoles.add(role);
    stagedTargets.add(target);
    if (!allowedTargets.has(target)) {
      fail(`${rel(manifest)} stages undeclared target=${JSON.stringify(target)}`);
    }
    if (!extensionArtifactKindAllowed(family, target, kind)) {
      fail(
        `${rel(manifest)} stages invalid artifact kind=${JSON.stringify(kind)} for family=${JSON.stringify(family)} target=${JSON.stringify(target)}`,
      );
    }
    const assetPath = path.join(ROOT, pathValue);
    if (
      path.dirname(assetPath) !== path.join(root, 'release-assets') ||
      path.basename(assetPath) !== name
    ) {
      fail(
        `${rel(manifest)} asset ${name} must live directly under ${rel(path.join(root, 'release-assets'))}`,
      );
    }
    if (!isFile(assetPath)) {
      fail(`${rel(manifest)} references missing asset ${rel(assetPath)}`);
    }
    if (statSync(assetPath).size !== bytes) {
      fail(`${rel(assetPath)} size does not match ${rel(manifest)}`);
    }
    if (sha256File(assetPath) !== sha256) {
      fail(`${rel(assetPath)} checksum does not match ${rel(manifest)}`);
    }
    validateReleaseArchivePayload(assetPath);
  }
  const nativeStem =
    typeof data.nativeModuleStem === 'string' && data.nativeModuleStem.length > 0
      ? data.nativeModuleStem
      : null;
  const iosDependencies = Array.isArray(data.iosNativeDependencies)
    ? data.iosNativeDependencies
    : fail(`${rel(manifest)} must declare iosNativeDependencies`);
  if (
    iosDependencies.some((value) => typeof value !== 'string' || value.length === 0) ||
    new Set(iosDependencies).size !== iosDependencies.length ||
    JSON.stringify([...iosDependencies].sort(compareText)) !== JSON.stringify(iosDependencies)
  ) {
    fail(`${rel(manifest)} iosNativeDependencies must be a sorted unique string list`);
  }
  const stagesIos = stagedTargets.has('ios-xcframework');
  if (nativeStem === null && (iosDependencies.length > 0 || data.iosRegistration !== null)) {
    fail(
      `${rel(manifest)} SQL-only extension must not fabricate iOS native dependencies or registration`,
    );
  }
  if (nativeStem !== null && stagesIos) {
    if (
      data.iosRegistration === null ||
      typeof data.iosRegistration !== 'object' ||
      Array.isArray(data.iosRegistration)
    ) {
      fail(
        `${rel(manifest)} native extension must include build-derived iOS registration metadata`,
      );
    }
    if (
      data.iosRegistration.sqlName !== data.sqlName ||
      data.iosRegistration.nativeModuleStem !== nativeStem
    ) {
      fail(
        `${rel(manifest)} iOS registration metadata does not match ${data.sqlName}/${nativeStem}`,
      );
    }
  }
  if (!stagesIos && (iosDependencies.length > 0 || data.iosRegistration !== null)) {
    fail(
      `${rel(manifest)} must not claim iOS dependency/registration metadata without staging the iOS target`,
    );
  }
  validateMemberWasixInstall(data, rel(manifest));
  const expectedRoles = [];
  const targetsToCheck = requireFullTargets ? allowedTargets : stagedTargets;
  for (const target of [...targetsToCheck].sort(compareText)) {
    if (target === 'wasix-portable') {
      expectedRoles.push(`wasix:${target}:wasix-runtime:`);
    } else {
      expectedRoles.push(`native:${target}:runtime:`);
      if (target === 'ios-xcframework' && nativeStem !== null) {
        expectedRoles.push(`native:${target}:ios-xcframework:${nativeStem}`);
        for (const dependency of iosDependencies) {
          expectedRoles.push(`native:${target}:ios-dependency-xcframework:${dependency}`);
        }
      }
    }
  }
  const actualRoles = [...seenRoles].sort(compareText);
  expectedRoles.sort(compareText);
  if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
    fail(
      `${rel(manifest)} artifact roles are not dependency-closed: expected=${JSON.stringify(expectedRoles)}, actual=${JSON.stringify(actualRoles)}`,
    );
  }
  const releaseManifest = path.join(
    root,
    'release-assets',
    `${product}-${expected.version}-manifest.json`,
  );
  if (!existsSync(releaseManifest)) {
    fail(`${product} must stage release manifest ${rel(releaseManifest)}`);
  }
  const releaseData = readJson(releaseManifest);
  const expectedRelease = {
    schema: 'oliphaunt-extension-release-manifest-v1',
    product,
    ...ownership,
    version: String(expected.version),
    sqlName: String(expectedSqlName),
    extensionClass: metadata.class,
    versioning: metadata.versioning,
    sourceIdentity: extensionSourceIdentity(product, PREFIX),
    compatibility: metadata.compatibility,
    createsExtension: data.createsExtension,
    dependencies: data.dependencies,
    dataFiles: data.dataFiles,
    extensionSqlFileNames: data.extensionSqlFileNames,
    extensionSqlFilePrefixes: data.extensionSqlFilePrefixes,
    nativeModuleStem: data.nativeModuleStem,
    iosNativeDependencies: data.iosNativeDependencies,
    iosRegistration: data.iosRegistration,
    wasixInstall: data.wasixInstall,
    sharedPreloadLibraries: data.sharedPreloadLibraries,
    assets: assets.map(publicExtensionAsset),
  };
  requireExactKeys(
    releaseData,
    new Set([...PUBLIC_EXTENSION_RELEASE_MANIFEST_KEYS, ...Object.keys(ownership)]),
    rel(releaseManifest),
  );
  if (!deepEqual(releaseData, expectedRelease)) {
    fail(`${rel(releaseManifest)} must exactly match stable metadata and staged artifacts`);
  }
  if (stagesIos) {
    const carrier = path.join(
      root,
      'release-assets',
      swiftExtensionCarrierAssetName(product, expected.version),
    );
    if (!existsSync(carrier)) {
      fail(`${product} must stage independently consumable Swift iOS carrier ${rel(carrier)}`);
    }
    let expectedCarrier;
    try {
      expectedCarrier = buildSwiftExtensionCarrierManifest({
        extensionManifest: manifest,
        nativeRuntimeVersion: metadata.compatibility.nativeRuntimeVersion,
      });
    } catch (error) {
      fail(`${rel(carrier)} cannot be derived from exact staged artifacts: ${error.message}`);
    }
    if (!deepEqual(readJson(carrier), expectedCarrier)) {
      fail(`${rel(carrier)} must exactly describe this extension and its compatible native base`);
    }
  }
  const publicAssets = releaseData.assets;
  for (const asset of publicAssets) {
    if (asset === null || Array.isArray(asset) || typeof asset !== 'object') {
      fail(`${rel(releaseManifest)} contains a non-object public asset row`);
    }
    if (!setEquals(new Set(Object.keys(asset)), PUBLIC_EXTENSION_RELEASE_ASSET_KEYS)) {
      fail(
        `${rel(releaseManifest)} public asset ${JSON.stringify(asset.name)} keys must be ${JSON.stringify([...PUBLIC_EXTENSION_RELEASE_ASSET_KEYS].sort(compareText))}, got ${JSON.stringify(Object.keys(asset).sort(compareText))}`,
      );
    }
  }
  const propertiesManifest = path.join(
    root,
    'release-assets',
    `${product}-${expected.version}-manifest.properties`,
  );
  if (!existsSync(propertiesManifest)) {
    fail(`${product} must stage properties manifest ${rel(propertiesManifest)}`);
  }
  const properties = readPropertiesText(readFileSync(propertiesManifest, 'utf8'));
  const expectedProperties = {
    schema: 'oliphaunt-extension-release-manifest-v1',
    product,
    ...(releaseProduct === product ? {} : { releaseProduct, carrierFamily: family }),
    version: String(expected.version),
    sqlName: String(expectedSqlName),
    extensionClass: String(releaseData.extensionClass),
    versioning: String(releaseData.versioning),
    sourceKind: String(releaseData.sourceIdentity.kind),
    createsExtension: data.createsExtension ? 'true' : 'false',
    dependencies: data.dependencies.join(','),
    dataFiles: data.dataFiles.join(','),
    extensionSqlFileNames: data.extensionSqlFileNames.join(','),
    extensionSqlFilePrefixes: data.extensionSqlFilePrefixes.join(','),
    nativeModuleStem: data.nativeModuleStem ?? '',
    iosNativeDependencies: data.iosNativeDependencies.join(','),
    sharedPreloadLibraries: data.sharedPreloadLibraries.join(','),
  };
  for (const asset of assets) {
    const identity = asset.identity === null ? '' : `.${asset.identity}`;
    expectedProperties[`asset.${asset.family}.${asset.target}.${asset.kind}${identity}`] =
      asset.name;
  }
  if (!deepEqual(properties, expectedProperties)) {
    fail(
      `${rel(propertiesManifest)} must exactly describe stable metadata and every staged asset identity`,
    );
  }
  const checksumManifest = path.join(
    root,
    'release-assets',
    `${product}-${expected.version}-release-assets.sha256`,
  );
  if (!existsSync(checksumManifest)) {
    fail(`${product} must stage checksum manifest ${rel(checksumManifest)}`);
  }
  validateChecksumManifest(checksumManifest, path.join(root, 'release-assets'));
  checkExtensionArtifactInventory(root, [
    ...assets.map((asset) => asset.path),
    rel(releaseManifest),
    rel(propertiesManifest),
    ...(stagesIos
      ? [
          rel(
            path.join(
              root,
              'release-assets',
              swiftExtensionCarrierAssetName(product, expected.version),
            ),
          ),
        ]
      : []),
    rel(checksumManifest),
  ]);
  if (requireFullTargets) {
    const missing = [...allowedTargets]
      .filter((target) => !stagedTargets.has(target))
      .sort(compareText);
    if (missing.length > 0) {
      fail(`${product} is missing published exact-extension targets: ${missing.join(', ')}`);
    }
  }
  console.log(`validated exact-extension package artifacts: ${product}`);
  return true;
}

export async function checkExtensionProduct(product, { family, require, requireFullTargets }) {
  const variants =
    family === null
      ? (() => {
          const nativeRoot = extensionArtifactProductRoot(
            product,
            'native',
            EXTENSION_ROOT,
            PREFIX,
          );
          const wasixRoot = extensionArtifactProductRoot(product, 'wasix', EXTENSION_ROOT, PREFIX);
          return nativeRoot === wasixRoot
            ? [{ family: null, root: nativeRoot }]
            : [
                { family: 'native', root: nativeRoot },
                { family: 'wasix', root: wasixRoot },
              ];
        })()
      : [
          {
            family,
            root: extensionArtifactProductRoot(product, family, EXTENSION_ROOT, PREFIX),
          },
        ];
  let checked = false;
  for (const variant of variants) {
    const manifest = path.join(variant.root, 'extension-artifacts.json');
    if (!existsSync(manifest)) {
      if (require) {
        fail(
          `missing staged exact-extension ${variant.family ?? 'combined'} package manifest for ${product} under ${rel(variant.root)}`,
        );
      }
      continue;
    }
    checked =
      (await checkExtensionProductVariant(product, variant.root, manifest, readJson(manifest), {
        family: variant.family,
        requireFullTargets,
      })) || checked;
  }
  return checked;
}

function setEquals(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function validateChecksumManifest(file, assetDir) {
  const declared = new Map();
  const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/u);
    if (parts.length !== 2) {
      fail(`${rel(file)}:${index + 1} must contain '<sha256> ./<asset>'`);
    }
    const [sha, name] = parts;
    if (!/^[0-9a-f]{64}$/u.test(sha) || !name.startsWith('./') || name.slice(2).includes('/')) {
      fail(`${rel(file)}:${index + 1} contains an invalid checksum entry`);
    }
    const assetName = name.slice(2);
    if (declared.has(assetName)) {
      fail(`${rel(file)} declares duplicate checksum entry for ${assetName}`);
    }
    declared.set(assetName, sha);
  }
  const expectedNames = readdirSync(assetDir)
    .map((name) => path.join(assetDir, name))
    .filter((candidate) => isFile(candidate) && candidate !== file)
    .map((candidate) => path.basename(candidate))
    .sort(compareText);
  if (JSON.stringify([...declared.keys()].sort(compareText)) !== JSON.stringify(expectedNames)) {
    fail(`${rel(file)} must cover release assets exactly`);
  }
  for (const [name, expectedSha] of declared) {
    const actual = sha256File(path.join(assetDir, name));
    if (actual !== expectedSha) {
      fail(`${rel(file)} checksum mismatch for ${name}`);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let family = null;
  const familyIndex = args.indexOf('--family');
  if (familyIndex >= 0) {
    family = args[familyIndex + 1];
    if (!['native', 'wasix'].includes(family)) fail('--family requires native or wasix');
    args.splice(familyIndex, 2);
  }
  const requireFullTargets = args.includes('--require-full-extension-targets');
  const products = args.filter((arg) => arg !== '--require-full-extension-targets');
  const known = new Set(exactExtensionProducts(PREFIX));
  if (
    products.length === 0 ||
    products.some((product) => product !== 'all' && !known.has(product))
  ) {
    fail(
      'usage: check-carriers.mts PRODUCT...|all [--family native|wasix] [--require-full-extension-targets]',
    );
  }
  for (const product of new Set(
    products.flatMap((product) => (product === 'all' ? [...known] : [product])),
  )) {
    await checkExtensionProduct(product, { family, require: true, requireFullTargets });
  }
}
