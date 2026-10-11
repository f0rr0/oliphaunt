import { expect, test } from 'bun:test';
import {
  postmasterCargoManifest,
  postmasterCargoSources,
  postmasterLeafPatch,
  postmasterRoleManifest,
  postmasterSource,
} from './metadata.mts';

const pin = { url: 'https://github.com/wasmerio/wasmer.git', commit: 'a'.repeat(40) };
const source = postmasterSource(pin, 'b'.repeat(64));
const patch = `diff --git a/Cargo.lock b/Cargo.lock
--- a/Cargo.lock
+++ b/Cargo.lock
@@ -1 +1 @@
-workspace
+workspace-new
diff --git a/lib/engine/src/lib.rs b/lib/engine/src/lib.rs
--- a/lib/engine/src/lib.rs
+++ b/lib/engine/src/lib.rs
@@ -1 +1 @@
-old
+new
diff --git a/lib/other/src/new.rs b/lib/other/src/new.rs
--- /dev/null
+++ b/lib/other/src/new.rs
@@ -0,0 +1 @@
+added
`;

test('projects full canonical hunks into a leaf without changing content', () => {
  expect(postmasterLeafPatch(patch, 'lib/engine')).toBe(`diff --git a/src/lib.rs b/src/lib.rs
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1 +1 @@
-old
+new
`);
  expect(postmasterLeafPatch(patch, 'lib/other')).toContain('--- /dev/null\n+++ b/src/new.rs');
  expect(postmasterLeafPatch(patch, 'lib/untouched')).toBe('');
  expect(() => postmasterLeafPatch(patch, '../engine')).toThrow('Unsafe source path');
  expect(() =>
    postmasterLeafPatch(patch.replace('b/lib/engine/', 'b/lib/other/'), 'lib/engine'),
  ).toThrow('crosses');
});

test('uses the canonical binary feature and retains package and dependency pins', () => {
  const manifest = {
    package: { name: 'executor', version: '7.2.0-alpha.2' },
    workspace: {},
    features: { default: [], execute: ['dep:runtime'], compile: ['dep:llvm'] },
    dependencies: {
      runtime: { version: '=1.0.0', optional: true },
      llvm: { version: '=2.0.0', optional: true },
    },
    'dev-dependencies': { testCompiler: '=3.0.0' },
    bin: [
      { name: 'executor', 'required-features': ['execute'] },
      { name: 'compiler', 'required-features': ['compile'] },
    ],
  };
  const result = Bun.TOML.parse(postmasterRoleManifest(manifest, 'executor'));
  expect(result.features.default).toEqual(['execute']);
  expect(result.package).toEqual(manifest.package);
  expect(result.dependencies).toEqual(manifest.dependencies);
  expect(result['dev-dependencies']).toEqual(manifest['dev-dependencies']);
  expect(result.workspace).toBeUndefined();
  expect(() => postmasterRoleManifest(manifest, 'missing')).toThrow('one canonical binary');
  expect(() =>
    postmasterRoleManifest(
      { ...manifest, features: { ...manifest.features, default: ['compile'] } },
      'executor',
    ),
  ).toThrow('empty');
});

test('exports actual selected local metadata identities and rejects source/lock drift', () => {
  const metadata = {
    workspace_members: ['executor'],
    packages: [
      { id: 'executor', source: null },
      {
        id: 'engine',
        source: null,
        name: 'engine',
        version: '1.2.3',
        manifest_path: '/source/lib/engine/Cargo.toml',
      },
      { id: 'registry', source: 'registry+https://example.invalid' },
    ],
  };
  const lock = { version: 4, package: [{ name: 'engine', version: '1.2.3' }] };
  const manifests = {
    'Cargo.toml': { workspace: { members: ['lib/engine'], package: { version: '1.2.3' } } },
    'lib/engine/Cargo.toml': { package: { name: 'engine', version: { workspace: true } } },
  };
  const read = (relative: string) => manifests[relative];
  const projection = postmasterCargoSources(metadata, lock, '/source', source, patch, read);
  expect(Object.keys(projection.sources)).toEqual(['engine 1.2.3']);
  expect(projection.sources['engine 1.2.3'].strip_prefix).toBe(`wasmer-${pin.commit}/lib/engine`);
  expect(projection.sources['engine 1.2.3'].patches).toEqual(['patches/cargo/engine.patch']);
  expect(Object.keys(projection.patches)).toEqual(['patches/cargo/engine.patch']);
  expect(() =>
    postmasterCargoSources(metadata, { ...lock, package: [] }, '/source', source, patch, read),
  ).toThrow('one canonical locked');
  expect(() =>
    postmasterCargoSources(
      {
        ...metadata,
        packages: [
          metadata.packages[0],
          { ...metadata.packages[1], manifest_path: '/other/lib/engine/Cargo.toml' },
        ],
      },
      lock,
      '/source',
      source,
      patch,
      read,
    ),
  ).toThrow('Unsafe source path');
  expect(() => postmasterSource({ ...pin, commit: 'main' }, 'b'.repeat(64))).toThrow(
    'Immutable GitHub',
  );
});

test('derives conventional direct path patches from exact workspace and lock identities', () => {
  const original = {
    package: { name: 'executor', version: '7.2.0-alpha.2', edition: '2024' },
    workspace: {},
    features: { default: [], execute: ['dep:runtime'] },
    dependencies: { runtime: { package: 'engine', version: '=1.2.3', optional: true } },
    'dev-dependencies': { test: '1.0' },
    bin: [{ name: 'executor', 'required-features': ['execute'] }],
  };
  const lock = { version: 4, package: [{ name: 'engine', version: '1.2.3' }] };
  const workspace = { members: ['lib/engine'], package: { version: '1.2.3' } };
  const read = (relative: string) => {
    expect(relative).toBe('lib/engine/Cargo.toml');
    return { package: { name: 'engine', version: { workspace: true } } };
  };
  const result = Bun.TOML.parse(
    postmasterCargoManifest(original, lock, workspace, read, 'executor'),
  );
  expect(result.patch['crates-io']).toEqual({ engine: { path: 'wasmer/lib/engine' } });
  expect(result.workspace).toEqual({ exclude: ['wasmer'] });
  expect(result.features.default).toEqual(['execute']);
  expect(result.dependencies).toEqual(original.dependencies);
  expect(result['dev-dependencies']).toEqual(original['dev-dependencies']);
  expect(() =>
    postmasterCargoManifest(original, { ...lock, package: [] }, workspace, read, 'executor'),
  ).toThrow('canonical local resolution');
  expect(() =>
    postmasterCargoManifest(
      {
        ...original,
        dependencies: { runtime: { package: 'engine', version: '=1.2.4', optional: true } },
      },
      lock,
      workspace,
      read,
      'executor',
    ),
  ).toThrow('Stale executor pin');
});
