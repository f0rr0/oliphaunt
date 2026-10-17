import { expect, test } from 'bun:test';
import { importToolchainMetadata, mobileRustTargets } from './toolchain-metadata.mts';

test('mobile Rust std acquisition follows the public slice and architecture contracts', () => {
  expect(mobileRustTargets()).toEqual([
    'aarch64-apple-ios',
    'aarch64-apple-ios-sim',
    'aarch64-linux-android',
    'x86_64-linux-android',
  ]);
});

function fixture() {
  const versions = { node: '22.22.3', bun: '1.4.2' };
  const rust = { toolchain: { channel: '1.93.1' } };
  const root = { workspaces: { catalog: { typescript: '^6.0.3' } } };
  const query: Parameters<typeof importToolchainMetadata>[3] = {
    name: '@oliphaunt/ts-query',
    devDependencies: { typescript: 'catalog:', '@types/node': '^24.10.1' },
  };
  const lock = {
    lockfileVersion: 2,
    configVersion: 1,
    catalog: structuredClone(root.workspaces.catalog),
    workspaces: { 'src/query/ts': structuredClone(query) },
    packages: {
      '@oliphaunt/ts-query/typescript': ['typescript@6.0.3', '', {}, 'sha512-typescript'],
      '@oliphaunt/ts-query/@types/node': [
        '@types/node@24.12.4',
        '',
        { dependencies: { 'undici-types': '7.16.0' } },
        'sha512-node',
      ],
      '@oliphaunt/ts-query/@types/node/undici-types': [
        'undici-types@7.16.0',
        '',
        {},
        'sha512-undici',
      ],
      typescript: ['typescript@5.9.3', '', {}, 'sha512-older-root-copy'],
    },
  } as Parameters<typeof importToolchainMetadata>[4];
  const cargo = { workspace: { package: { edition: '2024', 'rust-version': '1.93' } } };
  const queryRust = {
    package: {
      name: 'oliphaunt-query',
      version: '0.1.1',
      edition: { workspace: true },
      'rust-version': { workspace: true },
    },
  } as Parameters<typeof importToolchainMetadata>[6];
  return [versions, rust, root, query, lock, cargo, queryRust] as const;
}

test('imports the scoped locked dependency, rather than a different root copy', () => {
  const args = fixture();
  expect(importToolchainMetadata(...args).typescript.version).toBe('6.0.3');
  expect(importToolchainMetadata(...args).language_acquisition.undici_types.version).toBe('7.16.0');
});

test('Apple construction floors project the public compatibility policy without SDK discovery', () => {
  expect(importToolchainMetadata(...fixture()).apple_deployment_targets).toEqual({
    native_macos: '11.0.0',
    package_macos: '14.0.0',
    ios: '17.0.0',
    ios_simulator: '17.0.0',
  });
});

test.each([
  'Cargo version',
  'npm type',
  'npm name',
] as const)('%s metadata cannot change language acquisition', (change) => {
  const args = fixture();
  const before = importToolchainMetadata(...args);
  expect(Object.keys(before.language_acquisition).sort()).toEqual([
    'edition',
    'rust',
    'rust_targets',
    'types_node',
    'undici_types',
  ]);
  if (change === 'Cargo version') {
    args[6].package.version = '0.2.0';
  } else if (change === 'npm type') {
    args[3].type = 'module';
  } else {
    const oldName = args[3].name;
    args[3].name = '@oliphaunt/renamed-query';
    args[4].workspaces['src/query/ts'].name = args[3].name;
    for (const key of Object.keys(args[4].packages)) {
      if (!key.startsWith(`${oldName}/`)) continue;
      args[4].packages[`${args[3].name}${key.slice(oldName.length)}`] = args[4].packages[key];
      delete args[4].packages[key];
    }
  }
  const after = importToolchainMetadata(...args);
  expect(after.language_acquisition).toEqual(before.language_acquisition);
  if (change === 'Cargo version') {
    expect(after.query_rust.version).toBe('0.2.0');
    expect(after.query_rust.env.CARGO_PKG_VERSION).toBe('0.2.0');
  } else if (change === 'npm type') {
    expect(after.query_package_type).toBe('module');
  } else {
    expect(after.query_npm_name).toBe('@oliphaunt/renamed-query');
  }
});

