import { expect, test } from 'bun:test';
import { projectCargoWorkspace, renderToml } from './cargo-metadata.mts';

function fixture() {
  const workspace = {
    workspace: {
      members: ['core', 'sdk'],
      resolver: '3',
      package: { edition: '2024', 'rust-version': '1.93', license: 'MIT' },
    },
  };
  const manifests: Record<string, any> = {
    'core/Cargo.toml': {
      package: {
        name: 'core',
        version: '0.2.0',
        edition: { workspace: true },
        'rust-version': { workspace: true },
        description: 'Core',
      },
      dependencies: { serde: { version: '1', features: ['derive'] } },
    },
    'sdk/Cargo.toml': {
      package: {
        name: 'sdk',
        version: '0.3.0',
        edition: { workspace: true },
        'rust-version': { workspace: true },
        build: 'build.rs',
        links: 'resources',
      },
      features: { default: ['desktop'], desktop: ['dep:core'] },
      dependencies: { core: { path: '../core', version: '0.2.0', optional: true } },
      target: { 'cfg(unix)': { 'dev-dependencies': { libc: '0.2' } } },
    },
  };
  const lock = {
    version: 4,
    package: [
      { name: 'core', version: '0.2.0', dependencies: ['serde'] },
      { name: 'sdk', version: '0.3.0', dependencies: ['core', 'libc'] },
      {
        name: 'serde',
        version: '1.0.228',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'serde-sha256',
        dependencies: ['serde_derive'],
      },
      {
        name: 'serde_derive',
        version: '1.0.228',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'derive-sha256',
      },
      {
        name: 'libc',
        version: '0.2.183',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'libc-sha256',
      },
      {
        name: 'unrelated',
        version: '99.0.0',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        checksum: 'other-sha256',
      },
    ],
  };
  const project = () =>
    projectCargoWorkspace(
      workspace,
      lock,
      ['sdk'],
      (relative) => manifests[relative],
      (relative) => relative.endsWith('/src/lib.rs') || relative === 'sdk/build.rs',
    );
  return { workspace, manifests, lock, project };
}

test('a conventional adapter workspace keeps sibling members within declared repository paths', () => {
  const { workspace, manifests, lock } = fixture();
  const owner = {
    ...manifests['sdk/Cargo.toml'],
    workspace: { ...workspace.workspace, members: ['.', '../core'] },
  };
  const sources = {
    'nested/adapter/Cargo.toml': owner,
    'nested/core/Cargo.toml': {
      ...manifests['core/Cargo.toml'],
      package: { ...manifests['core/Cargo.toml'].package, workspace: '../adapter' },
    },
  };
  const result = projectCargoWorkspace(
    owner,
    lock,
    [],
    (relative) => sources[relative],
    (relative) => relative.endsWith('/src/lib.rs'),
    {},
    'nested/adapter',
  );
  expect(Object.keys(result.facts).sort()).toEqual(['nested/adapter', 'nested/core']);
  expect(Bun.TOML.parse(result.files['Cargo.toml']).workspace.members).toEqual([
    'nested/adapter',
    'nested/core',
  ]);
  expect(Bun.TOML.parse(result.files['nested/core/Cargo.toml']).package.workspace).toBeUndefined();
  expect(() =>
    projectCargoWorkspace(
      { workspace: { members: ['../../../outside'] } },
      lock,
      [],
      () => ({}),
      () => false,
      {},
      'nested/adapter',
    ),
  ).toThrow('escapes');
});

