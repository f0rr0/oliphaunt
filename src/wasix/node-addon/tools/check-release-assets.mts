#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCargoWorkspaceInheritance } from '../../../../tools/packaging/cargo-manifest.mts';
import { finalizeHelperAssets } from '../../../../tools/packaging/finalize-helper-assets.mts';
import {
  assertWasixNapiCarrierManifest as assertCarrierManifest,
  assertSingleWasixNapiAddonMember,
  assertWasixNapiConstructionData,
  assertWasixNapiPlatformEntries,
  WASIX_NAPI_SOURCE_PATCH_MEMBER,
  wasixNapiReleaseSqlNames,
} from './carrier-contract.mts';
import { workspaceCarrierManifest } from './workspace-runtime-contract.mts';

export {
  assertSingleWasixNapiAddonMember,
  assertWasixNapiPlatformEntries,
} from './carrier-contract.mts';

import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import {
  assertFileExists,
  checksumManifest,
  readArchiveEntries,
  sha256,
} from '../../../../tools/packaging/release-asset-validation.mts';
import {
  assertReleaseNoticesInEntries,
  releaseProfilePackageLicense,
} from '../../../../tools/packaging/release-notices.mts';
import {
  artifactTargets,
  compareText,
  currentProductVersion,
  exactExtensionProducts,
  expectedAssets,
  extensionSqlNames,
  extensionWasixAotMemberSqlNames,
  fail,
  ROOT,
} from '../../../../tools/release/release-artifact-targets.mts';

const PREFIX = 'check-wasix-napi-release-assets.mts';
const PRODUCT = 'oliphaunt-wasix-napi';
const KIND = 'wasix-napi-addon';
const PROFILE = 'wasix-napi-addon';
const BINARY = 'oliphaunt_wasix_napi.node';
const PRODUCT_MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, 'src/wasix/node-addon/package.json'), 'utf8'),
);
const SHA256 = /^[0-9a-f]{64}$/u;

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, 'target/oliphaunt-wasix-napi/release-assets'),
    allowPartial: false,
    npmPackages: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--asset-dir') {
      const value = argv[index + 1];
      if (!value) fail(PREFIX, '--asset-dir requires a value');
      args.assetDir = path.resolve(value);
      index += 1;
    } else if (arg === '--allow-partial') {
      args.allowPartial = true;
    } else if (arg === '--npm-package') {
      const value = argv[index + 1];
      if (!value) fail(PREFIX, '--npm-package requires a value');
      args.npmPackages.push(path.resolve(value));
      index += 1;
    } else {
      fail(PREFIX, `unknown argument ${arg}`);
    }
  }
  return args;
}

function archiveJson(entries, member, label) {
  const entry = entries.get(member);
  if (!entry?.isFile || entry.isSymbolicLink) {
    throw new Error(`${label} is missing regular member ${member}`);
  }
  try {
    return JSON.parse(Buffer.from(entry.data()).toString('utf8'));
  } catch (cause) {
    throw new Error(`${label} member ${member} must contain valid JSON: ${cause.message}`);
  }
}

function entrySha256(entry) {
  return createHash('sha256').update(Buffer.from(entry.data())).digest('hex');
}

function assertSameStrings(actual, expected, label) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (
    actualSorted.length !== new Set(actualSorted).size ||
    JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)
  ) {
    throw new Error(
      `${label} must be exactly ${expectedSorted.join(', ')}; got ${actualSorted.join(', ')}`,
    );
  }
}

