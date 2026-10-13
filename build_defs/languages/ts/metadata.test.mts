import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importJavascriptMetadata, validateJavascriptDependencyArchive } from './metadata.mts';

test('installed tools fixture acquires the public held SDK closure and rejects stale pins', () => {
  const fixture = new URL('../../../src/wasix/postgres-tools/ts/tests/installed/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', fixture), 'utf8'));
  const lock = Bun.JSONC.parse(readFileSync(new URL('bun.lock', fixture), 'utf8'));
  const project = (selectedManifest = manifest, selectedLock = lock) =>
    importJavascriptMetadata(
      { workspaces: {} },
      selectedLock,
      { '': selectedManifest },
      { [manifest.name]: ['@oliphaunt/wasix-ts'] },
    );
  const acquisition = project().consumerTools;
  expect(
    Object.values(acquisition.packages)
      .map((row) => row.package)
      .sort(),
  ).toEqual([
    '@oliphaunt/liboliphaunt-wasix',
    '@oliphaunt/ts-query',
    '@oliphaunt/wasix-napi-linux-x64-gnu',
    '@oliphaunt/wasix-ts',
    'fzstd',
  ]);
  expect(
    acquisition.packages[acquisition.roots[manifest.name]['@oliphaunt/wasix-ts']].version,
  ).toBe(manifest.devDependencies['@oliphaunt/wasix-ts']);
  const stale = structuredClone(manifest);
  stale.devDependencies['@oliphaunt/wasix-ts'] = '99.0.0';
  expect(() => project(stale)).toThrow(/stale consumer tool declaration/u);
  const missing = structuredClone(lock);
  delete missing.packages['@oliphaunt/liboliphaunt-wasix'];
  expect(() => project(manifest, missing)).toThrow(/Missing Linux x64 consumer tool dependency/u);
});

function fixture() {
  const manifest = {
    name: '@oliphaunt/sdk',
    version: '1.2.3',
    type: 'module',
    devDependencies: { typescript: 'catalog:', '@types/node': '^24.0.0', '@types/bun': 'catalog:' },
    dependencies: { '@oliphaunt/query': '1.0.0' },
  };
  const query = {
    name: '@oliphaunt/query',
    version: '1.0.0',
    devDependencies: { typescript: 'catalog:', '@types/node': '^24.0.0' },
  };
  const node = [
    '@types/node@24.1.0',
    '',
    { dependencies: { 'undici-types': '7.1.0' } },
    'sha512-bm9kZQ==',
  ];
  const typescript = ['typescript@6.0.3', '', {}, 'sha512-dHNj'];
  return {
    root: { workspaces: { catalog: { typescript: '^6.0.3', '@types/bun': '1.4.2' } } },
    manifests: { 'src/sdk': manifest, 'src/query': query },
    lock: {
      lockfileVersion: 2,
      configVersion: 1,
      catalog: { typescript: '^6.0.3', '@types/bun': '1.4.2' },
      workspaces: { 'src/sdk': manifest, 'src/query': query },
      packages: {
        typescript,
        '@types/node': ['@types/node@22.1.0', '', {}, 'sha512-b2xk'],
        '@oliphaunt/sdk/@types/node': node,
        '@oliphaunt/query/@types/node': node,
        '@oliphaunt/sdk/@types/node/undici-types': [
          'undici-types@7.1.0',
          '',
          {},
          'sha512-aHR0cA==',
        ],
        '@oliphaunt/query/@types/node/undici-types': [
          'undici-types@7.1.0',
          '',
          {},
          'sha512-aHR0cA==',
        ],
        '@types/bun': [
          '@types/bun@1.4.2',
          '',
          { dependencies: { 'bun-types': '1.4.2' } },
          'sha512-YnVu',
        ],
        'bun-types': [
          'bun-types@1.4.2',
          '',
          { dependencies: { '@types/node': '*' } },
          'sha512-dHlwZXM=',
        ],
      },
    },
  } as any;
}

test('imports nested exact Bun resolutions, preserving a dependency’s different Node types', () => {
  const { root, lock, manifests } = fixture();
  const imported = importJavascriptMetadata(root, lock, manifests);
  const sdkNode = imported.workspaces['@oliphaunt/sdk'].types['@types/node'];
  expect(imported.packages[sdkNode].version).toBe('24.1.0');
  expect(imported.workspaces['@oliphaunt/query'].types['@types/node']).toBe(sdkNode);
  const bun = imported.packages[imported.workspaces['@oliphaunt/sdk'].types['@types/bun']];
  const bunTypes = imported.packages[bun.dependencies['bun-types']];
  expect(imported.packages[bunTypes.dependencies['@types/node']].version).toBe('22.1.0');
  expect(Object.values(imported.packages).some((pkg) => pkg.package === 'typescript')).toBe(false);
});

