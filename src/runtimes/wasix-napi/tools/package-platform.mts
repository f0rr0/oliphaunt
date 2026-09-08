#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { archiveDirectory } from '../../../shared/artifact-packaging/archive-directory.mts';
import { readPortableArchiveEntries } from '../../../shared/artifact-packaging/portable-archive.mts';
import { stageReleaseNotices } from '../../../shared/artifact-packaging/release-notices.mts';
import { inspectPlatformBinaryTree } from '../../../shared/artifact-packaging/platform-binary-contract.mts';
import {
  WINDOWS_VC_RUNTIME_RECEIPT,
  stageWindowsVcRuntime,
  verifyWindowsVcRuntimeClosure,
} from '../../../shared/artifact-packaging/windows-vc-runtime-closure.mts';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PRODUCT_ROOT = path.join(WORKSPACE_ROOT, 'src/runtimes/wasix-napi');
const TARGETS = Object.freeze({
  'macos-arm64': 'darwin-arm64',
  'linux-arm64-gnu': 'linux-arm64-gnu',
  'linux-x64-gnu': 'linux-x64-gnu',
  'windows-x64-msvc': 'win32-x64-msvc',
});
const BINARY = 'oliphaunt_wasix_napi.node';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function requireFile(file) {
  if (!existsSync(file)) {
    throw new Error(`missing required file: ${path.relative(WORKSPACE_ROOT, file)}`);
  }
}

