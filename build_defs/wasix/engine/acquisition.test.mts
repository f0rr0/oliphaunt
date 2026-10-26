import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ENGINE_DLL_PACKAGE,
  ENGINE_SOURCE_PACKAGES,
  engineDeliveryManifests,
  normalizeEngineManifest,
} from '../../../src/wasix/runtime/engine/package.mts';
import { renderCargoToml } from '../../../tools/packaging/cargo-manifest.mts';
import { projectCargoWorkspace } from '../../languages/cargo-metadata.mts';
import { type EngineSourcePins, prepareEngineAcquisition } from './acquisition.mts';

const version = '0.3.4';
function fixture() {
  const pins = JSON.parse(
    readFileSync(
      new URL('../../../src/wasix/runtime/engine/sources.json', import.meta.url),
      'utf8',
    ),
  ).crates as EngineSourcePins;
  const manifests = Object.fromEntries(
    Object.keys(ENGINE_SOURCE_PACKAGES).map((name) => [
      name,
      renderCargoToml({
        package: { name, version: pins[name].version, edition: '2021', 'rust-version': '1.93' },
        lib: { path: 'src/lib.rs' },
        dependencies: {
          engine: { package: 'wasmer', version: '=7.5.0', 'default-features': false },
          'wasmer-types': '=7.5.0',
        },
        ...(name === 'wasmer'
          ? {
              features: { v8: ['std', 'dep:ureq'], std: [] },
              'build-dependencies': { ureq: { version: '3.4.2', optional: true } },
              example: [{ name: 'example', path: 'examples/example.rs' }],
            }
          : {}),
      }),
    ]),
  ) as Record<keyof typeof ENGINE_SOURCE_PACKAGES, string>;
  return { pins, manifests };
}

test('acquisition has four real-version source forks and exactly three delivery workspace members', () => {
  const { pins, manifests } = fixture();
  const before = structuredClone({ pins, manifests });
  const actual = prepareEngineAcquisition(manifests, version, pins);
  const delivery = engineDeliveryManifests(version);
  assert.deepEqual(
    actual.members.sort(),
    Object.keys(delivery)
      .map((name) => `engine/${name}`)
      .sort(),
  );
  assert.deepEqual(
    Object.keys(actual.patch).sort(),
    [...Object.values(ENGINE_SOURCE_PACKAGES), ...Object.keys(delivery)].sort(),
  );
  assert.equal(Object.hasOwn(actual.patch, 'wasmer'), false);
  assert.deepEqual(
    Object.keys(actual.sources).sort(),
    Object.values(ENGINE_SOURCE_PACKAGES)
      .map((name) => `${name} ${version}`)
      .sort(),
  );
  for (const [original, name] of Object.entries(ENGINE_SOURCE_PACKAGES)) {
    const directory = actual.patch[name].path;
    const manifest = Bun.TOML.parse(actual.files[`${directory}/Cargo.toml`]);
    assert.equal(manifest.package.name, name);
    assert.equal(manifest.package.version, version);
    assert.equal(manifest.lib.name, original.replaceAll('-', '_'));
    assert.equal(manifest.dependencies.engine.package, 'oliphaunt-wasmer');
    assert.equal(manifest.dependencies.engine.version, `=${version}`);
    assert.equal(manifest.dependencies['wasmer-types'].version, '=7.5.0');
    assert.deepEqual(manifest.workspace, {});
    assert.equal(manifest.patch, undefined);
    assert.equal(actual.members.includes(directory), false);
    assert.deepEqual(actual.sources[`${name} ${version}`], {
      url: pins[original].url,
      sha256: pins[original].sha256,
      strip_prefix: pins[original].strip_prefix,
      patches: [
        ...pins[original].patches.map((file) => `//src/wasix/runtime/engine:${file}`),
        `${directory}/Cargo.toml.patch`,
      ],
    });
  }
  const api = Bun.TOML.parse(actual.files['engine/oliphaunt-wasmer/Cargo.toml']);
  assert.equal(api['build-dependencies'][ENGINE_DLL_PACKAGE].version, '=0.0.0');
  const published = Bun.TOML.parse(normalizeEngineManifest(manifests.wasmer, { version }));
  assert.equal(published['build-dependencies'][ENGINE_DLL_PACKAGE].version, `=${version}`);
  api['build-dependencies'][ENGINE_DLL_PACKAGE].version = `=${version}`;
  assert.deepEqual(api, published);
  for (const directory of actual.members) {
    const manifest = Bun.TOML.parse(actual.files[`${directory}/Cargo.toml`]);
    assert.equal(manifest.workspace, undefined);
    assert.equal(manifest.package.version, version);
    assert.equal(actual.files[`${directory}/src/lib.rs`], '');
    for (const [name, dependency] of Object.entries(manifest.dependencies ?? {}))
      if (Object.hasOwn(delivery, name))
        assert.deepEqual(dependency, { path: `../${name}`, version: `=${version}` });
  }
  assert.equal(actual.files['engine/oliphaunt-wasmer/build.rs'], 'fn main() {}\n');
  assert.equal(actual.files['engine/oliphaunt-wasmer/examples/example.rs'], 'fn main() {}\n');
  assert.deepEqual({ pins, manifests }, before);
});

