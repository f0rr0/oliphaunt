import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPO_SMOKE_PASS_EVENT_MAX_BYTES,
  EXPO_SMOKE_PASS_TAG,
  serializeExpoSmokePassReceipt,
} from "../src/smoke-pass-receipt.ts";
import {
  GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
  GENERATED_MOBILE_EXTENSION_PLAN,
} from "../src/generated/extension-smoke.ts";

function platformExtensions() {
  return GENERATED_MOBILE_EXTENSION_PLAN
    .map((extension) => extension.sqlName)
    .sort();
}

function receiptInput(platform, overrides = {}) {
  const extensions = platformExtensions();
  return {
    platform,
    extensions,
    activatedExtensions: extensions,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: extensions.includes("pg_textsearch"),
    extensionCatalogSha256: GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
    catalogProfile: "icu",
    icuRuntimeProof: true,
    ...overrides,
  };
}

test("the exact mobile catalog produces a bounded authoritative receipt", () => {
  for (const platform of ["android", "ios"]) {
    const extensions = platformExtensions();
    const serialized = serializeExpoSmokePassReceipt(receiptInput(platform));
    const event = `${EXPO_SMOKE_PASS_TAG} ${serialized}`;
    assert(Buffer.byteLength(event) <= EXPO_SMOKE_PASS_EVENT_MAX_BYTES);
    assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
      "allExtensionsActivated",
      "catalogProfile",
      "extensionCatalogComplete",
      "extensionCatalogSha256",
      "extensionCount",
      "icuRuntimeProof",
      "pgTextsearchEnglishBm25",
      "platform",
      "runner",
      "schema",
    ]);
  }
});

test("receipt serialization fails closed on proof drift and remains constant-size as catalogs grow", () => {
  const extensions = platformExtensions();
  assert.throws(
    () => serializeExpoSmokePassReceipt(receiptInput("ios", {
      activatedExtensions: extensions.slice(1),
    })),
    /activated extension mismatch/u,
  );
  assert.throws(
    () => serializeExpoSmokePassReceipt(receiptInput("ios", {
      activatedExtensions: [...extensions, extensions[0]],
    })),
    /activated extension mismatch/u,
  );
  assert.throws(
    () => serializeExpoSmokePassReceipt(receiptInput("ios", {
      extensionCatalogComplete: false,
    })),
    /catalog completeness/u,
  );
  assert.throws(
    () => serializeExpoSmokePassReceipt(receiptInput("ios", {
      pgTextsearchEnglishBm25: false,
    })),
    /pg_textsearch English BM25 proof mismatch/u,
  );
  assert.throws(
    () => serializeExpoSmokePassReceipt(receiptInput("ios", {
      icuRuntimeProof: "yes",
    })),
    /ICU runtime proof boolean/u,
  );
  assert.throws(
    () => serializeExpoSmokePassReceipt(receiptInput("ios", {
      catalogProfile: "standard",
    })),
    /ICU proof must match its catalog profile/u,
  );
  const largeCatalog = Array.from({ length: 500 }, (_, index) => `extension_${index}`);
  const serialized = serializeExpoSmokePassReceipt({
    platform: "ios",
    extensions: largeCatalog,
    activatedExtensions: largeCatalog,
    extensionCatalogComplete: true,
    pgTextsearchEnglishBm25: false,
    extensionCatalogSha256: GENERATED_MOBILE_EXTENSION_METADATA_SHA256,
    catalogProfile: "standard",
    icuRuntimeProof: false,
  });
  assert(Buffer.byteLength(`${EXPO_SMOKE_PASS_TAG} ${serialized}`) <= EXPO_SMOKE_PASS_EVENT_MAX_BYTES);
  assert.equal(Object.hasOwn(JSON.parse(serialized), "extensions"), false);
});
