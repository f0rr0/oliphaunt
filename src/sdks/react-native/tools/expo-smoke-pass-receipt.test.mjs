import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPO_SMOKE_PASS_EVENT_MAX_BYTES,
  EXPO_SMOKE_PASS_TAG,
  serializeExpoSmokePassReceipt,
} from "../examples/expo/src/smoke-pass-receipt.ts";
import {
  GENERATED_EXTENSION_METADATA,
  GENERATED_EXTENSION_METADATA_SHA256,
} from "../src/generated/extensions.ts";

function platformExtensions(platform) {
  return GENERATED_EXTENSION_METADATA
    .filter((extension) => {
      const status = extension.support.mobile?.[platform];
      return extension.mobileReleaseReady && (status === undefined || status === "supported");
    })
    .map((extension) => extension.sqlName)
    .sort();
}

test("the exact mobile catalog produces a bounded authoritative receipt", () => {
  for (const platform of ["android", "ios"]) {
    const extensions = platformExtensions(platform);
    const serialized = serializeExpoSmokePassReceipt({
      platform,
      extensions,
      extensionProofCount: extensions.length + 1,
      extensionCatalogSha256: GENERATED_EXTENSION_METADATA_SHA256,
    });
    const event = `${EXPO_SMOKE_PASS_TAG} ${serialized}`;
    assert(Buffer.byteLength(event) <= EXPO_SMOKE_PASS_EVENT_MAX_BYTES);
    assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(), [
      "extensionCatalogSha256",
      "extensionCount",
      "extensionProofCount",
      "platform",
      "runner",
      "schema",
    ]);
  }
});

test("receipt serialization fails closed on proof drift and remains constant-size as catalogs grow", () => {
  const extensions = platformExtensions("ios");
  assert.throws(
    () => serializeExpoSmokePassReceipt({
      platform: "ios",
      extensions,
      extensionProofCount: extensions.length - 1,
      extensionCatalogSha256: GENERATED_EXTENSION_METADATA_SHA256,
    }),
    /extension proof mismatch/u,
  );
  const largeCatalog = Array.from({ length: 500 }, (_, index) => `extension_${index}`);
  const serialized = serializeExpoSmokePassReceipt({
    platform: "ios",
    extensions: largeCatalog,
    extensionProofCount: largeCatalog.length + 1,
    extensionCatalogSha256: GENERATED_EXTENSION_METADATA_SHA256,
  });
  assert(Buffer.byteLength(`${EXPO_SMOKE_PASS_TAG} ${serialized}`) <= EXPO_SMOKE_PASS_EVENT_MAX_BYTES);
  assert.equal(Object.hasOwn(JSON.parse(serialized), "extensions"), false);
});
