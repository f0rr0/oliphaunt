import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { ExtractedArchive, WasixRuntimeLayout } from '../archive.js';
import {
  assertExactCarrierClosure,
  assertExtensionCarriersCompatible,
  assertRuntimeDescriptorMatchesManifest,
  assertClusterSeedProfileContract,
  mergeExtensionStartupGUCs,
  overlayExtensionArchive,
  overlayIcuArchive,
  parseWasixAssetManifest,
  resolveWasixExtensions,
} from '../extensions.js';
import type { SerializedExtensionCarrier, SerializedRuntimeDescriptor } from '../rpc.js';
import type { WasixAssetManifest } from '../types.js';

type ProjectedExtension = ReturnType<typeof resolveWasixExtensions>['extensions'][number];
type ProjectedLifecycle = ProjectedExtension['lifecycle'];

// liboliphaunt-doc-example:wasix-typescript-extensions
describe('WASIX TypeScript extensions', () => {
  it('uses the shared cluster-seed profile fixtures', () => {
    const standard = sharedSeedFixture('standard.valid.json');
    const icu = sharedSeedFixture('icu.valid.json');
    const mismatch = sharedSeedFixture('profile-mismatch.invalid.json');

    expect(() => assertClusterSeedProfileContract(standard, 'standard')).not.toThrow();
    expect(() => assertClusterSeedProfileContract(icu, 'icu')).not.toThrow();
    expect(() => assertClusterSeedProfileContract(mismatch, 'standard')).toThrow(
      'profile mismatch',
    );
  });

  it('validates the complete ICU overlay before mutating the runtime', () => {
    const runtime: ExtractedArchive = {
      files: new Map(),
      directories: new Set(),
    };
    const icu: ExtractedArchive = {
      files: new Map([['share/icu/icudt76l.dat', Uint8Array.of(1)]]),
      directories: new Set(['share/icu', 'outside']),
    };

    expect(() => overlayIcuArchive(runtime, icu)).toThrow('directory outside share/icu');
    expect(runtime.files.size).toBe(0);
    expect(runtime.directories.size).toBe(0);
  });

  it('resolves pgtap through the canonical manifest and runtime-provided plpgsql', () => {
    const pgtap = extension('pgtap', {
      dependencies: ['plpgsql'],
      schema: 'pg_catalog',
      installedFiles: [
        'share/postgresql/extension/pgtap.control',
        'share/postgresql/extension/pgtap--1.3.3.sql',
      ],
    });
    const resolved = resolveWasixExtensions(manifest(), carrierMap(pgtap), ['pgtap']);

    expect(resolved).toEqual({
      extensions: [pgtap],
      runtimeDependencies: ['plpgsql'],
    });
  });

  it('orders selected extension carriers after their manifest dependencies', () => {
    const cube = extension('cube');
    const earthdistance = extension('earthdistance', {
      dependencies: ['cube'],
    });

    expect(
      resolveWasixExtensions(manifest(), carrierMap(earthdistance, cube), [
        'earthdistance',
      ]).extensions.map((entry) => entry['sql-name']),
    ).toEqual(['cube', 'earthdistance']);
  });

  it('rejects cyclic dependencies and duplicate canonical manifest identities', () => {
    const first = extension('first', { dependencies: ['second'] });
    const second = extension('second', { dependencies: ['first'] });
    expect(() => resolveWasixExtensions(manifest(), carrierMap(first, second), ['first'])).toThrow(
      "cyclic WASIX extension dependency involving 'first'",
    );

    const runtimeOwned = { ...manifest(), extensions: [extension('pgtap')] };
    expect(() =>
      parseWasixAssetManifest(new TextEncoder().encode(JSON.stringify(runtimeOwned))),
    ).toThrow('core asset manifest must not contain extension rows');
  });

  it('resolves install metadata exclusively from an imported carrier', () => {
    const pgtap = extension('pgtap');
    const resolved = resolveWasixExtensions(manifest(), carrierMap(pgtap), ['pgtap']);
    expect(resolved.extensions).toEqual([pgtap]);
    expect(() => resolveWasixExtensions(manifest(), {}, ['pgtap'])).toThrow(
      'has no imported carrier',
    );
  });

  it('does not let imported carriers replace core runtime support', () => {
    const pgtap = extension('pgtap', { dependencies: ['plpgsql'] });
    const shadow = extension('plpgsql');

    expect(() => resolveWasixExtensions(manifest(), carrierMap(pgtap, shadow), ['pgtap'])).toThrow(
      "carrier 'plpgsql' cannot replace runtime-provided support",
    );
  });

  it('requires the imported carrier closure to equal manifest-resolved extensions', () => {
    const cube = extension('cube');
    const earthdistance = extension('earthdistance', {
      dependencies: ['cube'],
    });
    const resolved = resolveWasixExtensions(manifest(), carrierMap(earthdistance, cube), [
      'earthdistance',
    ]);
    const cubeCarrier = serializedCarrier(cube);
    const earthdistanceCarrier = serializedCarrier(earthdistance);

    expect(() =>
      assertExactCarrierClosure(resolved.extensions, {
        cube: cubeCarrier,
        earthdistance: earthdistanceCarrier,
      }),
    ).not.toThrow();
    expect(() =>
      assertExactCarrierClosure(resolved.extensions, {
        earthdistance: earthdistanceCarrier,
      }),
    ).toThrow('missing cube');
    expect(() =>
      assertExactCarrierClosure(resolved.extensions, {
        cube: cubeCarrier,
        earthdistance: earthdistanceCarrier,
        unrelated: { ...cubeCarrier, archive: 'extensions/unrelated.tar.zst' },
      }),
    ).toThrow('unexpected unrelated');
  });

  it('gates imported carriers on runtime identity, PostgreSQL major, and core exports', () => {
    const carrier = serializedCarrier(extension('native'));
    carrier.install.coreExportsRequired = ['required_export'];
    const core = manifest();
    core.runtime.link.exports = [{ name: 'required_export', kind: 'func' }];

    expect(() =>
      assertExtensionCarriersCompatible(runtimeDescriptor(), core, {
        native: carrier,
      }),
    ).not.toThrow();
    expect(() =>
      assertExtensionCarriersCompatible(runtimeDescriptor(), core, {
        native: {
          ...carrier,
          compatibility: {
            ...carrier.compatibility,
            wasixRuntimeVersion: '0.2.0',
          },
        },
      }),
    ).toThrow('targets liboliphaunt-wasix@0.2.0');
    expect(() =>
      assertExtensionCarriersCompatible(runtimeDescriptor(), core, {
        native: {
          ...carrier,
          install: {
            ...carrier.install,
            coreExportsRequired: ['missing_export'],
          },
        },
      }),
    ).toThrow('requires exports absent from the selected core runtime: missing_export');
  });

  it('requires runtime carrier archive identities to match the core manifest', () => {
    expect(() =>
      assertRuntimeDescriptorMatchesManifest(runtimeDescriptor(), manifest()),
    ).not.toThrow();
    expect(() =>
      assertRuntimeDescriptorMatchesManifest(
        {
          ...runtimeDescriptor(),
          standardSeedArchive: { ...runtimeDescriptor().standardSeedArchive, size: 101 },
        },
        manifest(),
      ),
    ).toThrow('standard cluster seed archive size does not match the canonical manifest');
  });

  it('materializes declared native load order and fails closed on shared-memory requirements', () => {
    const ordered = extension('ordered', {
      installedFiles: ['share/postgresql/extension/ordered.control', 'lib/postgresql/ordered.so'],
      loadOrder: ['lib/postgresql/ordered.so'],
    });
    expect(
      resolveWasixExtensions(manifest(), carrierMap(ordered), ['ordered']).extensions[0]?.[
        'load-order'
      ],
    ).toEqual(['lib/postgresql/ordered.so']);

    const shared = extension('shared', { sharedMemoryRequired: true });
    expect(() => resolveWasixExtensions(manifest(), carrierMap(shared), ['shared'])).toThrow(
      'requires shared-memory behavior that the @oliphaunt/wasix-ts host has not qualified',
    );
  });

  it('merges shared preloads and rejects conflicting scalar startup settings', () => {
    const first = extension('first', {
      startupConfig: ['shared_preload_libraries=first', 'first.mode=safe'],
    });
    const second = extension('second', {
      startupConfig: ['shared_preload_libraries=second,first'],
    });

    expect(
      mergeExtensionStartupGUCs({ shared_preload_libraries: 'caller', 'first.mode': 'safe' }, [
        first,
        second,
      ]),
    ).toEqual({
      shared_preload_libraries: 'caller,first,second',
      'first.mode': 'safe',
    });
    expect(() => mergeExtensionStartupGUCs({ 'first.mode': 'fast' }, [first])).toThrow(
      'requires first.mode=safe',
    );
  });

  it('overlays only exact manifest-declared extension files into canonical mounts', () => {
    const pgtap = extension('pgtap', {
      installedFiles: [
        'share/postgresql/extension/pgtap.control',
        'share/postgresql/extension/pgtap--1.3.3.sql',
      ],
    });
    const layout = runtimeLayout();
    const archive: ExtractedArchive = {
      files: new Map([
        ['share/postgresql/extension/pgtap.control', Uint8Array.of(1)],
        ['share/postgresql/extension/pgtap--1.3.3.sql', Uint8Array.of(2)],
      ]),
      directories: new Set(['share', 'share/postgresql', 'share/postgresql/extension']),
    };

    overlayExtensionArchive(layout, archive, pgtap);

    expect(layout.mounts['/share']?.files['postgresql/extension/pgtap.control']).toEqual(
      Uint8Array.of(1),
    );
    expect(layout.mounts['/share']?.files['postgresql/extension/pgtap--1.3.3.sql']).toEqual(
      Uint8Array.of(2),
    );
  });

  it('rejects undeclared, foreign-root, and colliding extension files', () => {
    const layout = runtimeLayout();
    const declared = extension('pgtap', {
      installedFiles: ['share/postgresql/extension/pgtap.control'],
    });
    expect(() =>
      overlayExtensionArchive(
        layout,
        {
          files: new Map([
            ['share/postgresql/extension/pgtap.control', Uint8Array.of(1)],
            ['share/postgresql/extension/undeclared.sql', Uint8Array.of(2)],
          ]),
          directories: new Set(),
        },
        declared,
      ),
    ).toThrow('unexpected share/postgresql/extension/undeclared.sql');

    const foreign = extension('foreign', { installedFiles: ['bin/foreign'] });
    expect(() =>
      overlayExtensionArchive(
        runtimeLayout(),
        {
          files: new Map([['bin/foreign', Uint8Array.of(1)]]),
          directories: new Set(),
        },
        foreign,
      ),
    ).toThrow('non-canonical install path bin/foreign');

    const collision = extension('collision', {
      installedFiles: ['share/postgresql/extension/plpgsql.control'],
    });
    expect(() =>
      overlayExtensionArchive(
        runtimeLayout(),
        {
          files: new Map([['share/postgresql/extension/plpgsql.control', Uint8Array.of(9)]]),
          directories: new Set(),
        },
        collision,
      ),
    ).toThrow('collides with installed file share/postgresql/extension/plpgsql.control');
  });

  it('parses the host-relevant canonical generated manifest shape', () => {
    const expected = manifest();
    const parsed = parseWasixAssetManifest(new TextEncoder().encode(JSON.stringify(expected)));
    expect(parsed.extensions).toEqual([]);

    const invalid = { ...expected, 'format-version': 1 };
    expect(() =>
      parseWasixAssetManifest(new TextEncoder().encode(JSON.stringify(invalid))),
    ).toThrow('format-version 2');

    const missingFingerprint = { ...expected, 'source-fingerprint': undefined };
    expect(() =>
      parseWasixAssetManifest(new TextEncoder().encode(JSON.stringify(missingFingerprint))),
    ).toThrow('WASIX asset source fingerprint');
  });
});

