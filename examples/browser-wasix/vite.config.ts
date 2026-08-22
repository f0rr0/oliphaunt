import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(exampleRoot, '../..');
const bindingRoot = resolve(repositoryRoot, 'src/bindings/wasix-ts');
const bindingLibRoot = resolve(bindingRoot, 'lib');
const assetRoot = resolve(repositoryRoot, 'target/oliphaunt-wasix/assets');
const pgliteAssetRoot = resolve(bindingRoot, 'node_modules/@electric-sql/pglite/dist');
const packedConsumerRoot = process.env.OLIPHAUNT_WASIX_BROWSER_PACKAGE_ROOT;
const packedConsumer = packedConsumerRoot === undefined ? undefined : resolve(packedConsumerRoot);
export default defineConfig({
  root: packedConsumer ?? exampleRoot,
  resolve: {
    ...(packedConsumer === undefined
      ? {
          alias: [
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
          dedupe: [
            '@oliphaunt/wasix-ts',
            '@oliphaunt/liboliphaunt-wasix',
            '@oliphaunt/extension-pgtap-wasix',
            'fzstd',
          ],
        }),
  },
  optimizeDeps: {
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
    ['@oliphaunt/extension-pgtap-wasix', '\0oliphaunt:extension-pgtap-wasix'],
    ['@oliphaunt/extension-pg-uuidv7-wasix', '\0oliphaunt:extension-pg-uuidv7-wasix'],
    ['@oliphaunt/extension-postgis-wasix', '\0oliphaunt:extension-postgis-wasix'],
  ]);
  const packageByVirtualModule = new Map(
    [...virtualModules].map(([packageName, virtualModule]) => [virtualModule, packageName]),
  );
  const descriptorPromises = new Map<string, Promise<Record<string, unknown>>>();
  const routes = new Map([
    ['/runtime', resolve(assetRoot, 'oliphaunt.wasix.tar.zst')],
    ['/pgdata', resolve(assetRoot, 'prepopulated/pgdata-template.tar.zst')],
    ['/manifest', resolve(assetRoot, 'manifest.json')],
    ['/extensions/pgtap', resolve(assetRoot, 'extensions/pgtap.tar.zst')],
    ['/extensions/pg_uuidv7', resolve(assetRoot, 'extensions/pg_uuidv7.tar.zst')],
    ['/extensions/postgis', resolve(assetRoot, 'extensions/postgis.tar.zst')],
    ['/pglite.data', resolve(pgliteAssetRoot, 'pglite.data')],
    ['/pglite.wasm', resolve(pgliteAssetRoot, 'pglite.wasm')],
    ['/initdb.wasm', resolve(pgliteAssetRoot, 'initdb.wasm')],
  ]);
  return {
    name: 'oliphaunt-wasix-assets',
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
      const namedRuntimeExports =
        packageName === '@oliphaunt/liboliphaunt-wasix'
          ? 'export const POSTGRES_MAJOR = 18;\nexport const PHYSICAL_FORMAT = "wasix-pg18-v1";\n'
          : '';
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

async function developmentDescriptor(packageName: string): Promise<Record<string, unknown>> {
  const manifestBytes = await readFile(resolve(assetRoot, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
  const versions = JSON.parse(
    await readFile(resolve(repositoryRoot, '.release-please-manifest.json'), 'utf8'),
  ) as Record<string, string>;
  const runtimeVersion = requireVersion(versions, 'src/runtimes/liboliphaunt/wasix');

  if (packageName === '@oliphaunt/liboliphaunt-wasix') {
    const runtime = requireRecord(manifest.runtime, 'runtime manifest entry');
    const pgdata = requireRecord(manifest['pgdata-template'], 'PGDATA manifest entry');
    const runtimeBytes = await readFile(resolve(assetRoot, String(runtime.archive)));
    const pgdataBytes = await readFile(resolve(assetRoot, String(pgdata.archive)));
    const projectedManifest = coreManifest(manifestBytes);
    return {
      schema: 'oliphaunt-wasix-runtime-v1',
      runtime: 'wasix',
      product: 'liboliphaunt-wasix',
      version: runtimeVersion,
      runtimeArchive: {
        archive: runtime.archive,
        sha256: sha256(runtimeBytes),
        size: runtimeBytes.length,
        source: '/wasix-assets/runtime',
      },
      pgdataArchive: {
        archive: pgdata.archive,
        sha256: sha256(pgdataBytes),
        size: pgdataBytes.length,
        source: '/wasix-assets/pgdata',
      },
      manifest: {
        sha256: sha256(projectedManifest),
        size: projectedManifest.length,
        source: '/wasix-assets/manifest',
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
