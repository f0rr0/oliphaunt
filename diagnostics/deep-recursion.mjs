import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [addonArgument, queryArgument, outputArgument, childArgument] = process.argv.slice(2);
assert(addonArgument && queryArgument && outputArgument, 'usage: node deep-recursion.mjs ADDON QUERY_MODULE OUTPUT');
const addonPath = path.resolve(addonArgument);
const queryPath = path.resolve(queryArgument);
const output = path.resolve(outputArgument);
const reference = process.env.PGLITE_RECURSION === '1';
mkdirSync(output, { recursive: true });
const fixtures = {
  'json-malformed-array': "SELECT repeat('[', 10000)::json",
  'json-malformed-object': "SELECT repeat('{\"a\":', 10000)::json",
  'json-valid': "SELECT length((repeat('[', 10000) || '0' || repeat(']', 10000))::json::text)",
  expression: `SELECT ${'1+'.repeat(5000)}0`,
  plpgsql: 'SELECT pg_temp.stack_probe(2000)',
};
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

if (!childArgument) {
  const report = {
    schema: 'oliphaunt-deep-recursion-v2',
    startedAt: new Date().toISOString(),
    engine: reference ? 'pglite' : 'oliphaunt-wasix',
    sourceRun: reference ? null : 37584874208,
    sourceCommit: reference ? null : '8db3bd8885c32a5ca546f9038fc04764ab56610b',
    referencePackage: reference ? JSON.parse(readFileSync(path.resolve(path.dirname(addonPath), '../package.json'), 'utf8')).version : undefined,
    diagnosticCommit: process.env.GITHUB_SHA ?? null,
    host: { platform: platform(), arch: arch(), release: release(), node: process.version },
    addonSha256: hash(addonPath),
    querySha256: reference ? undefined : hash(queryPath),
    wasmSha256: reference ? hash(path.join(path.dirname(addonPath), 'pglite.wasm')) : undefined,
    fixtureSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
    cases: [],
  };
  for (const api of reference ? ['exec', 'query'] : ['direct', 'actor']) {
    for (const storage of ['memory', 'directory']) {
      for (const limit of ['default', '100kB']) {
        for (const fixture of Object.keys(fixtures)) {
          const test = { api, storage, limit, fixture };
          const id = `${api}-${storage}-${limit}-${fixture}`;
          console.log(`START ${id}`);
          const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), addonPath, queryPath, path.join(output, id), JSON.stringify(test)], {
            env: process.env,
            encoding: 'utf8',
            timeout: reference ? 30_000 : 90_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          writeFileSync(path.join(output, `${id}.stdout.log`), result.stdout ?? '');
          writeFileSync(path.join(output, `${id}.stderr.log`), result.stderr ?? '');
          let child;
          try { child = JSON.parse(readFileSync(path.join(output, id, 'result.json'), 'utf8')); } catch {}
          const row = { ...test, id, exitCode: result.status, signal: result.signal, processError: result.error?.message, ...child };
          row.passed = result.status === 0 && child?.passed === true;
          report.cases.push(row);
          console.log(JSON.stringify({ id, passed: row.passed, phase: row.phase, exitCode: row.exitCode, observations: row.observations, error: row.error?.message }));
          writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        }
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.cases.every((row) => row.passed);
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`RESULT ${report.cases.filter((row) => row.passed).length}/${report.cases.length} passed`);
  process.exitCode = report.passed ? 0 : 1;
} else {
  const test = JSON.parse(childArgument);
  const result = { phase: 'load', passed: false, checks: [], observations: [] };
  const save = () => writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const event = (phase, details = {}) => {
    result.phase = phase;
    save();
    appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase, ...details }) + '\n');
  };
  const addon = reference ? await import(pathToFileURL(addonPath).href) : createRequire(import.meta.url)(addonPath);
  const { decodeQueryResult, parseSimpleQueryRawResponse, simpleQuery, responseTransactionStatus } = reference ? {} : await import(pathToFileURL(queryPath).href);
  const storage = test.storage === 'memory' ? { kind: 'memory' } : { kind: 'directory', path: path.join(output, 'database') };
  const openOptions = { profile: 'standard', storage, username: 'postgres', database: 'postgres', startupGucs: {}, extensions: [] };
  const Constructor = test.api === 'direct' ? addon.NativeWasixDatabase : addon.NativeWasixActorDatabase;
  const open = () => reference ? addon.PGlite.create({ dataDir: test.storage === 'directory' ? storage.path : undefined, username: 'postgres', database: 'postgres' }) : Constructor.open(openOptions);
  let database;
  const query = async (sql) => reference
    ? test.api === 'exec' ? (await database.exec(sql, { rowMode: 'array' }))[0] : database.query(sql, [], { rowMode: 'array' })
    : decodeQueryResult(parseSimpleQueryRawResponse(await database.execProtocolRaw(simpleQuery(sql))), { rowMode: 'array' });
  const scalar = async (sql, expected) => {
    const response = await query(sql);
    assert.equal(String(response.rows[0]?.[0]), expected, sql);
  };
  const depthQuery = async () => {
    const malformed = test.fixture.startsWith('json-malformed-');
    const expectedErrors = malformed ? ['54001', '22P02'] : ['54001'];
    const expectedValue = { 'json-valid': '20001', expression: '5000', plpgsql: '2000' }[test.fixture];
    let response;
    let error;
    try {
      response = await query(fixtures[test.fixture]);
    } catch (caught) {
      error = caught;
    }
    const sqlstate = error?.sqlstate ?? error?.code;
    const acceptable = error ? expectedErrors.includes(sqlstate) : !malformed && String(response?.rows[0]?.[0]) === expectedValue;
    const observation = error
      ? { sqlstate, name: error.name, message: error.message, addonError: error.oliphauntWasixError, transactionStatus: responseTransactionStatus?.(error), closed: database.closed }
      : { outcome: acceptable ? 'success' : 'unexpected-response', rows: response?.rows, closed: database.closed };
    result.observations.push(observation);
    save();
    if (!acceptable) {
      event('failure-reuse');
      try {
        await scalar('SELECT 42::text AS value', '42');
        observation.reuse = 'passed';
      } catch (reuseError) {
        observation.reuse = { message: reuseError.message, addonError: reuseError.oliphauntWasixError, closed: database.closed };
      }
      save();
    }
    assert(acceptable, 'must return a correct result or recoverable PostgreSQL error');
    assert.equal(database.closed, false, 'SQL depth errors must leave the database open');
  };
  try {
    event('open');
    database = await open();
    result.runtimeVersion = reference ? JSON.parse(readFileSync(path.resolve(path.dirname(addonPath), '../package.json'), 'utf8')).version : addon.runtimeVersion();
    result.postgresVersion = String((await query('SHOW server_version')).rows[0][0]);
    result.defaultMaxStackDepth = String((await query('SHOW max_stack_depth')).rows[0][0]);
    result.durability = {};
    for (const setting of ['fsync', 'synchronous_commit', 'full_page_writes']) {
      const value = String((await query(`SHOW ${setting}`)).rows[0][0]);
      result.durability[setting] = value;
      if (!reference && test.storage === 'directory') assert.equal(value, 'on', `SHOW ${setting}`);
    }
    if (test.limit !== 'default') await query(`SET max_stack_depth = '${test.limit}'`);
    result.maxStackDepth = String((await query('SHOW max_stack_depth')).rows[0][0]);
    await query('CREATE TABLE survivor(value integer)');
    await query('INSERT INTO survivor VALUES (42)');
    await query('CREATE FUNCTION pg_temp.stack_probe(n integer) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN IF n = 0 THEN RETURN 0; END IF; RETURN pg_temp.stack_probe(n - 1) + 1; END $$');
    await scalar('SELECT pg_temp.stack_probe(4)', '4');
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      event('depth-query', { cycle });
      await depthQuery();
      await scalar('SELECT 42::text AS value', '42');
      result.checks.push(`cycle-${cycle}-query-and-reuse`);
    }
    event('savepoint');
    await query('BEGIN');
    await query('SAVEPOINT depth_probe');
    await query('INSERT INTO survivor VALUES (99)');
    await depthQuery();
    await query('ROLLBACK TO SAVEPOINT depth_probe');
    await scalar('SELECT sum(value)::text FROM survivor', '42');
    await query('COMMIT');
    result.checks.push('savepoint-rollback-and-reuse');
    if (test.fixture === 'plpgsql' && result.observations.some((row) => row.sqlstate === '54001')) {
      event('plpgsql-catch');
      await query("CREATE FUNCTION pg_temp.stack_catch() RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO survivor VALUES (99); PERFORM pg_temp.stack_probe(2000); RETURN 'missing-error'; EXCEPTION WHEN statement_too_complex THEN RETURN SQLSTATE; END $$");
      await scalar('SELECT pg_temp.stack_catch()', '54001');
      await scalar('SELECT sum(value)::text FROM survivor', '42');
      await scalar('SELECT pg_temp.stack_probe(4)', '4');
      result.checks.push('plpgsql-catch-rollback-and-reuse');
    }
    await query('RESET max_stack_depth');
    await scalar('SHOW max_stack_depth', result.defaultMaxStackDepth);
    await scalar("SELECT 'true'::json::text", 'true');
    event('close');
    await database.close();
    assert.equal(database.closed, true);
    if (test.storage === 'directory') {
      event('reopen');
      database = await open();
      await scalar('SELECT sum(value)::text FROM survivor', '42');
      await database.close();
      result.checks.push('directory-reopen-with-committed-data');
    }
    result.passed = true;
    event('complete');
  } catch (error) {
    result.error = { name: error.name, message: error.message, sqlstate: error.sqlstate, stack: error.stack };
    save();
    console.error(error);
    process.exitCode = 1;
    if (database && !database.closed) {
      event('failure-close');
      try { await database.close(); } catch (cleanupError) { result.cleanupError = cleanupError.message; save(); }
    }
  }
}
