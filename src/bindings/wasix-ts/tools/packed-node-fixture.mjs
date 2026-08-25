import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WASIX_RUNTIME_NPM_ASSET_PATHS } from '../../../../tools/release/wasix-runtime-npm-contract.mjs';
import {
  renderWasixRuntimeDescriptorModule,
  renderWasixRuntimeDescriptorTypes,
} from '../../../../tools/release/wasix-runtime-npm-descriptor.mjs';
import { prepareWasixToolsTypescriptPackage } from '../../../../tools/release/wasix-tools-typescript-package.mjs';
import { prepareWasixTypescriptPackage } from '../../../../tools/release/wasix-typescript-package.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../../..');
const assetRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix/assets');
const buildOutputsFile = resolve(
  repositoryRoot,
  'target/oliphaunt-wasix/wasix-build/build/outputs.json',
);
const databaseRootContractFile = resolve(
  repositoryRoot,
  'src/shared/fixtures/storage/database-root.json',
);

export async function createPackedWasixConsumer({
  scratch,
  consumerName = 'oliphaunt-wasix-node-consumer',
  includePgtap = false,
  includeTools = false,
  useStubRuntime = false,
}) {
  if (typeof scratch !== 'string' || !isAbsolute(scratch)) {
    throw new Error(
      'packed WASIX Node/Bun/Deno host fixture requires an absolute scratch directory',
    );
  }
  const releaseVersions = JSON.parse(
    await readFile(resolve(repositoryRoot, '.release-please-manifest.json'), 'utf8'),
  );
  const runtimeVersion = releaseVersions['src/runtimes/liboliphaunt/wasix'];
  const extensionVersion = releaseVersions['src/extensions/external/pgtap'];
  const tarballs = resolve(scratch, 'tarballs');
  await mkdir(tarballs, { recursive: true });

  const binding = await packBinding({ scratch, tarballs });
  const toolsCarrier = includeTools
    ? await packToolsCarrier({ scratch, tarballs, runtimeVersion })
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
  const extension = includePgtap
    ? await packPgtap({ scratch, tarballs, runtimeVersion, extensionVersion })
    : undefined;
  const consumer = resolve(scratch, 'consumer');
  await mkdir(consumer, { recursive: true });
  const dependencies = {
    [runtime.name]: `file:${runtime.file}`,
    [binding.name]: `file:${binding.file}`,
  };
  if (extension !== undefined) dependencies[extension.name] = `file:${extension.file}`;
  if (toolsCarrier !== undefined) dependencies[toolsCarrier.name] = `file:${toolsCarrier.file}`;
  if (toolsFacade !== undefined) dependencies[toolsFacade.name] = `file:${toolsFacade.file}`;
  await writeJson(resolve(consumer, 'package.json'), {
    name: consumerName,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  });
  const localPackages = [runtime, binding, extension, toolsCarrier, toolsFacade].filter(Boolean);
  await writeFile(
    resolve(consumer, 'pnpm-workspace.yaml'),
    `packages:\n  - .\noverrides:\n${localPackages
      .map((candidate) => `  '${candidate.name}': file:${candidate.file}`)
      .join('\n')}\n`,
  );
  await runFixtureCommand(
    'pnpm',
    ['install', '--ignore-scripts', '--no-frozen-lockfile'],
    consumer,
  );
  return {
    consumer,
    packages: {
      binding,
      runtime,
      ...(extension === undefined ? {} : { extension }),
      ...(toolsCarrier === undefined ? {} : { toolsCarrier }),
      ...(toolsFacade === undefined ? {} : { toolsFacade }),
    },
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

export async function runFixtureCommand(command, args, cwd, timeout = 120_000) {
  return execFileAsync(command, args, {
    cwd,
    env: { ...process.env, PNPM_CONFIG_IGNORE_SCRIPTS: 'true' },
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
  return pack(staging, tarballs);
}

async function packToolsCarrier({ scratch, tarballs, runtimeVersion }) {
  requireReleaseVersion(runtimeVersion, 'src/runtimes/liboliphaunt/wasix');
  const staging = resolve(scratch, 'tools-carrier');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'));
  const descriptors = {};
  for (const [field, key, filename] of [
    ['pgDump', 'pg-dump', 'pg_dump.wasix.wasm'],
    ['psql', 'psql', 'psql.wasix.wasm'],
  ]) {
    const row = manifest[key];
    const bytes = await readFile(resolve(assetRoot, row.path));
    requireDigest(bytes, row.sha256, row.path);
    if (bytes.length !== row.size) throw new Error(`${row.path} size differs from its manifest`);
    await writeFile(resolve(assets, filename), bytes);
    descriptors[field] = {
      name: row.name,
      sha256: row.sha256,
      size: row.size,
      filename,
    };
  }
  const tool = ({ name, sha256: digest, size, filename }) =>
    `Object.freeze({ name: ${JSON.stringify(name)}, sha256: ${JSON.stringify(digest)}, size: ${size}, source: new URL('./assets/${filename}', import.meta.url).href })`;
  await writeFile(
    resolve(staging, 'index.js'),
    `export default Object.freeze({\n  schema: 'oliphaunt-wasix-tools-v1',\n  product: 'oliphaunt-wasix-tools',\n  version: ${JSON.stringify(runtimeVersion)},\n  runtimeProduct: 'liboliphaunt-wasix',\n  runtimeVersion: ${JSON.stringify(runtimeVersion)},\n  pgDump: ${tool(descriptors.pgDump)},\n  psql: ${tool(descriptors.psql)},\n});\n`,
  );
  await writeJson(resolve(staging, 'package.json'), {
    name: '@oliphaunt/liboliphaunt-wasix-tools',
    version: runtimeVersion,
    type: 'module',
    exports: { '.': './index.js' },
  });
  return pack(staging, tarballs);
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
    outputs['source-fingerprint'] !== manifest['source-fingerprint'] ||
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
    sourceFingerprint: outputs['source-fingerprint'],
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

async function packPgtap({ scratch, tarballs, runtimeVersion, extensionVersion }) {
  requireReleaseVersion(extensionVersion, 'src/extensions/external/pgtap');
  const staging = resolve(scratch, 'pgtap');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'));
  const row = manifest.extensions.find((candidate) => candidate['sql-name'] === 'pgtap');
  if (row === undefined) throw new Error('WASIX manifest has no pgtap carrier');
  await cp(resolve(assetRoot, row.archive), resolve(assets, 'pgtap.tar.zst'));
  const lifecycle = row.lifecycle;
  const carrier = {
    product: 'oliphaunt-extension-pgtap',
    version: extensionVersion,
    sqlName: 'pgtap',
    archive: row.archive,
    sha256: row.sha256,
    size: row.size,
    install: {
      schema: 'oliphaunt-wasix-extension-install-v1',
      name: row.name,
      nativeModule: null,
      nativeModules: [],
      dependencies: row.dependencies,
      coreExportsRequired: row['core-exports-required'],
      loadOrder: row['load-order'],
      lifecycle: {
        createExtension: lifecycle['create-extension'],
        createSchema: lifecycle['create-schema'],
        loadSql: lifecycle['load-sql'],
        postCreateSql: lifecycle['post-create-sql'],
        startupConfig: lifecycle['startup-config'],
        preloadRequired: lifecycle['preload-required'],
        restartRequired: lifecycle['restart-required'],
        sharedMemoryRequired: lifecycle['shared-memory-required'],
      },
      installedFiles: row['installed-files'],
      unresolvedImports: row['unresolved-imports'],
    },
  };
  const descriptor = {
    schema: 'oliphaunt-wasix-extension-v1',
    runtime: 'wasix',
    product: carrier.product,
    version: carrier.version,
    compatibility: {
      extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
      postgresMajor: manifest.runtime['postgres-version'].split('.')[0],
      wasixRuntimeProduct: 'liboliphaunt-wasix',
      wasixRuntimeVersion: runtimeVersion,
    },
    sqlName: 'pgtap',
    carriers: [carrier],
  };
  await writeFile(
    resolve(staging, 'index.js'),
    `const descriptor = ${JSON.stringify(descriptor, null, 2)};
descriptor.carriers[0].source = new URL('./assets/pgtap.tar.zst', import.meta.url);
export default descriptor;
`,
  );
  await writeJson(resolve(staging, 'package.json'), {
    name: '@oliphaunt/extension-pgtap-wasix',
    version: extensionVersion,
    type: 'module',
    exports: { '.': './index.js' },
  });
  return pack(staging, tarballs);
}

async function pack(directory, tarballs) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const { stdout } = await runFixtureCommand(
    'pnpm',
    ['pack', '--pack-destination', tarballs, '--json'],
    directory,
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