test('external runtime acquisition stays locked and workspace names can resolve genuine registry entries', () => {
  const value = fixture();
  value.manifests['src/sdk'].dependencies.fzstd = '0.1.1';
  value.lock.packages.fzstd = ['fzstd@0.1.1', '', {}, 'sha512-ZnpzdGQ='];
  const imported = importJavascriptMetadata(value.root, value.lock, value.manifests);
  const id = imported.workspaces['@oliphaunt/sdk'].packages?.fzstd;
  if (!id) throw new Error('Locked runtime package missing');
  expect(imported.packages[id]).toEqual({
    package: 'fzstd',
    version: '0.1.1',
    integrity: 'sha512-ZnpzdGQ=',
    dependencies: {},
  });
  expect(imported.workspaces['@oliphaunt/query'].packages).toBeUndefined();
  value.lock.packages.fzstd[3] = '';
  expect(() => importJavascriptMetadata(value.root, value.lock, value.manifests)).toThrow(
    'integrity-bearing',
  );
  const workspace = fixture();
  workspace.lock.packages['@oliphaunt/query'] = [
    '@oliphaunt/query@1.0.0',
    '',
    {},
    'sha512-cXVlcnk=',
  ];
  delete workspace.manifests['src/query'];
  const locked = importJavascriptMetadata(workspace.root, workspace.lock, workspace.manifests);
  expect(locked.workspaces['@oliphaunt/sdk'].dependencyInputs?.['@oliphaunt/query'].source).toBe(
    'registry',
  );
});

test('asset workspace dependency identities remain conventional without becoming compiler inputs', () => {
  const value = fixture();
  const asset = { name: '@oliphaunt/assets', version: '0.2.4', type: 'module' };
  value.manifests['src/sdk'].dependencies[asset.name] = 'workspace:*';
  value.lock.workspaces['src/assets'] = { ...asset };
  const dependencies = { 'src/assets': asset };
  const before = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    {},
    {},
    dependencies,
  );
  expect(before.workspaces[asset.name]).toEqual({ ...asset, dependencies: {}, types: {} });
  expect(Object.values(before.packages).some((row) => row.package === asset.name)).toBe(false);
  asset.version = '0.2.5';
  expect(() =>
    importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, dependencies),
  ).toThrow('stale workspace identity');
  asset.version = '0.2.4';
  value.manifests['src/sdk'].dependencies[asset.name] = '0.2.5';
  expect(
    importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, dependencies)
      .workspaces['@oliphaunt/sdk'].dependencyInputs?.[asset.name].source,
  ).toBe('unverified');
  expect(() =>
    importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, value.manifests),
  ).toThrow('both compiler and dependency');
});

