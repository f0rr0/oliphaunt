#!/usr/bin/env bun
import {
  RUST_PAYLOAD_LICENSE,
  assertRustDependencyLicensesInEntries,
} from './dependency-license-contract.mts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeHelperAssets } from '../../../../tools/packaging/finalize-helper-assets.mts';
import { inspectPlatformBinaryEntries } from '../../../../tools/packaging/platform-binary-contract.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import {
  assertFileExists,
  checksumManifest,
  readArchiveEntries,
  sha256,
} from '../../../../tools/packaging/release-asset-validation.mts';
import { assertReleaseNoticesInEntries } from '../../../../tools/packaging/release-notices.mts';
import {
  artifactTargets,
  compareText,
  currentProductVersion,
  expectedAssets,
  fail,
  ROOT,
} from '../../../../tools/release/release-artifact-targets.mts';

const PREFIX = 'check-node-direct-release-assets.mts';
const PRODUCT = 'oliphaunt-node-direct';
const KIND = 'node-direct-addon';
const NOTICE_OPTIONS = Object.freeze({ profile: 'source-sdk' });
const NOTICE_MEMBERS = Object.freeze(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_LICENSES']);
const PACKAGE_LICENSE = RUST_PAYLOAD_LICENSE;

function parseArgs(argv) {
  const args = {
    assetDir: path.join(ROOT, 'target/oliphaunt-node-direct/release-assets'),
    allowPartial: false,
    npmPackages: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--asset-dir') {
      const value = argv[index + 1];
      if (!value) {
        fail(PREFIX, '--asset-dir requires a value');
      }
      args.assetDir = path.resolve(value);
      index += 1;
    } else if (arg === '--allow-partial') {
      args.allowPartial = true;
    } else if (arg === '--npm-package') {
      const value = argv[index + 1];
      if (!value) {
        fail(PREFIX, '--npm-package requires a value');
      }
      args.npmPackages.push(path.resolve(value));
      index += 1;
    } else {
      fail(PREFIX, `unknown argument ${arg}`);
    }
  }
  return args;
}

export function assertNodeDirectReleaseNoticeEntries(
  entries,
  { prefix = '', label = 'Node direct archive' } = {},
) {
  const rustRoot = `${prefix ? prefix + '/' : ''}THIRD_PARTY_LICENSES/rust`;
  const sourceEntries = new Map(
    [...entries].filter(([name]) => name !== rustRoot && !name.startsWith(rustRoot + '/')),
  );
  return assertReleaseNoticesInEntries(sourceEntries, {
    ...NOTICE_OPTIONS,
    prefix,
    label,
  });
}

function archiveJson(entries, member, label) {
  const entry = entries.get(member);
  if (!entry?.isFile || entry.isSymbolicLink) {
    throw new Error(`${label} is missing regular member ${member}`);
  }
  if ((entry.mode & 0o444) !== 0o444 || (entry.mode & 0o7000) !== 0) {
    throw new Error(
      `${label} member ${member} must be readable by all users without special permission bits`,
    );
  }
  try {
    return JSON.parse(Buffer.from(entry.data()).toString('utf8'));
  } catch (cause) {
    throw new Error(`${label} member ${member} must contain valid JSON: ${cause.message}`);
  }
}

