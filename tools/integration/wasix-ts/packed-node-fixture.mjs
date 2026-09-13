import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readPortableArchiveEntries } from '../../../src/shared/artifact-packaging/portable-archive.mjs';
import { WASIX_RUNTIME_NPM_ASSET_PATHS } from '../../release/wasix-runtime-npm-contract.mjs';
import {
  renderWasixRuntimeDescriptorModule,
  renderWasixRuntimeDescriptorTypes,
} from '../../release/wasix-runtime-npm-descriptor.mjs';
import { prepareWasixToolsTypescriptPackage } from '../../release/wasix-tools-typescript-package.mjs';
import { prepareWasixTypescriptPackage } from '../../release/wasix-typescript-package.mjs';
import { portableCommand } from '../../../src/runtimes/wasix-napi/tools/portable-command.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageRoot = resolve(repositoryRoot, 'src/bindings/wasix-ts');
const assetRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix/assets');
const buildOutputsFile = resolve(
  repositoryRoot,
  'target/oliphaunt-wasix/wasix-build/build/outputs.json',
);
const nativeCarrierRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix-napi/npm-packages');
const databaseRootContractFile = resolve(
  repositoryRoot,
  'src/shared/fixtures/storage/database-root.json',
);

export async function createPackedWasixConsumer({
  scratch,
  consumerName = 'oliphaunt-wasix-node-consumer',
  includePgtap = false,
  includeTools = false,
  includeNative = true,
  useStubRuntime = false,
  packageManager = 'pnpm',
}) {
  if (typeof scratch !== 'string' || !isAbsolute(scratch)) {
    throw new Error(
      'packed WASIX Node/Bun/Deno/Electron host fixture requires an absolute scratch directory',
    );
  }
  if (!['npm', 'pnpm'].includes(packageManager)) {
    throw new Error(`packed WASIX host fixture does not support package manager ${packageManager}`);
  }
  const releaseVersions = JSON.parse(
    await readFile(resolve(repositoryRoot, '.release-please-manifest.json'), 'utf8'),
  );
  const runtimeVersion = releaseVersions['src/runtimes/liboliphaunt/wasix'];
  const tarballs = resolve(scratch, 'tarballs');
  await mkdir(tarballs, { recursive: true });

  const binding = await packBinding({ scratch, tarballs });
  const nativeCarrier = includeNative
    ? await findNativeCarrier({
        nativeVersion: binding.nativeVersion,
        runtimeVersion,
      })
    : undefined;
  const toolsCarrier = includeTools
    ? await packToolsCarrier({ scratch, tarballs, runtimeVersion })
    : undefined;
  const toolsAot =
    includeTools && includeNative
      ? await packToolsAotCarrier({ scratch, tarballs, runtimeVersion })
      : undefined;
  const toolsFacade = includeTools
    ? await packToolsFacade({ scratch, tarballs, bindingVersion: binding.version })
    : undefined;
  if (includePgtap && useStubRuntime) {
    throw new Error('the packed WASIX stub runtime cannot carry extensions');
  }
  const runtime = useStubRuntime
    ? await packStubRuntime({ scratch, tarballs, runtimeVersion })
    : await packRuntime({ scratch, tarballs, runtimeVersion });
  const extensionPackages = await packExtensions({ scratch, includePgtap });
  const contrib = extensionPackages.find(
    (row) => row.name === '@oliphaunt/extension-contrib-pg18-wasix',
  );
  const extension = extensionPackages.find(
    (row) => row.name === '@oliphaunt/extension-pgtap-wasix',
  );
  if (contrib === undefined || (includePgtap && extension === undefined))
    throw new Error(
      `same-candidate WASIX extension packages are missing; staged: ${extensionPackages.map((row) => row.name).join(', ')}`,
    );
  const consumer = resolve(scratch, 'consumer');
  await mkdir(consumer, { recursive: true });
  const dependencies = {
    [runtime.name]: pathToFileURL(runtime.file).href,
    [binding.name]: pathToFileURL(binding.file).href,
    [contrib.name]: pathToFileURL(contrib.file).href,
  };
  if (nativeCarrier !== undefined) {
    dependencies[nativeCarrier.name] = pathToFileURL(nativeCarrier.file).href;
  }
  if (extension !== undefined) {
    dependencies[extension.name] = pathToFileURL(extension.file).href;
  }
  if (toolsCarrier !== undefined) {
    dependencies[toolsCarrier.name] = pathToFileURL(toolsCarrier.file).href;
  }
  if (toolsAot !== undefined) dependencies[toolsAot.name] = pathToFileURL(toolsAot.file).href;
  if (toolsFacade !== undefined) {
    dependencies[toolsFacade.name] = pathToFileURL(toolsFacade.file).href;
  }
  await writeJson(resolve(consumer, 'package.json'), {
    name: consumerName,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  });
  const localPackages = [
    runtime,
    binding,
    nativeCarrier,
    extension,
    toolsCarrier,
    toolsFacade,
    toolsAot,
    contrib,
  ].filter(Boolean);
  await writeFile(
    resolve(consumer, 'pnpm-workspace.yaml'),
    `packages:\n  - .\noverrides:\n${localPackages
      .map((candidate) => `  '${candidate.name}': ${pathToFileURL(candidate.file).href}`)
      .join('\n')}\n`,
  );
  if (packageManager === 'pnpm') {
    await runFixtureCommand(
      'pnpm',
      ['install', '--ignore-scripts', '--no-frozen-lockfile'],
      consumer,
    );
  } else {
    await runFixtureCommand(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'],
      consumer,
    );
  }
  return {
    consumer,
    packages: {
      binding,
      runtime,
      contrib,
      ...(toolsAot === undefined ? {} : { toolsAot }),
      ...(nativeCarrier === undefined ? {} : { nativeCarrier }),
      ...(extension === undefined ? {} : { extension }),
      ...(toolsCarrier === undefined ? {} : { toolsCarrier }),
      ...(toolsFacade === undefined ? {} : { toolsFacade }),
    },
    packageManager,
  };
}