test('consumer tools use an isolated exact lock closure with canonical overrides and host optional packages', () => {
  const value = fixture();
  value.root.overrides = { esbuild: '0.28.1' };
  value.lock.overrides = { ...value.root.overrides };
  value.manifests['src/sdk'].devDependencies.vite = '^6.0.3';
  Object.assign(value.lock.packages, {
    vite: [
      'vite@6.4.2',
      '',
      { dependencies: { esbuild: '^0.21.0' }, optionalDependencies: { absent: '*' } },
      'sha512-dml0ZQ==',
    ],
    esbuild: [
      'esbuild@0.28.1',
      '',
      { optionalDependencies: { linux: '0.28.1', darwin: '0.28.1' } },
      'sha512-ZXNi',
    ],
    linux: ['linux@0.28.1', '', { os: 'linux', cpu: 'x64' }, 'sha512-bGludXg='],
    darwin: ['darwin@0.28.1', '', { os: 'darwin', cpu: 'arm64' }, 'sha512-ZGFyd2lu'],
  });
  const before = importJavascriptMetadata(value.root, value.lock, value.manifests);
  const { consumerTools, ...production } = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    { '@oliphaunt/sdk': ['vite'] },
  );
  expect(production).toEqual(before);
  expect(
    Object.values(consumerTools?.packages ?? {})
      .map((row) => row.package)
      .sort(),
  ).toEqual(['esbuild', 'linux', 'vite']);
  expect(consumerTools?.platform).toEqual({ os: 'linux', cpu: 'x64' });
  for (const mutate of [
    (fixture: any) => {
      fixture.lock.overrides.esbuild = '0.21.0';
    },
    (fixture: any) => {
      delete fixture.lock.packages.esbuild;
    },
    (fixture: any) => {
      fixture.lock.packages.linux[3] = '';
    },
    (fixture: any) => {
      fixture.lock.packages.esbuild[2].os = 'darwin';
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    expect(() =>
      importJavascriptMetadata(invalid.root, invalid.lock, invalid.manifests, {
        '@oliphaunt/sdk': ['vite'],
      }),
    ).toThrow();
  }
});

test('rejects stale declarations and missing integrity without selecting unavailable workspace versions', () => {
  for (const mutate of [
    (value: any) => {
      value.lock.workspaces['src/sdk'] = { ...value.lock.workspaces['src/sdk'], version: '1.2.2' };
    },
    (value: any) => {
      value.lock.catalog.typescript = '^5.9.0';
    },
    (value: any) => {
      value.lock.packages['@oliphaunt/sdk/@types/node'][3] = '';
    },
    (value: any) => {
      value.root.overrides = { '@types/node': '24.1.0' };
    },
  ]) {
    const value = fixture();
    mutate(value);
    expect(() => importJavascriptMetadata(value.root, value.lock, value.manifests)).toThrow();
  }
});

test('compiler/type sharing admits exact lock context and rejects conflicting bytes or dependencies', () => {
  const value = fixture();
  value.manifests['src/sdk'].devDependencies.framework = '^2.0.0';
  Object.assign(value.lock.packages, {
    framework: [
      'framework@2.1.0',
      '',
      { dependencies: { '@types/node': '^24.0.0' } },
      'sha512-ZnJhbWU=',
    ],
    'framework/@types/node': structuredClone(value.lock.packages['@oliphaunt/sdk/@types/node']),
    'framework/@types/node/undici-types': structuredClone(
      value.lock.packages['@oliphaunt/sdk/@types/node/undici-types'],
    ),
  });
  const selection = { workspaces: { '@oliphaunt/sdk': ['framework'] } };
  const before = importJavascriptMetadata(value.root, value.lock, value.manifests);
  const { compilerInputs, ...unchanged } = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    {},
    selection,
  );
  expect(unchanged).toEqual(before);
  const nodeId = before.workspaces['@oliphaunt/sdk'].types['@types/node'];
  const undiciId = before.packages[nodeId].dependencies['undici-types'];
  expect(compilerInputs?.shared).toEqual([nodeId, undiciId].sort());
  expect(compilerInputs?.packages[nodeId]).toEqual(before.packages[nodeId]);
  for (const mutate of [
    (invalid: any) => {
      invalid.lock.packages['framework/@types/node'][3] = 'sha512-Y29uZmxpY3Q=';
    },
    (invalid: any) => {
      invalid.lock.packages['framework/@types/node'][2].dependencies['undici-types'] = '^7.1.0';
      invalid.lock.packages['framework/@types/node/undici-types'] = [
        'undici-types@7.2.0',
        '',
        {},
        'sha512-Y29uZmxpY3Q=',
      ];
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    expect(() =>
      importJavascriptMetadata(invalid.root, invalid.lock, invalid.manifests, {}, selection),
    ).toThrow('Conflicting compiler/type acquisition context');
  }
});

test('compiler roots import declared type peers and every immutable tool platform without changing existing views', () => {
  const value = fixture();
  value.manifests['src/sdk'].devDependencies.framework = '^2.0.0';
  value.root.overrides = { esbuild: '0.28.1' };
  value.lock.overrides = { ...value.root.overrides };
  Object.assign(value.lock.packages, {
    framework: [
      'framework@2.1.0',
      '',
      { peerDependencies: { '@types/render': '^19.0.0' }, optionalPeers: ['@types/render'] },
      'sha512-ZnJhbWU=',
    ],
    '@types/render': ['@types/render@19.2.0', '', {}, 'sha512-cmVuZGVy'],
    esbuild: [
      'esbuild@0.28.1',
      '',
      { optionalDependencies: { linux: '0.28.1', darwin: '0.28.1' } },
      'sha512-ZXNi',
    ],
    linux: ['linux@0.28.1', '', { os: 'linux', cpu: 'x64' }, 'sha512-bGludXg='],
    darwin: ['darwin@0.28.1', '', { os: 'darwin', cpu: 'arm64' }, 'sha512-ZGFyd2lu'],
  });
  const selection = { workspaces: { '@oliphaunt/sdk': ['framework'] }, overrideTools: ['esbuild'] };
  const before = importJavascriptMetadata(value.root, value.lock, value.manifests);
  const { compilerInputs, ...unchanged } = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    {},
    selection,
  );
  expect(unchanged).toEqual(before);
  const compiled = compilerInputs!;
  const framework = compiled.packages[compiled.roots['@oliphaunt/sdk'].framework];
  expect(compiled.packages[framework.dependencies['@types/render']].version).toBe('19.2.0');
  const tool = compiled.packages[compiled.tools.esbuild];
  expect(
    Object.values(tool.dependencies)
      .map((id) => compiled.packages[id].os)
      .sort(),
  ).toEqual(['darwin', 'linux']);
  const cyclic = structuredClone(value);
  cyclic.lock.packages.framework[2].dependencies = { helper: '2.1.0' };
  cyclic.lock.packages.helper = [
    'helper@2.1.0',
    '',
    { dependencies: { framework: '^2.0.0' } },
    'sha512-aGVscGVy',
  ];
  const withCycle = importJavascriptMetadata(
    cyclic.root,
    cyclic.lock,
    cyclic.manifests,
    {},
    selection,
  ).compilerInputs!;
  const frameworkId = withCycle.roots['@oliphaunt/sdk'].framework;
  const helperId = withCycle.packages[frameworkId].dependencies.helper;
  expect(withCycle.packages[helperId].dependencies.framework).toBe(frameworkId);
  expect(withCycle.closures[frameworkId]).toContain(helperId);
  for (const mutate of [
    (invalid: any) => {
      invalid.lock.workspaces['src/sdk'] = {
        ...invalid.lock.workspaces['src/sdk'],
        devDependencies: {
          ...invalid.lock.workspaces['src/sdk'].devDependencies,
          framework: '^1.0.0',
        },
      };
    },
    (invalid: any) => {
      delete invalid.lock.packages['@types/render'];
    },
    (invalid: any) => {
      invalid.lock.packages['@types/render'][0] = '@types/render@18.0.0';
    },
    (invalid: any) => {
      invalid.lock.overrides.esbuild = '0.21.0';
    },
    (invalid: any) => {
      delete invalid.lock.packages.darwin;
    },
    (invalid: any) => {
      invalid.lock.packages.linux[0] = 'linux@1.0.0';
    },
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    expect(() =>
      importJavascriptMetadata(invalid.root, invalid.lock, invalid.manifests, {}, selection),
    ).toThrow();
  }
});

test('detects cyclic type acquisitions and conflicting immutable package closures', () => {
  const cyclic = fixture();
  cyclic.lock.packages['bun-types'][2].dependencies['@types/bun'] = '1.4.2';
  expect(() => importJavascriptMetadata(cyclic.root, cyclic.lock, cyclic.manifests)).toThrow(
    'Cycle',
  );
  const conflicting = fixture();
  conflicting.lock.packages['@oliphaunt/query/@types/node'] = [
    '@types/node@24.1.0',
    '',
    {},
    'sha512-bm9kZQ==',
  ];
  expect(() =>
    importJavascriptMetadata(conflicting.root, conflicting.lock, conflicting.manifests),
  ).toThrow('Conflicting');
});

test('nested compiler dependencies inherit the nearest locked resolution context', () => {
  const value = fixture();
  value.manifests['src/sdk'].devDependencies.framework = '^2.0.0';
  Object.assign(value.lock.packages, {
    framework: [
      'framework@2.1.0',
      '',
      { dependencies: { transformer: '2.1.0' } },
      'sha512-ZnJhbWU=',
    ],
    transformer: ['transformer@2.1.0', '', {}, 'sha512-dHJhbnM='],
    'framework/transformer': [
      'transformer@2.1.0',
      '',
      { dependencies: { parser: '^3.5.0' } },
      'sha512-dHJhbnM=',
    ],
    'framework/parser': ['parser@3.5.0', '', {}, 'sha512-bmVhcg=='],
    parser: ['parser@3.3.0', '', {}, 'sha512-Z2xvYmFs'],
  });
  const compiled = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    {},
    {
      workspaces: { '@oliphaunt/sdk': ['framework'] },
    },
  ).compilerInputs!;
  const framework = compiled.packages[compiled.roots['@oliphaunt/sdk'].framework];
  const transformer = compiled.packages[framework.dependencies.transformer];
  expect(compiled.packages[transformer.dependencies.parser].version).toBe('3.5.0');
});

function executionFixture() {
  const value = fixture();
  value.root.overrides = { esbuild: '0.28.1' };
  value.lock.overrides = { ...value.root.overrides };
  const manifest = {
    name: '@oliphaunt/docs',
    version: '0.0.0',
    dependencies: { framework: '^16.0.0', render: '^19.0.0' },
    devDependencies: { css: '^4.0.0', typescript: '^5.9.3' },
  };
  value.dependencies = { 'src/docs': manifest };
  value.lock.workspaces['src/docs'] = structuredClone(manifest);
  Object.assign(value.lock.packages, {
    framework: [
      'framework@16.2.7',
      '',
      {
        dependencies: { esbuild: '^0.21.0' },
        peerDependencies: { render: '^19.0.0', optional: '^1.0.0', unrelated: '^7.0.0' },
        optionalPeers: ['optional', 'unrelated'],
        bin: { build: './dist/cli.js' },
      },
      'sha512-ZnJhbWU=',
    ],
    render: ['render@19.2.7', '', {}, 'sha512-cmVuZGVy'],
    css: ['css@4.3.0', '', { dependencies: { optional: '^1.0.0' } }, 'sha512-Y3Nz'],
    optional: ['optional@1.0.0', '', {}, 'sha512-cGVlcg=='],
    unrelated: ['unrelated@6.4.2', '', {}, 'sha512-dml0ZQ=='],
    '@oliphaunt/docs/typescript': [
      'typescript@5.9.3',
      '',
      { bin: { tsc: './bin/tsc' } },
      'sha512-dHM=',
    ],
    esbuild: [
      'esbuild@0.28.1',
      '',
      { optionalDependencies: { linux: '0.28.1', darwin: '0.28.1' } },
      'sha512-ZXNi',
    ],
    linux: ['linux@0.28.1', '', { os: 'linux', cpu: 'x64' }, 'sha512-bGludXg='],
    darwin: ['darwin@0.28.1', '', { os: 'darwin', cpu: 'arm64' }, 'sha512-ZGFyd2lu'],
  });
  return value;
}

const executionProjection = (value = executionFixture()) =>
  importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, value.dependencies, [
    '@oliphaunt/docs',
  ]);

