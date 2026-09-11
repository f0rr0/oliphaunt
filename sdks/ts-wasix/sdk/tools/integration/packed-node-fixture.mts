import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WASIX_RUNTIME_NPM_ASSET_PATHS } from '../../../../../runtimes/liboliphaunt-wasix/tools/wasix-runtime-npm-contract.mts';
import {
  renderWasixRuntimeDescriptorModule,
  renderWasixRuntimeDescriptorTypes,
} from '../../../../../runtimes/liboliphaunt-wasix/tools/wasix-runtime-npm-descriptor.mts';
import { createDeterministicTar } from '../../../../../tools/packaging/cargo-source-package.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../../../../tools/packaging/portable-archive.mts';
import { packWasixToolsNpmCarrier } from '../../../../../postgres-tools/wasix/tools/wasix-tools-npm-carrier.mts';
import { packWasixToolsAotNpmCarriers } from '../../../../../postgres-tools/wasix/tools/wasix-tools-aot-npm.mts';
import { artifactTargets } from '../../../../../tools/release/release-artifact-targets.mts';
import { assertWasixTypescriptNpmArchive } from '../wasix-typescript-package.mts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const packageRoot = resolve(repositoryRoot, 'sdks/ts-wasix/sdk');
const assetRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix/assets');
const extensionAssetRoot = resolve(repositoryRoot, 'target/extensions/wasix/assets');
const nativeCarrierRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix-napi/npm-packages');
const databaseRootContractFile = resolve(
  repositoryRoot,
  'test-fixtures/storage/database-root.json',
);

export async function stagePackedWasixConsumer({
  scratch,
  consumerName = 'oliphaunt-wasix-node-consumer',
  includePgtap = false,
  includeTools = false,
  includeNative = true,
  includeSeed = false,
  includeResources = false,
  useStubRuntime = false,
}) {
  if (typeof scratch !== 'string' || !isAbsolute(scratch)) {
    throw new Error(
      'packed WASIX Node/Bun/Deno/Electron host fixture requires an absolute scratch directory',
    );
  }
  const releaseVersions = JSON.parse(
    await readFile(resolve(repositoryRoot, '.release-please-manifest.json'), 'utf8'),
  );
  const runtimeVersion = releaseVersions['runtimes/liboliphaunt-wasix'];
  const extensionVersion = releaseVersions['extensions/external/pgtap'];
  const tarballs = resolve(scratch, 'tarballs');
  await mkdir(tarballs, { recursive: true });

  const binding = await packedBinding();
  const queryFile = resolve(scratch, 'query.tgz');
  const queryEntries = readPortableArchiveEntries(queryFile);
  const queryManifest = queryEntries.get('package/package.json');
  if (!queryManifest?.isFile)
    throw new Error('Packed query dependency is missing its package manifest');
  const query = {
    ...JSON.parse(Buffer.from(queryManifest.data()).toString('utf8')),
    file: queryFile,
  };
  const nativeCarrier = includeNative
    ? await findNativeCarrier({
        nativeVersion: binding.nativeVersion,
        runtimeVersion,
      })
    : undefined;
  const toolsVersion = releaseVersions['postgres-tools/wasix'];
  const toolsCarrier = includeTools
    ? await packToolsCarrier({ scratch, tarballs, toolsVersion })
    : undefined;
  const toolsFacade = includeTools ? await findToolsFacade() : undefined;
  if (includePgtap && useStubRuntime) {
    throw new Error('the packed WASIX stub runtime cannot carry extensions');
  }
  const runtime = useStubRuntime
    ? await packStubRuntime({ scratch, tarballs, runtimeVersion })
    : await packRuntime({ scratch, tarballs, runtimeVersion });
  const extension = includePgtap
    ? await packPgtap({ scratch, tarballs, runtimeVersion, extensionVersion })
    : undefined;
  const toolsAot =
    includeTools && includeNative ? await packToolsAot({ scratch, toolsVersion }) : undefined;
  const resources = [];
  if (includeSeed || includeResources) {
    const version = releaseVersions['database-resources'];
    requireReleaseVersion(version, 'database-resources');
    for (const profile of includeResources ? ['standard', 'icu'] : ['standard']) {
      resources.push(
        await archivePackage(
          resolve(
            repositoryRoot,
            `target/database-resources/seed-carriers/npm/oliphaunt-seed-wasix-${profile}/oliphaunt-seed-wasix-${profile}-${version}.tgz`,
          ),
        ),
      );
    }
    if (includeResources)
      resources.push(
        await archivePackage(
          resolve(
            repositoryRoot,
            `target/release/npm-packages/oliphaunt-icu/oliphaunt-icu-${version}.tgz`,
          ),
        ),
      );
  }
  const consumer = resolve(scratch, 'consumer');
  await mkdir(consumer, { recursive: true });
  const dependencies = {
    [query.name]: pathToFileURL(query.file).href,
    [runtime.name]: pathToFileURL(runtime.file).href,
    [binding.name]: pathToFileURL(binding.file).href,
  };
  for (const resource of resources) dependencies[resource.name] = pathToFileURL(resource.file).href;
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
    overrides: dependencies,
  });
  return {
    consumer,
    packages: {
      query,
      resources,
      binding,
      runtime,
      ...(nativeCarrier === undefined ? {} : { nativeCarrier }),
      ...(extension === undefined ? {} : { extension }),
      ...(toolsCarrier === undefined ? {} : { toolsCarrier }),
      ...(toolsFacade === undefined ? {} : { toolsFacade }),
    },
  };
}

