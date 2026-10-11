#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveDirectory } from '../../../../tools/packaging/archive-directory.mts';
import { packGeneratedNpmCarrier } from '../../../../tools/packaging/npm-package.mts';
import { inspectPlatformBinaryTree } from '../../../../tools/packaging/platform-binary-contract.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import {
  releaseNoticeRows,
  stageReleaseNotices,
} from '../../../../tools/packaging/release-notices.mts';
import {
  stageWindowsVcRuntime,
  verifyWindowsVcRuntimeClosure,
  WINDOWS_VC_RUNTIME_RECEIPT,
} from '../../../../tools/packaging/windows-vc-runtime-closure.mts';
import {
  assertWasixNapiConstructionData,
  type WasixNapiConstructionContract,
} from './carrier-contract.mts';
import { workspaceCarrierManifest } from './workspace-runtime-contract.mts';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PRODUCT_ROOT = path.join(WORKSPACE_ROOT, 'src/wasix/node-addon');
const TARGETS = Object.freeze({
  'macos-arm64': 'darwin-arm64',
  'linux-arm64-gnu': 'linux-arm64-gnu',
  'linux-x64-gnu': 'linux-x64-gnu',
  'windows-x64-msvc': 'win32-x64-msvc',
});
export const WASIX_NAPI_BINARY = 'oliphaunt_wasix_napi.node';
const BINARY = WASIX_NAPI_BINARY;

export type WasixNapiStage = {
  target: keyof typeof TARGETS;
  manifest: Record<string, any>;
  readme: string;
  binary: string;
  provenance: Record<string, any>;
  constructionContract?: WasixNapiConstructionContract;
  sourceRoot: string;
  packageStage: string;
  releaseStage: string;
  windowsRuntimeSourceDirectory?: string;
};

/** Stage the canonical envelope from explicit inputs; qualification is never promoted here. */
export async function stageWasixNapiCarrier(input: WasixNapiStage) {
  if (!Object.hasOwn(TARGETS, input.target)) throw new Error('unknown WASIX Node-API target');
  const binary = lstatSync(input.binary);
  if (!binary.isFile() || binary.isSymbolicLink() || binary.size <= 0)
    throw new Error('WASIX Node-API binary must be a non-empty regular file');
  const buildInputs = input.provenance.buildInputs;
  const construction = input.provenance.schema === 'oliphaunt-wasix-napi-construction-data-v2';
  if (!construction && input.provenance.schema !== 'oliphaunt-wasix-napi-provenance-v1')
    throw new Error('unknown WASIX Node-API provenance schema');
  if (construction) {
    if (!input.constructionContract)
      throw new Error('native WASIX Node-API construction requires its declared release contract');
    assertWasixNapiConstructionData(
      input.provenance,
      input.target,
      sha256(input.binary),
      input.constructionContract,
    );
  }
  if (
    buildInputs?.schema !==
      (construction
        ? 'oliphaunt-wasix-napi-build-inputs-v2'
        : 'oliphaunt-wasix-napi-build-inputs-v1') ||
    buildInputs.target !== input.target ||
    typeof buildInputs.targetTriple !== 'string' ||
    buildInputs.targetTriple.length === 0 ||
    !Array.isArray(buildInputs.inputs?.extensionArtifacts) ||
    buildInputs.inputs.extensionArtifacts.length === 0 ||
    input.provenance.target !== input.target ||
    input.provenance.product !== 'oliphaunt-wasix-napi' ||
    (!construction && !/^[0-9a-f]{40}$/u.test(input.provenance.sourceSha ?? '')) ||
    (!construction && !/^[0-9a-f]{40}$/u.test(input.provenance.artifactSourceSha ?? '')) ||
    input.provenance.binary?.filename !== BINARY ||
    input.provenance.binary?.sha256 !== sha256(input.binary)
  )
    throw new Error('WASIX Node-API provenance differs from its declared binary or inputs');
  const contains = (directory: string, file: string) => {
    const relative = path.relative(path.resolve(directory), path.resolve(file));
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  };
  if (
    contains(input.packageStage, input.releaseStage) ||
    contains(input.releaseStage, input.packageStage) ||
    [input.packageStage, input.releaseStage].some((stage) =>
      [input.sourceRoot, input.binary, input.readme].some((source) => contains(stage, source)),
    )
  )
    throw new Error('WASIX Node-API staging directories must be distinct from source inputs');

  const packagePrebuilds = path.join(input.packageStage, 'prebuilds');
  for (const stage of [input.packageStage, input.releaseStage]) {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    stageReleaseNotices(stage, { profile: 'wasix-napi-addon', sourceRoot: input.sourceRoot });
    writeFileSync(
      path.join(stage, 'artifact-provenance.json'),
      `${JSON.stringify(input.provenance, null, 2)}\n`,
    );
  }
  writeFileSync(
    path.join(input.packageStage, 'package.json'),
    `${JSON.stringify(input.manifest, null, 2)}\n`,
  );
  cpSync(input.readme, path.join(input.packageStage, 'README.md'));
  mkdirSync(packagePrebuilds, { recursive: true });
  cpSync(input.binary, path.join(packagePrebuilds, BINARY));
  cpSync(input.binary, path.join(input.releaseStage, BINARY));
  if (input.target === 'windows-x64-msvc') {
    const npm = stageWindowsVcRuntime({
      root: input.packageStage,
      sourceDirectory: input.windowsRuntimeSourceDirectory,
      destinations: [packagePrebuilds],
    }).required;
    const github = stageWindowsVcRuntime({
      root: input.releaseStage,
      sourceDirectory: packagePrebuilds,
      destinations: [input.releaseStage],
    }).required;
    if (JSON.stringify(npm) !== JSON.stringify(github))
      throw new Error('release and npm carriers derived different Windows VC runtime closures');
  }
  await inspectPlatformBinaryTree(input.releaseStage, { target: input.target });
}