async function packStubRuntime({ scratch, tarballs, runtimeVersion }) {
  requireReleaseVersion(runtimeVersion, 'src/runtimes/liboliphaunt/wasix');
  const identity = await wasixPhysicalIdentity();
  const staging = resolve(scratch, 'runtime');
  await mkdir(staging);
  const emptyByteSha256 = sha256(Buffer.of(0));
  await writeFile(
    resolve(staging, 'index.js'),
    `export const POSTGRES_MAJOR = ${JSON.stringify(identity.postgresMajor)};
export const PHYSICAL_FORMAT = ${JSON.stringify(identity.physicalFormat)};

const byte = new URL('data:application/octet-stream;base64,AA==');
export default Object.freeze({
  schema: 'oliphaunt-wasix-runtime-v2',
  runtime: 'wasix',
  product: 'liboliphaunt-wasix',
  version: ${JSON.stringify(runtimeVersion)},
  runtimeArchive: {
    archive: 'runtime.tar.zst',
    sha256: ${JSON.stringify(emptyByteSha256)},
    size: 1,
    source: byte,
  },
  standardSeedArchive: {
    archive: 'cluster-seeds/standard.tar.zst',
    sha256: ${JSON.stringify(emptyByteSha256)},
    size: 1,
    source: byte,
  },
  standardSeedManifest: {
    sha256: ${JSON.stringify(emptyByteSha256)},
    size: 1,
    source: byte,
  },
  manifest: {
    sha256: ${JSON.stringify(emptyByteSha256)},
    size: 1,
    source: byte,
  },
});
`,
  );
  await writeJson(resolve(staging, 'package.json'), {
    name: '@oliphaunt/liboliphaunt-wasix',
    version: runtimeVersion,
    type: 'module',
    exports: { '.': './index.js' },
  });
  return pack(staging, tarballs);
}

