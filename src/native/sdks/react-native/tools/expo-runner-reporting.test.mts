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
    schema: 'oliphaunt-expo-smoke-pass-v4',
    runner: 'smoke',
    platform: 'android',
    extensionCount,
    allExtensionsActivated: true,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: false,
    extensionCatalogSha256: catalogSha256,
    catalogProfile: 'standard',
    icuRuntimeProof: false,
  };
}

function extensionReceipt(selectedExtensions, extensionCount) {
  writeFileSync(reportFile, JSON.stringify(report(extensionCount)));
  return spawnSync(
    process.execPath,
    [
      reportingTool,
      'extension-receipt',
      reportFile,
      metadataFile,
      'android',
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
