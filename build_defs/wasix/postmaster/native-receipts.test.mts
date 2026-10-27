import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  canonicalJson,
  digest,
  nativeExecutorReceipt,
  nativeGuestReceipt,
  nativeWasmerReceipt,
  runtimeAbiFacts,
} from './native-receipts.mts';

const file = { sha256: 'a'.repeat(64), size: 42 };
function contract() {
  const abi: any = {
    schema: 'oliphaunt.wasix-postmaster.runtime-abi.native.v2',
    artifact_abi_version: 21,
    package: { name: 'oliphaunt-wasix-postmaster-executor', version: '7.2.0-alpha.2' },
    lock_sha256: 'b'.repeat(64),
    source: { wasmer: { commit: 'c'.repeat(40) } },
    rust: { target: 'x86_64-unknown-linux-gnu' },
    roles: Object.fromEntries(
      ['executor', 'compiler'].map((role) => [
        role,
        {
          features: [`product-${role}`],
          dependencies: [{ id: 'wasmer 7.2.0-alpha.2' }, { id: 'wasmer-wasix 0.702.0-alpha.2' }],
        },
      ]),
    ),
  };
  abi.runtime_abi_id = digest(canonicalJson(abi));
  return abi;
}
test('native serialized contract rejects changed content and conflicting selected versions', () => {
  const abi = contract();
  assert.equal(runtimeAbiFacts(abi).wasmerVersion, '7.2.0-alpha.2');
  abi.rust.target = 'aarch64-unknown-linux-gnu';
  assert.throws(() => runtimeAbiFacts(abi), /contract hash/);
  const conflict = contract();
  conflict.roles.compiler.dependencies[0].id = 'wasmer 7.2.1';
  const { runtime_abi_id: _id, ...unsigned } = conflict;
  conflict.runtime_abi_id = digest(canonicalJson(unsigned));
  assert.throws(() => runtimeAbiFacts(conflict), /Ambiguous/);
});
test('native executor binding rejects stale carrier identity and compiler-bearing features', () => {
  const wasmer = nativeWasmerReceipt({
    schema: 'oliphaunt.wasix-postmaster.wasmer-build.native.v1',
    runtime_abi: contract(),
    canonical_patch_sha256: file.sha256,
    compiler: file,
  });
  const receipt = {
    schema: 'oliphaunt.wasix-postmaster.executor-build.native.v1',
    runtime_abi_id: wasmer.runtime_abi_id,
    wasmer_build_receipt_sha256: file.sha256,
    binary: file,
    package: 'oliphaunt-wasix-postmaster-executor',
    features: ['product-executor'],
  };
  nativeExecutorReceipt(receipt, wasmer, file.sha256, file);
  assert.throws(() =>
    nativeExecutorReceipt(
      { ...receipt, features: ['product-executor', 'product-compiler'] },
      wasmer,
      file.sha256,
      file,
    ),
  );
  assert.throws(() => nativeExecutorReceipt(receipt, wasmer, 'b'.repeat(64), file));
  assert.throws(() => nativeExecutorReceipt(receipt, wasmer, file.sha256, { ...file, size: 43 }));
  assert.throws(
    () =>
      nativeExecutorReceipt(
        { ...receipt, features: ['product-executor', 'extra-feature'] },
        wasmer,
        file.sha256,
        file,
      ),
    /features differ/,
  );
});
test('native guest namespace rejects legacy builder claims and duplicate source inputs', () => {
  const receipt = {
    schema: 'oliphaunt.wasix-postmaster.guest-build.native.v1',
    source: {
      postgresql: {
        version: '18.4',
        url: 'https://example.test/postgresql.tar.bz2',
        sha256: file.sha256,
      },
      patches: [{ path: 'src/postgres/patch.patch', ...file }],
      overlays: [{ path: 'src/port.c', ...file }],
    },
    configuration: { 'pg_config.h': file },
    sysroot: {
      schema: 'oliphaunt.wasix-postmaster.libc.native.v1',
      source: {
        commit: 'c'.repeat(40),
        sha256: file.sha256,
        url: 'https://example.test/libc.tar.gz',
        strip_prefix: 'libc',
      },
      patch_sha256: file.sha256,
      closure_sha256: file.sha256,
    },
    compiler: file,
    core_profile: 'release-o3',
    postgres_version: '18.4',
    installed_closure_sha256: file.sha256,
    atomic_fence_total: 995,
    final_wasm_concurrency_receipt_sha256: file.sha256,
    linear_memory_install_receipt_sha256: file.sha256,
  };
  nativeGuestReceipt(receipt);
  assert.throws(
    () => nativeGuestReceipt({ ...receipt, docker_image_id: `sha256:${file.sha256}` }),
    /fields differ/,
  );
  assert.throws(() =>
    nativeGuestReceipt({
      ...receipt,
      source: {
        ...receipt.source,
        patches: [...receipt.source.patches, ...receipt.source.patches],
      },
    }),
  );
  assert.throws(() => nativeGuestReceipt({ ...receipt, postgres_version: '18.5' }));
  assert.throws(
    () =>
      nativeGuestReceipt({
        ...receipt,
        source: { ...receipt.source, docker_image_id: file.sha256 },
      }),
    /fields differ/,
  );
  assert.throws(() =>
    nativeGuestReceipt({
      ...receipt,
      sysroot: {
        ...receipt.sysroot,
        source: { ...receipt.sysroot.source, strip_prefix: '../libc' },
      },
    }),
  );
});
