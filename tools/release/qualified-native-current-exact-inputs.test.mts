import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import { releaseZstdCompressSync } from '../packaging/portable-archive.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import { loadReleaseMetadata } from './bazel-release-metadata.mts';
import {
  deriveQualifiedNativeCurrentExactInputs,
  inspectNativeCurrentExactInputs,
} from './qualified-native-current-exact-inputs.mts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const extensionFixtureDirectories: string[] = [];
afterEach(() => {
  for (const directory of extensionFixtureDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
/** Controlled archives have real manifest/module digests, never authenticated producer status. */
function fixture() {
  const metadata = loadReleaseMetadata(path.resolve(import.meta.dir, '../..'));
  const version = metadata.products['liboliphaunt-wasix'].version;
  metadata.databaseResourceWasixConsumer = { source: 'current', version };
  const module = Buffer.from('controlled WASIX consuming module');
  const runtime = releaseZstdCompressSync(
    gunzipSync(tarArchive([{ name: 'oliphaunt/bin/postgres', data: module }])),
  );
  const manifest = {
    'format-version': 2,
    'source-fingerprint': 'controlled current source',
    runtime: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: sha(runtime),
      size: runtime.length,
      'module-sha256': sha(module),
      'postgres-version': '18.4',
      link: { exports: [] },
    },
    'runtime-support': [],
    extensions: [],
  };
  const bytes = releaseZstdCompressSync(
    gunzipSync(
      tarArchive([
        { name: WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive, data: runtime },
        { name: WASIX_PORTABLE_RELEASE_MEMBERS.manifest, data: JSON.stringify(manifest) },
      ]),
    ),
  );
  const core = {
    path: 'bazel-out/core/public.tar.zst',
    label: '//core:public',
    size: bytes.length,
    sha256: sha(bytes),
  };
  const files = new Map([[core.path, bytes]]);
  const descriptors = metadata.databaseResourceArtifacts
    .filter((row) => row.kind === 'wasix-seeds' && String(row.asset).endsWith('.json'))
    .map((row) => {
      const profile = String(row.asset).includes('-standard.') ? 'standard' : 'icu';
      const descriptor = {
        catalogProfile: profile,
        runtime: {
          engineFamily: 'wasix',
          target: 'portable',
          version,
          consumerSha256: sha(module),
          producerSha256: 'b'.repeat(64),
        },
      };
      const data = Buffer.from(JSON.stringify(descriptor));
      const qualified = {
        path: `bazel-out/resources/${profile}.json`,
        label: `//resources:${profile}`,
        size: data.length,
        sha256: sha(data),
      };
      files.set(qualified.path, data);
      return {
        id: `github-release:${String(row.asset).replace('{version}', metadata.products['database-resources'].version)}`,
        qualifiedFiles: [qualified],
        kind: 'wasix-seeds',
        target: 'portable',
      };
    });
  const observation = {
    products: [
      {
        product: metadata.products['liboliphaunt-wasix'],
        productArtifacts: [
          {
            kind: 'wasix-runtime',
            target: 'portable',
            role: 'github-release-asset',
            qualifiedFiles: [core],
          },
        ],
      },
      { product: metadata.products['database-resources'], productArtifacts: descriptors },
    ],
  } as any;
  const suppliers = descriptors.map((row) => ({
    consumer: 'database-resources',
    product: 'liboliphaunt-wasix',
    version,
    configuration: 'portable',
    root: row.qualifiedFiles[0].label,
    binding: 'abi-contract',
    origin: { kind: 'current-source' },
    files: [{ path: 'bazel-out/core/raw.tar.zst' }],
  })) as any;
  return {
    metadata,
    observation,
    suppliers,
    files,
    readOutput: (file: any) => files.get(file.path)!,
    inputIdentity: () => ({ size: core.size, sha256: core.sha256 }),
  };
}

test('both exact current profile descriptors bind the actual archive module and retain original creator identity', () => {
  const value = fixture();
  expect(inspectNativeCurrentExactInputs(value)).toEqual([
    { product: 'database-resources', sourceProduct: 'liboliphaunt-wasix' },
  ]);
  const descriptor = JSON.parse(value.files.get('bazel-out/resources/standard.json')!.toString());
  expect(descriptor.runtime.producerSha256).not.toBe(descriptor.runtime.consumerSha256);
  value.metadata.databaseResourceWasixConsumer = {
    ...value.metadata.databaseResourceWasixConsumer!,
    source: 'completed',
  };
  expect(inspectNativeCurrentExactInputs(value)).toEqual([]);
});
for (const fault of ['one-profile', 'wrong-module', 'held-origin', 'wrong-input', 'wrong-version'])
  test(`current exact consumer fails closed: ${fault}`, () => {
    const value = fixture();
    if (fault === 'one-profile') value.observation.products[1].productArtifacts.pop();
    if (fault === 'wrong-module') {
      const descriptor = JSON.parse(value.files.get('bazel-out/resources/icu.json')!.toString());
      descriptor.runtime.consumerSha256 = 'f'.repeat(64);
      value.files.set('bazel-out/resources/icu.json', Buffer.from(JSON.stringify(descriptor)));
    }
    if (fault === 'held-origin') value.suppliers[1].origin.kind = 'completed-publication';
    if (fault === 'wrong-input')
      value.inputIdentity = () => ({ size: 123, sha256: 'f'.repeat(64) });
    if (fault === 'wrong-version')
      value.metadata.databaseResourceWasixConsumer = {
        ...value.metadata.databaseResourceWasixConsumer!,
        version: '1.2.3',
      };
    expect(() => inspectNativeCurrentExactInputs(value)).toThrow();
  });
test('physical construction data and copied JSON origins cannot mint a controller association', () => {
  const value = fixture();
  const origin = {
    evidence: { source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, cohorts: [] },
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
  };
  const preparation = {
    origins: new Map([['/tmp/fake', origin]]),
    observation: { ...value.observation, authenticated: [{ origin, evidence: origin.evidence }] },
    suppliers: { suppliers: value.suppliers, buildBound: new Map(), unknowns: [] },
  } as any;
  expect(() => deriveQualifiedNativeCurrentExactInputs(preparation, value.metadata)).toThrow(
    'authenticated producer transport',
  );
});

function extensionFixture() {
  const metadata = loadReleaseMetadata(path.resolve(import.meta.dir, '../..'));
  const producer = 'liboliphaunt-wasix';
  const sqlName = 'pg_textsearch';
  const canonical = metadata.extensionReleaseMetadata.find(
    (row) => row.class === 'external' && row.sqlName === sqlName,
  ) as any;
  const consumer = canonical.product;
  const version = metadata.products[producer].version;
  canonical.compatibility.wasixRuntimeVersion = version;
  metadata.databaseResourceWasixConsumer = { source: 'completed', version };
  const identity = (bytes: Buffer) => ({ size: bytes.length, sha256: sha(bytes) });
  const archive = (entries: { name: string; data: Buffer | string }[]) =>
    releaseZstdCompressSync(gunzipSync(tarArchive(entries)));
  const runtime = (name: string, exports: string[]) => {
    const module = Buffer.from(`controlled ${name} WASIX module`);
    const bytes = archive([{ name: 'oliphaunt/bin/postgres', data: module }]);
    return {
      module,
      bytes,
      manifest: {
        'format-version': 2,
        'source-fingerprint': `controlled ${name} source`,
        runtime: {
          archive: 'oliphaunt.wasix.tar.zst',
          ...identity(bytes),
          'module-sha256': sha(module),
          'postgres-version': '18.4',
          link: { exports: exports.map((name) => ({ name, kind: 'func' })) },
        },
        'runtime-support': [],
        extensions: [],
      },
    };
  };
  const held = runtime('held', ['legacy_']);
  const current = runtime('current', ['backend', 'callback', 'legacy_']);
  const publicArchive = (value: typeof held) =>
    archive([
      { name: WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive, data: value.bytes },
      { name: WASIX_PORTABLE_RELEASE_MEMBERS.manifest, data: JSON.stringify(value.manifest) },
    ]);
  const coreBytes = publicArchive(current);
  const coreFile = {
    path: 'bazel-out/core/current-public.tar.zst',
    label: '//src/wasix/runtime:release_archive_portable',
    ...identity(coreBytes),
  };
  const module = Buffer.from('controlled compiled pg_textsearch side module');
  const nativeModules = [
    {
      name: sqlName,
      path: `lib/postgresql/${sqlName}.so`,
      ...identity(module),
      moduleSha256: sha(module),
    },
  ];
  const receipt = {
    schema: 'oliphaunt-declared-wasix-extension-link-v1',
    sqlName,
    nativeModules,
    coreExportsRequired: ['backend', 'callback', 'legacy_'],
    unresolvedImports: [] as string[],
    moduleLinkMetadata: {
      [sqlName]: {
        'dylink-needed': [],
        imports: [
          { module: 'env', name: 'backend', kind: 'func' },
          { module: 'GOT.func', name: 'backend', kind: 'global' },
          { module: 'env', name: 'callback', kind: 'func' },
          { module: 'env', name: 'legacy_', kind: 'func' },
        ],
        exports: [{ name: sqlName, kind: 'func' }],
      },
    },
    sourceFingerprint: current.manifest['source-fingerprint'],
    postgresVersion: current.manifest.runtime['postgres-version'],
    runtimeSelection: {
      kind: 'current-source',
      declaredModuleSha256: sha(held.module),
      currentModuleSha256: sha(current.module),
      selectedModuleSha256: sha(current.module),
      missingExports: ['backend', 'callback'],
    },
  };
  const frozen = {
    product: consumer,
    version: metadata.products[consumer].version,
    sqlName,
    compatibility: { wasixRuntimeVersion: version },
    wasixInstall: {
      nativeModules: structuredClone(nativeModules),
      coreExportsRequired: [...receipt.coreExportsRequired],
      unresolvedImports: [],
    },
  };
  const root = (label: string, role: string, file: string) => ({
    label,
    package: {
      product: consumer,
      version: metadata.products[consumer].version,
      ecosystem: 'internal',
      configuration: 'wasix-portable',
      name: `${sqlName}-${role}`,
      role,
      outputs: [{ path: file, owner: '//extensions:pg_textsearch_carriers' }],
    },
  });
  const linkRoot = root(
    '//extensions:pg_textsearch_link_shipping',
    'extension-release-link-input',
    'bazel-out/extensions/pg_textsearch.link.json',
  );
  const frozenRoot = root(
    '//extensions:pg_textsearch_frozen_shipping',
    'extension-release-frozen-input',
    'bazel-out/extensions/pg_textsearch.frozen.json',
  );
  const coreRoot = {
    label: coreFile.label,
    package: {
      product: producer,
      version,
      ecosystem: 'github',
      configuration: 'portable',
      name: 'controlled-current-wasix.tar.zst',
      role: 'github-release-asset',
      outputs: [{ path: coreFile.path, owner: coreFile.label }],
    },
  };
  const cohort = { roots: [coreRoot, linkRoot, frozenRoot], outputs: [] as any[] };
  const files = new Map<string, Buffer>([[coreFile.path, coreBytes]]);
  const directory = mkdtempSync(path.join(tmpdir(), 'oliphaunt-exact-wasix-abi-'));
  extensionFixtureDirectories.push(directory);
  const declaredCargoPath = path.join(directory, 'original.crate');
  const cargo = {
    name: 'liboliphaunt-wasix-portable',
    version,
    manifest: null as Buffer | null,
    runtime: null as Buffer | null,
  };
  const put = (root: typeof linkRoot, bytes: Buffer) => {
    const file = root.package.outputs[0].path;
    files.set(file, bytes);
    cohort.outputs = cohort.outputs.filter((row) => row.path !== file);
    cohort.outputs.push({
      path: file,
      members: [{ path: '', type: 'file', mode: 0o644, ...identity(bytes) }],
    });
  };
  const sync = () => {
    put(coreRoot, files.get(coreFile.path)!);
    put(linkRoot, Buffer.from(JSON.stringify(receipt)));
    put(frozenRoot, Buffer.from(JSON.stringify(frozen)));
    const prefix = `liboliphaunt-wasix-portable-${version}`;
    writeFileSync(
      declaredCargoPath,
      tarArchive([
        {
          name: `${prefix}/Cargo.toml`,
          data: `[package]\nname = ${JSON.stringify(cargo.name)}\nversion = ${JSON.stringify(cargo.version)}\n`,
        },
        {
          name: `${prefix}/payload/manifest.json`,
          data: cargo.manifest ?? Buffer.from(JSON.stringify(held.manifest)),
        },
        {
          name: `${prefix}/payload/oliphaunt.wasix.tar.zst`,
          data: cargo.runtime ?? held.bytes,
        },
      ]),
    );
  };
  sync();
  const observation = {
    products: [
      {
        product: metadata.products[producer],
        productArtifacts: [
          {
            kind: 'wasix-runtime',
            target: 'portable',
            role: 'github-release-asset',
            qualifiedFiles: [coreFile],
          },
        ],
      },
      { product: metadata.products[consumer], productArtifacts: [] },
    ],
    // This is controlled physical evidence, without an authenticated origin capability.
    authenticated: [{ evidence: { cohorts: [cohort] } }],
  } as any;
  const heldSupplier = {
    consumer,
    product: producer,
    version,
    configuration: 'portable',
    root: linkRoot.label,
    binding: 'abi-contract',
    origin: {
      kind: 'completed-publication',
      publication: {
        product: producer,
        version,
        tagName: `${producer}-v${version}`,
        publicationSha: 'a'.repeat(40),
        publicationTree: 'b'.repeat(40),
        releaseSha: 'c'.repeat(40),
      },
      artifact: 'cargo:liboliphaunt-wasix-portable',
    },
    files: [{ path: 'external/held/original.crate' }],
  };
  const currentSupplier = {
    consumer,
    product: producer,
    version,
    configuration: 'wasix-portable',
    root: linkRoot.label,
    binding: 'abi-contract',
    origin: { kind: 'current-source' },
    files: [{ path: coreFile.path }],
  };
  return {
    metadata,
    observation,
    suppliers: [heldSupplier, currentSupplier] as any,
    readOutput: (file: any) => files.get(file.path)!,
    readDeclaredRuntime: (product: string, requestedVersion: string) => {
      expect([product, requestedVersion]).toEqual([producer, version]);
      return publicArchive(held);
    },
    readDeclaredCargo: (_supplier: any) => declaredCargoPath,
    inputIdentity: (_supplier: any, file: any) => {
      const bytes =
        file.path === heldSupplier.files[0].path
          ? readFileSync(declaredCargoPath)
          : files.get(file.path)!;
      return identity(bytes);
    },
    consumer,
    producer,
    held,
    current,
    cargo,
    receipt,
    frozen,
    coreFile,
    files,
    cohort,
    linkRoot,
    frozenRoot,
    heldSupplier,
    currentSupplier,
    sync,
    refreshCurrent: () => {
      const bytes = publicArchive(current);
      Object.assign(coreFile, identity(bytes));
      files.set(coreFile.path, bytes);
      sync();
    },
  };
}

test('a compiled external WASIX ABI receipt binds both physical runtimes before current adoption', () => {
  const value = extensionFixture();
  expect(inspectNativeCurrentExactInputs(value)).toEqual([
    { product: value.consumer, sourceProduct: value.producer },
  ]);
  expect(value.receipt.runtimeSelection.missingExports).toEqual(['backend', 'callback']);
  expect(value.receipt.runtimeSelection.declaredModuleSha256).not.toBe(
    value.receipt.runtimeSelection.currentModuleSha256,
  );
});

test('native frozen roots for the same extension do not interfere with WASIX adoption', () => {
  const value = extensionFixture();
  for (const configuration of ['linux-x64', 'macos-aarch64']) {
    const root = structuredClone(value.frozenRoot);
    root.label = `//extensions:pg_textsearch_${configuration}_frozen_shipping`;
    root.package.configuration = configuration;
    const file = `bazel-out/extensions/pg_textsearch-${configuration}.frozen.json`;
    root.package.outputs = [
      { path: file, owner: `//extensions:pg_textsearch_${configuration}_carriers` },
    ];
    const bytes = Buffer.from(JSON.stringify({ ...value.frozen, wasixInstall: null }));
    value.files.set(file, bytes);
    value.cohort.roots.push(root);
    value.cohort.outputs.push({
      path: file,
      members: [{ path: '', type: 'file', mode: 0o644, size: bytes.length, sha256: sha(bytes) }],
    });
  }
  expect(inspectNativeCurrentExactInputs(value)).toEqual([
    { product: value.consumer, sourceProduct: value.producer },
  ]);
});

test('a held-preferred compiled WASIX ABI receipt creates no current association', () => {
  const value = extensionFixture();
  value.held.manifest.runtime.link.exports.push(
    { name: 'backend', kind: 'func' },
    { name: 'callback', kind: 'func' },
  );
  value.receipt.runtimeSelection.kind = 'completed-publication';
  value.receipt.runtimeSelection.selectedModuleSha256 = sha(value.held.module);
  value.receipt.runtimeSelection.missingExports = [];
  value.sync();
  expect(inspectNativeCurrentExactInputs(value)).toEqual([]);
});

test('current WASIX ABI adoption requires the physical declared-runtime reader', () => {
  const value = extensionFixture();
  expect(() =>
    inspectNativeCurrentExactInputs({ ...value, readDeclaredRuntime: undefined }),
  ).toThrow();
});

test('current WASIX ABI adoption requires the original whole Cargo reader', () => {
  const value = extensionFixture();
  expect(() =>
    inspectNativeCurrentExactInputs({ ...value, readDeclaredCargo: undefined }),
  ).toThrow();
});

const invalidExtensionAdoptions: [string, (value: ReturnType<typeof extensionFixture>) => void][] =
  [
    [
      'invalid current archive',
      (value) => value.files.set(value.coreFile.path, Buffer.from('invalid')),
    ],
    [
      'held manifest module mismatch',
      (value) => (value.held.manifest.runtime['module-sha256'] = 'f'.repeat(64)),
    ],
    [
      'captured whole Cargo input mismatch',
      (value) => {
        const original = value.inputIdentity;
        value.inputIdentity = (supplier, file) =>
          file.path === value.heldSupplier.files[0].path
            ? { size: 1, sha256: 'f'.repeat(64) }
            : original(supplier, file);
      },
    ],
    ['wrong Cargo package name', (value) => (value.cargo.name = 'invented-runtime')],
    ['wrong Cargo package version', (value) => (value.cargo.version = '999.0.0')],
    [
      'Cargo manifest differs from completed public archive',
      (value) => {
        const manifest = structuredClone(value.held.manifest);
        manifest['source-fingerprint'] = 'another controlled source';
        value.cargo.manifest = Buffer.from(JSON.stringify(manifest));
      },
    ],
    [
      'Cargo runtime differs from completed public archive',
      (value) => (value.cargo.runtime = Buffer.from('another controlled runtime archive')),
    ],
    ['missing current supplier', (value) => value.suppliers.pop()],
    [
      'current supplier is held',
      (value) => (value.currentSupplier.origin.kind = 'completed-publication'),
    ],
    [
      'wrong current supplier configuration',
      (value) => (value.currentSupplier.configuration = 'portable'),
    ],
    [
      'held Cargo binding names an extracted member',
      (value) => {
        Reflect.set(value.heldSupplier.files[0], 'member', 'payload/manifest.json');
      },
    ],
    [
      'wrong supplier input path',
      (value) => (value.currentSupplier.files[0].path = 'bazel-out/unqualified'),
    ],
    [
      'wrong selected module',
      (value) => (value.receipt.runtimeSelection.selectedModuleSha256 = 'f'.repeat(64)),
    ],
    [
      'wrong declared module',
      (value) => (value.receipt.runtimeSelection.declaredModuleSha256 = 'f'.repeat(64)),
    ],
    [
      'wrong current module',
      (value) => (value.receipt.runtimeSelection.currentModuleSha256 = 'f'.repeat(64)),
    ],
    [
      'current runtime drops a held-supported export',
      (value) => {
        value.current.manifest.runtime.link.exports =
          value.current.manifest.runtime.link.exports.filter((row) => row.name !== 'legacy_');
        value.refreshCurrent();
      },
    ],
    [
      'runtime import has the wrong kind',
      (value) => (value.receipt.moduleLinkMetadata.pg_textsearch.imports[0].kind = 'global'),
    ],
    [
      'current runtime export has the wrong kind',
      (value) => {
        value.current.manifest.runtime.link.exports[0].kind = 'global';
        value.refreshCurrent();
      },
    ],
    ['empty missing-export proof', (value) => (value.receipt.runtimeSelection.missingExports = [])],
    [
      'duplicate missing-export proof',
      (value) => (value.receipt.runtimeSelection.missingExports = ['backend', 'backend']),
    ],
    [
      'unsorted missing-export proof',
      (value) => (value.receipt.runtimeSelection.missingExports = ['callback', 'backend']),
    ],
    [
      'invented missing-export proof',
      (value) => (value.receipt.runtimeSelection.missingExports = ['invented']),
    ],
    [
      'export already supplied by held runtime',
      (value) => (value.receipt.runtimeSelection.missingExports = ['legacy_']),
    ],
    [
      'frozen module differs',
      (value) => (value.frozen.wasixInstall.nativeModules[0].moduleSha256 = 'f'.repeat(64)),
    ],
    [
      'frozen module metadata is incomplete',
      (value) => {
        Reflect.deleteProperty(value.frozen.wasixInstall.nativeModules[0], 'size');
      },
    ],
    [
      'frozen export requirements differ',
      (value) => (value.frozen.wasixInstall.coreExportsRequired = ['backend']),
    ],
    ['unresolved imports', (value) => value.receipt.unresolvedImports.push('env.invented')],
    ['unknown SQL identity', (value) => (value.receipt.sqlName = 'unknown_extension')],
    ['wrong canonical product', (value) => (value.linkRoot.package.product = 'database-resources')],
    ['wrong extension version', (value) => (value.linkRoot.package.version = '999.0.0')],
    ['wrong held floor', (value) => (value.heldSupplier.version = '999.0.0')],
    ['duplicate link root', (value) => value.cohort.roots.push(structuredClone(value.linkRoot))],
    [
      'duplicate frozen root',
      (value) => value.cohort.roots.push(structuredClone(value.frozenRoot)),
    ],
  ];
for (const [fault, mutate] of invalidExtensionAdoptions)
  test(`compiled external WASIX current adoption fails closed: ${fault}`, () => {
    const value = extensionFixture();
    mutate(value);
    value.sync();
    expect(() => inspectNativeCurrentExactInputs(value)).toThrow();
  });
