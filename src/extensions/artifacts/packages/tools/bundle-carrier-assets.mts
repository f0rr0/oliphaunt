/** Canonical contrib bundle archive assembly shared by declared producers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createDeterministicTar } from '../../../../../tools/packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../../../../tools/packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  stageReleaseNotices,
} from '../../../../../tools/packaging/release-notices.mts';
import {
  assertExtensionUpstreamLicensesInArchive,
  extensionCarrierLegalContract,
  stageExtensionUpstreamLicenses,
} from '../../../tools/extension-upstream-licenses.mts';

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, sortValue(value[key])]),
    );
  return value;
}

export function bundleCarrierAssets(
  product,
  version,
  productRoot,
  members,
  compatibility,
  {
    root,
    fail = (message: string): never => {
      throw new Error(message);
    },
  },
) {
  const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');
  assert.equal(
    new Set(members.map((member) => member.sqlName)).size,
    members.length,
    'bundle members must be unique',
  );
  const assetDir = path.join(productRoot, 'release-assets');
  const stageRoot = path.join(productRoot, '.bundle-stage');
  const groups = new Map();
  for (const member of members) {
    for (const asset of member.assets) {
      const key = `${asset.family}\0${asset.target}`;
      const group = groups.get(key) ?? { family: asset.family, target: asset.target, rows: [] };
      group.rows.push({ sqlName: member.sqlName, asset });
      groups.set(key, group);
    }
  }
  const carrierAssets = [];
  for (const group of [...groups.values()].sort((left, right) =>
    compareText(`${left.family}\0${left.target}`, `${right.family}\0${right.target}`),
  )) {
    const memberNames = [...new Set(group.rows.map((row) => row.sqlName))].sort(compareText);
    const expectedNames = members.map((member) => member.sqlName).sort(compareText);
    if (JSON.stringify(memberNames) !== JSON.stringify(expectedNames)) {
      fail(
        `${product} ${group.family}/${group.target} bundle is missing exact members: expected ${expectedNames.join(',')}, got ${memberNames.join(',')}`,
      );
    }
    const archiveRoot = `${product}-${version}-${group.family}-${group.target}-bundle`;
    const stageDir = path.join(stageRoot, archiveRoot);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true });
    const manifestMembers = [];
    for (const row of group.rows.sort((left, right) =>
      compareText(
        `${left.sqlName}\0${left.asset.kind}\0${left.asset.identity ?? ''}`,
        `${right.sqlName}\0${right.asset.kind}\0${right.asset.identity ?? ''}`,
      ),
    )) {
      const memberPath = `extensions/${row.sqlName}/${row.asset.name}`;
      const source = path.resolve(root, row.asset.path);
      assert(
        !path.relative(root, source).startsWith('..') &&
          !path.isAbsolute(path.relative(root, source)),
        'bundle member must be a declared root-relative file',
      );
      assert(
        !memberPath
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || part.includes('\\\\')),
        'bundle member path must be safe',
      );
      const destination = path.join(stageDir, ...memberPath.split('/'));
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, 0o644);
      const copiedSha256 = sha256(destination);
      const copiedBytes = statSync(destination).size;
      if (copiedSha256 !== row.asset.sha256 || copiedBytes !== row.asset.bytes) {
        fail(
          `${product} ${group.family}/${group.target} changed ${row.sqlName} member bytes while staging ${memberPath}`,
        );
      }
      const member = {
        sqlName: row.sqlName,
        kind: row.asset.kind,
        identity: row.asset.identity ?? null,
        path: memberPath,
        sha256: row.asset.sha256,
        bytes: row.asset.bytes,
      };
      manifestMembers.push(member);
      row.asset.carrierAsset = `${archiveRoot}.tar.gz`;
      row.asset.carrierRoot = archiveRoot;
      row.asset.memberPath = memberPath;
    }
    const externalLicenseFiles = [];
    for (const sqlName of memberNames) {
      externalLicenseFiles.push(...stageExtensionUpstreamLicenses(sqlName, stageDir));
    }
    const legal = extensionCarrierLegalContract(product, memberNames, {
      family: group.family,
      target: group.target,
      memberContracts: members,
    });
    const stagedLicenseFiles = [...new Set(externalLicenseFiles)].sort(compareText);
    if (JSON.stringify(stagedLicenseFiles) !== JSON.stringify(legal.licenseFiles)) {
      fail(
        `${product} ${group.family}/${group.target} staged upstream licenses differ from its legal contract: ` +
          `expected ${legal.licenseFiles.join(',')}, got ${stagedLicenseFiles.join(',')}`,
      );
    }
    const bundleManifest = path.join(stageDir, 'bundle-manifest.json');
    writeFileSync(
      bundleManifest,
      `${JSON.stringify(
        sortValue({
          schema: 'oliphaunt-extension-bundle-v1',
          product,
          version,
          compatibility,
          family: group.family,
          target: group.target,
          licenseProfile: legal.profile,
          licenseFiles: legal.licenseFiles,
          members: manifestMembers,
        }),
        null,
        2,
      )}\n`,
      'utf8',
    );
    chmodSync(bundleManifest, 0o644);
    stageReleaseNotices(stageDir, { profile: legal.profile });
    const output = path.join(assetDir, `${archiveRoot}.tar.gz`);
    writeFileSync(
      output,
      canonicalGzipSync(
        createDeterministicTar(stageDir, archiveRoot, {
          fail,
          includeDirectories: false,
          // Every bundle member is data. Windows filesystem modes are synthetic,
          // so encode the portable carrier contract instead of copying stat bits.
          fixedFileMode: 0o644,
        }),
      ),
    );
    assertReleaseNoticesInArchive(output, {
      prefix: archiveRoot,
      profile: legal.profile,
    });
    if (legal.upstreamMembers.length > 0) {
      assertExtensionUpstreamLicensesInArchive(legal.upstreamMembers, output, {
        prefix: archiveRoot,
      });
    }
    carrierAssets.push({
      name: path.basename(output),
      path: rel(output),
      sha256: sha256(output),
      bytes: statSync(output).size,
      family: group.family,
      target: group.target,
      kind: 'extension-bundle',
      memberCount: memberNames.length,
    });
  }
  rmSync(stageRoot, { recursive: true, force: true });
  return carrierAssets;
}
