import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixture = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-runner-reporting-'));
const metadataFile = path.join(fixture, 'extensions.json');
const reportFile = path.join(fixture, 'report.json');
const reportingTool = path.join(import.meta.dir, 'expo-runner-reporting.mts');
const catalogSha256 = 'c'.repeat(64);

writeFileSync(
  metadataFile,
  JSON.stringify({
    'extension-catalog-sha256': catalogSha256,
    extensions: [{ 'sql-name': 'pgtap' }, { 'sql-name': 'vector' }],
  }),
);

test.after(() => rmSync(fixture, { force: true, recursive: true }));

function report(extensionCount) {
  return {
    schema: 'oliphaunt-expo-smoke-pass-v5',
    runner: 'smoke',
    platform: 'android',
    extensionCount,
    allExtensionsActivated: true,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: false,
    extensionCatalogSha256: catalogSha256,
    catalogProfile: 'standard',
    icuRuntimeProof: false,
    lifecycleResume: false,
  };
}

function extensionReceipt(
  selectedExtensions,
  extensionCount,
  overrides = {},
  expectedLifecycle = '0',
) {
  writeFileSync(reportFile, JSON.stringify({ ...report(extensionCount), ...overrides }));
  return spawnSync(
    process.execPath,
    [
      reportingTool,
      'extension-receipt',
      reportFile,
      metadataFile,
      (overrides as any).platform ?? 'android',
      'a'.repeat(40),
      'b'.repeat(40),
      selectedExtensions,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        OLIPHAUNT_MOBILE_E2E_EXPECT_ICU: '0',
        OLIPHAUNT_MOBILE_E2E_EXPECT_CATALOG_PROFILE: 'standard',
        OLIPHAUNT_MOBILE_E2E_EXPECT_LIFECYCLE: expectedLifecycle,
      },
    },
  );
}

test('validates the exact packaged extension selection', () => {
  const result = extensionReceipt('vector', 1);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).extensions, ['vector']);
});

test('allows an explicitly empty extension selection for core runtime smoke', () => {
  const result = extensionReceipt('', 0);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).extensions, []);
});

test('rejects unknown, duplicate, and mismatched extension selections', () => {
  assert.notEqual(extensionReceipt('unknown', 1).status, 0);
  assert.notEqual(extensionReceipt('vector,vector', 2).status, 0);
  assert.notEqual(extensionReceipt('vector', 0).status, 0);
});

test('required lifecycle qualification rejects ordinary, old and missing PASS proofs on both platforms', () => {
  for (const platform of ['android', 'ios']) {
    const valid = extensionReceipt('vector', 1, { platform, lifecycleResume: true }, '1');
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).lifecycleResume, true);
    for (const overrides of [
      { lifecycleResume: false },
      { lifecycleResume: undefined },
      { lifecycleResume: 'true' },
      { schema: 'oliphaunt-expo-smoke-pass-v4', lifecycleResume: true },
    ])
      assert.notEqual(extensionReceipt('vector', 1, { platform, ...overrides }, '1').status, 0);
    assert.notEqual(extensionReceipt('vector', 1, { platform }, 'invalid').status, 0);
    const ordinary = extensionReceipt('vector', 1, { platform, lifecycleResume: false }, '0');
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(JSON.parse(ordinary.stdout).lifecycleResume, false);
  }
});
