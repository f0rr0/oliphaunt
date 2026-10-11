import { expect, test } from 'bun:test';
import {
  browserCargoSources,
  browserCargoWorkspace,
  browserNpmAcquisition,
  browserRustFlags,
  browserSources,
  projectPatchedCargoLock,
} from './metadata.mts';

function sourceFixture() {
  const source: any = {
    'wasmer-js': {
      name: '@wasmer/sdk',
      version: '0.8.0',
      url: 'https://github.com/wasmerio/wasmer-js.git',
      commit: 'a'.repeat(40),
    },
    patches: { series: ['0001-wasmer-js-example.patch', '0002-wasmer-example.patch'] },
  };
  for (const name of ['wasmer-wasix', 'wasmer', 'virtual-fs', 'virtual-mio'])
    source[name] = {
      name,
      version: '6.1.0',
      url: `https://static.crates.io/crates/${name}/${name}-6.1.0.crate`,
      sha256: 'b'.repeat(64),
    };
  return source;
}

test('browser sources retain their separate immutable identity and ordered patch ownership', () => {
  const source = sourceFixture();
  const imported = browserSources(source);
  expect(imported.sources[0].directory).toBe('wasmer-js');
  expect(imported.sources[2].directory).toBe('wasmer-6.1.0');
  expect(imported.patches.map((row) => row.source)).toEqual(['wasmer-js', 'wasmer']);
  source.patches.series.push('../escape.patch');
  expect(() => browserSources(source)).toThrow('Unsafe');
});

test('Cargo string and array rustflags preserve the same compiler argument sequence', () => {
  const flags = [
    '-Ctarget-feature=+atomics,+bulk-memory',
    '-Clink-args=--no-check-features',
    '--cfg=web_sys_unstable_apis',
  ];
  expect(browserRustFlags(`  ${flags.join('  ')}\n`)).toEqual(flags);
  expect(browserRustFlags(flags)).toEqual(flags);
  expect(() => browserRustFlags('')).toThrow('argument list');
  expect(() => browserRustFlags([false])).toThrow('argument list');
});

test('patched Cargo HTTP identities and patch order come only from the canonical source', () => {
  const source = sourceFixture();
  source.patches.series.push('0003-wasmer-next.patch');
  const projected = browserCargoSources(source);
  expect(Object.keys(projected)).toHaveLength(4);
  expect(projected['wasmer 6.1.0']).toEqual({
    url: source.wasmer.url,
    sha256: source.wasmer.sha256,
    strip_prefix: 'wasmer-6.1.0',
    patches: ['patches/0002-wasmer-example.patch', 'patches/0003-wasmer-next.patch'],
  });
  expect(Object.keys(projected).some((id) => id.startsWith('wasmer-js '))).toBe(false);
  const duplicate = sourceFixture();
  duplicate.patches.series.push(duplicate.patches.series[0]);
  expect(() => browserCargoSources(duplicate)).toThrow('unique');
  source.wasmer.sha256 = 'not-a-digest';
  expect(() => browserCargoSources(source)).toThrow('immutable');
});

test('complete Cargo projection preserves path patches without extra root feature activation', () => {
  const source = sourceFixture();
  const manifest: any = {
    patch: {
      'crates-io': Object.fromEntries(
        browserSources(source)
          .sources.slice(1)
          .map((row) => [row.name, { path: `../${row.directory}` }]),
      ),
    },
    profile: { release: { lto: true, 'opt-level': 3 } },
  };
  const projected = Bun.TOML.parse(browserCargoWorkspace(source, manifest));
  expect(projected.workspace.members).toEqual(['wasmer-js']);
  expect(projected.workspace.exclude).toHaveLength(4);
  expect(projected.patch['crates-io'].wasmer.path).toBe('wasmer-6.1.0');
  expect(projected.profile.release).toEqual(manifest.profile.release);
  manifest.patch['crates-io'].wasmer.path = '../../ambient';
  expect(() => browserCargoWorkspace(source, manifest)).toThrow('patch path');
});