type ExtensionOptions = {
  createExtension?: boolean;
  dependencies?: string[];
  installedFiles?: string[];
  loadOrder?: string[];
  schema?: string;
  sharedMemoryRequired?: boolean;
  startupConfig?: string[];
};

function extension(
  sqlName: string,
  {
    createExtension = true,
    dependencies = [],
    installedFiles = [`share/postgresql/extension/${sqlName}.control`],
    loadOrder = [],
    schema,
    sharedMemoryRequired = false,
    startupConfig = [],
  }: ExtensionOptions = {},
): ProjectedExtension {
  const lifecycle: ProjectedLifecycle = {
    'create-extension': createExtension,
    'create-schema': schema ?? null,
    'load-sql': [],
    'post-create-sql': [],
    'startup-config': startupConfig,
    'shared-memory-required': sharedMemoryRequired,
  };
  return {
    name: sqlName,
    'sql-name': sqlName,
    archive: `extensions/${sqlName}.tar.zst`,
    sha256: '2'.repeat(64),
    size: 100,
    'native-module': null,
    'native-modules': [],
    dependencies,
    'load-order': loadOrder,
    lifecycle,
    'installed-files': installedFiles,
    'unresolved-imports': [],
  };
}

function serializedCarrier(extension: ProjectedExtension): SerializedExtensionCarrier {
  return {
    product: `oliphaunt-extension-${extension.name.replaceAll('_', '-')}`,
    version: '0.1.1',
    sqlName: extension['sql-name'],
    archive: extension.archive,
    sha256: extension.sha256,
    size: extension.size,
    source: `/${extension.name}.tar.zst`,
    compatibility: {
      extensionRuntimeContract: 'oliphaunt-extension-runtime-contract-v1',
      postgresMajor: '18',
      wasixRuntimeProduct: 'liboliphaunt-wasix',
      wasixRuntimeVersion: '0.1.1',
    },
    install: {
      schema: 'oliphaunt-wasix-extension-install-v1',
      name: extension.name,
      nativeModule: extension['native-module'] ?? null,
      nativeModules: [],
      dependencies: [...extension.dependencies],
      coreExportsRequired: [],
      loadOrder: [...extension['load-order']],
      lifecycle: {
        createExtension: extension.lifecycle['create-extension'],
        createSchema: extension.lifecycle['create-schema'] ?? null,
        loadSql: [...extension.lifecycle['load-sql']],
        postCreateSql: [...extension.lifecycle['post-create-sql']],
        startupConfig: [...extension.lifecycle['startup-config']],
        preloadRequired: extension.lifecycle['startup-config'].length > 0,
        restartRequired: extension.lifecycle['startup-config'].length > 0,
        sharedMemoryRequired: extension.lifecycle['shared-memory-required'],
      },
      installedFiles: [...extension['installed-files']],
      unresolvedImports: [],
    },
  };
}

