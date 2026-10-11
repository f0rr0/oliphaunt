import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

test('relocated legacy reader parses text without the native helper and fails closed for native JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'postmaster-legacy-reader-'));
  const files = [
    'src/wasix/postmaster/lib/verify-sealed-carrier.mts',
    'src/wasix/postmaster/lib/guest-build-provenance.mts',
    'src/wasix/postmaster/lib/linear-memory-profile.mts',
    'src/wasix/postmaster/lib/receipt-files.mts',
    'src/wasix/postmaster/lib/sealed-export-chain.mts',
    'src/wasix/postmaster/wasmer/bin/verify-postmaster-concurrency-contract.mts',
    'src/wasix/postmaster/wasmer/bin/verify-postmaster-wasm-import.mts',
    'src/wasix/postmaster/wasmer/policies/sealed-side-modules.v1.tsv',
    'tools/packaging/strict-json.mts',
  ];
  try {
    for (const relative of files) {
      const destination = join(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(new URL(`../../../${relative}`, import.meta.url), destination);
    }
    const reader = await import(join(root, files[0]));
    const receipt = join(root, 'wasmer-build.receipt');
    writeFileSync(
      receipt,
      'schema=oliphaunt.wasix-postmaster.wasmer-build.v2\nruntime_abi_id=legacy-identity\n',
    );
    assert.deepEqual(
      reader.parseReceipt(root, undefined, 'wasmer-build.receipt', ['schema', 'runtime_abi_id']),
      {
        schema: 'oliphaunt.wasix-postmaster.wasmer-build.v2',
        runtime_abi_id: 'legacy-identity',
      },
    );
    writeFileSync(receipt, '{}\n');
    assert.throws(
      () => reader.parseReceipt(root, undefined, 'wasmer-build.receipt', []),
      /native-receipts|Cannot find/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
