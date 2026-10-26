import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cases = [
  {
    name: 'division',
    expected: [['division-caught']],
    sql: "DO $$ BEGIN BEGIN PERFORM 1 / 0; EXCEPTION WHEN division_by_zero THEN NULL; END; END $$; SELECT 'division-caught'::text",
  },
  {
    name: 'missing-schema',
    expected: [['missing-schema-caught']],
    sql: "DO $$ BEGIN BEGIN EXECUTE 'ALTER EXTENSION plpgsql DROP SCHEMA oliphaunt_missing_exception_probe'; EXCEPTION WHEN invalid_schema_name THEN NULL; END; END $$; SELECT 'missing-schema-caught'::text",
  },
  {
    name: 'nested-rethrow',
    expected: [['nested-rethrow-caught']],
    sql: "DO $$ BEGIN BEGIN BEGIN RAISE EXCEPTION SQLSTATE '22012' USING MESSAGE = 'nested rethrow probe'; EXCEPTION WHEN division_by_zero THEN RAISE; END; EXCEPTION WHEN division_by_zero THEN NULL; END; END $$; SELECT 'nested-rethrow-caught'::text",
  },
  {
    name: 'subtransaction-rollback',
    expected: [['2']],
    sql: 'CREATE TEMP TABLE exception_probe(value integer); DO $$ BEGIN BEGIN INSERT INTO exception_probe VALUES (1); PERFORM 1 / 0; EXCEPTION WHEN division_by_zero THEN INSERT INTO exception_probe VALUES (2); END; END $$; SELECT value::text FROM exception_probe ORDER BY value',
  },
];
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function query(database: any, sql: string) {
  const text = Buffer.from(sql + '\0');
  const request = Buffer.alloc(text.length + 5);
  request[0] = 81;
  request.writeUInt32BE(text.length + 4, 1);
  text.copy(request, 5);
  const bytes = Buffer.from(database.execProtocolRaw(request));
  const errors: Record<string, string>[] = [],
    rows: (string | null)[][] = [];
  let ready: string | undefined;
  for (let offset = 0; offset < bytes.length; ) {
    assert(offset + 5 <= bytes.length);
    const length = bytes.readUInt32BE(offset + 1);
    assert(length >= 4 && offset + length + 1 <= bytes.length);
    const tag = String.fromCharCode(bytes[offset]),
      data = bytes.subarray(offset + 5, offset + length + 1);
    if (tag === 'E') {
      const fields: Record<string, string> = {};
      for (let cursor = 0; cursor < data.length && data[cursor] !== 0; ) {
        const end = data.indexOf(0, cursor + 1);
        assert(end > cursor);
        fields[String.fromCharCode(data[cursor])] = data.subarray(cursor + 1, end).toString();
        cursor = end + 1;
      }
      errors.push(fields);
    }
    if (tag === 'D') {
      const row: (string | null)[] = [];
      for (let field = 0, cursor = 2; field < data.readUInt16BE(0); field++) {
        assert(cursor + 4 <= data.length);
        const size = data.readInt32BE(cursor);
        cursor += 4;
        assert(size === -1 || (size >= 0 && cursor + size <= data.length));
        row.push(size === -1 ? null : data.subarray(cursor, cursor + size).toString());
        if (size >= 0) cursor += size;
      }
      rows.push(row);
    }
    if (tag === 'Z') {
      assert.equal(data.length, 1);
      ready = data.toString();
    }
    offset += length + 1;
  }
  assert(ready, 'missing ReadyForQuery');
  return { errors, rows, ready };
}
function runCase(name: string, packageRoot: string) {
  const selected = cases.find((test) => test.name === name);
  assert(selected);
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const binary = path.join(packageRoot, 'prebuilds/oliphaunt_wasix_napi.node');
  const binarySha256 = sha256(readFileSync(binary));
  const provenance = JSON.parse(
    readFileSync(path.join(packageRoot, 'artifact-provenance.json'), 'utf8'),
  );
  assert.equal(provenance.binary.sha256, binarySha256);
  const addon = require(binary);
  assert.equal(addon.addonAbiVersion(), manifest.oliphaunt.addonAbiVersion);
  assert.equal(addon.runtimeVersion(), manifest.oliphaunt.runtimeVersion);
  console.log(
    JSON.stringify({
      phase: 'identity',
      name,
      package: manifest.name,
      version: manifest.version,
      binarySha256,
      runtimeVersion: addon.runtimeVersion(),
      addonAbiVersion: addon.addonAbiVersion(),
      runtimeArchive: addon.payloadIdentity('runtimeArchive'),
    }),
  );
  const database = addon.NativeWasixDatabase.open({
    profile: 'standard',
    storage: { kind: 'memory' },
    username: 'postgres',
    database: 'postgres',
    startupGucs: {},
    extensions: [],
    extensionPackages: [],
  });
  let result;
  try {
    const baseline = query(database, "SELECT 'before'::text");
    const probe = query(database, selected.sql);
    const after = query(database, "SELECT 'after'::text");
    const passed =
      baseline.errors.length === 0 &&
      JSON.stringify(baseline.rows) === '[["before"]]' &&
      baseline.ready === 'I' &&
      probe.errors.length === 0 &&
      JSON.stringify(probe.rows) === JSON.stringify(selected.expected) &&
      probe.ready === 'I' &&
      after.errors.length === 0 &&
      JSON.stringify(after.rows) === '[["after"]]' &&
      after.ready === 'I';
    result = { phase: 'result', name, passed, baseline, probe, after };
  } finally {
    database.close();
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}
async function main() {
  if (process.argv[2] === '--case') {
    runCase(process.argv[3], process.argv[4]);
    return;
  }
  assert(process.platform === 'win32' || process.platform === 'linux');
  assert.equal(process.arch, 'x64');
  const started = Date.now(),
    root =
      process.argv[2] ?? mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-public-wasix-exceptions-'));
  mkdirSync(root, { recursive: true });
  const packageName =
    process.platform === 'win32'
      ? '@oliphaunt/wasix-napi-win32-x64-msvc'
      : '@oliphaunt/wasix-napi-linux-x64-gnu';
  const pins = JSON.parse(readFileSync(new URL('./pinned-carriers.json', import.meta.url), 'utf8'));
  const pin = pins.find((row: any) => row.name === packageName);
  assert(pin);
  const response = await fetch(pin.tarball, { signal: AbortSignal.timeout(30000) });
  assert(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, pin.size);
  assert.equal(sha256(bytes), pin.sha256);
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), pin.integrity);
  const archive = path.join(root, 'carrier.tgz'),
    extracted = path.join(root, 'extracted');
  writeFileSync(archive, bytes);
  mkdirSync(extracted);
  const untar = spawnSync('tar', ['-xzf', 'carrier.tgz', '-C', 'extracted'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(untar.status, 0, untar.stderr);
  const packageRoot = path.join(extracted, 'package');
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, pin.name);
  assert.equal(manifest.version, pin.version);
  const results = [];
  for (const test of cases) {
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(import.meta.url),
        '--case',
        test.name,
        packageRoot,
      ],
      {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_PATH: '',
          TMPDIR: root,
          TEMP: root,
          TMP: root,
        },
      },
    );
    const lines = (child.stdout ?? '').trim().split('\n').filter(Boolean);
    const records = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    const detail = records.find((row) => row.phase === 'result');
    const result = {
      name: test.name,
      passed: child.status === 0 && detail?.passed === true,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message,
      records,
      stderr: (child.stderr ?? '').slice(-8192),
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    sourceCommit: process.env.GITHUB_SHA ?? null,
    carrier: pin,
    elapsedMs: Date.now() - started,
    passed: results.every((row) => row.passed),
    results,
  };
  writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      resultFile: path.join(root, 'result.json'),
      passed: report.passed,
      elapsedMs: report.elapsedMs,
    }),
  );
  process.exitCode = report.passed ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