test('explicit tools select conventional runtime or development libraries with exact field bindings', () => {
  const value = fixture();
  const workspace = '@oliphaunt/release-tools';
  const manifest = {
    name: workspace,
    type: 'module',
    dependencies: { protobufjs: '8.8.1', 'release-please': '17.3.0' },
  };
  const dependencies = { 'tools/release': manifest } as any;
  value.lock.workspaces['tools/release'] = structuredClone(manifest);
  Object.assign(value.lock.packages, {
    protobufjs: ['protobufjs@8.8.1', '', { dependencies: { long: '^5.3.2' } }, 'sha512-cHJvdG8='],
    long: ['long@5.3.2', '', {}, 'sha512-bG9uZw=='],
    'release-please': ['release-please@17.3.0', '', {}, 'sha512-cmVsZWFzZQ=='],
  });
  const project = (tools = {}, execution: string[] = []) =>
    importJavascriptMetadata(
      value.root,
      value.lock,
      value.manifests,
      tools,
      {},
      dependencies,
      execution,
    );
  expect(() => project({ [workspace]: ['protobufjs'] }, [workspace])).toThrow(
    'independent conventional selection',
  );
  const selected = { [workspace]: ['protobufjs'] };
  const acquired = project(selected).consumerTools!;
  expect(Object.keys(acquired.roots[workspace])).toEqual(['protobufjs']);
  const library = acquired.packages[acquired.roots[workspace].protobufjs];
  expect(library.version).toBe('8.8.1');
  expect(Object.keys(library.dependencies)).toEqual(['long']);
  expect(acquired.packages[library.dependencies.long].version).toBe('5.3.2');
  expect(
    Object.values(acquired.packages)
      .map((row) => row.package)
      .sort(),
  ).toEqual(['long', 'protobufjs']);
  value.lock.workspaces['tools/release'].dependencies.protobufjs = '8.8.0';
  expect(() => project(selected)).toThrow('stale consumer tool declaration');
  value.lock.workspaces['tools/release'] = structuredClone(manifest);
  const runtime = structuredClone(acquired);
  (manifest as any).devDependencies = { protobufjs: manifest.dependencies.protobufjs };
  delete (manifest.dependencies as any).protobufjs;
  expect(() => project(selected)).toThrow('stale consumer tool declaration');
  value.lock.workspaces['tools/release'] = structuredClone(manifest);
  expect(project(selected).consumerTools).toEqual(runtime);
});