function canonicalRepoPath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a canonical repository-relative path`);
  }
  return value;
}

function digestRecord(value, label, { expectedPath, pathPrefix, pathSuffix } = {}) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  const recordPath = canonicalRepoPath(value.path, `${label} path`);
  if (
    (expectedPath !== undefined && recordPath !== expectedPath) ||
    (pathPrefix !== undefined && !recordPath.startsWith(pathPrefix)) ||
    (pathSuffix !== undefined && !recordPath.endsWith(pathSuffix))
  ) {
    throw new Error(`${label} has incompatible path ${recordPath}`);
  }
  if (!SHA256.test(value.sha256 ?? '')) {
    throw new Error(`${label} must record a lowercase SHA-256 digest`);
  }
  return recordPath;
}

function assertBuildInputs(buildInputs, target, label) {
  if (
    buildInputs?.schema !== 'oliphaunt-wasix-napi-build-inputs-v1' ||
    buildInputs.target !== target.target ||
    buildInputs.targetTriple !== target.triple ||
    buildInputs.inputs === null ||
    Array.isArray(buildInputs.inputs) ||
    typeof buildInputs.inputs !== 'object'
  ) {
    throw new Error(`${label} has incompatible embedded build-input provenance`);
  }
  const inputs = buildInputs.inputs;
  digestRecord(inputs.portableManifest, `${label} portable WASIX manifest`, {
    expectedPath: 'target/oliphaunt-wasix/assets/manifest.json',
  });
  if (inputs.runtimeAotManifest?.targetTriple !== target.triple) {
    throw new Error(`${label} runtime AOT manifest must target ${target.triple}`);
  }
  digestRecord(inputs.runtimeAotManifest, `${label} runtime AOT manifest`, {
    expectedPath: `target/oliphaunt-wasix/aot/${target.triple}/manifest.json`,
  });
  if (!Array.isArray(inputs.extensionArtifacts)) {
    throw new Error(`${label} extension artifact inventory must be an array`);
  }
  const expectedProducts = exactExtensionProducts(PREFIX).filter(
    (product) => product === 'oliphaunt-extension-contrib-pg18',
  );
  assertSameStrings(
    inputs.extensionArtifacts.map((row) => row?.product),
    expectedProducts,
    `${label} extension product inventory`,
  );
  for (const extension of inputs.extensionArtifacts) {
    const product = extension.product;
    digestRecord(extension.manifest, `${label} ${product} extension manifest`, {
      pathPrefix: 'target/extension-artifacts/',
      pathSuffix: '/extension-artifacts.json',
    });
    if (!Array.isArray(extension.portableArchives)) {
      throw new Error(`${label} ${product} portable extension inventory must be an array`);
    }
    assertSameStrings(
      extension.portableArchives.map((row) => row?.sqlName),
      extensionSqlNames(product, PREFIX),
      `${label} ${product} portable extension inventory`,
    );
    for (const archive of extension.portableArchives) {
      digestRecord(archive, `${label} ${product}/${archive.sqlName} portable extension`, {
        pathPrefix: 'target/extension-artifacts/',
        pathSuffix: '-wasix-portable.tar.zst',
      });
    }
    if (!Array.isArray(extension.aotManifests)) {
      throw new Error(`${label} ${product} extension AOT inventory must be an array`);
    }
    assertSameStrings(
      extension.aotManifests.map((row) => row?.sqlName),
      extensionWasixAotMemberSqlNames(product, PREFIX),
      `${label} ${product} extension AOT inventory`,
    );
    for (const aot of extension.aotManifests) {
      if (aot?.targetTriple !== target.triple) {
        throw new Error(
          `${label} ${product}/${aot?.sqlName} AOT manifest must target ${target.triple}`,
        );
      }
      digestRecord(aot, `${label} ${product}/${aot.sqlName} AOT manifest`, {
        pathPrefix: 'target/extension-artifacts/',
        pathSuffix: '/manifest.json',
      });
    }
  }
}

export function assertWasixNapiCarrierManifest(
  manifest,
  target,
  version,
  label = 'carrier',
  contract = PRODUCT_MANIFEST.oliphaunt,
) {
  return assertCarrierManifest(manifest, target, version, label, {
    ...PRODUCT_MANIFEST.oliphaunt,
    ...contract,
    packageLicense: releaseProfilePackageLicense(PROFILE).spdx,
  });
}

function assertPayload(entries, { prefix = '', label, target, version, npm = false, contract }) {
  assertReleaseNoticesInEntries(entries, { profile: PROFILE, prefix, label });
  const member = (name) => (prefix ? `${prefix}/${name}` : name);
  const provenance = archiveJson(entries, member('artifact-provenance.json'), label);
  const binaryMember = member(npm ? `prebuilds/${BINARY}` : BINARY);
  const entry = entries.get(binaryMember);
  if (!entry?.isFile || entry.isSymbolicLink || entry.size <= 0) {
    throw new Error(`${label} is missing non-empty regular ${binaryMember}`);
  }
  const actual = entrySha256(entry);
  if (
    provenance.schema === 'oliphaunt-wasix-napi-construction-data-v2' ||
    provenance.schema === 'oliphaunt-wasix-napi-construction-data-v3'
  ) {
    const cargo = Bun.TOML.parse(
      readFileSync(path.join(ROOT, 'src/wasix/node-addon/Cargo.toml'), 'utf8'),
    );
    const workspace = Bun.TOML.parse(readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8'));
    const sdk = resolveCargoWorkspaceInheritance(cargo, workspace.workspace).dependencies[
      'oliphaunt-wasix'
    ];
    const legacy = provenance.schema === 'oliphaunt-wasix-napi-construction-data-v2';
    const patch = legacy
      ? readFileSync(path.join(ROOT, 'build_defs/wasix/held-wasix-relocatable-includes.patch'))
      : undefined;
    const sdkVersion = legacy
      ? (typeof sdk === 'string' ? sdk : sdk.version).replace(/^=/u, '')
      : Bun.TOML.parse(readFileSync(path.join(ROOT, 'src/wasix/sdks/rust/Cargo.toml'), 'utf8'))
          .package.version;
    assertWasixNapiConstructionData(provenance, target.target, actual, {
      targetTriple: target.triple,
      runtimeVersion: (contract ?? PRODUCT_MANIFEST.oliphaunt).runtimeVersion,
      sdkVersion,
      sqlNames: wasixNapiReleaseSqlNames(
        cargo,
        extensionSqlNames('oliphaunt-extension-contrib-pg18', PREFIX),
      ),
      ...(patch
        ? {
            sourcePatch: {
              path: WASIX_NAPI_SOURCE_PATCH_MEMBER,
              sha256: createHash('sha256').update(patch).digest('hex'),
              size: patch.length,
            },
          }
        : {}),
    });
  } else {
    if (
      provenance.schema !== 'oliphaunt-wasix-napi-provenance-v1' ||
      provenance.product !== PRODUCT ||
      provenance.target !== target.target ||
      !/^[0-9a-f]{40}$/u.test(provenance.sourceSha ?? '') ||
      !/^[0-9a-f]{40}$/u.test(provenance.artifactSourceSha ?? '')
    ) {
      throw new Error(`${label} has incompatible WASIX Node-API provenance`);
    }
    if (provenance.sourceSha !== provenance.artifactSourceSha) {
      throw new Error(
        `${label} provenance must bind addon source and embedded artifacts to one commit`,
      );
    }
    const expectedBuild = {
      cargoProfile: 'release',
      incremental: false,
      codegenUnits: 1,
      lto: 'thin',
      strip: 'symbols',
      features: ['release'],
      targetTriple: target.triple,
    };
    if (JSON.stringify(provenance.build) !== JSON.stringify(expectedBuild)) {
      throw new Error(
        `${label} provenance must record the exact optimized addon build: ${JSON.stringify(expectedBuild)}`,
      );
    }
    assertBuildInputs(provenance.buildInputs, target, label);
  }
  if (
    provenance.binary?.filename !== BINARY ||
    provenance.binary?.sha256 !== actual ||
    Object.hasOwn(provenance, 'binaries')
  ) {
    throw new Error(`${label} provenance must bind its sole ${BINARY} subject to ${actual}`);
  }
  if (!npm) return;
  assertSingleWasixNapiAddonMember(entries, binaryMember, label);
  const manifest = archiveJson(entries, member('package.json'), label);
  assertWasixNapiCarrierManifest(manifest, target, version, label, contract);
}

export function assertWasixNapiNpmArchive(file, targets, version, contract) {
  const label = path.basename(file);
  let entries;
  try {
    entries = readPortableArchiveEntries(file);
  } catch (error) {
    throw new Error(`${label} is not a valid portable archive: ${error.message}`);
  }
  const manifest = archiveJson(entries, 'package/package.json', label);
  const target = targets.find((candidate) => candidate.npmPackage === manifest.name);
  if (!target) {
    throw new Error(
      `${label} package name is not a published WASIX Node-API carrier: ${JSON.stringify(manifest.name)}`,
    );
  }
  assertPayload(entries, { prefix: 'package', label, target, version, npm: true, contract });
  assertWasixNapiPlatformEntries(entries, {
    target: target.target,
    label,
    prefix: 'package',
    binaryDirectory: 'prebuilds',
  });
  return manifest;
}

async function validateArchive(file, target, version) {
  const entries = await readArchiveEntries(file, fail, PREFIX, 'WASIX Node-API');
  try {
    assertPayload(entries, { label: path.basename(file), target, version });
  } catch (error) {
    fail(PREFIX, error.message);
  }
  assertWasixNapiPlatformEntries(entries, {
    target: target.target,
    label: path.basename(file),
  });
}

export async function checkWasixNapiReleaseAssets(argv) {
  const workspace = argv.includes('--workspace');
  argv = argv.filter((arg) => arg !== '--workspace');
  const contract = workspace
    ? workspaceCarrierManifest(PRODUCT_MANIFEST, PRODUCT_MANIFEST.oliphaunt).oliphaunt
    : undefined;
  if (argv.includes('--aggregate'))
    argv = await finalizeHelperAssets(PRODUCT, KIND, argv, {
      assetDir:
        process.env.OLIPHAUNT_WASIX_NAPI_ASSET_OUT_DIR ??
        path.join(ROOT, 'target/oliphaunt-wasix-napi/release-assets'),
      npmPackageDir:
        process.env.OLIPHAUNT_WASIX_NAPI_NPM_PACKAGE_OUT_DIR ??
        path.join(ROOT, 'target/oliphaunt-wasix-napi/npm-packages'),
    });
  const args = parseArgs(argv);
  const version = await currentProductVersion(PRODUCT, PREFIX);
  const requiredAssets = expectedAssets(PRODUCT, KIND, version, PREFIX);
  const targets = artifactTargets(PRODUCT, KIND, PREFIX);
  const targetsByAsset = new Map(
    targets.map((target) => [target.asset.replaceAll('{version}', version), target]),
  );
  const missing = [];
  for (const asset of requiredAssets) {
    if (!(await assertFileExists(path.join(args.assetDir, asset)))) missing.push(asset);
  }
  if (missing.length > 0) {
    if (!args.allowPartial) {
      fail(PREFIX, `missing WASIX Node-API release asset(s): ${missing.join(', ')}`);
    }
    let present = 0;
    for (const asset of targetsByAsset.keys()) {
      if (await assertFileExists(path.join(args.assetDir, asset))) present += 1;
    }
    if (present === 0) {
      fail(PREFIX, 'partial WASIX Node-API validation requires at least one addon asset');
    }
  }

  const checksumAsset = `${PRODUCT}-${version}-release-assets.sha256`;
  const checksumPath = path.join(args.assetDir, checksumAsset);
  if (!(await assertFileExists(checksumPath))) {
    fail(PREFIX, `missing checksum manifest: ${checksumAsset}`);
  }
  const checksums = await checksumManifest(checksumPath, fail, PREFIX);
  for (const asset of requiredAssets.sort(compareText)) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) continue;
    if (asset === checksumAsset) continue;
    const expected = checksums.get(asset);
    if (!expected) fail(PREFIX, `${checksumAsset} does not cover ${asset}`);
    const actual = await sha256(assetPath);
    if (actual !== expected) {
      fail(PREFIX, `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
  }
  for (const [asset, target] of targetsByAsset) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) continue;
    await validateArchive(assetPath, target, version);
  }
  for (const npmPackage of args.npmPackages) {
    try {
      assertWasixNapiNpmArchive(npmPackage, targets, version, contract);
    } catch (error) {
      fail(PREFIX, error.message);
    }
  }
  console.log(`WASIX Node-API release assets validated: ${args.assetDir}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  await checkWasixNapiReleaseAssets(Bun.argv.slice(2));
}