function carrierMap(
  ...extensions: readonly ProjectedExtension[]
): Record<string, SerializedExtensionCarrier> {
  return Object.fromEntries(
    extensions.map((extension) => [extension['sql-name'], serializedCarrier(extension)]),
  );
}

function manifest(): WasixAssetManifest {
  return {
    'format-version': 2,
    'source-fingerprint': 'postgres-source-fingerprint',
    runtime: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '0'.repeat(64),
      'module-sha256': '1'.repeat(64),
      'postgres-version': '18.4',
      link: { exports: [] },
    },
    'runtime-support': [
      {
        name: 'plpgsql',
        path: 'lib/postgresql/plpgsql.so',
        sha256: '3'.repeat(64),
      },
    ],
    'cluster-seeds': {
      standard: {
        'artifact-role': 'cluster-seed-standard',
        'catalog-profile': 'standard',
        archive: 'cluster-seeds/standard.tar.zst',
        manifest: 'cluster-seeds/standard.json',
        sha256: '4'.repeat(64),
        size: 100,
        'runtime-module-sha256': '1'.repeat(64),
        'source-fingerprint': 'postgres-source-fingerprint',
        'postgres-version': '18',
        'physical-format': 'wasix-pg18-v1',
        'compatibility-key': 'wasix-pg18-datum32-v1',
      },
      icu: {
        'artifact-role': 'cluster-seed-icu',
        'catalog-profile': 'icu',
        archive: 'cluster-seeds/icu.tar.zst',
        manifest: 'cluster-seeds/icu.json',
        sha256: '6'.repeat(64),
        size: 101,
        'runtime-module-sha256': '1'.repeat(64),
        'source-fingerprint': 'postgres-source-fingerprint',
        'postgres-version': '18',
        'physical-format': 'wasix-pg18-v1',
        'compatibility-key': 'wasix-pg18-datum32-v1',
        'icu-data-tree-sha256': '7'.repeat(64),
      },
    },
    extensions: [],
  };
}