test('execution workspaces acquire every conventional root with their own compiler and lock-projected CLI paths', () => {
  const value = executionFixture();
  const before = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    {},
    {},
    value.dependencies,
  );
  const { consumerTools, ...unchanged } = executionProjection(value);
  expect(unchanged).toEqual(before);
  const acquired = consumerTools!;
  expect(Object.keys(acquired.roots['@oliphaunt/docs'])).toEqual([
    'css',
    'framework',
    'render',
    'typescript',
  ]);
  expect(acquired.packages[acquired.roots['@oliphaunt/docs'].typescript].version).toBe('5.9.3');
  expect(before.typescript.version).toBe('6.0.3');
  const framework = acquired.packages[acquired.roots['@oliphaunt/docs'].framework];
  expect(Object.keys(framework.dependencies).sort()).toEqual(['esbuild', 'optional', 'render']);
  const esbuild = acquired.packages[framework.dependencies.esbuild];
  expect(esbuild.version).toBe('0.28.1');
  expect(Object.keys(esbuild.dependencies)).toEqual(['linux']);
  expect(acquired.bins['@oliphaunt/docs']).toEqual({
    framework: { build: 'dist/cli.js' },
    typescript: { tsc: 'bin/tsc' },
  });
  expect(acquired.closures['@oliphaunt/docs']).toEqual(Object.keys(acquired.packages).sort());
  value.manifests['src/sdk'].devDependencies.tool = '1.0.0';
  value.lock.packages.tool = [
    'tool@1.0.0',
    '',
    { dependencies: { esbuild: '^0.21.0' } },
    'sha512-dG9vbA==',
  ];
  const isolated = importJavascriptMetadata(
    value.root,
    value.lock,
    value.manifests,
    { '@oliphaunt/sdk': ['tool'] },
    {},
    value.dependencies,
    ['@oliphaunt/docs'],
  ).consumerTools!;
  expect(
    isolated.closures['@oliphaunt/sdk'].map((id) => isolated.packages[id].package).sort(),
  ).toEqual(['esbuild', 'linux', 'tool']);
  expect(isolated.closures['@oliphaunt/docs']).not.toContain(isolated.roots['@oliphaunt/sdk'].tool);
  const scalar = executionFixture();
  scalar.lock.packages.framework[2].bin = './dist/cli.js';
  expect(executionProjection(scalar).consumerTools!.bins['@oliphaunt/docs'].framework).toEqual({
    framework: 'dist/cli.js',
  });
});

