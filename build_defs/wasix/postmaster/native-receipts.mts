import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const canonicalJson = (value: any): string =>
  JSON.stringify(value, (_key, row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((key) => [key, row[key]]),
        )
      : row,
  );
export const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const sha = (value: unknown) =>
  assert(
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    'Invalid native receipt SHA-256',
  );
const keys = (value: any, names: string[]) => {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Native receipt must be an object',
  );
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Native receipt fields differ');
};
export function fileIdentity(value: any) {
  keys(value, ['sha256', 'size']);
  sha(value.sha256);
  assert(Number.isSafeInteger(value.size) && value.size > 0, 'Invalid native receipt file size');
  return value;
}
export function runtimeAbiFacts(abi: any) {
  assert.equal(abi.schema, 'oliphaunt.wasix-postmaster.runtime-abi.native.v2');
  const { runtime_abi_id: id, ...contract } = abi;
  sha(id);
  assert.equal(id, digest(canonicalJson(contract)), 'Native runtime ABI contract hash differs');
  assert.equal(abi.artifact_abi_version, 21, 'Native serialized ABI differs');
  const version = (name: string) => {
    const ids = new Set<string>(
      Object.values<any>(abi.roles)
        .flatMap((role) => role.dependencies.map((row: any) => row.id))
        .filter((id: string) => id.startsWith(`${name} `)),
    );
    assert.equal(ids.size, 1, `Ambiguous actual native ${name} identity`);
    return [...ids][0].slice(name.length + 1);
  };
  const target = abi.rust.target;
  assert(typeof target === 'string');
  const hostAbi = target.endsWith('-linux-gnu')
    ? 'linux-gnu'
    : target.endsWith('-apple-darwin')
      ? 'darwin'
      : undefined;
  assert(hostAbi, `Unsupported postmaster native host target: ${target}`);
  assert.match(abi.source.wasmer.commit, /^[0-9a-f]{40}$/);
  sha(abi.lock_sha256);
  return {
    wasmerVersion: version('wasmer'),
    wasixVersion: version('wasmer-wasix'),
    hostAbi,
    target,
  };
}
export function nativeWasmerReceipt(value: any): Record<string, string> {
  keys(value, ['schema', 'runtime_abi', 'canonical_patch_sha256', 'compiler']);
  assert.equal(value.schema, 'oliphaunt.wasix-postmaster.wasmer-build.native.v1');
  const facts = runtimeAbiFacts(value.runtime_abi);
  sha(value.canonical_patch_sha256);
  fileIdentity(value.compiler);
  const features = value.runtime_abi.roles.executor.features;
  assert(
    Array.isArray(features) && features.every((feature: unknown) => typeof feature === 'string'),
  );
  assert.equal(new Set(features).size, features.length);
  return {
    schema: value.schema,
    runtime_abi_id: value.runtime_abi.runtime_abi_id,
    artifact_abi_version: String(value.runtime_abi.artifact_abi_version),
    rustc_host: facts.target,
    host_abi: facts.hostAbi,
    wasmer_source_commit: value.runtime_abi.source.wasmer.commit,
    wasmer_patch_sha256: value.canonical_patch_sha256,
    wasmer_cargo_lock_sha256: value.runtime_abi.lock_sha256,
    sysroot_variant: 'oliphaunt.wasix-postmaster.libc.native.v1',
    executor_features: canonicalJson([...features].sort()),
  };
}
export function nativeExecutorReceipt(
  value: any,
  wasmer: Record<string, string>,
  wasmerHash: string,
  executor: any,
) {
  keys(value, [
    'schema',
    'runtime_abi_id',
    'wasmer_build_receipt_sha256',
    'binary',
    'package',
    'features',
  ]);
  assert.equal(value.schema, 'oliphaunt.wasix-postmaster.executor-build.native.v1');
  assert.equal(value.runtime_abi_id, wasmer.runtime_abi_id);
  assert.equal(value.wasmer_build_receipt_sha256, wasmerHash);
  assert.equal(value.package, 'oliphaunt-wasix-postmaster-executor');
  assert(
    Array.isArray(value.features) &&
      value.features.includes('product-executor') &&
      !value.features.includes('product-compiler'),
  );
  assert.equal(new Set(value.features).size, value.features.length);
  assert.equal(
    canonicalJson([...value.features].sort()),
    wasmer.executor_features,
    'Executor features differ from the selected native ABI role',
  );
  assert.deepEqual(fileIdentity(value.binary), executor);
  return { schema: value.schema, executor_binary_sha256: value.binary.sha256 };
}
export function nativeGuestReceipt(value: any): Record<string, string> {
  keys(value, [
    'schema',
    'source',
    'configuration',
    'sysroot',
    'compiler',
    'core_profile',
    'postgres_version',
    'installed_closure_sha256',
    'atomic_fence_total',
    'final_wasm_concurrency_receipt_sha256',
    'linear_memory_install_receipt_sha256',
  ]);
  assert.equal(value.schema, 'oliphaunt.wasix-postmaster.guest-build.native.v1');
  keys(value.source, ['postgresql', 'overlays', 'patches']);
  keys(value.source.postgresql, ['version', 'url', 'sha256']);
  assert.equal(value.core_profile, 'release-o3');
  assert.equal(value.postgres_version, value.source.postgresql.version);
  assert.match(value.postgres_version, /^[0-9]+\.[0-9]+$/);
  sha(value.source.postgresql.sha256);
  assert.equal(new URL(value.source.postgresql.url).protocol, 'https:');
  for (const kind of ['overlays', 'patches']) {
    assert(Array.isArray(value.source[kind]) && value.source[kind].length > 0);
    const paths = new Set<string>();
    for (const row of value.source[kind]) {
      keys(row, ['path', 'sha256', 'size']);
      assert(
        typeof row.path === 'string' &&
          row.path.startsWith('src/') &&
          row.path.split('/').every((part: string) => part && part !== '.' && part !== '..') &&
          !paths.has(row.path),
      );
      paths.add(row.path);
      fileIdentity({ sha256: row.sha256, size: row.size });
    }
  }
  assert(value.configuration && Object.keys(value.configuration).length > 0);
  for (const identity of Object.values(value.configuration)) fileIdentity(identity);
  keys(value.sysroot, ['schema', 'source', 'patch_sha256', 'closure_sha256']);
  assert.equal(value.sysroot.schema, 'oliphaunt.wasix-postmaster.libc.native.v1');
  keys(value.sysroot.source, ['commit', 'sha256', 'strip_prefix', 'url']);
  assert.match(value.sysroot.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(new URL(value.sysroot.source.url).protocol, 'https:');
  assert(
    typeof value.sysroot.source.strip_prefix === 'string' &&
      value.sysroot.source.strip_prefix
        .split('/')
        .every((part: string) => part && part !== '.' && part !== '..'),
  );
  sha(value.sysroot.source.sha256);
  sha(value.sysroot.patch_sha256);
  sha(value.sysroot.closure_sha256);
  fileIdentity(value.compiler);
  assert(Number.isSafeInteger(value.atomic_fence_total) && value.atomic_fence_total > 0);
  for (const name of [
    'installed_closure_sha256',
    'final_wasm_concurrency_receipt_sha256',
    'linear_memory_install_receipt_sha256',
  ])
    sha(value[name]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) =>
        [
          'schema',
          'core_profile',
          'postgres_version',
          'installed_closure_sha256',
          'atomic_fence_total',
          'final_wasm_concurrency_receipt_sha256',
          'linear_memory_install_receipt_sha256',
        ].includes(key),
      )
      .map(([key, row]) => [key, String(row)])
      .concat([['sysroot_variant', value.sysroot.schema]]),
  );
}
