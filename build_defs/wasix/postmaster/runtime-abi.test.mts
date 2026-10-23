import { expect, test } from 'bun:test';
import { nativeRuntimeAbi } from './runtime-abi.mts';

const source = {
  url: 'https://example.test/immutable/archive',
  sha256: 'a'.repeat(64),
  strip_prefix: 'archive/lib/types',
  patches: ['@@source//:patches/types.patch'],
};
const manifest = {
  package: { name: 'postmaster', version: '7.2.0-alpha.2', edition: '2024' },
  features: { default: [], execute: [], compile: [] },
  bin: ['executor', 'compiler'].map((role) => ({
    name: `postmaster-${role}`,
    path: `${role}.rs`,
    'required-features': [role === 'executor' ? 'execute' : 'compile'],
  })),
};
const context = (feature: string) => ({
  workspace_members: { 'postmaster 7.2.0-alpha.2': '' },
  crates: {
    'postmaster 7.2.0-alpha.2': { common_attrs: { crate_features: ['default', feature] } },
    'wasmer-types 7.2.0-alpha.2': {
      version: '7.2.0-alpha.2',
      library_target_name: 'wasmer_types',
      common_attrs: { crate_features: feature === 'execute' ? ['std'] : ['std', 'compiler'] },
      repository: { Http: { ...source, patch_args: ['-p1'] } },
    },
  },
});
const configured = {
  crate_name: 'wasmer_types',
  version: '7.2.0-alpha.2',
  target: 'x86_64-unknown-linux-gnu',
  features: ['std'],
};
const fixture = () => ({
  manifest,
  manifestBytes: 'conventional manifest bytes',
  lock: 'conventional lock bytes',
  contexts: { executor: context('execute'), compiler: context('compile') },
  sources: { 'wasmer-types 7.2.0-alpha.2': source },
  patches: { 'types.patch': 'actual ordered patch bytes' },
  sourceIdentity: {
    wasmer: { commit: 'immutable commit', url: source.url, sha256: source.sha256 },
    unused: { commit: 'unused source' },
  },
  rootSources: {
    'src/lib.rs': 'actual Rust library source',
    'executor.rs': 'executor entry',
    'compiler.rs': 'compiler entry',
  },
  serializer: 'pub const CURRENT_VERSION: u32 = 21;',
  loader: 'const ARTIFACT_ABI_VERSION: u32 = 21;',
  rust: { target: configured.target, version: '1.93.1', flags: [] },
  rustc: 'actual compiler bytes',
  roles: { executor: [configured], compiler: [{ ...configured, features: ['std', 'compiler'] }] },
});

test('native ABI keeps actual configured roles separate and ignores repository label spelling', () => {
  const input = fixture();
  const result = nativeRuntimeAbi(input);
  expect(result.schema).toBe('oliphaunt.wasix-postmaster.runtime-abi.native.v2');
  expect(result.roles.executor.dependencies[0].features).toEqual(['std']);
  expect(result.roles.compiler.dependencies[0].features).toEqual(['compiler', 'std']);
  const renamedSource = { ...source, patches: ['@@other_canonical_index//:patches/types.patch'] };
  const renamed = fixture();
  renamed.sources['wasmer-types 7.2.0-alpha.2'] = renamedSource;
  for (const context of Object.values(renamed.contexts))
    context.crates['wasmer-types 7.2.0-alpha.2'].repository.Http = {
      ...renamedSource,
      patch_args: ['-p1'],
    };
  expect(nativeRuntimeAbi(renamed).runtime_abi_id).toBe(result.runtime_abi_id);
  const unused = fixture();
  unused.sourceIdentity.unused.commit = 'changed unused source';
  expect(nativeRuntimeAbi(unused).runtime_abi_id).toBe(result.runtime_abi_id);
  for (const mutate of [
    (value: any) => {
      value.patches['types.patch'] += ' changed';
    },
    (value: any) => {
      value.rust.target = 'aarch64-unknown-linux-gnu';
    },
    (value: any) => {
      value.rustc += ' changed';
    },
    (value: any) => {
      value.roles.executor = [{ ...configured, features: ['std', 'different'] }];
      value.contexts.executor.crates['wasmer-types 7.2.0-alpha.2'].common_attrs.crate_features = [
        'std',
        'different',
      ];
    },
    (value: any) => {
      value.roles.compiler = [{ ...configured, features: ['std'] }];
      value.contexts.compiler.crates['wasmer-types 7.2.0-alpha.2'].common_attrs.crate_features = [
        'std',
      ];
    },
    (value: any) => {
      value.rootSources['src/lib.rs'] += ' changed';
    },
  ]) {
    const changed = fixture();
    mutate(changed);
    expect(nativeRuntimeAbi(changed).runtime_abi_id).not.toBe(result.runtime_abi_id);
  }
});

test('native ABI rejects protocol disagreement and incomplete or conflicting source/configured inputs', () => {
  for (const mutate of [
    (value: any) => {
      value.loader = 'const ARTIFACT_ABI_VERSION: u32 = 22;';
    },
    (value: any) => {
      value.patches = {};
    },
    (value: any) => {
      value.patches['unexpected.patch'] = 'extra';
    },
    (value: any) => {
      value.contexts.executor.crates['wasmer-types 7.2.0-alpha.2'].repository = null;
    },
    (value: any) => {
      value.contexts.executor.crates['wasmer-types 7.2.0-alpha.2'].repository.Http.patch_args = [
        '-p0',
      ];
    },
    (value: any) => {
      value.roles.executor = [];
    },
    (value: any) => {
      value.roles.executor = [configured, { ...configured, features: ['conflict'] }];
    },
    (value: any) => {
      value.roles.executor = [{ ...configured, version: '7.2.1' }];
    },
    (value: any) => {
      value.roles.executor = [{ ...configured, features: ['unknown'] }];
    },
    (value: any) => {
      delete value.rootSources['src/lib.rs'];
    },
  ]) {
    const changed = fixture();
    mutate(changed);
    expect(() => nativeRuntimeAbi(changed)).toThrow();
  }
});
