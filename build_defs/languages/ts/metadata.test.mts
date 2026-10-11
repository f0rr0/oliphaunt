import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { importJavascriptMetadata } from './metadata.mts';

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

test('external runtime acquisition stays locked and local workspace dependencies require source', () => {
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
  expect(() =>
    importJavascriptMetadata(workspace.root, workspace.lock, workspace.manifests),
  ).toThrow('selected source package');
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
  expect(() =>
    importJavascriptMetadata(value.root, value.lock, value.manifests, {}, {}, dependencies),
  ).toThrow('conventional workspace version');
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

test('rejects stale declarations, missing integrity, and unavailable held workspace versions', () => {
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
      value.manifests['src/query'].version = '2.0.0';
      value.lock.workspaces['src/query'].version = '2.0.0';
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