test('optional peers require a compatible provider in the selected workspace context', () => {
  for (const provided of [false, true]) {
    const value = executionFixture();
    delete value.lock.packages.css[2].dependencies.optional;
    if (provided) {
      value.dependencies['src/docs'].devDependencies.unrelated = '^6.0.0';
      value.lock.workspaces['src/docs'].devDependencies.unrelated = '^6.0.0';
    }
    const acquired = executionProjection(value).consumerTools!;
    const framework = acquired.packages[acquired.roots['@oliphaunt/docs'].framework];
    expect(Object.keys(framework.dependencies).sort()).toEqual(['esbuild', 'render']);
  }
  const value = executionFixture();
  value.manifests['src/sdk'].devDependencies.framework = '^16.0.0';
  value.manifests['src/sdk'].devDependencies.css = '^4.0.0';
  value.lock.workspaces['src/sdk'] = structuredClone(value.manifests['src/sdk']);
  value.lock.workspaces['src/sdk'].devDependencies.css = '^3.0.0';
  expect(() =>
    importJavascriptMetadata(value.root, value.lock, value.manifests, {
      '@oliphaunt/sdk': ['framework'],
    }),
  ).toThrow('stale consumer provider declaration');
  const incompatible = executionFixture();
  incompatible.lock.packages.css[2].dependencies.optional = '^2.0.0';
  expect(() => executionProjection(incompatible)).toThrow('does not satisfy');
  const required = executionFixture();
  required.lock.packages.framework[2].dependencies.optional = '^1.0.0';
  required.lock.packages.framework[2].peerDependencies.optional = '^2.0.0';
  expect(executionProjection(required).consumerTools?.packages).toBeDefined();
});