export async function runFixtureCommand(command, args, cwd, timeout = 120_000, extraEnv = {}) {
  const invocation = portableCommand(command, args);
  return execFileAsync(invocation.command, invocation.args, {
    cwd,
    env: {
      ...process.env,
      NPM_CONFIG_IGNORE_SCRIPTS: 'true',
      PNPM_CONFIG_IGNORE_SCRIPTS: 'true',
      ...extraEnv,
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
}

async function packBinding({ scratch, tarballs }) {
  const staging = resolve(scratch, 'binding');
  await mkdir(staging);
  for (const name of ['package.json', 'README.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'lib']) {
    await cp(resolve(packageRoot, name), resolve(staging, name), { recursive: true });
  }
  prepareWasixTypescriptPackage(staging);
  const manifest = JSON.parse(await readFile(resolve(staging, 'package.json'), 'utf8'));
  const nativeVersion = manifest.oliphaunt?.wasixNapiVersion;
  requireReleaseVersion(nativeVersion, 'oliphaunt-wasix-napi');
  return { ...(await pack(staging, tarballs)), nativeVersion };
}

async function findNativeCarrier({ nativeVersion, runtimeVersion }) {
  const expected = nativeCarrierIdentity(platform(), arch());
  let names;
  try {
    names = (await readdir(nativeCarrierRoot)).filter((name) => name.endsWith('.tgz')).sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(
      `packed WASIX Node/Bun/Deno/Electron smoke requires ${expected.name} ${nativeVersion} under ${nativeCarrierRoot}`,
    );
  }

  const matches = [];
  for (const filename of names) {
    const file = resolve(nativeCarrierRoot, filename);
    const entries = readPortableArchiveEntries(file);
    const manifestEntry = entries.get('package/package.json');
    if (!manifestEntry?.isFile || manifestEntry.isSymbolicLink) continue;
    const manifest = JSON.parse(Buffer.from(manifestEntry.data()).toString('utf8'));
    if (manifest.name !== expected.name || manifest.version !== nativeVersion) continue;
    const artifactProvenance = validateNativeCarrierArchive(
      file,
      entries,
      manifest,
      expected,
      runtimeVersion,
    );
    const bytes = await readFile(file);
    matches.push({
      file,
      name: manifest.name,
      version: manifest.version,
      target: expected.target,
      sha256: sha256(bytes),
      size: bytes.length,
      manifest,
      artifactProvenance,
      artifactProvenanceMember: 'package/artifact-provenance.json',
    });
  }
  if (matches.length !== 1) {
    throw new Error(
      `packed WASIX Node/Bun/Deno/Electron smoke requires exactly one ${expected.name} ${nativeVersion} tarball under ${nativeCarrierRoot}; found ${matches.length}`,
    );
  }
  return matches[0];
}

function validateNativeCarrierArchive(file, entries, manifest, expected, runtimeVersion) {
  const label = file.slice(file.lastIndexOf('/') + 1);
  if (
    manifest.oliphaunt?.target !== expected.target ||
    manifest.oliphaunt?.runtimeProduct !== 'liboliphaunt-wasix' ||
    manifest.oliphaunt?.runtimeVersion !== runtimeVersion ||
    manifest.oliphaunt?.addonAbiVersion !== 2 ||
    manifest.oliphaunt?.nodeApiVersion !== 8 ||
    JSON.stringify(manifest.oliphaunt?.profiles) !== JSON.stringify(['standard', 'icu'])
  ) {
    throw new Error(`${label} has incompatible WASIX Node-API carrier metadata`);
  }
  const provenanceEntry = entries.get('package/artifact-provenance.json');
  if (!provenanceEntry?.isFile || provenanceEntry.isSymbolicLink) {
    throw new Error(`${label} omits native artifact provenance`);
  }
  const provenance = JSON.parse(Buffer.from(provenanceEntry.data()).toString('utf8'));
  if (
    provenance.schema !== 'oliphaunt-wasix-napi-provenance-v1' ||
    provenance.product !== 'oliphaunt-wasix-napi' ||
    provenance.target !== expected.target ||
    !/^[0-9a-f]{40}$/.test(provenance.artifactSourceSha ?? '')
  ) {
    throw new Error(`${label} has invalid native artifact provenance`);
  }
  if (
    provenance.build?.cargoProfile !== 'release' ||
    provenance.build?.incremental !== false ||
    provenance.build?.codegenUnits !== 1 ||
    provenance.build?.lto !== 'thin' ||
    provenance.build?.strip !== 'symbols' ||
    JSON.stringify(provenance.build?.features) !== JSON.stringify(['release']) ||
    provenance.build?.targetTriple !== provenance.buildInputs?.targetTriple
  ) {
    throw new Error(`${label} has incompatible optimized native build provenance`);
  }
  const binary = 'oliphaunt_wasix_napi.node';
  const entry = entries.get(`package/prebuilds/${binary}`);
  if (!entry?.isFile || entry.isSymbolicLink || entry.size <= 0) {
    throw new Error(`${label} omits non-empty ${binary}`);
  }
  const digest = sha256(Buffer.from(entry.data()));
  if (
    provenance.binary?.filename !== binary ||
    provenance.binary?.sha256 !== digest ||
    Object.hasOwn(provenance, 'binaries')
  ) {
    throw new Error(`${label} ${binary} differs from native artifact provenance`);
  }
  return provenance;
}

function nativeCarrierIdentity(currentPlatform, currentArch) {
  if (currentPlatform === 'darwin' && currentArch === 'arm64') {
    return { name: '@oliphaunt/wasix-napi-darwin-arm64', target: 'macos-arm64' };
  }
  if (currentPlatform === 'linux' && currentArch === 'arm64') {
    return { name: '@oliphaunt/wasix-napi-linux-arm64-gnu', target: 'linux-arm64-gnu' };
  }
  if (currentPlatform === 'linux' && currentArch === 'x64') {
    return { name: '@oliphaunt/wasix-napi-linux-x64-gnu', target: 'linux-x64-gnu' };
  }
  if (currentPlatform === 'win32' && currentArch === 'x64') {
    return { name: '@oliphaunt/wasix-napi-win32-x64-msvc', target: 'windows-x64-msvc' };
  }
  throw new Error(
    `packed WASIX Node/Bun/Deno/Electron smoke has no native carrier for ${currentPlatform}/${currentArch}`,
  );
}

function stageResources(options) {
  return runFixtureCommand(
    resolve(repositoryRoot, 'tools/dev/bun.sh'),
    ['tools/integration/wasix-ts/stage-resource-packages.mjs', JSON.stringify(options)],
    repositoryRoot,
  );
}

async function packToolsCarrier({ scratch, tarballs, runtimeVersion }) {
  const staging = resolve(scratch, 'tools-carrier');
  await stageResources({
    kind: 'tools',
    version: runtimeVersion,
    packageDir: staging,
    assetDirectory: assetRoot,
  });
  return pack(staging, tarballs);
}

async function packToolsAotCarrier({ scratch, tarballs, runtimeVersion }) {
  const { target } = nativeCarrierIdentity(platform(), arch());
  const staging = resolve(scratch, 'tools-aot');
  await stageResources({
    kind: 'tools-aot',
    version: runtimeVersion,
    target,
    packageDir: staging,
    aotArtifactDirectory: resolve(repositoryRoot, 'target/oliphaunt-wasix/aot'),
  });
  return pack(staging, tarballs);
}

async function packExtensions({ scratch, includePgtap }) {
  // The canonical artifact builder deliberately keeps its output in the checkout.
  const work = await mkdtemp(resolve(repositoryRoot, 'target/wasix-consumer-resources-'));
  try {
    const artifactRoot = resolve(work, 'artifacts');
    await runFixtureCommand(
      resolve(repositoryRoot, 'tools/dev/bun.sh'),
      [
        'tools/release/build-extension-ci-artifacts.mjs',
        '--output-root',
        artifactRoot,
        '--family',
        'wasix',
        '--require-wasix',
        'oliphaunt-extension-contrib-pg18',
        ...(includePgtap ? ['oliphaunt-extension-pgtap'] : []),
      ],
      repositoryRoot,
      120_000,
      { OLIPHAUNT_WASIX_GENERATED_ASSET_ROOT: assetRoot },
    );
    const stagingRoot = resolve(work, 'packages');
    await stageResources({ kind: 'extensions', artifactRoot, stagingRoot });
    const tarballRoot = resolve(stagingRoot, 'tarballs');
    return await Promise.all(
      (await readdir(tarballRoot, { recursive: true }))
        .filter((name) => name.endsWith('.tgz'))
        .map(async (name) => {
          const source = resolve(tarballRoot, name);
          const file = resolve(scratch, 'tarballs', source.split(/[\\/]/).at(-1));
          await cp(source, file);
          const bytes = await readFile(file);
          const entries = readPortableArchiveEntries(file);
          const manifest = JSON.parse(
            Buffer.from(entries.get('package/package.json').data()).toString('utf8'),
          );
          return {
            file,
            name: manifest.name,
            version: manifest.version,
            sha256: sha256(bytes),
            size: bytes.length,
          };
        }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function packToolsFacade({ scratch, tarballs, bindingVersion }) {
  const source = resolve(packageRoot, 'tools-package');
  const staging = resolve(scratch, 'tools-facade');
  await mkdir(staging);
  for (const name of ['package.json', 'README.md', 'lib']) {
    await cp(resolve(source, name), resolve(staging, name), { recursive: true });
  }
  await cp(resolve(packageRoot, 'CHANGELOG.md'), resolve(staging, 'CHANGELOG.md'));
  prepareWasixToolsTypescriptPackage(staging, bindingVersion);
  return pack(staging, tarballs);
}

async function packRuntime({ scratch, tarballs, runtimeVersion }) {
  requireReleaseVersion(runtimeVersion, 'src/runtimes/liboliphaunt/wasix');
  const identity = await wasixPhysicalIdentity();
  const staging = resolve(scratch, 'runtime');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'));
  const manifestPostgresMajor = Number(manifest.runtime?.['postgres-version']?.split('.')[0]);
  if (manifestPostgresMajor !== identity.postgresMajor) {
    throw new Error('WASIX runtime manifest disagrees with the shared physical identity');
  }
  const coreManifest = Buffer.from(JSON.stringify({ ...manifest, extensions: [] }));
  const runtimeSource = resolve(assetRoot, manifest.runtime.archive);
  const standardSeed = manifest['cluster-seeds'].standard;
  const seedSource = resolve(assetRoot, standardSeed.archive);
  const seedManifestSource = resolve(assetRoot, standardSeed.manifest);
  const runtimeBytes = await readFile(runtimeSource);
  const seedBytes = await readFile(seedSource);
  const seedManifestBytes = await readFile(seedManifestSource);
  requireDigest(runtimeBytes, manifest.runtime.sha256, manifest.runtime.archive);
  requireDigest(seedBytes, standardSeed.sha256, standardSeed.archive);
  const build = await runtimeBuildProvenance(manifest);
  await cp(runtimeSource, resolve(staging, WASIX_RUNTIME_NPM_ASSET_PATHS.runtimeArchive));
  await cp(seedSource, resolve(staging, WASIX_RUNTIME_NPM_ASSET_PATHS.standardSeedArchive));
  await cp(
    seedManifestSource,
    resolve(staging, WASIX_RUNTIME_NPM_ASSET_PATHS.standardSeedManifest),
  );
  await writeFile(resolve(staging, WASIX_RUNTIME_NPM_ASSET_PATHS.manifest), coreManifest);
  const descriptor = {
    schema: 'oliphaunt-wasix-runtime-v2',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: runtimeVersion,
    runtimeArchive: {
      archive: manifest.runtime.archive,
      sha256: sha256(runtimeBytes),
      size: runtimeBytes.length,
    },
    standardSeedArchive: {
      archive: standardSeed.archive,
      sha256: sha256(seedBytes),
      size: seedBytes.length,
    },
    standardSeedManifest: {
      sha256: sha256(seedManifestBytes),
      size: seedManifestBytes.length,
    },
    manifest: { sha256: sha256(coreManifest), size: coreManifest.length },
  };
  await writeFile(resolve(staging, 'index.js'), renderWasixRuntimeDescriptorModule(descriptor));
  await writeFile(resolve(staging, 'index.d.ts'), renderWasixRuntimeDescriptorTypes());
  await writeJson(resolve(staging, 'package.json'), {
    name: '@oliphaunt/liboliphaunt-wasix',
    version: runtimeVersion,
    type: 'module',
    exports: {
      '.': { types: './index.d.ts', import: './index.js', default: './index.js' },
    },
  });
  return { ...(await pack(staging, tarballs)), build };
}

async function wasixPhysicalIdentity() {
  const contract = JSON.parse(await readFile(databaseRootContractFile, 'utf8'));
  const postgresMajor = contract.postgresMajor;
  const physicalFormat = contract.families?.wasix?.physicalFormat;
  if (!Number.isInteger(postgresMajor) || typeof physicalFormat !== 'string' || !physicalFormat) {
    throw new Error('shared database-root fixture has no valid WASIX physical identity');
  }
  return { postgresMajor, physicalFormat };
}

export async function runtimeBuildProvenance(manifest) {
  const bytes = await readFile(buildOutputsFile);
  let outputs;
  try {
    outputs = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`WASIX build outputs are invalid JSON: ${describeError(error)}`);
  }
  const runtimeRows = Array.isArray(outputs.modules)
    ? outputs.modules.filter((row) => row?.kind === 'runtime' && row?.name === 'runtime:oliphaunt')
    : [];
  const runtime = runtimeRows.length === 1 ? runtimeRows[0] : undefined;
  const profileText = outputs['build-profile'];
  const profile = parseBuildProfile(profileText);
  if (
    outputs['format-version'] !== 1 ||
    outputs['source-lane'] !== manifest['source-lane'] ||
    outputs['postgres-version'] !== manifest.runtime?.['postgres-version'] ||
    runtime?.sha256 !== manifest.runtime?.['module-sha256'] ||
    manifest['cluster-seeds']?.standard?.['runtime-module-sha256'] !== runtime?.sha256
  ) {
    throw new Error('WASIX build outputs do not describe the packaged runtime assets');
  }
  return {
    schema: 'oliphaunt-wasix-build-provenance-v1',
    outputs: { sha256: sha256(bytes), size: bytes.length },
    formatVersion: outputs['format-version'],
    postgresVersion: outputs['postgres-version'],
    sourceLane: outputs['source-lane'],
    runtimeModuleSha256: runtime.sha256,
    configuration: profile,
    buildProfile: {
      text: profileText,
      sha256: sha256(Buffer.from(profileText)),
      size: Buffer.byteLength(profileText),
    },
  };
}

export function parseBuildProfile(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('WASIX build outputs have no build-profile signature');
  }
  const fields = new Map();
  for (const line of value.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('WASIX build-profile signature is malformed');
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error(`WASIX build-profile repeats ${key}`);
    fields.set(key, line.slice(separator + 1));
  }
  const configuration = {};
  for (const [field, key] of Object.entries({
    profile: 'profile',
    cflags: 'cflags',
    ldflags: 'ldflags',
    configureWasmOpt: 'configure_wasm_opt',
    buildWasmOpt: 'build_wasm_opt',
    wasmOptFlags: 'wasm_opt_flags',
    wasmOptSuppressDefault: 'wasm_opt_suppress_default',
    wasmOptPreserveUnoptimized: 'wasm_opt_preserve_unoptimized',
    compilerFlags: 'compiler_flags',
    linkerFlags: 'linker_flags',
  })) {
    if (!fields.has(key)) throw new Error(`WASIX build-profile omits ${key}`);
    configuration[field] = fields.get(key);
  }
  return configuration;
}

async function pack(directory, tarballs) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const { stdout } = await runFixtureCommand(
    'pnpm',
    ['pack', '--pack-destination', tarballs, '--json'],
    directory,
    120_000,
    { PNPM_CONFIG_NODE_LINKER: 'hoisted' },
  );
  const result = stdout.trim() === '' ? undefined : JSON.parse(stdout);
  const reportedFilename = Array.isArray(result) ? result[0]?.filename : result?.filename;
  const filename =
    typeof reportedFilename === 'string'
      ? reportedFilename
      : resolve(
          tarballs,
          `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`,
        );
  const file = resolve(directory, filename);
  const bytes = await readFile(file);
  return {
    file,
    name: manifest.name,
    version: manifest.version,
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requireReleaseVersion(value, component) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(`release manifest has no exact version for ${component}`);
  }
}

function requireDigest(bytes, expected, label) {
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}, expected ${expected}`);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