function npmFixture() {
  const declarations = { rollup: '^4.0.0', typescript: '^5.3.0', '@types/node': '^22.0.0' };
  const manifest = { name: '@wasmer/sdk', version: '0.8.0', devDependencies: declarations };
  const row = (name: string, version: string, extra = {}) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
    integrity: 'sha512-Ynl0ZXM=',
    ...extra,
  });
  const lock: any = {
    lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version, devDependencies: declarations },
      'node_modules/rollup': row('rollup', '4.20.0', {
        dependencies: { helper: '^1.0.0' },
        optionalDependencies: { native: '1.0.0' },
      }),
      'node_modules/rollup/node_modules/helper': row('helper', '1.4.0'),
      'node_modules/helper': row('helper', '2.0.0'),
      'node_modules/native': row('native', '1.0.0', { os: ['darwin'], cpu: ['arm64'] }),
      'node_modules/typescript': row('typescript', '5.3.3'),
      'node_modules/@types/node': row('@types/node', '22.20.1'),
    },
  };
  return { manifest, lock };
}

test('npm acquisition follows physical nested lock resolutions and optional compiler platforms', () => {
  const { manifest, lock } = npmFixture();
  const imported = browserNpmAcquisition(manifest, lock, ['rollup']);
  const rollup = imported.packages[imported.roots.rollup];
  expect(imported.packages[rollup.dependencies.helper].version).toBe('1.4.0');
  expect(rollup.dependencies.native).toBeUndefined();
  expect(Object.values(imported.packages).some((row: any) => row.version === '2.0.0')).toBe(false);
  for (const mutate of [
    (value: any) => {
      value.lock.packages[''].version = '0.7.0';
    },
    (value: any) => {
      value.lock.packages['node_modules/typescript'].integrity = '';
    },
    (value: any) => {
      value.lock.packages['node_modules/rollup/node_modules/helper'].version = '2.0.0';
    },
  ]) {
    const value = npmFixture();
    mutate(value);
    expect(() => browserNpmAcquisition(value.manifest, value.lock, ['rollup'])).toThrow();
  }
});

test('patched Cargo projection preserves exact locked versions and rejects new resolution', () => {
  const checksum = 'c'.repeat(64);
  const source = { wasmer: { version: '6.1.0', sha256: checksum } };
  const original = `version = 4\n\n[[package]]\nname = "wasmer"\nversion = "6.1.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\ndependencies = [\n "existing",\n]\n\n[[package]]\nname = "existing"\nversion = "1.0.0"\n\n[[package]]\nname = "wasm-bindgen-futures"\nversion = "0.4.51"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "retained"\n`;
  const before = {
    package: { name: 'wasmer', version: '6.1.0' },
    dependencies: { existing: '1.0' },
  };
  const patched = {
    ...before,
    dependencies: { ...before.dependencies, 'wasm-bindgen-futures': '0.4.51' },
  };
  const projected = projectPatchedCargoLock(source, { wasmer: patched }, original, {
    wasmer: before,
  });
  const lock = Bun.TOML.parse(projected);
  expect(lock.package[0].source).toBeUndefined();
  expect(lock.package[0].checksum).toBeUndefined();
  expect(lock.package[0].dependencies).toEqual(['existing', 'wasm-bindgen-futures']);
  expect(lock.package.slice(1)).toEqual(Bun.TOML.parse(original).package.slice(1));
  patched.dependencies['wasm-bindgen-futures'] = '=0.4.52';
  expect(() =>
    projectPatchedCargoLock(source, { wasmer: patched }, original, { wasmer: before }),
  ).toThrow('missing or ambiguous');
  patched.dependencies['wasm-bindgen-futures'] = '0.4.51';
  patched.dependencies.existing = '=2.0.0';
  expect(() =>
    projectPatchedCargoLock(source, { wasmer: patched }, original, { wasmer: before }),
  ).toThrow('missing or ambiguous');
});
