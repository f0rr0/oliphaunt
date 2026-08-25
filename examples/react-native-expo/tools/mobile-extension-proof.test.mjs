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
  "../src/mobile-smoke.ts"
);
const { serializeExpoSmokePassReceipt } = await import(
  "../src/smoke-pass-receipt.ts"
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
  const executed = [];
  const queried = [];
  const db = {
    async execute(sql) {
      executed.push(sql);
    },
    async query(sql) {
      queried.push(sql);
      if (sql === "SELECT 1") {
        return queryResult({ "?column?": "1" });
      }
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
    smokeStatements: ["SELECT 1"],
  }]);

  assert.deepEqual(proof.activatedExtensions, ["pg_textsearch"]);
  assert.equal(proof.extensionCatalogComplete, true);
  assert.equal(proof.pgTextsearchEnglishBm25, true);
  assert.deepEqual(executed, [
    "CREATE EXTENSION pg_textsearch",
    "DROP TABLE IF EXISTS oliphaunt_mobile_pg_textsearch_english",
    "CREATE TABLE oliphaunt_mobile_pg_textsearch_english (id bigint PRIMARY KEY, body text NOT NULL)",
    `INSERT INTO oliphaunt_mobile_pg_textsearch_english (id, body) VALUES
        (1, 'PostgreSQL databases support reliable runners'),
        (2, 'An unrelated document about walking')`,
    `CREATE INDEX oliphaunt_mobile_pg_textsearch_english_bm25
        ON oliphaunt_mobile_pg_textsearch_english
        USING bm25 (body)
        WITH (text_config = 'pg_catalog.english')`,
    "DROP TABLE IF EXISTS oliphaunt_mobile_pg_textsearch_english",
  ]);
  assert.equal(queried[0], "SELECT 1");
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
    catalogProfile: "icu",
    icuRuntimeProof: true,
  }));
  assert.equal(receipt.schema, "oliphaunt-expo-smoke-pass-v4");
  assert.equal(receipt.catalogProfile, "icu");
  assert.equal(receipt.allExtensionsActivated, true);
  assert.equal(receipt.extensionCatalogComplete, true);
  assert.equal(receipt.pgTextsearchEnglishBm25, true);
});
