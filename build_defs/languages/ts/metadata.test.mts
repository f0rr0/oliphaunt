import { expect, test } from 'bun:test';
import { importJavascriptMetadata } from './metadata.mts';

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