async function packStubRuntime({ scratch, tarballs, runtimeVersion }) {
  requireReleaseVersion(runtimeVersion, 'runtimes/liboliphaunt-wasix');
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

async function packedBinding() {
  const { version } = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  const file = resolve(
    repositoryRoot,
    `target/oliphaunt-wasix-ts/package/packages/oliphaunt-wasix-ts-${version}.tgz`,
  );
  const manifest = assertWasixTypescriptNpmArchive(file);
  const nativeVersion = manifest.oliphaunt?.wasixNapiVersion;
  requireReleaseVersion(nativeVersion, 'oliphaunt-wasix-napi');
  const bytes = await readFile(file);
  return {
    file,
    name: manifest.name,
    version: manifest.version,
    sha256: sha256(bytes),
    size: bytes.length,
    nativeVersion,
  };
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

async function archivePackage(file) {
  const entries = readPortableArchiveEntries(file);
  const row = entries.get('package/package.json');
  if (!row?.isFile) throw new Error(`Missing package manifest in ${file}`);
  const manifest = JSON.parse(Buffer.from(row.data()).toString('utf8'));
  const bytes = await readFile(file);
  return {
    file,
    name: manifest.name,
    version: manifest.version,
    sha256: sha256(bytes),
    size: bytes.length,
  };
}
async function packToolsCarrier({ scratch, tarballs, toolsVersion }) {
  requireReleaseVersion(toolsVersion, 'postgres-tools/wasix');
  const packed = packWasixToolsNpmCarrier({
    version: toolsVersion,
    portableReleaseArchive: resolve(
      repositoryRoot,
      `target/postgres-tools/wasix/release-assets/postgres-tools-wasix-${toolsVersion}-portable.tar.gz`,
    ),
    packageDir: resolve(scratch, 'tools-carrier'),
    tarballRoot: resolve(tarballs, 'tools'),
  });
  return archivePackage(packed.tarball);
}
async function packToolsAot({ scratch, toolsVersion }) {
  const target = artifactTargets('postgres-tools-wasix', 'wasix-tools-aot', 'packed-consumer').find(
    (row) => row.npmOs === platform() && row.npmCpu === arch(),
  );
  if (!target) throw new Error('No PostgreSQL tools AOT carrier for this host');
  const [file] = packWasixToolsAotNpmCarriers(
    toolsVersion,
    resolve(repositoryRoot, 'target/postgres-tools/wasix/release-assets'),
    { targetIds: [target.target], workRoot: resolve(scratch, 'tools-aot') },
  );
  return archivePackage(file);
}
async function findToolsFacade() {
  const root = resolve(repositoryRoot, 'target/sdk-artifacts/postgres-tools-wasix');
  const files = (await readdir(root)).filter((name) => name.endsWith('.tgz'));
  if (files.length !== 1) throw new Error('Expected one packaged PostgreSQL tools facade');
  return archivePackage(resolve(root, files[0]));
}

async function packRuntime({ scratch, tarballs, runtimeVersion }) {
  requireReleaseVersion(runtimeVersion, 'runtimes/liboliphaunt-wasix');
  const identity = await wasixPhysicalIdentity();
  const staging = resolve(scratch, 'runtime');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(assetRoot, 'manifest.json'), 'utf8'));
  const manifestPostgresMajor = Number(manifest.runtime?.['postgres-version']?.split('.')[0]);
  if (manifestPostgresMajor !== identity.postgresMajor) {
    throw new Error('WASIX runtime manifest disagrees with the shared physical identity');
  }
  const { ['cluster-seeds']: _retiredSeeds, ...runtimeManifest } = manifest;
  const coreManifest = Buffer.from(JSON.stringify({ ...runtimeManifest, extensions: [] }));
  const runtimeSource = resolve(assetRoot, manifest.runtime.archive);
  const runtimeBytes = await readFile(runtimeSource);
  requireDigest(runtimeBytes, manifest.runtime.sha256, manifest.runtime.archive);
  await cp(runtimeSource, resolve(staging, WASIX_RUNTIME_NPM_ASSET_PATHS.runtimeArchive));
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
  return pack(staging, tarballs);
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

async function packPgtap({ scratch, tarballs, runtimeVersion, extensionVersion }) {
  requireReleaseVersion(extensionVersion, 'extensions/external/pgtap');
  const staging = resolve(scratch, 'pgtap');
  const assets = resolve(staging, 'assets');
  await mkdir(assets, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extensionAssetRoot, 'manifest.json'), 'utf8'));
  const row = manifest.extensions.find((candidate) => candidate['sql-name'] === 'pgtap');
  if (row === undefined) throw new Error('WASIX manifest has no pgtap carrier');
  await cp(resolve(extensionAssetRoot, row.archive), resolve(assets, 'pgtap.tar.zst'));
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
  await cp(resolve(repositoryRoot, 'LICENSE'), resolve(directory, 'LICENSE'), { force: false });
  const file = resolve(
    tarballs,
    `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`,
  );
  const bytes = canonicalGzipSync(createDeterministicTar(directory, 'package', {}));
  await writeFile(file, bytes, { flag: 'wx' });
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [scratch, ...flags] = process.argv.slice(2);
  if (
    !scratch ||
    flags.some(
      (flag) => !['--pgtap', '--tools', '--without-native', '--stub-runtime'].includes(flag),
    )
  ) {
    throw new Error(
      'usage: packed-node-fixture.mts SCRATCH [--pgtap] [--tools] [--without-native] [--stub-runtime]',
    );
  }
  const fixture = await stagePackedWasixConsumer({
    scratch: resolve(scratch),
    includePgtap: flags.includes('--pgtap'),
    includeTools: flags.includes('--tools'),
    includeNative: !flags.includes('--without-native'),
    useStubRuntime: flags.includes('--stub-runtime'),
  });
  await writeJson(resolve(scratch, 'packed-consumer.json'), fixture);
}
