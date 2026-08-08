import assert from "node:assert/strict";
import { mock, test } from "bun:test";

class FixturePostgresError extends Error {}

mock.module("@oliphaunt/react-native", () => ({
  PostgresError: FixturePostgresError,
  simpleQuery() {
    throw new Error("simpleQuery is outside the extension-proof fixture");
  },
}));

const { runMobileReleaseExtensionProof } = await import(
  "../examples/expo/src/postgres-workload.ts"
);
const { serializeExpoSmokePassReceipt } = await import(
  "../examples/expo/src/smoke-pass-receipt.ts"
);

function queryResult(values) {
  return {
    getText(_row, column) {
      return values[column] ?? null;
    },
    rowCount: 1,
    rows: [values],
  };
}

test("the successful pg_textsearch producer supplies every semantic PASS fact", async () => {
  const db = {
    async execute() {},
    async query(sql) {
      if (sql.includes("WHERE extname = $1")) {
        return queryResult({ name: "pg_textsearch", version: "0.3.1" });
      }
      if (sql.includes("to_bm25query")) {
        return queryResult({ id: "1" });
      }
      if (sql.includes("string_agg")) {
        return queryResult({ value: "pg_textsearch" });
      }
      throw new Error(`unexpected extension-proof query: ${sql}`);
    },
  };
  const proof = await runMobileReleaseExtensionProof(db, [{
    sqlName: "pg_textsearch",
    createsExtension: true,
    nativeModuleStem: "pg_textsearch",
    selectedExtensionDependencies: [],
    activationSql: ["CREATE EXTENSION pg_textsearch"],
  }]);

  assert.deepEqual(proof.activatedExtensions, ["pg_textsearch"]);
  assert.equal(proof.extensionCatalogComplete, true);
  assert.equal(proof.pgTextsearchEnglishBm25, true);
  assert.deepEqual(proof.checks.map((check) => check.name), [
    "extension activation: pg_textsearch",
    "extension functional proof: pg_textsearch English BM25",
    "extension activation catalog completeness",
  ]);

  const receipt = JSON.parse(serializeExpoSmokePassReceipt({
    platform: "ios",
    extensions: ["pg_textsearch"],
    activatedExtensions: proof.activatedExtensions,
    extensionCatalogComplete: proof.extensionCatalogComplete,
    pgTextsearchEnglishBm25: proof.pgTextsearchEnglishBm25,
    extensionCatalogSha256: "a".repeat(64),
    icuRuntimeProof: true,
  }));
  assert.equal(receipt.schema, "oliphaunt-expo-smoke-pass-v3");
  assert.equal(receipt.allExtensionsActivated, true);
  assert.equal(receipt.extensionCatalogComplete, true);
  assert.equal(receipt.pgTextsearchEnglishBm25, true);
});
