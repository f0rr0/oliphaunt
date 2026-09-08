#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createDeterministicTar } from '../../../../shared/artifact-packaging/cargo-source-package.mts';
import { validateNpmTrustedPublishingManifest } from '../../../../shared/artifact-packaging/npm-trusted-publishing.mts';
import {
  archiveLogicalTreeRows,
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../../../shared/artifact-packaging/portable-archive.mts';
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from '../../../../shared/artifact-packaging/release-notices.mts';
import { logicalTreeSha256 } from '../../../../shared/cluster-seed-contract/native-manifest.mts';
import { validateIcuSeedIdentity } from './check-release-assets.mts';
import {
  WASIX_ICU_DATA_ARCHIVE_PATH,
  WASIX_ICU_DESCRIPTOR_SCHEMA,
  WASIX_ICU_NPM_ASSET_PATHS,
  WASIX_ICU_NPM_PACKAGE,
  WASIX_ICU_PRODUCT,
} from './wasix-icu-npm-contract.mts';
import {
  WASIX_PORTABLE_RELEASE_MEMBERS,
  WASIX_RUNTIME_NPM_PACKAGE,
  WASIX_RUNTIME_PRODUCT,
} from './wasix-runtime-npm-contract.mts';

const TOOL = 'wasix-icu-npm-carrier.mts';
const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const NOTICE_OPTIONS = Object.freeze({ profile: 'wasix-icu-data' });
const ICU_RELEASE_PREFIX = 'target/oliphaunt-wasix/icu/share/icu/';

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireEntry(entries, member, label) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${label} must contain ${member} as a non-empty regular file`);
  }
  return Buffer.from(entry.data());
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value === null || Array.isArray(value) || typeof value !== 'object')
      fail(`${label} must be an object`);
    return value;
  } catch (error) {
    fail(`${label} is not valid UTF-8 JSON: ${error.message}`);
  }
}

function canonicalIcuArchive(icuReleaseArchive) {
  const entries = readPortableArchiveEntries(path.resolve(icuReleaseArchive));
  const rows = archiveLogicalTreeRows(entries, icuReleaseArchive, ICU_RELEASE_PREFIX);
  if (!rows.some(({ path }) => path.split('/')[0]?.startsWith('icudt')))
    fail('ICU release asset has no icudt files-data tree');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-wasix-icu-npm-'));
  try {
    const stage = path.join(scratch, 'stage');
    for (const row of rows) {
      const output = path.join(stage, 'share/icu', ...row.path.split('/'));
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, row.bytes, { mode: 0o644 });
    }
    const tar = createDeterministicTar(stage, '.', { fail, fixedFileMode: 0o644 });
    return Object.freeze({ bytes: zstdCompressSync(tar), dataTreeSha256: logicalTreeSha256(rows) });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function wasixIcuNpmInputs({ version, portableReleaseArchive, icuDataReleaseArchive }) {
  const runtimeEntries = readPortableArchiveEntries(path.resolve(portableReleaseArchive));
  const manifest = parseJson(
    requireEntry(runtimeEntries, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, 'WASIX runtime release'),
    'WASIX runtime manifest',
  );
  const seedArchiveBytes = requireEntry(
    runtimeEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.icuSeedArchive,
    'WASIX runtime release',
  );
  const seedManifestBytes = requireEntry(
    runtimeEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.icuSeedManifest,
    'WASIX runtime release',
  );
  const seed = parseJson(seedManifestBytes, 'WASIX ICU cluster seed manifest');
  const identity = validateIcuSeedIdentity(manifest, seed);
  const outer = manifest['cluster-seeds'].icu;
  const data = canonicalIcuArchive(icuDataReleaseArchive);
  if (
    seed.runtime?.product !== WASIX_RUNTIME_PRODUCT ||
    seed.runtime?.version !== version ||
    seed.runtime?.physicalFormat !== 'wasix-pg18-v1' ||
    seed.runtime?.compatibilityKey !== 'wasix-pg18-datum32-v1' ||
    seed.icu?.dataTreeSha256 !== data.dataTreeSha256 ||
    outer?.sha256 !== sha256(seedArchiveBytes) ||
    outer?.size !== seedArchiveBytes.length
  ) {
    fail('ICU data, ICU cluster seed, and WASIX runtime do not form one compatible closure');
  }
  return Object.freeze({
    compatibility: Object.freeze({
      runtimeProduct: WASIX_RUNTIME_PRODUCT,
      runtimeVersion: version,
      postgresMajor: '18',
      physicalFormat: 'wasix-pg18-v1',
      compatibilityKey: 'wasix-pg18-datum32-v1',
      dataVersion: identity.dataVersion,
      dataForm: identity.dataForm,
      dataTreeSha256: data.dataTreeSha256,
    }),
    dataArchive: Object.freeze({
      archive: WASIX_ICU_DATA_ARCHIVE_PATH,
      bytes: data.bytes,
      sha256: sha256(data.bytes),
      size: data.bytes.length,
    }),
    clusterSeedArchive: Object.freeze({
      archive: outer.archive,
      bytes: seedArchiveBytes,
      sha256: outer.sha256,
      size: outer.size,
    }),
    clusterSeedManifest: Object.freeze({
      bytes: seedManifestBytes,
      sha256: sha256(seedManifestBytes),
      size: seedManifestBytes.length,
    }),
  });
}

function renderDescriptor({ version, inputs }) {
  const literal = JSON.stringify(
    {
      schema: WASIX_ICU_DESCRIPTOR_SCHEMA,
      runtime: 'wasix',
      product: WASIX_ICU_PRODUCT,
      version,
      compatibility: inputs.compatibility,
      dataArchive: {
        archive: inputs.dataArchive.archive,
        sha256: inputs.dataArchive.sha256,
        size: inputs.dataArchive.size,
      },
      clusterSeedArchive: {
        archive: inputs.clusterSeedArchive.archive,
        sha256: inputs.clusterSeedArchive.sha256,
        size: inputs.clusterSeedArchive.size,
      },
      clusterSeedManifest: {
        sha256: inputs.clusterSeedManifest.sha256,
        size: inputs.clusterSeedManifest.size,
      },
    },
    null,
    2,
  );
  return `const descriptor = ${literal};\nconst paths = ${JSON.stringify(WASIX_ICU_NPM_ASSET_PATHS)};\nfor (const name of ["dataArchive", "clusterSeedArchive", "clusterSeedManifest"]) {\n  descriptor[name].source = new URL(\`./\${paths[name]}\`, import.meta.url);\n  Object.freeze(descriptor[name]);\n}\nObject.freeze(descriptor.compatibility);\nObject.freeze(descriptor);\nexport { descriptor };\nexport default descriptor;\n`;
}

function descriptorTypes() {
  return `export type OliphauntWasixIcuDescriptor = Readonly<{\n  schema: "${WASIX_ICU_DESCRIPTOR_SCHEMA}"; runtime: "wasix"; product: "${WASIX_ICU_PRODUCT}"; version: string;\n  compatibility: Readonly<{ runtimeProduct: "${WASIX_RUNTIME_PRODUCT}"; runtimeVersion: string; postgresMajor: "18"; physicalFormat: "wasix-pg18-v1"; compatibilityKey: "wasix-pg18-datum32-v1"; dataVersion: "76.1"; dataForm: "files-le"; dataTreeSha256: string }>;\n  dataArchive: Readonly<{ archive: string; sha256: string; size: number; source: URL }>;\n  clusterSeedArchive: Readonly<{ archive: string; sha256: string; size: number; source: URL }>;\n  clusterSeedManifest: Readonly<{ sha256: string; size: number; source: URL }>;\n}>;\ndeclare const descriptor: OliphauntWasixIcuDescriptor;\nexport { descriptor };\nexport default descriptor;\n`;
}

export function stageWasixIcuNpmCarrier({
  version,
  portableReleaseArchive,
  icuDataReleaseArchive,
  packageDir,
}) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new TypeError(`${TOOL}: version must be an exact stable semantic version`);
  }
  const output = path.resolve(packageDir);
  const inputs = wasixIcuNpmInputs({ version, portableReleaseArchive, icuDataReleaseArchive });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(path.join(output, 'assets'), { recursive: true });
  for (const name of ['dataArchive', 'clusterSeedArchive', 'clusterSeedManifest']) {
    const destination = path.join(output, ...WASIX_ICU_NPM_ASSET_PATHS[name].split('/'));
    writeFileSync(destination, inputs[name].bytes, { mode: 0o644 });
    chmodSync(destination, 0o644);
  }
  writeFileSync(path.join(output, 'index.js'), renderDescriptor({ version, inputs }), {
    mode: 0o644,
  });
  writeFileSync(path.join(output, 'index.d.ts'), descriptorTypes(), { mode: 0o644 });
  writeFileSync(
    path.join(output, 'README.md'),
    `# ${WASIX_ICU_NPM_PACKAGE}\n\nOptional ICU data and matching ICU catalog cluster seed for ${WASIX_RUNTIME_NPM_PACKAGE}.\n\n\`import icu from '${WASIX_ICU_NPM_PACKAGE}'\` and pass \`{ icu }\` to \`Oliphaunt.open\`.\n`,
    { mode: 0o644 },
  );
  stageReleaseNotices(output, NOTICE_OPTIONS);
  const packageJson = {
    name: WASIX_ICU_NPM_PACKAGE,
    version,
    description: 'Optional ICU data and matching cluster seed for Oliphaunt WASIX.',
    license: releaseProfilePackageLicense('wasix-icu-data').spdx,
    type: 'module',
    sideEffects: false,
    repository: { type: 'git', url: 'git+https://github.com/f0rr0/oliphaunt.git' },
    oliphaunt: {
      product: WASIX_ICU_PRODUCT,
      kind: 'icu-data',
      runtime: 'wasix',
      descriptorSchema: WASIX_ICU_DESCRIPTOR_SCHEMA,
    },
    publishConfig: { access: 'public', provenance: true },
    files: [
      'README.md',
      'index.js',
      'index.d.ts',
      'assets',
      ...releaseNoticeRows(NOTICE_OPTIONS).map(({ member }) => member),
    ],
    exports: {
      '.': { types: './index.d.ts', import: './index.js', default: './index.js' },
      './package.json': './package.json',
    },
  };
  validateNpmTrustedPublishingManifest(packageJson, `${WASIX_ICU_NPM_PACKAGE} generated package`);
  writeFileSync(path.join(output, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, {
    mode: 0o644,
  });
  assertReleaseNoticesInDirectory(output, NOTICE_OPTIONS);
  return Object.freeze({
    packageDir: output,
    packageName: WASIX_ICU_NPM_PACKAGE,
    descriptor: inputs,
  });
}

export function packWasixIcuNpmCarrier({
  version,
  portableReleaseArchive,
  icuDataReleaseArchive,
  packageDir = path.join(ROOT, 'target/release/npm-package-sources/wasix-icu'),
  tarballRoot = path.join(ROOT, 'target/release/npm-packages/wasix-icu'),
}) {
  const staged = stageWasixIcuNpmCarrier({
    version,
    portableReleaseArchive,
    icuDataReleaseArchive,
    packageDir,
  });
  rmSync(tarballRoot, { recursive: true, force: true });
  mkdirSync(tarballRoot, { recursive: true });
  const tarball = path.join(tarballRoot, `oliphaunt-wasix-icu-${version}.tgz`);
  writeFileSync(
    tarball,
    canonicalGzipSync(
      createDeterministicTar(staged.packageDir, 'package', { fail, fixedFileMode: 0o644 }),
    ),
  );
  assertReleaseNoticesInArchive(tarball, { ...NOTICE_OPTIONS, prefix: 'package' });
  return Object.freeze({ ...staged, tarball });
}