test('execution acquisition rejects stale declarations, wrong platforms, missing peers, integrity and overrides', () => {
  for (const mutate of [
    (value: any) => {
      value.lock.workspaces['src/docs'].dependencies.framework = '^15.0.0';
    },
    (value: any) => {
      value.lock.workspaces['src/docs'].dependencies.removed = '1.0.0';
    },
    (value: any) => {
      value.lock.packages.framework[2].os = 'darwin';
    },
    (value: any) => {
      delete value.lock.packages.render;
    },
    (value: any) => {
      value.lock.packages.render[0] = 'render@18.0.0';
    },
    (value: any) => {
      value.lock.packages.framework[3] = '';
    },
    (value: any) => {
      value.lock.overrides.esbuild = '0.21.0';
    },
    (value: any) => {
      value.lock.packages.framework[2].dependencies.framework = '^16.0.0';
    },
  ]) {
    const value = executionFixture();
    mutate(value);
    expect(() => executionProjection(value)).toThrow();
  }
  const value = executionFixture();
  expect(() =>
    importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, value.dependencies, [
      '@oliphaunt/docs',
      '@oliphaunt/docs',
    ]),
  ).toThrow('Duplicate execution workspace');
});

test('consumer CLI paths stay inside the declared package', () => {
  for (const path of [
    '',
    '../cli.js',
    './dist/../../cli.js',
    '/cli.js',
    'C:/cli.js',
    'dist\\cli.js',
    'dist/\ncli.js',
  ]) {
    const value = executionFixture();
    value.lock.packages.framework[2].bin.build = path;
    expect(() => executionProjection(value)).toThrow();
  }
  for (const command of ['', '../build', 'build:run', 'build\nrun']) {
    const value = executionFixture();
    value.lock.packages.framework[2].bin = { [command]: 'dist/cli.js' };
    expect(() => executionProjection(value)).toThrow();
  }
});

test('distinct optional peer contexts cannot silently share one installation identity', () => {
  const value = executionFixture();
  value.manifests['src/sdk'].devDependencies.framework = '^16.0.0';
  expect(() =>
    importJavascriptMetadata(
      value.root,
      value.lock,
      value.manifests,
      { '@oliphaunt/sdk': ['framework'] },
      {},
      value.dependencies,
      ['@oliphaunt/docs'],
    ),
  ).toThrow('Conflicting acquisition closure');
  value.manifests['src/sdk'].devDependencies.css = '^4.0.0';
  const same = structuredClone(value.lock.packages.framework);
  same[2].peerDependencies = Object.fromEntries(Object.entries(same[2].peerDependencies).reverse());
  value.lock.packages['@oliphaunt/sdk/framework'] = same;
  expect(() =>
    importJavascriptMetadata(
      value.root,
      value.lock,
      value.manifests,
      { '@oliphaunt/sdk': ['framework'] },
      {},
      value.dependencies,
      ['@oliphaunt/docs'],
    ),
  ).not.toThrow();
});