test('rejects a stale lock declaration before using resolved versions', () => {
  const args = fixture();
  args[4].workspaces['src/query/ts'].devDependencies = { typescript: '^5.0.0' };
  expect(() => importToolchainMetadata(...args)).toThrow('stale query declaration');
});

test('rejects stale catalog declarations and unsupported lock schemas', () => {
  const args = fixture();
  args[4].catalog = { typescript: '^6.0.2' };
  expect(() => importToolchainMetadata(...args)).toThrow('stale catalog declaration');
  args[4].catalog = { typescript: '^6.0.3' };
  args[4].lockfileVersion = 3;
  expect(() => importToolchainMetadata(...args)).toThrow('Unsupported Bun lockfile schema');
});

test('rejects missing or incompatible scoped dependencies', () => {
  const args = fixture();
  delete args[4].packages['@oliphaunt/ts-query/typescript'];
  expect(() => importToolchainMetadata(...args)).toThrow('does not satisfy');
});

test('rejects an incompatible transitive package or absent integrity', () => {
  const args = fixture();
  args[4].packages['@oliphaunt/ts-query/@types/node/undici-types'][0] = 'undici-types@6.21.0';
  expect(() => importToolchainMetadata(...args)).toThrow('does not satisfy');
  args[4].packages['@oliphaunt/ts-query/@types/node/undici-types'][0] = 'undici-types@7.16.0';
  args[4].packages['@oliphaunt/ts-query/@types/node/undici-types'][3] = '';
  expect(() => importToolchainMetadata(...args)).toThrow('integrity-bearing');
});

test('unrelated lock records cannot change the imported toolchain closure', () => {
  const args = fixture();
  const before = importToolchainMetadata(...args);
  args[4].packages.unrelated = ['unrelated@99.0.0', '', {}, 'sha512-unrelated'];
  expect(importToolchainMetadata(...args)).toEqual(before);
});

test('rejects a compiler below the conventional Cargo minimum', () => {
  const args = fixture();
  args[1].toolchain.channel = '1.92.0';
  expect(() => importToolchainMetadata(...args)).toThrow('below the Cargo workspace rust-version');
});

test('query Rust compile facts come from Cargo and unsupported changes fail closed', () => {
  const args = fixture();
  expect(importToolchainMetadata(...args).query_rust).toMatchObject({
    crate_name: 'oliphaunt_query',
    edition: '2024',
    minimum: '1.93',
    version: '0.1.1',
  });
  args[6].package.edition.workspace = false;
  expect(() => importToolchainMetadata(...args)).toThrow('requires workspace edition');
  args[6].package.edition.workspace = true;
  args[6].dependencies = { serde: '1' };
  expect(() => importToolchainMetadata(...args)).toThrow(
    'does not yet support Cargo [dependencies]',
  );
});

test('preserves Cargo version and inherited metadata in compiler environment', () => {
  const args = fixture();
  args[6].package.version = '0.2.0-beta.1+build';
  args[6].package.license = { workspace: true };
  args[5].workspace.package.license = 'MIT';
  args[6].package.authors = ['First Author', 'Second Author'];
  expect(importToolchainMetadata(...args).query_rust.env).toMatchObject({
    CARGO_PKG_NAME: 'oliphaunt-query',
    CARGO_PKG_VERSION: '0.2.0-beta.1+build',
    CARGO_PKG_VERSION_PATCH: '0',
    CARGO_PKG_VERSION_PRE: 'beta.1',
    CARGO_PKG_LICENSE: 'MIT',
    CARGO_PKG_AUTHORS: 'First Author:Second Author',
  });
});
