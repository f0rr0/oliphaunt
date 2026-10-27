#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ROOT } from '../../../../tools/release/release-artifact-targets.mts';
import {
  assertCanonicalWasixAotManifest,
  canonicalWasixAotMetadata,
} from './wasix-aot-manifest.mts';
import {
  WASIX_ENGINE_SOURCES_PATH,
  WASIX_TOOLCHAIN_PATH,
} from './wasix-cargo-toolchain-policy.mts';

function manifest(overrides = {}) {
  const target = overrides['target-triple'] ?? 'x86_64-unknown-linux-gnu';
  const canonical = canonicalWasixAotMetadata(ROOT, target);
  return {
    'format-version': 1,
    'source-lane': canonical.sourceLane,
    'target-triple': target,
    engine: canonical.engine,
    'wasmer-version': canonical.wasmerVersion,
    'wasmer-wasix-version': canonical.wasmerWasixVersion,
    artifacts: [{ name: 'runtime:oliphaunt', path: 'oliphaunt.aot.zst' }],
    ...overrides,
  };
}

test('accepts AOT metadata that exactly matches the canonical WASIX toolchain', () => {
  assert.doesNotThrow(() =>
    assertCanonicalWasixAotManifest(manifest(), {
      expectedTarget: 'x86_64-unknown-linux-gnu',
    }),
  );
});

test('rejects stale prerelease Wasmer metadata', () => {
  assert.throws(
    () =>
      assertCanonicalWasixAotManifest(
        manifest({
          'wasmer-version': '7.2.1-alpha.3',
          'wasmer-wasix-version': '0.702.1-alpha.3',
        }),
        { expectedTarget: 'x86_64-unknown-linux-gnu' },
      ),
    /wasmer-version must match canonical WASIX metadata/u,
  );
});

test('rejects stale prerelease Wasmer-WASIX metadata', () => {
  assert.throws(
    () =>
      assertCanonicalWasixAotManifest(manifest({ 'wasmer-wasix-version': '0.702.1-alpha.3' }), {
        expectedTarget: 'x86_64-unknown-linux-gnu',
      }),
    /wasmer-wasix-version must match canonical WASIX metadata/u,
  );
});

test('rejects an AOT archive labeled for another target', () => {
  assert.throws(
    () =>
      assertCanonicalWasixAotManifest(manifest(), {
        expectedTarget: 'aarch64-apple-darwin',
      }),
    /target-triple must match canonical WASIX metadata/u,
  );
});

test('Windows metadata requires V8 for both explicit and manifest-derived targets', () => {
  const target = 'x86_64-pc-windows-msvc';
  const windows = manifest({ 'target-triple': target });
  assert.equal(windows.engine, 'v8');
  assert.doesNotThrow(() => assertCanonicalWasixAotManifest(windows, { expectedTarget: target }));
  assert.doesNotThrow(() => assertCanonicalWasixAotManifest(windows));
  assert.throws(
    () => assertCanonicalWasixAotManifest({ ...windows, engine: 'llvm-opta' }),
    /engine must match canonical WASIX metadata/u,
  );
  assert.throws(
    () => assertCanonicalWasixAotManifest(windows, { expectedTarget: 'x86_64-unknown-linux-gnu' }),
    /engine must match canonical WASIX metadata/u,
  );
});

test('canonical metadata reads only the target engine pins without a workspace fallback', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wasix-aot-metadata-'));
  try {
    mkdirSync(path.dirname(path.join(root, WASIX_TOOLCHAIN_PATH)), { recursive: true });
    writeFileSync(
      path.join(root, WASIX_TOOLCHAIN_PATH),
      '[toolchain]\nwasmer = "8.1.2"\nwasmer-wasix = "0.801.2"\nwebc = "12.0.1"\n',
    );
    for (const target of [
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu',
      'aarch64-apple-darwin',
    ])
      assert.deepEqual(canonicalWasixAotMetadata(root, target), {
        sourceLane: 'stable',
        engine: 'llvm-opta',
        wasmerVersion: '8.1.2',
        wasmerWasixVersion: '0.801.2',
      });
    assert.throws(() => canonicalWasixAotMetadata(root, 'x86_64-pc-windows-msvc'), /ENOENT/u);
    const sources = path.join(root, WASIX_ENGINE_SOURCES_PATH);
    mkdirSync(path.dirname(sources), { recursive: true });
    writeFileSync(
      sources,
      JSON.stringify({
        crates: { wasmer: { version: '9.2.3' }, 'wasmer-wasix': { version: '0.902.3' } },
      }),
    );
    assert.deepEqual(canonicalWasixAotMetadata(root, 'x86_64-pc-windows-msvc'), {
      sourceLane: 'stable',
      engine: 'v8',
      wasmerVersion: '9.2.3',
      wasmerWasixVersion: '0.902.3',
    });
    writeFileSync(sources, JSON.stringify({ crates: { wasmer: { version: '9.2.3' } } }));
    assert.throws(
      () => canonicalWasixAotMetadata(root, 'x86_64-pc-windows-msvc'),
      /crates.wasmer-wasix.version must be a non-empty string/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
