import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { browserSources } from './metadata.mts';
import {
  assertNativeBrowserHostProvenance,
  HOST_FILES,
  nativeBrowserHostProvenance,
} from './provenance.mts';

function fixture() {
  const rust = {
    channel: 'nightly-2025-07-05',
    edition: '2021',
    target: 'wasm32-unknown-unknown',
    flags: '-Ctarget-feature=+atomics,+bulk-memory --cfg=web_sys_unstable_apis',
    buildStd: ['std', 'panic_abort'],
    profile: { lto: true, 'opt-level': 3 },
  };
  const std = {
    schema: 'oliphaunt-browser-rust-std-native-v1',
    channel: rust.channel,
    target: rust.target,
    buildStd: rust.buildStd,
    targetFeatures: ['atomics', 'bulk-memory', 'mutable-globals'],
    compiler: { sha256: 'a'.repeat(64) },
    rustSrc: { commit: 'b'.repeat(40), sha256: 'c'.repeat(64) },
    stdlib: [
      { path: 'lib/rustlib/wasm32-unknown-unknown/lib/libstd.rlib', sha256: 'd'.repeat(64) },
    ],
    rust,
  };
  const sourceInputs = {
    'src/wasix/browser-host/source.toml': 'e'.repeat(64),
    'src/wasix/browser-host/patches/0001-wasmer-js-example.patch': 'f'.repeat(64),
  };
  const source: any = {
    'wasmer-js': {
      name: '@wasmer/sdk',
      version: '0.8.0',
      url: 'https://github.com/wasmerio/wasmer-js.git',
      commit: 'a'.repeat(40),
    },
    patches: { series: ['0001-wasmer-js-example.patch'] },
  };
  for (const name of ['wasmer-wasix', 'wasmer', 'virtual-fs', 'virtual-mio'])
    source[name] = {
      name,
      version: '6.1.0',
      url: `https://static.crates.io/crates/${name}/${name}-6.1.0.crate`,
      sha256: 'b'.repeat(64),
    };
  const packages: Record<string, any> = {};
  const roots: Record<string, string> = {};
  for (const name of ['typescript', 'rollup', '@types/node']) {
    const key = `node_modules/${name}`;
    const id = `p_${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    roots[name] = id;
    packages[id] = {
      key,
      package: name,
      version: '1.0.0',
      url: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-1.0.0.tgz`,
      integrity: 'sha512-Zml4dHVyZQ==',
      dependencies: {},
    };
  }
  const metadata = {
    sources: browserSources(source).sources,
    sourceInputs,
    rust,
    compilerSources: {
      'wasm-bindgen': { version: '0.2.101', sha256: '1'.repeat(64) },
      'wasm-opt': { version: '117', sha256: '2'.repeat(64) },
    },
    wasmOpt: ['--enable-threads', '--enable-bulk-memory', '-O3'],
    acquisition: { platform: { os: 'linux', cpu: 'x64' }, roots, packages },
  };
  const files = Object.fromEntries(HOST_FILES.map((name) => [name, Buffer.from(name)]));
  files['wasmer_js_bg.wasm'] = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const result = nativeBrowserHostProvenance(
    metadata,
    files,
    Buffer.from('generated declaration fixture'),
    std,
    '24.14.0',
  );
  return { result, files, source: { sources: metadata.sources, sourceInputs } };
}

test('native receipt binds payload bytes, source identities, and actual std capability', () => {
  const { result, files, source } = fixture();
  expect(() => assertNativeBrowserHostProvenance(result, { source, files })).not.toThrow();
  expect(result.schema).toBe('oliphaunt-browser-host-native-v1');
  expect(result).not.toHaveProperty('inputsSha256');
  expect(result.abi.curatedSha256).toBe(result.files['index.d.mts'].sha256);
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => {
      value.files['index.mjs'] = Buffer.from('changed');
    },
    (value: ReturnType<typeof fixture>) => {
      value.result.source.sourceInputs['src/wasix/browser-host/source.toml'] = '0'.repeat(64);
    },
    (value: ReturnType<typeof fixture>) => {
      value.result.rust.std.targetFeatures = ['bulk-memory'];
    },
    (value: ReturnType<typeof fixture>) => {
      value.result.optimization.wasmOpt = ['-O2'];
    },
    (value: ReturnType<typeof fixture>) => {
      value.result.abi.compatibility = 'unchecked';
    },
  ]) {
    const value = fixture();
    value.source = structuredClone(value.source);
    mutate(value);
    expect(() => assertNativeBrowserHostProvenance(value.result, value)).toThrow();
  }
});
