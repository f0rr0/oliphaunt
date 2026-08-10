import assert from "node:assert/strict";

const PG_TEXTSEARCH_TABLE = "exact_candidate_pg_textsearch_english";
const PG_TEXTSEARCH_INDEX = "exact_candidate_pg_textsearch_english_bm25";

function resultText(result, column) {
  assert.equal(result?.rows?.length ?? 1, 1, `${column} query must return exactly one row`);
  return result.getText(0, column);
}

async function pgTextsearchTopId(database, terms) {
  const result = await database.query(
    `SELECT id::text AS id FROM ${PG_TEXTSEARCH_TABLE} `
      + `ORDER BY body <@> to_bm25query('${terms}', '${PG_TEXTSEARCH_INDEX}') LIMIT 1`,
  );
  return resultText(result, "id");
}

async function assertPgTextsearchState(database, writeTerms) {
  const existingTopId = await pgTextsearchTopId(database, "running database");
  assert.equal(existingTopId, "1", "pg_textsearch must preserve the original indexed row");

  const updatedTopId = await pgTextsearchTopId(database, "updated migration target");
  assert.equal(updatedTopId, "2", "pg_textsearch must index an updated row");

  const sentinelTopId = await pgTextsearchTopId(database, "merge sentinel proof");
  assert.equal(sentinelTopId, "1000", "pg_textsearch must preserve the post-index sentinel row");

  const postOpenWriteTopId = await pgTextsearchTopId(database, writeTerms);
  assert.equal(postOpenWriteTopId, "1001", "pg_textsearch must index a post-open write");

  const deletedTopId = await pgTextsearchTopId(database, "deleted wildlife marker");
  assert.equal(
    deletedTopId,
    "4",
    "pg_textsearch must discard the higher-scoring deleted posting and return its survivor",
  );

  return {
    sqlName: "pg_textsearch",
    scenario: "bm25-mutation-merge-persistence",
    existingTopId,
    updatedTopId,
    sentinelTopId,
    postOpenWriteTopId,
    deletionSurvivorTopId: deletedTopId,
  };
}

export async function verifyCoreEnglishTextSearch(database) {
  const result = await database.query(
    "SELECT CASE WHEN "
      + "to_tsvector('pg_catalog.english', 'the quick foxes running') "
      + "@@ to_tsquery('pg_catalog.english', 'run & fox') "
      + "THEN 'english-snowball-ok' ELSE 'english-snowball-failed' END AS value",
  );
  assert.equal(
    resultText(result, "value"),
    "english-snowball-ok",
    "every runtime mode must load PostgreSQL core dict_snowball and its English stopword data",
  );
}

export async function verifyPgTextsearchEnglishBm25(database, phase) {
  assert.ok(
    phase === "produce" || phase === "verify-restored",
    `unsupported pg_textsearch exact-candidate phase ${phase}`,
  );

  if (phase === "produce") {
    await database.query(
      `CREATE TABLE ${PG_TEXTSEARCH_TABLE} (id bigint PRIMARY KEY, body text NOT NULL)`,
    );
    await database.query(
      `INSERT INTO ${PG_TEXTSEARCH_TABLE} (id, body) VALUES `
        + "(1, 'PostgreSQL databases support reliable runners'), "
        + "(2, 'An unrelated document about walking'), "
        + "(3, 'deleted wildlife marker deleted wildlife marker deleted wildlife marker'), "
        + "(4, 'deleted wildlife marker')",
    );
    await database.query(
      `CREATE INDEX ${PG_TEXTSEARCH_INDEX} `
        + `ON ${PG_TEXTSEARCH_TABLE} USING bm25 (body) `
        + "WITH (text_config = 'pg_catalog.english')",
    );
    await database.query(
      `INSERT INTO ${PG_TEXTSEARCH_TABLE} (id, body) VALUES `
        + "(1000, 'merge sentinel proof merge sentinel proof'), "
        + "(1001, 'post activation write marker')",
    );
    await database.query(
      `UPDATE ${PG_TEXTSEARCH_TABLE} `
        + "SET body = 'updated migration target updated migration target' WHERE id = 2",
    );
    await database.query(`DELETE FROM ${PG_TEXTSEARCH_TABLE} WHERE id = 3`);
    await database.query(`SELECT bm25_force_merge('${PG_TEXTSEARCH_INDEX}')`);
    return assertPgTextsearchState(database, "post activation write marker");
  }

  const persisted = await assertPgTextsearchState(database, "post activation write marker");
  await database.query(
    `UPDATE ${PG_TEXTSEARCH_TABLE} `
      + "SET body = 'post restore write marker' WHERE id = 1001",
  );
  await database.query(`SELECT bm25_force_merge('${PG_TEXTSEARCH_INDEX}')`);
  const afterWrite = await assertPgTextsearchState(database, "post restore write marker");
  assert.deepEqual(afterWrite, persisted);
  return afterWrite;
}

export async function verifyExtensionFunctionality(database, extensions, phase) {
  const functional = [];
  if (extensions.some((extension) => extension.sqlName === "pg_textsearch")) {
    functional.push(await verifyPgTextsearchEnglishBm25(database, phase));
  }
  return functional;
}