export function assertNodeDirectNpmArchive(file, targets, version) {
  const label = path.basename(file);
  const entries = readArchiveEntriesForNotices(file, label);
  assertNodeDirectReleaseNoticeEntries(entries, { prefix: 'package', label });
  const manifest = archiveJson(entries, 'package/package.json', label);
  const target = targets.find((candidate) => candidate.npmPackage === manifest.name);
  if (!target) {
    throw new Error(
      `${label} package name is not a published Node direct carrier: ${JSON.stringify(manifest.name)}`,
    );
  }
  assertRustDependencyLicensesInEntries(entries, {
    target: target.target,
    prefix: 'package',
    label,
  });
  if (manifest.version !== version) {
    throw new Error(
      `${label} package version must be ${version}, got ${JSON.stringify(manifest.version)}`,
    );
  }
  if (manifest.license !== PACKAGE_LICENSE) {
    throw new Error(
      `${label} package license must be ${PACKAGE_LICENSE}, got ${JSON.stringify(manifest.license)}`,
    );
  }
  if (manifest.oliphaunt?.target !== target.target) {
    throw new Error(
      `${label} package target must be ${target.target}, got ${JSON.stringify(manifest.oliphaunt?.target)}`,
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${label} package.json must declare an npm files allowlist`);
  }
  if (
    manifest.files.some((member) => typeof member !== 'string' || member.length === 0) ||
    new Set(manifest.files).size !== manifest.files.length
  ) {
    throw new Error(
      `${label} package.json npm files allowlist must contain unique non-empty strings`,
    );
  }
  for (const member of NOTICE_MEMBERS) {
    if (!manifest.files.includes(member)) {
      throw new Error(`${label} package.json npm files allowlist must include ${member}`);
    }
  }
  const prebuild = entries.get('package/prebuilds/oliphaunt_node.node');
  if (!prebuild?.isFile || prebuild.isSymbolicLink || prebuild.size === 0) {
    throw new Error(
      `${label} is missing a non-empty regular package/prebuilds/oliphaunt_node.node`,
    );
  }
  if (target.target === 'windows-x64-msvc') {
    inspectPlatformBinaryEntries(
      [...entries].map(([name, entry]) => ({ name, ...entry })),
      { target: target.target, rootLabel: label },
    );
  }
  return manifest;
}

function readArchiveEntriesForNotices(file, label) {
  try {
    return readPortableArchiveEntries(file);
  } catch (error) {
    throw new Error(`${label} is not a valid portable archive: ${error.message}`);
  }
}

async function validateArchive(file, target) {
  const entries = await readArchiveEntries(file, fail, PREFIX, 'Node direct');
  try {
    assertNodeDirectReleaseNoticeEntries(entries, { label: path.basename(file) });
    assertRustDependencyLicensesInEntries(entries, {
      target: target.target,
      label: path.basename(file),
    });
  } catch (error) {
    fail(PREFIX, error.message);
  }
  const memberName = target.libraryRelativePath;
  if (!entries.has(memberName)) {
    fail(PREFIX, `${path.basename(file)} is missing ${memberName}`);
  }
  const member = entries.get(memberName);
  if (!member.isFile) {
    fail(PREFIX, `${path.basename(file)} ${memberName} is not a regular file`);
  }
  if (member.size === 0) {
    fail(PREFIX, `${path.basename(file)} ${memberName} is empty`);
  }
  inspectPlatformBinaryEntries(
    [...entries].map(([name, entry]) => ({ name, ...entry })),
    { target: target.target, rootLabel: path.basename(file) },
  );
}

export async function checkNodeDirectReleaseAssets(argv) {
  if (argv.includes('--aggregate'))
    argv = await finalizeHelperAssets(PRODUCT, KIND, argv, {
      assetDir:
        process.env.OLIPHAUNT_NODE_ADDON_ASSET_OUT_DIR ??
        path.join(ROOT, 'target/oliphaunt-node-direct/release-assets'),
      npmPackageDir:
        process.env.OLIPHAUNT_NODE_ADDON_NPM_PACKAGE_OUT_DIR ??
        path.join(ROOT, 'target/oliphaunt-node-direct/npm-packages'),
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
    if (!(await assertFileExists(path.join(args.assetDir, asset)))) {
      missing.push(asset);
    }
  }
  if (missing.length > 0) {
    if (!args.allowPartial) {
      fail(PREFIX, `missing oliphaunt-node-direct release asset(s): ${missing.join(', ')}`);
    }
    let presentAddons = 0;
    for (const target of targets) {
      if (
        await assertFileExists(
          path.join(args.assetDir, target.asset.replaceAll('{version}', version)),
        )
      ) {
        presentAddons += 1;
      }
    }
    if (presentAddons === 0) {
      fail(
        PREFIX,
        'partial oliphaunt-node-direct release asset validation requires at least one addon asset',
      );
    }
  }

  const checksumAsset = `oliphaunt-node-direct-${version}-release-assets.sha256`;
  const checksumPath = path.join(args.assetDir, checksumAsset);
  if (!(await assertFileExists(checksumPath))) {
    fail(PREFIX, `missing checksum manifest: ${checksumAsset}`);
  }
  const checksums = await checksumManifest(checksumPath, fail, PREFIX);
  for (const asset of requiredAssets.sort(compareText)) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) {
      continue;
    }
    if (asset === checksumAsset) {
      continue;
    }
    const expected = checksums.get(asset);
    if (!expected) {
      fail(PREFIX, `${checksumAsset} does not cover ${asset}`);
    }
    const actual = await sha256(assetPath);
    if (actual !== expected) {
      fail(PREFIX, `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
    }
  }
  for (const [asset, target] of targetsByAsset) {
    const assetPath = path.join(args.assetDir, asset);
    if (args.allowPartial && !(await assertFileExists(assetPath))) {
      continue;
    }
    await validateArchive(assetPath, target);
  }
  for (const npmPackage of args.npmPackages) {
    try {
      assertNodeDirectNpmArchive(npmPackage, targets, version);
    } catch (error) {
      fail(PREFIX, error.message);
    }
  }
  console.log(`oliphaunt-node-direct release assets validated: ${args.assetDir}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  await checkNodeDirectReleaseAssets(Bun.argv.slice(2));
}