async function main() {
  const [mode, ...argv] = process.argv.slice(2);
  if (!['stage', 'finish'].includes(mode)) throw new Error('expected stage or finish');
  const options = parseArguments(argv);
  const target = options.target;
  const carrierDirectory = TARGETS[target];
  if (!carrierDirectory) {
    throw new Error(`--target must be one of ${Object.keys(TARGETS).join(', ')}`);
  }
  const sourcePackage = path.join(PRODUCT_ROOT, 'packages', carrierDirectory);
  const packageWork = path.join(
    WORKSPACE_ROOT,
    'target/oliphaunt-wasix-napi/npm-package-work',
    carrierDirectory,
  );
  const packageOutput = path.join(WORKSPACE_ROOT, 'target/oliphaunt-wasix-napi/npm-packages');
  const rootManifest = readJson(path.join(PRODUCT_ROOT, 'package.json'));
  const releaseStage = path.join(
    WORKSPACE_ROOT,
    'target/oliphaunt-wasix-napi/release-stage',
    target,
  );
  const releaseAssets = path.join(WORKSPACE_ROOT, 'target/oliphaunt-wasix-napi/release-assets');
  const archiveExtension = target === 'windows-x64-msvc' ? 'zip' : 'tar.gz';
  const releaseArchive = path.join(
    releaseAssets,
    `oliphaunt-wasix-napi-${rootManifest.version}-${target}.${archiveExtension}`,
  );
  if (mode === 'stage') {
    if (!options['build-inputs']) {
      throw new Error('--build-inputs is required');
    }
    const buildInputsFile = path.resolve(options['build-inputs']);
    requireFile(buildInputsFile);
    const buildInputs = readJson(buildInputsFile);
    if (
      buildInputs.schema !== 'oliphaunt-wasix-napi-build-inputs-v1' ||
      buildInputs.target !== target ||
      typeof buildInputs.targetTriple !== 'string' ||
      buildInputs.targetTriple.length === 0 ||
      !Array.isArray(buildInputs.inputs?.extensionArtifacts) ||
      buildInputs.inputs.extensionArtifacts.length === 0
    ) {
      throw new Error(
        `${path.basename(buildInputsFile)} has incompatible WASIX N-API build inputs`,
      );
    }
    const prebuildDirectory = path.resolve(
      options['prebuild-dir'] ??
        path.join(WORKSPACE_ROOT, 'target/oliphaunt-wasix-napi/prebuilds', target),
    );
    requireFile(path.join(prebuildDirectory, BINARY));

    rmSync(packageWork, { recursive: true, force: true });
    mkdirSync(path.join(packageWork, 'prebuilds'), { recursive: true });
    mkdirSync(packageOutput, { recursive: true });
    cpSync(sourcePackage, packageWork, { recursive: true });
    const packagePrebuilds = path.join(packageWork, 'prebuilds');
    mkdirSync(packagePrebuilds, { recursive: true });
    cpSync(path.join(prebuildDirectory, BINARY), path.join(packagePrebuilds, BINARY));
    stageReleaseNotices(packageWork, { profile: 'wasix-napi-addon' });
    const windowsRuntimeNames =
      target === 'windows-x64-msvc'
        ? stageWindowsVcRuntime({
            root: packageWork,
            destinations: [packagePrebuilds],
          }).required
        : [];

    const sourceSha = options['source-sha'];
    if (!/^[0-9a-f]{40}$/u.test(sourceSha ?? ''))
      throw new Error('--source-sha must be a lowercase Git SHA');
    const artifactSourceSha = process.env.OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA ?? sourceSha;
    if (!/^[0-9a-f]{40}$/.test(artifactSourceSha)) {
      throw new Error('OLIPHAUNT_WASIX_NAPI_ARTIFACT_SOURCE_SHA must be a lowercase Git SHA');
    }
    const provenance = {
      schema: 'oliphaunt-wasix-napi-provenance-v1',
      product: 'oliphaunt-wasix-napi',
      target,
      sourceSha,
      artifactSourceSha,
      build: {
        cargoProfile: 'release',
        incremental: false,
        codegenUnits: 1,
        lto: 'thin',
        strip: 'symbols',
        features: ['release'],
        targetTriple: buildInputs.targetTriple,
      },
      buildInputs,
      binary: {
        filename: BINARY,
        sha256: sha256(path.join(packageWork, 'prebuilds', BINARY)),
      },
    };
    writeFileSync(
      path.join(packageWork, 'artifact-provenance.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );

    rmSync(releaseStage, { recursive: true, force: true });
    mkdirSync(releaseStage, { recursive: true });
    mkdirSync(releaseAssets, { recursive: true });
    cpSync(path.join(prebuildDirectory, BINARY), path.join(releaseStage, BINARY));
    stageReleaseNotices(releaseStage, { profile: 'wasix-napi-addon' });
    cpSync(
      path.join(packageWork, 'artifact-provenance.json'),
      path.join(releaseStage, 'artifact-provenance.json'),
    );
    if (target === 'windows-x64-msvc') {
      const releaseRuntimeNames = stageWindowsVcRuntime({
        root: releaseStage,
        sourceDirectory: packagePrebuilds,
        destinations: [releaseStage],
      }).required;
      if (JSON.stringify(releaseRuntimeNames) !== JSON.stringify(windowsRuntimeNames)) {
        throw new Error('release and npm carriers derived different Windows VC runtime closures');
      }
    }
    await inspectPlatformBinaryTree(releaseStage, { target });
    console.log(
      [releaseStage, packageWork, packageOutput]
        .map((file) => path.relative(WORKSPACE_ROOT, file).split(path.sep).join('/'))
        .join('\t'),
    );
    return;
  }
  const parsed = readJson(options['pack-result']);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry.filename !== 'string' || !entry.filename.endsWith('.tgz')) {
    throw new Error('pnpm pack did not report a .tgz filename');
  }
  const tarball = path.isAbsolute(entry.filename)
    ? entry.filename
    : path.join(packageOutput, entry.filename);
  requireFile(tarball);

  const listing = readPortableArchiveEntries(tarball);
  const windowsRuntimeNames =
    target === 'windows-x64-msvc'
      ? verifyWindowsVcRuntimeClosure({
          root: packageWork,
          searchRoots: [path.join(packageWork, 'prebuilds')],
        }).required
      : [];
  const requiredMembers = [
    `package/prebuilds/${BINARY}`,
    'package/artifact-provenance.json',
    'package/LICENSE',
    'package/THIRD_PARTY_NOTICES.md',
    'package/THIRD_PARTY_NOTICES.oliphaunt-wasix.md',
    'package/THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT',
    'package/THIRD_PARTY_LICENSES/ICU-LICENSE',
    'package/THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt',
  ];
  if (windowsRuntimeNames.length > 0) {
    requiredMembers.push(
      ...windowsRuntimeNames.map((name) => `package/prebuilds/${name}`),
      `package/prebuilds/${WINDOWS_VC_RUNTIME_RECEIPT}`,
    );
  }
  for (const member of requiredMembers) {
    if (!listing.get(member)?.isFile || listing.get(member)?.isSymbolicLink) {
      throw new Error(`${path.basename(tarball)} is missing ${member}`);
    }
  }
  await archiveDirectory(releaseStage, releaseArchive);
  process.stdout.write(`${tarball}\n${releaseArchive}\n`);
}

try {
  await main();
} catch (error) {
  console.error(
    `package-wasix-napi-platform: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