test('preserves resolver, feature, optional, target/dev, generator and exact external lock facts', () => {
  const { project } = fixture();
  const result = project();
  const sdk = Bun.TOML.parse(result.files['sdk/Cargo.toml']);
  expect(sdk.features).toEqual({ default: ['desktop'], desktop: ['dep:core'] });
  expect(sdk.dependencies.core).toEqual({ path: '../core', version: '=0.0.0', optional: true });
  expect(sdk.target['cfg(unix)']['dev-dependencies']).toEqual({ libc: '0.2' });
  expect(sdk.package).toMatchObject({
    build: 'build.rs',
    links: 'resources',
    edition: '2024',
    'rust-version': '1.93',
  });
  expect(Bun.TOML.parse(result.files['Cargo.toml']).workspace).toEqual({
    members: ['core', 'sdk'],
    resolver: '3',
  });
  const lock = Bun.TOML.parse(result.files['Cargo.lock']);
  expect(lock.package.map((item) => item.name)).toEqual([
    'core',
    'libc',
    'sdk',
    'serde',
    'serde_derive',
  ]);
  expect(lock.package.find((item) => item.name === 'serde')).toMatchObject({
    version: '1.0.228',
    checksum: 'serde-sha256',
  });
  expect(result.watched).toContain('sdk/build.rs');
  expect(result.watched).toContain('sdk/tests');
});

test('coherent public version and package metadata edits do not change acquisition files', () => {
  const { project, manifests, lock } = fixture();
  const before = project();
  manifests['core/Cargo.toml'].package.version = '0.2.1';
  manifests['core/Cargo.toml'].package.description = 'New description';
  manifests['sdk/Cargo.toml'].dependencies.core.version = '0.2.1';
  manifests['sdk/Cargo.toml'].package.version = '0.3.1';
  for (const item of lock.package) {
    if (item.name === 'core') item.version = '0.2.1';
    if (item.name === 'sdk') item.version = '0.3.1';
  }
  const after = project();
  expect(after.files).toEqual(before.files);
  expect(after.facts.sdk.version).toBe('0.3.1');
  expect(after.facts.core.version).toBe('0.2.1');
});

test('an independently released workspace library does not retarget an SDK registry requirement', () => {
  const { workspace, manifests, lock } = fixture();
  manifests['sdk/Cargo.toml'].dependencies.core = { version: '=0.2.0' };
  for (const item of lock.package)
    if (item.name === 'sdk')
      item.dependencies = [
        'core 0.2.0 (registry+https://github.com/rust-lang/crates.io-index)',
        'libc',
      ];
  lock.package.push({
    name: 'core',
    version: '0.2.0',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    checksum: 'held-core-sha256',
  });
  const project = () =>
    projectCargoWorkspace(
      workspace,
      lock,
      [],
      (relative) => manifests[relative],
      (relative) => relative.endsWith('/src/lib.rs') || relative === 'sdk/build.rs',
    );
  const before = project();
  manifests['core/Cargo.toml'].package.version = '1.0.0';
  for (const item of lock.package) if (item.name === 'core' && !item.source) item.version = '1.0.0';
  const after = project();
  expect(after.files).toEqual(before.files);
  expect(after.facts.core.version).toBe('1.0.0');
  expect(Bun.TOML.parse(after.files['sdk/Cargo.toml']).dependencies.core).toEqual({
    version: '=0.2.0',
  });
  expect(
    Bun.TOML.parse(after.files['Cargo.lock']).package.filter((item) => item.name === 'core'),
  ).toEqual([
    { name: 'core', version: '0.0.0', dependencies: ['serde'] },
    {
      name: 'core',
      version: '0.2.0',
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      checksum: 'held-core-sha256',
    },
  ]);
});

test('same-version local and registry lock identities retain their distinct sources', () => {
  const { project, lock } = fixture();
  for (const item of lock.package)
    if (item.name === 'sdk') item.dependencies = ['core 0.2.0', 'libc'];
  lock.package.push({
    name: 'core',
    version: '0.2.0',
    source: 'registry+https://github.com/rust-lang/crates.io-index',
    checksum: 'unused-registry-core-sha256',
  });
  const selected = Bun.TOML.parse(project().files['Cargo.lock']).package;
  expect(selected.find((item) => item.name === 'core')).toEqual({
    name: 'core',
    version: '0.0.0',
    dependencies: ['serde'],
  });
  expect(selected.filter((item) => item.name === 'core')).toHaveLength(1);
});