function runtimeDescriptor(): SerializedRuntimeDescriptor {
  return {
    schema: 'oliphaunt-wasix-runtime-v2',
    runtime: 'wasix',
    product: 'liboliphaunt-wasix',
    version: '0.1.1',
    runtimeArchive: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: '0'.repeat(64),
      size: 100,
      source: '/runtime.tar.zst',
    },
    standardSeedArchive: {
      archive: 'cluster-seeds/standard.tar.zst',
      sha256: '4'.repeat(64),
      size: 100,
      source: '/standard-seed.tar.zst',
    },
    standardSeedManifest: {
      sha256: '8'.repeat(64),
      size: 100,
      source: '/standard-seed.json',
    },
    manifest: {
      sha256: '5'.repeat(64),
      size: 100,
      source: '/manifest.json',
    },
  };
}

function runtimeLayout(): WasixRuntimeLayout {
  return {
    module: Uint8Array.of(0, 97, 115, 109),
    mounts: {
      '/lib': { files: {}, directories: ['postgresql'] },
      '/share': {
        files: {
          'postgresql/postgres.bki': Uint8Array.of(1),
          'postgresql/extension/plpgsql.control': Uint8Array.of(2),
        },
        directories: ['postgresql', 'postgresql/extension'],
      },
    },
  };
}

function sharedSeedFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../shared/cluster-seed-contract/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
}