function heldQueryFixture() {
  const value = fixture();
  const original = value.manifests['src/query'];
  original.name = '@oliphaunt/ts-query';
  original.version = '0.1.1';
  value.manifests['src/sdk'].dependencies = { [original.name]: '0.1.1' };
  value.lock.packages[`${original.name}/@types/node`] =
    value.lock.packages['@oliphaunt/query/@types/node'];
  value.lock.packages[`${original.name}/@types/node/undici-types`] =
    value.lock.packages['@oliphaunt/query/@types/node/undici-types'];
  const file = fileURLToPath(new URL('./testdata/ts-query-0.1.1.tgz', import.meta.url));
  const bytes = readFileSync(file);
  const row = {
    publication: {
      product: 'oliphaunt-query-ts',
      version: '0.1.1',
      tagName: 'oliphaunt-query-ts-v0.1.1',
      publicationSha: 'c51052fe8b8ffc7e992266c5ab3d7a63b47441e7',
      publicationTree: '59791800860832994b48b8009bb48c5a74a7764e',
      releaseSha: '7b192697ff522f71f9c694593d352aa30469cea1',
    },
    artifact: `npm:${original.name}`,
    archive: '@oliphaunt_metadata//:supplier-artifacts/query.tgz',
    file: {
      path: file,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const owners = {
    'src/query': { id: row.publication.product, registry_packages: [row.artifact] },
  };
  const project = (options = {}) =>
    importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, {}, [], [], {
      supplierArchives: [row],
      sourceOwners: owners,
      ...options,
    });
  return { value, row, owners, project };
}

test('ordinary held query survives a current major version and uses the exact retained published File', () => {
  const { value, row, project } = heldQueryFixture();
  value.manifests['src/query'].version = '1.0.0';
  const choice = project().workspaces['@oliphaunt/sdk'].dependencyInputs!['@oliphaunt/ts-query'];
  expect(choice).toMatchObject({
    source: 'completed',
    version: '0.1.1',
    archive: row.archive,
    sha256: 'f0f690ed68891aef72f49dab3f4b79206cda428e55ace54cef8ff8de58557c60',
    packages: {},
  });
  expect(project().workspaces['@oliphaunt/sdk'].dependencies['@oliphaunt/ts-query']).toBe('0.1.1');
});

test('same-version workspace bytes do not imply adoption; prepared source selection and owner must both match', () => {
  const { row, project } = heldQueryFixture();
  expect(
    project().workspaces['@oliphaunt/sdk'].dependencyInputs!['@oliphaunt/ts-query'].source,
  ).toBe('completed');
  const selected = project({ selectedProducts: ['oliphaunt-query-ts'] }).workspaces[
    '@oliphaunt/sdk'
  ].dependencyInputs!['@oliphaunt/ts-query'];
  expect(selected).toEqual({
    source: 'workspace',
    workspace: 'src/query',
    version: '0.1.1',
    owner: 'oliphaunt-query-ts',
  });
  expect(
    project({ selectedProducts: ['oliphaunt-react-native'] }).workspaces['@oliphaunt/sdk']
      .dependencyInputs!['@oliphaunt/ts-query'].source,
  ).toBe('completed');
  expect(
    project({
      selectedProducts: ['oliphaunt-query-ts'],
      sourceOwners: { 'src/query': { id: 'other', registry_packages: [row.artifact] } },
    }).workspaces['@oliphaunt/sdk'].dependencyInputs!['@oliphaunt/ts-query'].source,
  ).toBe('unverified');
});

test('explicit workspace source remains conventional and missing pool does not prevent metadata/tool loading', () => {
  const { value, project } = heldQueryFixture();
  const missing = project({ supplierArchives: [] });
  expect(missing.typescript.version).toBe('6.0.3');
  expect(
    missing.workspaces['@oliphaunt/sdk'].dependencyInputs!['@oliphaunt/ts-query'],
  ).toMatchObject({ source: 'unverified' });
  value.manifests['src/sdk'].dependencies['@oliphaunt/ts-query'] = 'workspace:*';
  expect(
    project({ supplierArchives: [] }).workspaces['@oliphaunt/sdk'].dependencyInputs![
      '@oliphaunt/ts-query'
    ].source,
  ).toBe('workspace');
  value.manifests['src/sdk'].dependencies['@oliphaunt/ts-query'] = 'workspace:2.0.0';
  expect(() => project()).toThrow('conventional workspace version');
});

test('held File digest and packed identity reject same-version byte substitution and wrong archive identities', () => {
  const { row, project } = heldQueryFixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'ts-held-query-'));
  try {
    const file = path.join(directory, 'query.tgz');
    const bytes = gzipSync(gunzipSync(readFileSync(row.file.path)), { level: 1 });
    writeFileSync(file, bytes);
    expect(validateJavascriptDependencyArchive(file, '@oliphaunt/ts-query', '0.1.1').version).toBe(
      '0.1.1',
    );
    expect(() =>
      project({
        supplierArchives: [{ ...row, file: { ...row.file, path: file, size: bytes.length } }],
      }),
    ).toThrow('digest differs');
    expect(() =>
      validateJavascriptDependencyArchive(row.file.path, '@oliphaunt/ts-query', '1.0.0', row.file),
    ).toThrow('packed identity differs');
    expect(() =>
      validateJavascriptDependencyArchive(row.file.path, 'wrong', '0.1.1', row.file),
    ).toThrow('packed identity differs');
    expect(() => project({ supplierArchives: [row, row] })).toThrow('Ambiguous');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('declared dependency worker preserves retained archive bytes and rejects post-projection tampering', () => {
  const { row } = heldQueryFixture();
  const directory = mkdtempSync(path.join(tmpdir(), 'ts-dependency-worker-'));
  try {
    const output = path.join(directory, 'checked.tgz');
    const run = (file = row.file.path) =>
      Bun.spawnSync([
        process.execPath,
        fileURLToPath(new URL('./metadata.mts', import.meta.url)),
        '--verify-dependency',
        file,
        output,
        '@oliphaunt/ts-query',
        '0.1.1',
        String(row.file.size),
        row.file.sha256,
      ]);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(output)).toEqual(readFileSync(row.file.path));
    const substitute = path.join(directory, 'substitute.tgz');
    writeFileSync(substitute, gzipSync(gunzipSync(readFileSync(row.file.path)), { level: 1 }));
    expect(run(substitute).exitCode).not.toBe(0);
    expect(readFileSync(output)).toEqual(readFileSync(row.file.path));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
