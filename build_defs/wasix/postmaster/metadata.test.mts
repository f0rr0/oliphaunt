import { expect, test } from 'bun:test';
import {
  postmasterCargoManifest,
  postmasterCargoSources,
  postmasterCargoTargets,
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

test('imports every genuine locked path source without selecting optional features', () => {
  const own = { name: 'executor', version: '7.2.0-alpha.2' };
  const lock = {
    version: 4,
    package: [
      own,
      { name: 'engine', version: '1.2.3' },
      { name: 'optional-compiler', version: '1.2.3' },
      { name: 'registry', version: '1.0.0', source: 'registry+https://example.invalid' },
    ],
  };
  const manifests = {
    'Cargo.toml': {
      workspace: {
        members: ['lib/engine', 'lib/compiler', 'lib/unlocked'],
        package: { version: '1.2.3' },
      },
    },
    'lib/engine/Cargo.toml': { package: { name: 'engine', version: { workspace: true } } },
    'lib/compiler/Cargo.toml': {
      package: { name: 'optional-compiler', version: { workspace: true } },
    },
    'lib/unlocked/Cargo.toml': { package: { name: 'unlocked', version: { workspace: true } } },
  };
  const read = (relative: string) => manifests[relative];
  const projection = postmasterCargoSources(lock, own, source, patch, read);
  expect(Object.keys(projection.sources)).toEqual(['engine 1.2.3', 'optional-compiler 1.2.3']);
  expect(projection.sources['engine 1.2.3'].strip_prefix).toBe(`wasmer-${pin.commit}/lib/engine`);
  expect(projection.sources['engine 1.2.3'].patches).toEqual(['patches/cargo/engine.patch']);
  expect(Object.keys(projection.patches)).toEqual(['patches/cargo/engine.patch']);
  expect(projection.sources['optional-compiler 1.2.3'].patches).toEqual([]);
  expect(projection.sources['unlocked 1.2.3']).toBeUndefined();
  expect(() =>
    postmasterCargoSources({ ...lock, package: [own] }, own, source, patch, read),
  ).toThrow('no patched path sources');
  expect(() =>
    postmasterCargoSources(lock, { ...own, version: '7.2.0-alpha.3' }, source, patch, read),
  ).toThrow('executor package must match');
  expect(() =>
    postmasterCargoSources(
      {
        ...lock,
        package: [{ ...own, source: 'registry+https://example.invalid' }, ...lock.package.slice(1)],
      },
      own,
      source,
      patch,
      read,
    ),
  ).toThrow('retain its path source');
  expect(() =>
    postmasterCargoSources(
      {
        ...lock,
        package: [
          ...lock.package,
          { name: 'engine', version: '1.2.3', source: 'registry+https://example.invalid' },
        ],
      },
      own,
      source,
      patch,
      read,
    ),
  ).toThrow('Ambiguous canonical source identity');
  expect(() =>
    postmasterCargoSources(
      { ...lock, package: [own, { name: 'engine', version: '1.2.4' }] },
      own,
      source,
      patch,
      read,
    ),
  ).toThrow('one immutable workspace member');
  expect(() =>
    postmasterCargoSources(lock, own, source, patch, (relative) =>
      relative === 'Cargo.toml' ? { workspace: { members: ['../engine'] } } : read(relative),
    ),
  ).toThrow('Unsafe source path');
  expect(() =>
    postmasterCargoSources(
      { ...lock, package: [own, { name: '../engine', version: '1.2.3' }] },
      own,
      source,
      patch,
      read,
    ),
  ).toThrow('Unsafe Cargo package');
  expect(() => postmasterSource({ ...pin, commit: 'main' }, 'b'.repeat(64))).toThrow(
    'Immutable GitHub',
  );
});

test('metadata target placeholders require authentic declared source paths', () => {
  const manifest = {
    package: { name: 'executor' },
    bin: [{ name: 'executor', path: 'src/bin/executor.rs' }],
  };
  const files = new Set(['src/lib.rs', 'src/bin/executor.rs']);
  expect(postmasterCargoTargets(manifest, (relative) => files.has(relative))).toEqual([
    'src/bin/executor.rs',
    'src/lib.rs',
  ]);
  expect(() => postmasterCargoTargets(manifest, (relative) => relative === 'src/lib.rs')).toThrow(
    'Missing canonical Cargo target src/bin/executor.rs',
  );
  expect(() =>
    postmasterCargoTargets(
      { ...manifest, bin: [{ name: 'executor', path: '../other.rs' }] },
      () => true,
    ),
  ).toThrow('Unsafe source path');
  expect(() =>
    postmasterCargoTargets(
      { ...manifest, bin: [{ name: 'executor', path: 'src/\nother.rs' }] },
      () => true,
    ),
  ).toThrow('Unsafe source path');
  expect(() =>
    postmasterCargoTargets(
      { ...manifest, package: { name: 'executor', build: 'other-build.rs' } },
      (relative) => files.has(relative),
    ),
  ).toThrow('Missing canonical Cargo target other-build.rs');
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