test('dependency features and compiler minimum change their acquisition contract', () => {
  const { project, manifests, workspace } = fixture();
  const before = project();
  manifests['core/Cargo.toml'].dependencies.serde.features.push('rc');
  workspace.workspace.package['rust-version'] = '1.94';
  expect(project().files['core/Cargo.toml']).not.toBe(before.files['core/Cargo.toml']);
});

test('authored release stripping changes compiler facts without changing acquisition', () => {
  const { project, workspace } = fixture();
  const before = project();
  (workspace as any).profile = { release: { strip: 'symbols' } };
  const after = project();
  expect(after.files).toEqual(before.files);
  expect(after.facts.sdk.release_strip).toBe('symbols');
  expect(after.facts.core.release_strip).toBe('symbols');
  (workspace as any).profile.release.strip = 'unrepresented';
  expect(project).toThrow('Unsupported conventional Cargo release strip setting');
  (workspace as any).profile.release = { strip: 'symbols', lto: true };
  expect(project).toThrow('Unrepresented authored Cargo release profile fields');
});

test('rejects missing locks, incompatible path versions and unknown source overrides', () => {
  const { project, manifests, workspace } = fixture();
  manifests['core/Cargo.toml'].dependencies.new_dependency = '1';
  expect(project).toThrow('Stale canonical Cargo lock dependency');
  delete manifests['core/Cargo.toml'].dependencies.new_dependency;
  manifests['sdk/Cargo.toml'].dependencies.core.version = '0.4';
  expect(project).toThrow('Cargo path/version mismatch');
  manifests['sdk/Cargo.toml'].dependencies.core.version = '0.2';
  (workspace as any).patch = { 'crates-io': {} };
  expect(project).toThrow('workspace patch/replace');
});

test('TOML serializer preserves manifests with nested tables and target arrays', () => {
  const value = {
    package: { name: 'tool', version: '0.1.0' },
    bin: [
      { name: 'first', path: 'src/first.rs' },
      { name: 'second', path: 'src/second.rs' },
    ],
    target: {
      'cfg(unix)': {
        dependencies: {
          renamed: { package: 'actual', version: '=1.2.3', 'default-features': false },
        },
      },
    },
  };
  expect(Bun.TOML.parse(renderToml(value))).toEqual(value);
});

test('tool feature activation changes only the requested acquisition view, retaining canonical pins', () => {
  const { workspace, manifests, lock, project } = fixture();
  manifests['sdk/Cargo.toml'].features.bindgen = [];
  const before = project();
  const activated = projectCargoWorkspace(
    workspace,
    lock,
    [],
    (relative) => manifests[relative],
    (relative) => relative.endsWith('/src/lib.rs') || relative === 'sdk/build.rs',
    { sdk: ['bindgen'] },
  );
  expect(activated.files['Cargo.lock']).toBe(before.files['Cargo.lock']);
  expect(Bun.TOML.parse(activated.files['sdk/Cargo.toml']).features.default).toEqual([
    'desktop',
    'bindgen',
  ]);
  expect(activated.facts).toEqual(before.facts);
  expect(manifests['sdk/Cargo.toml'].features.default).toEqual(['desktop']);
  expect(() =>
    projectCargoWorkspace(
      workspace,
      lock,
      [],
      (p) => manifests[p],
      () => true,
      { sdk: ['unknown'] },
    ),
  ).toThrow('Unknown Cargo tool feature');
  expect(() =>
    projectCargoWorkspace(
      workspace,
      lock,
      [],
      (p) => manifests[p],
      () => true,
      { absent: ['desktop'] },
    ),
  ).toThrow('Unknown Cargo tool member');
});

test('Cargo dependency version checks ignore registry build metadata', () => {
  const { manifests, lock, project } = fixture();
  manifests['core/Cargo.toml'].dependencies.serde.version = '=1.0.228';
  for (const item of lock.package) if (item.name === 'serde') item.version = '1.0.228+upstream';
  expect(project().files['Cargo.lock']).toContain('1.0.228+upstream');
});