test('the ordinary member projector owns zeroing delivery identities and their local dependency edges', () => {
  const { pins, manifests } = fixture();
  const prepared = prepareEngineAcquisition(manifests, version, pins);
  const lock = {
    version: 4,
    package: [
      ...prepared.members.map((directory) => {
        const manifest = Bun.TOML.parse(prepared.files[`${directory}/Cargo.toml`]);
        return {
          name: manifest.package.name,
          version,
          dependencies: Object.keys(manifest.dependencies),
        };
      }),
      {
        name: 'flate2',
        version: '1.1.9',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
      },
    ],
  };
  const projected = projectCargoWorkspace(
    { workspace: { members: prepared.members } },
    lock,
    [],
    (file) => Bun.TOML.parse(prepared.files[file]),
    (file) => Object.hasOwn(prepared.files, file),
  );
  for (const directory of prepared.members) {
    const manifest = Bun.TOML.parse(projected.files[`${directory}/Cargo.toml`]);
    assert.equal(manifest.package.version, '0.0.0');
    for (const dependency of Object.values(manifest.dependencies) as any[])
      if (dependency.path) assert.equal(dependency.version, '=0.0.0');
    assert.equal(projected.facts[directory].version, version);
  }
  assert.equal(
    Bun.TOML.parse(projected.files['Cargo.lock']).package.find((entry) => entry.name === 'flate2')
      .version,
    '1.1.9',
  );
  assert.throws(
    () =>
      projectCargoWorkspace(
        {
          workspace: { members: [] },
          patch: { 'crates-io': { wasmer: { path: 'ambient-patch' } } },
        },
        { version: 4, package: [] },
        [],
        () => ({}),
        () => false,
      ),
    /does not yet represent workspace patch/,
  );
});

test('generated replacement patches apply to the exact original manifest including absent final newline', (t) => {
  const { pins, manifests } = fixture();
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'engine-cargo-patch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const original of Object.keys(ENGINE_SOURCE_PACKAGES)) {
    for (const trailingNewline of [true, false]) {
      const sources = {
        ...manifests,
        [original]: trailingNewline ? manifests[original] : manifests[original].replace(/\n$/u, ''),
      };
      const prepared = prepareEngineAcquisition(sources, version, pins);
      const directory = prepared.patch[ENGINE_SOURCE_PACKAGES[original]].path;
      writeFileSync(path.join(root, 'Cargo.toml'), sources[original]);
      const applied = spawnSync(
        'git',
        ['-c', 'core.autocrlf=false', 'apply', '--no-index', '-p1', '-'],
        {
          cwd: root,
          input: prepared.files[`${directory}/Cargo.toml.patch`],
          encoding: 'utf8',
        },
      );
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(
        readFileSync(path.join(root, 'Cargo.toml'), 'utf8'),
        prepared.files[`${directory}/Cargo.toml`],
      );
    }
  }
});

test('source identity mistakes fail before producing misleading owned acquisition manifests', () => {
  const { pins, manifests } = fixture();
  assert.throws(
    () =>
      prepareEngineAcquisition(
        { ...manifests, wasmer: manifests['wasmer-journal'] },
        version,
        pins,
      ),
    /Wrong engine source/,
  );
  assert.throws(
    () =>
      prepareEngineAcquisition(manifests, version, {
        ...pins,
        wasmer: { ...pins.wasmer, version: '7.2.1' },
      }),
    /Stale source pin/,
  );
  assert.throws(
    () => prepareEngineAcquisition({ ...manifests, other: manifests.wasmer } as any, version, pins),
    /deep-equal/,
  );
});
