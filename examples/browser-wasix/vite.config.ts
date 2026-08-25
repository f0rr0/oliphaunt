import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(exampleRoot, '../..');
const bindingRoot = resolve(repositoryRoot, 'src/bindings/wasix-ts');
const bindingLibRoot = resolve(bindingRoot, 'lib');
const assetRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix/assets');
const pgliteAssetRoot = resolve(bindingRoot, 'node_modules/@electric-sql/pglite/dist');
const databaseRootContractFile = resolve(
  repositoryRoot,
  'src/shared/fixtures/storage/database-root.json',
);
const packedConsumerRoot = process.env.OLIPHAUNT_WASIX_BROWSER_PACKAGE_ROOT;
const packedConsumer = packedConsumerRoot === undefined ? undefined : resolve(packedConsumerRoot);
export default defineConfig({
  root: packedConsumer ?? exampleRoot,
  resolve: {
    ...(packedConsumer === undefined
      ? {
          alias: [
            {
              find: /^@oliphaunt\/wasix-tools$/,
              replacement: resolve(
                repositoryRoot,
                'src/bindings/wasix-ts/tools-package/src/index.ts',
              ),
            },
            {
              find: /^@oliphaunt\/wasix-ts\/internal\/tools$/,
              replacement: resolve(bindingLibRoot, 'internal.js'),
            },
            {
              find: /^@oliphaunt\/wasix-ts$/,
              replacement: resolve(bindingLibRoot, 'index.js'),
            },
            {
              find: /^@oliphaunt\/wasix-ts\/(.+)$/,
              replacement: `${bindingLibRoot}/$1.js`,
            },
          ],
        }
      : {
          alias: [
            {
              find: /^fzstd$/,
              replacement: createRequire(
                resolve(packedConsumer, 'node_modules/@oliphaunt/wasix-ts/package.json'),
              ).resolve('fzstd'),
            },
          ],
          dedupe: [
            '@oliphaunt/wasix-ts',
            '@oliphaunt/liboliphaunt-wasix',
            '@oliphaunt/wasix-tools',
            '@oliphaunt/liboliphaunt-wasix-tools',
            '@oliphaunt/extension-pgtap-wasix',
            'fzstd',
          ],
        }),
  },
  optimizeDeps: {
    ...(packedConsumer === undefined
      ? {}
      : {
          exclude: [
            '@oliphaunt/wasix-ts',
            '@oliphaunt/liboliphaunt-wasix',
            '@oliphaunt/wasix-tools',
            '@oliphaunt/liboliphaunt-wasix-tools',
            '@oliphaunt/extension-pgtap-wasix',
          ],
        }),
    esbuildOptions: {
      target: 'esnext',
    },
  },
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
  server: {
    fs: {
      allow: [repositoryRoot, ...(packedConsumer === undefined ? [] : [packedConsumer])],
    },
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  plugins:
    packedConsumer === undefined ? [wasixAssets()] : [packedBrowserPackageExports(packedConsumer)],
});

function packedBrowserPackageExports(consumerRoot: string): Plugin {
  const expected = new Map([
    ['@oliphaunt/wasix-ts', '/@oliphaunt/wasix-ts/lib/index.js'],
    ['@oliphaunt/wasix-ts/storage/indexed-db', '/@oliphaunt/wasix-ts/lib/storage/indexed-db.js'],
    ['@oliphaunt/liboliphaunt-wasix', '/@oliphaunt/liboliphaunt-wasix/index.js'],
    ['@oliphaunt/wasix-tools', '/@oliphaunt/wasix-tools/lib/index.js'],
    ['@oliphaunt/liboliphaunt-wasix-tools', '/@oliphaunt/liboliphaunt-wasix-tools/index.js'],
    ['@oliphaunt/extension-pgtap-wasix', '/@oliphaunt/extension-pgtap-wasix/index.js'],
  ]);
  return {
    name: 'oliphaunt-packed-browser-package-exports',
    enforce: 'pre',
    async resolveId(source, importer) {
      const suffix = expected.get(source);
      if (suffix === undefined) return undefined;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (resolved === null) {
        throw new Error(`packed browser consumer could not resolve ${source}`);
      }
      const id = resolved.id.split('?')[0]?.split('\\').join('/');
      if (id === undefined || !id.endsWith(suffix)) {
        throw new Error(
          `packed browser consumer resolved ${source} to ${resolved.id}, expected ${suffix}`,
        );
      }
      if (!id.includes('/node_modules/')) {
        throw new Error(`packed browser consumer did not load ${source} from its install`);
      }
      return resolved;
    },
    configResolved(config) {
      if (resolve(config.root) !== consumerRoot) {
        throw new Error('packed browser consumer did not become the Vite project root');
      }
    },
  };
}

function wasixAssets(): Plugin {
  const virtualModules = new Map([
    ['@oliphaunt/liboliphaunt-wasix', '\0oliphaunt:liboliphaunt-wasix'],
    ['@oliphaunt/liboliphaunt-wasix-tools', '\0oliphaunt:liboliphaunt-wasix-tools'],
    ['@oliphaunt/extension-pgtap-wasix', '\0oliphaunt:extension-pgtap-wasix'],
    ['@oliphaunt/extension-pg-uuidv7-wasix', '\0oliphaunt:extension-pg-uuidv7-wasix'],
    ['@oliphaunt/extension-postgis-wasix', '\0oliphaunt:extension-postgis-wasix'],
  ]);
  const packageByVirtualModule = new Map(
    [...virtualModules].map(([packageName, virtualModule]) => [virtualModule, packageName]),
  );
  const descriptorPromises = new Map<string, Promise<Record<string, unknown>>>();
  let runtimeIdentityPromise:
    | Promise<{ postgresMajor: number; physicalFormat: string }>
    | undefined;
  const routes = new Map([
    ['/runtime', resolve(assetRoot, 'oliphaunt.wasix.tar.zst')],
    ['/cluster-seed-standard', resolve(assetRoot, 'cluster-seeds/standard.tar.zst')],
    ['/cluster-seed-standard-manifest', resolve(assetRoot, 'cluster-seeds/standard.json')],
    ['/manifest', resolve(assetRoot, 'manifest.json')],
    ['/tools/pg_dump', resolve(assetRoot, 'bin/pg_dump.wasix.wasm')],
    ['/tools/psql', resolve(assetRoot, 'bin/psql.wasix.wasm')],
    ['/extensions/pgtap', resolve(assetRoot, 'extensions/pgtap.tar.zst')],
    ['/extensions/pg_uuidv7', resolve(assetRoot, 'extensions/pg_uuidv7.tar.zst')],
    ['/extensions/postgis', resolve(assetRoot, 'extensions/postgis.tar.zst')],
    ['/pglite.data', resolve(pgliteAssetRoot, 'pglite.data')],
    ['/pglite.wasm', resolve(pgliteAssetRoot, 'pglite.wasm')],
    ['/initdb.wasm', resolve(pgliteAssetRoot, 'initdb.wasm')],
  ]);
  return {
    name: 'oliphaunt-wasix-assets',
    enforce: 'pre',
    resolveId(id) {
      return virtualModules.get(id);
    },
    async load(id) {
      const packageName = packageByVirtualModule.get(id);
      if (packageName === undefined) {
        return undefined;
      }
      let descriptorPromise = descriptorPromises.get(packageName);
      if (descriptorPromise === undefined) {
        descriptorPromise = developmentDescriptor(packageName);
        descriptorPromises.set(packageName, descriptorPromise);
      }
      const descriptor = await descriptorPromise;
      let namedRuntimeExports = '';
      if (packageName === '@oliphaunt/liboliphaunt-wasix') {
        runtimeIdentityPromise ??= developmentWasixIdentity();
        const identity = await runtimeIdentityPromise;
        namedRuntimeExports =
          `export const POSTGRES_MAJOR = ${JSON.stringify(identity.postgresMajor)};\n` +
          `export const PHYSICAL_FORMAT = ${JSON.stringify(identity.physicalFormat)};\n`;
      }
      return (
        namedRuntimeExports +
        `const descriptor = Object.freeze(${JSON.stringify(descriptor)});\n` +
        'export { descriptor };\nexport default descriptor;\n'
      );
    },
    configureServer(server) {
      server.middlewares.use('/wasix-assets', async (request, response, next) => {
        const path = routes.get(request.url ?? '');
        if (path === undefined) {
          next();
          return;
        }
        try {
          const source = await readFile(path);
          const bytes = path.endsWith('manifest.json') ? coreManifest(source) : source;
          response.statusCode = 200;
          const contentType = path.endsWith('.json')
            ? 'application/json'
            : path.endsWith('.wasm')
              ? 'application/wasm'
              : path.endsWith('.data')
                ? 'application/octet-stream'
                : 'application/zstd';
          response.setHeader('Content-Type', contentType);
          response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          response.end(bytes);
        } catch (error) {
          response.statusCode = 500;
          response.end(
            `Missing WASIX assets. Run liboliphaunt-wasix:runtime-portable first.\n${String(error)}`,
          );
        }
      });
    },
  };
}

async function developmentWasixIdentity(): Promise<{
  postgresMajor: number;
  physicalFormat: string;
}> {
  const contract = JSON.parse(await readFile(databaseRootContractFile, 'utf8')) as Record<
    string,
    unknown
  >;
  const families = requireRecord(contract.families, 'database-root families');
  const wasix = requireRecord(families.wasix, 'database-root WASIX family');
  const postgresMajor = contract.postgresMajor;
  const physicalFormat = wasix.physicalFormat;
  if (!Number.isInteger(postgresMajor) || typeof physicalFormat !== 'string' || !physicalFormat) {
    throw new Error('shared database-root fixture has no valid WASIX physical identity');
  }
  return { postgresMajor: postgresMajor as number, physicalFormat };
}

async function developmentDescriptor(packageName: string): Promise<Record<string, unknown>> {
  const manifestBytes = await readFile(resolve(assetRoot, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const versions = JSON.parse(
    await readFile(resolve(repositoryRoot, '.release-please-manifest.json'), 'utf8'),
  ) as Record<string, string>;
  const runtimeVersion = requireVersion(versions, 'src/runtimes/liboliphaunt/wasix');

  if (packageName === '@oliphaunt/liboliphaunt-wasix') {
    const runtime = requireRecord(manifest.runtime, 'runtime manifest entry');
    const clusterSeeds = requireRecord(manifest['cluster-seeds'], 'cluster seed manifest entry');
    const standardSeed = requireRecord(clusterSeeds.standard, 'standard cluster seed entry');
    const runtimeBytes = await readFile(resolve(assetRoot, String(runtime.archive)));
    const standardSeedBytes = await readFile(resolve(assetRoot, String(standardSeed.archive)));
    const standardSeedManifestBytes = await readFile(
      resolve(assetRoot, String(standardSeed.manifest)),
    );
    const projectedManifest = coreManifest(manifestBytes);
    return {
      schema: 'oliphaunt-wasix-runtime-v2',
      runtime: 'wasix',
      product: 'liboliphaunt-wasix',
      version: runtimeVersion,
      runtimeArchive: {
        archive: runtime.archive,
        sha256: sha256(runtimeBytes),
        size: runtimeBytes.length,
        source: '/wasix-assets/runtime',
      },
      standardSeedArchive: {
        archive: standardSeed.archive,
        sha256: sha256(standardSeedBytes),
        size: standardSeedBytes.length,
        source: '/wasix-assets/cluster-seed-standard',
      },
      standardSeedManifest: {
        sha256: sha256(standardSeedManifestBytes),
        size: standardSeedManifestBytes.length,
        source: '/wasix-assets/cluster-seed-standard-manifest',
      },
      manifest: {
        sha256: sha256(projectedManifest),
        size: projectedManifest.length,
        source: '/wasix-assets/manifest',
      },
    };
  }

  if (packageName === '@oliphaunt/liboliphaunt-wasix-tools') {
    const pgDump = requireRecord(manifest['pg-dump'], 'pg_dump manifest entry');
    const psql = requireRecord(manifest.psql, 'psql manifest entry');
    return {
      schema: 'oliphaunt-wasix-tools-v1',
      product: 'oliphaunt-wasix-tools',
      version: runtimeVersion,
      runtimeProduct: 'liboliphaunt-wasix',
      runtimeVersion,
      pgDump: {
        name: 'pg_dump',
        sha256: pgDump.sha256,
        size: pgDump.size,
        source: '/wasix-assets/tools/pg_dump',
      },
      psql: {
        name: 'psql',
        sha256: psql.sha256,
        size: psql.size,
        source: '/wasix-assets/tools/psql',
      },
    };
  }

  const extension = extensionPackage(packageName);
  const rows = manifest.extensions;
  if (!Array.isArray(rows)) {
    throw new Error('canonical development manifest has no extension rows');
  }
  const row = rows.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === 'object' &&
      (candidate as Record<string, unknown>)['sql-name'] === extension.sqlName,
  );
  const metadata = requireRecord(row, `${extension.sqlName} manifest entry`);
  const lifecycle = requireRecord(metadata.lifecycle, `${extension.sqlName} lifecycle`);
  const version = requireVersion(versions, extension.releasePath);
  const carrier = {
    product: extension.product,
    version,
    sqlName: extension.sqlName,
    archive: metadata.archive,
    sha256: metadata.sha256,
    size: metadata.size,
    source: `/wasix-assets/extensions/${extension.sqlName}`,
    install: {
      schema: 'oliphaunt-wasix-extension-install-v1',
      name: metadata.name,
      nativeModule: metadata['native-module'] ?? null,
      nativeModules: requireArray(metadata['native-modules'], 'native modules').map((value) => {
        const module = requireRecord(value, 'native module');
        return {
          name: module.name,
          path: module.path,
          sha256: module.sha256,
          moduleSha256: module['module-sha256'],
          size: module.size,
        };
      }),
      dependencies: metadata.dependencies,
      coreExportsRequired: metadata['core-exports-required'],
      loadOrder: metadata['load-order'],
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
      installedFiles: metadata['installed-files'],
      unresolvedImports: requireArray(metadata['unresolved-imports'], 'unresolved imports').map(
        (value) => {
          const entry = requireRecord(value, 'unresolved import');
          return { module: entry.module, name: entry.name, kind: entry.kind };
        },
      ),
    },
  };
  return {
    schema: 'oliphaunt-wasix-extension-v1',
    runtime: 'wasix',
    product: extension.product,
    version,
    compatibility: {
      extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
      postgresMajor: '18',
      wasixRuntimeProduct: 'liboliphaunt-wasix',
      wasixRuntimeVersion: runtimeVersion,
    },
    sqlName: extension.sqlName,
    carriers: [carrier],
  };
}

function extensionPackage(packageName: string): {
  product: string;
  releasePath: string;
  sqlName: string;
} {
  switch (packageName) {
    case '@oliphaunt/extension-pgtap-wasix':
      return {
        product: 'oliphaunt-extension-pgtap',
        releasePath: 'src/extensions/external/pgtap',
        sqlName: 'pgtap',
      };
    case '@oliphaunt/extension-pg-uuidv7-wasix':
      return {
        product: 'oliphaunt-extension-pg-uuidv7',
        releasePath: 'src/extensions/external/pg_uuidv7',
        sqlName: 'pg_uuidv7',
      };
    case '@oliphaunt/extension-postgis-wasix':
      return {
        product: 'oliphaunt-extension-postgis',
        releasePath: 'src/extensions/external/postgis',
        sqlName: 'postgis',
      };
    default:
      throw new Error(`unsupported development WASIX package ${packageName}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireVersion(versions: Record<string, string>, productPath: string): string {
  const version = versions[productPath];
  if (version === undefined) {
    throw new Error(`missing release version for ${productPath}`);
  }
  return version;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function coreManifest(bytes: Uint8Array): Uint8Array {
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  manifest.extensions = [];
  delete manifest['pg-dump'];
  delete manifest.psql;
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}
