import { defineWasixExtension } from '../extension-descriptor.js';

export const hstore = defineWasixExtension({
  schema: 'oliphaunt-wasix-extension-v1',
  runtime: 'wasix',
  product: 'oliphaunt-extension-contrib-pg18',
  version: '0.1.1',
  sqlName: 'hstore',
  compatibility: {
    extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
    postgresMajor: '18',
    wasixRuntimeProduct: 'liboliphaunt-wasix',
    wasixRuntimeVersion: '0.1.1',
  },
  carriers: [
    {
      product: 'oliphaunt-extension-contrib-pg18',
      version: '0.1.1',
      sqlName: 'hstore',
      archive: 'extensions/hstore.tar.zst',
      source: '/extensions/hstore.tar.zst',
      sha256: '2'.repeat(64),
      size: 100,
      install: {
        schema: 'oliphaunt-wasix-extension-install-v1',
        name: 'hstore',
        nativeModule: null,
        nativeModules: [],
        dependencies: [],
        coreExportsRequired: [],
        loadOrder: [],
        unresolvedImports: [],
        installedFiles: ['share/postgresql/extension/hstore.control'],
        lifecycle: {
          createExtension: true,
          createSchema: 'pg_catalog',
          loadSql: [],
          postCreateSql: [],
          startupConfig: [],
          preloadRequired: false,
          restartRequired: false,
          sharedMemoryRequired: false,
        },
      },
    },
  ],
});