export async function finishWasixNapiCarrier(input: {
  target: keyof typeof TARGETS;
  packageStage: string;
  releaseStage: string;
  tarball: string;
  releaseArchive: string;
}) {
  const listing = readPortableArchiveEntries(input.tarball);
  const windowsRuntimeNames =
    input.target === 'windows-x64-msvc'
      ? verifyWindowsVcRuntimeClosure({
          root: input.packageStage,
          searchRoots: [path.join(input.packageStage, 'prebuilds')],
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
  if (windowsRuntimeNames.length > 0)
    requiredMembers.push(
      ...windowsRuntimeNames.map((name) => `package/prebuilds/${name}`),
      `package/prebuilds/${WINDOWS_VC_RUNTIME_RECEIPT}`,
    );
  for (const member of requiredMembers)
    if (!listing.get(member)?.isFile || listing.get(member)?.isSymbolicLink)
      throw new Error(`${path.basename(input.tarball)} is missing ${member}`);
  await archiveDirectory(input.releaseStage, input.releaseArchive);
  return { npm: input.tarball, github: input.releaseArchive };
}

/** Both public envelopes share the sole compiled binary and provenance subjects. */
export async function packageWasixNapiCarrier(
  input: WasixNapiStage & { tarballRoot: string; releaseArchive: string },
) {
  await stageWasixNapiCarrier(input);
  const tarball = packGeneratedNpmCarrier(input.packageStage, input.tarballRoot);
  return finishWasixNapiCarrier({ ...input, tarball });
}

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

    mkdirSync(packageOutput, { recursive: true });
    mkdirSync(releaseAssets, { recursive: true });
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
        sha256: sha256(path.join(prebuildDirectory, BINARY)),
      },
    };
    await stageWasixNapiCarrier({
      target,
      manifest: workspaceCarrierManifest(
        readJson(path.join(sourcePackage, 'package.json')),
        rootManifest.oliphaunt,
        WORKSPACE_ROOT,
      ),
      readme: path.join(sourcePackage, 'README.md'),
      binary: path.join(prebuildDirectory, BINARY),
      provenance,
      sourceRoot: path.dirname(releaseNoticeRows({ profile: 'wasix-napi-addon' })[0].source),
      packageStage: packageWork,
      releaseStage,
    });
    console.log(
      [releaseStage, packageWork, packageOutput]
        .map((file) => path.relative(WORKSPACE_ROOT, file).split(path.sep).join('/'))
        .join('\t'),
    );
    return;
  }
  const tarball = options.tarball;
  requireFile(tarball);

  await finishWasixNapiCarrier({
    target,
    packageStage: packageWork,
    releaseStage,
    tarball,
    releaseArchive,
  });
  process.stdout.write(`${tarball}\n${releaseArchive}\n`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `package-wasix-napi-platform: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
