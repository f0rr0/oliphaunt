import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
  GENERATED_MOBILE_EXTENSION_PLAN,
  GENERATED_MOBILE_EXTENSION_SMOKE,
} from '../src/generated/extension-smoke.ts';
import {
  EXPO_SMOKE_PASS_EVENT_MAX_BYTES,
  EXPO_SMOKE_PASS_TAG,
  serializeExpoSmokePassReceipt,
} from '../src/smoke-pass-receipt.ts';

function platformExtensions() {
  return GENERATED_MOBILE_EXTENSION_PLAN.map((extension) => extension.sqlName).sort();
}

function receiptInput(platform, overrides = {}) {
  const extensions = platformExtensions();
  return {
    platform,
    extensions,
    activatedExtensions: extensions,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: extensions.includes('pg_textsearch'),
    extensionCatalogSha256: GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
    catalogProfile: 'icu',
    icuRuntimeProof: true,
    lifecycleResume: true,
    ...overrides,
  };
}

test('the exact mobile catalog produces a bounded authoritative receipt', () => {
  for (const platform of ['android', 'ios']) {
    const extensions = platformExtensions();
    const serialized = serializeExpoSmokePassReceipt(receiptInput(platform));
    const event = `${EXPO_SMOKE_PASS_TAG} ${serialized}`;
    assert(Buffer.byteLength(event) <= EXPO_SMOKE_PASS_EVENT_MAX_BYTES);
    assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
      'allExtensionsActivated',
      'catalogProfile',
      'extensionCatalogComplete',
      'extensionCatalogSha256',
      'extensionCount',
      'icuRuntimeProof',
      'lifecycleResume',
      'pgTextsearchEnglishBm25',
      'platform',
      'runner',
      'schema',
    ]);
  }
});

test('an extension-free developer smoke emits a non-release receipt', () => {
  const receipt = JSON.parse(
    serializeExpoSmokePassReceipt(
      receiptInput('ios', {
        extensions: [],
        activatedExtensions: [],
        pgTextsearchEnglishBm25: false,
        lifecycleResume: false,
      }),
    ),
  );
  assert.equal(receipt.extensionCount, 0);
  assert.equal(receipt.allExtensionsActivated, true);
  assert.equal(receipt.lifecycleResume, false);
});

test('lifecycle receipts distinguish a completed resume from an ordinary smoke', () => {
  for (const platform of ['android', 'ios']) {
    for (const lifecycleResume of [false, true])
      assert.equal(
        JSON.parse(serializeExpoSmokePassReceipt(receiptInput(platform, { lifecycleResume })))
          .lifecycleResume,
        lifecycleResume,
      );
    for (const lifecycleResume of [undefined, 'true', 1])
      assert.throws(
        () => serializeExpoSmokePassReceipt(receiptInput(platform, { lifecycleResume })),
        /lifecycle resume proof boolean/u,
      );
  }
});

test('receipt serialization fails closed on proof drift and remains constant-size as catalogs grow', () => {
  const extensions = platformExtensions();
  const sqlOnly = GENERATED_MOBILE_EXTENSION_PLAN.find(
    (extension) => extension.sqlName === 'pgtap',
  );
  assert(
    sqlOnly && GENERATED_MOBILE_EXTENSION_SMOKE[sqlOnly.sqlName].length > 0,
    'SQL-only mobile member must have smoke SQL',
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('android', {
          activatedExtensions: extensions.filter((name) => name !== sqlOnly.sqlName),
        }),
      ),
    /activated extension mismatch/u,
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('ios', {
          activatedExtensions: extensions.slice(1),
        }),
      ),
    /activated extension mismatch/u,
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('ios', {
          activatedExtensions: [...extensions, extensions[0]],
        }),
      ),
    /activated extension mismatch/u,
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('ios', {
          extensionCatalogComplete: false,
        }),
      ),
    /catalog completeness/u,
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('ios', {
          pgTextsearchEnglishBm25: false,
        }),
      ),
    /pg_textsearch English BM25 proof mismatch/u,
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('ios', {
          icuRuntimeProof: 'yes',
        }),
      ),
    /ICU runtime proof boolean/u,
  );
  assert.throws(
    () =>
      serializeExpoSmokePassReceipt(
        receiptInput('ios', {
          catalogProfile: 'standard',
        }),
      ),
    /ICU proof must match its catalog profile/u,
  );
  const largeCatalog = Array.from({ length: 500 }, (_, index) => `extension_${index}`);
  const serialized = serializeExpoSmokePassReceipt({
    platform: 'ios',
    extensions: largeCatalog,
    activatedExtensions: largeCatalog,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: false,
    extensionCatalogSha256: GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
    catalogProfile: 'standard',
    icuRuntimeProof: false,
    lifecycleResume: false,
  });
  assert(
    Buffer.byteLength(`${EXPO_SMOKE_PASS_TAG} ${serialized}`) <= EXPO_SMOKE_PASS_EVENT_MAX_BYTES,
  );
  assert.equal(Object.hasOwn(JSON.parse(serialized), 'extensions'), false);
});
