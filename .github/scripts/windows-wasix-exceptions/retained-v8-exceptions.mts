import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, query } from './published-exceptions.mts';

const original = {
  runId: 37409777766,
  artifactId: 11389566342,
  sourceCommit: '9d6906435e85652b6a6edfd4834d6242b390a3f8',
  zipSha256: '897e3348635e56e4641cfef9de593432b5a3d140a7bcb48245ef16e313731a57',
  runtimeVersion: '0.3.1',
  addonAbiVersion: 3,
  moduleSha256: '69fdbc72f9e110c1e356db8f46b941cb67591eff140231fcfaffff201d4e7cf9',
  files: {
    'delivery-addon.node': '7ab3a7dcfb46d80c2f2d6ad49599250177854ce9517a5659306dd586c7b205c7',
    'engine/oliphaunt_wee8.dll': '63e2a2fed2c775f618b42de73580774a9d35e86ddd255b079b14586f6d86ced8',
    'node-delivery-receipt.json':
      '08b460d3cf9527466e700b7ca232d7e68a2b3cb2f79db18e95b1f7a2da87a070',
    'embedded-delivery-receipt.json':
      '31feb49698eb99073f326cf815b306cac1b73305a3ccbe50e4356a86756763eb',
    'cache-only-receipt.json': '264aa8386f8a82e849ef24c4aa533cf24f15b998353f7f69d430c966c55a6d35',
    'family/family-receipt.json':
      '33a958367dee38f7f324062887e06c6d5cec6dd9399af455b26b2a6d557707ef',
  },
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function verifyFixture(root: string) {
  for (const [name, expected] of Object.entries(original.files)) {
    assert.equal(sha256(readFileSync(path.join(root, name))), expected, name);
  }
  assert(
    readFileSync(path.join(root, 'delivery-addon.node')).includes(
      Buffer.from('research_guest_compilation_reached=true'),
    ),
  );
  const delivery = json(path.join(root, 'node-delivery-receipt.json'));
  assert.equal(delivery.addon_sha256, original.files['delivery-addon.node']);
  assert.deepEqual(
    delivery.checks.map((row: any) => [row.mode, row.exit_code]),
    [
      ['direct', 0],
      ['actor', 0],
    ],
  );
  const engine = json(path.join(root, 'embedded-delivery-receipt.json'));
  assert.equal(engine.dll_sha256, original.files['engine/oliphaunt_wee8.dll']);
  assert.equal(json(path.join(root, 'cache-only-receipt.json')).compiler_sentinel, true);
  const family = json(path.join(root, 'family/family-receipt.json'));
  assert.equal(family.dll_sha256, engine.dll_sha256);
  assert.equal(family.family.wasmer.name, 'oliphaunt-wasmer');
  assert.equal(family.family.wasmer.version, '7.5.0');
  assert.equal(family.family['wasmer-wasix'].version, '0.705.0');
}

function captureAotCache(localAppData: string) {
  const root = path.join(
    localAppData,
    'oliphaunt-wasix',
    'oliphaunt-wasix',
    'cache',
    'wasmer-aot',
    'x86_64-pc-windows-msvc',
  );
  const wanted = ['runtime:oliphaunt', 'runtime-support:plpgsql', 'runtime-support:dict_snowball'];
  const receipts = readdirSync(root)
    .filter((name) => name.endsWith('.receipt.json'))
    .map((name) => ({ name, value: json(path.join(root, name)) }));
  return wanted.map((artifactName) => {
    const matches = receipts.filter(({ value }) => value['artifact-name'] === artifactName);
    assert.equal(matches.length, 1, `exact selected AOT receipt ${artifactName}`);
    const { name, value } = matches[0];
    assert.equal(value.engine, 'v8');
    assert.equal(value['wasmer-version'], '7.5.0');
    assert.equal(value['wasmer-wasix-version'], '0.705.0');
    assert.equal(value['target-triple'], 'x86_64-pc-windows-msvc');
    const bytes = readFileSync(path.join(root, name.replace(/\.receipt\.json$/u, '.bin')));
    assert.equal(bytes.length, value['raw-size']);
    assert.equal(sha256(bytes), value['raw-sha256']);
    if (artifactName === 'runtime:oliphaunt')
      assert.equal(value['module-sha256'], original.moduleSha256);
    return { receipt: name, receiptSha256: sha256(readFileSync(path.join(root, name))), ...value };
  });
}

function runCase(name: string, root: string) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  verifyFixture(root);
  const selected = cases.find((candidate) => candidate.name === name);
  assert(selected);
  const addon = createRequire(import.meta.url)(path.join(root, 'delivery-addon.node'));
  assert.equal(addon.addonAbiVersion(), original.addonAbiVersion);
  assert.equal(addon.runtimeVersion(), original.runtimeVersion);
  const runtimeArchive = addon.payloadIdentity('runtimeArchive');
  assert.match(runtimeArchive, /^[a-f0-9]{64}:\d+$/u);
  console.log(JSON.stringify({ phase: 'identity', name, original, runtimeArchive }));
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
    const sqlPassed =
      baseline.errors.length === 0 &&
      JSON.stringify(baseline.rows) === '[["before"]]' &&
      baseline.ready === 'I' &&
      probe.errors.length === 0 &&
      JSON.stringify(probe.rows) === JSON.stringify(selected.expected) &&
      probe.ready === 'I' &&
      after.errors.length === 0 &&
      JSON.stringify(after.rows) === '[["after"]]' &&
      after.ready === 'I';
    let engineProof;
    try {
      const localAppData = process.env.LOCALAPPDATA;
      assert(localAppData);
      const loadedEnginePath = path.join(
        localAppData,
        'Oliphaunt',
        'research-engines',
        original.files['engine/oliphaunt_wee8.dll'],
        'oliphaunt_wee8.dll',
      );
      const loadedEngineSha256 = sha256(readFileSync(loadedEnginePath));
      assert.equal(loadedEngineSha256, original.files['engine/oliphaunt_wee8.dll']);
      engineProof = {
        passed: true,
        loadedEnginePath,
        loadedEngineSha256,
        aotCache: captureAotCache(localAppData),
      };
    } catch (error) {
      engineProof = { passed: false, error: String(error) };
    }
    result = {
      phase: 'result',
      name,
      passed: sqlPassed && engineProof.passed,
      sqlPassed,
      baseline,
      probe,
      after,
      engineProof,
    };
  } finally {
    database.close();
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.passed ? 0 : 1;
}

function main() {
  if (process.argv[2] === '--case') return runCase(process.argv[3], path.resolve(process.argv[4]));
  const verifyOnly = process.argv[2] === '--verify-only';
  const root = path.resolve(process.argv[verifyOnly ? 3 : 2]);
  verifyFixture(root);
  if (verifyOnly) {
    console.log(JSON.stringify({ original, verified: true }));
    return;
  }
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  const output = path.resolve(process.argv[3]);
  mkdirSync(output, { recursive: true });
  const started = Date.now();
  const results = cases.map((test) => {
    const child = spawnSync(
      process.execPath,
      ['--experimental-strip-types', fileURLToPath(import.meta.url), '--case', test.name, root],
      {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_PATH: '',
          OLIPHAUNT_WASM_AOT_VERIFY: 'full',
          TMPDIR: output,
          TEMP: output,
          TMP: output,
        },
      },
    );
    const records = (child.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    const detail = records.find((record) => record.phase === 'result');
    const engineMarker = `research_embedded_engine_loaded=${detail?.engineProof?.loadedEnginePath}`;
    const markerPresent = (child.stderr ?? '')
      .replaceAll('\\', '/')
      .includes(engineMarker.replaceAll('\\', '/'));
    const result = {
      name: test.name,
      passed: child.status === 0 && detail?.passed === true && markerPresent,
      sqlPassed: detail?.sqlPassed === true,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message,
      records,
      stderr: (child.stderr ?? '').slice(-8192),
      engineMarkerPresent: markerPresent,
    };
    console.log(JSON.stringify(result));
    return result;
  });
  const report = {
    scope:
      'retained private Windows V8 nested SQL diagnostic; not current-source or installed release qualification',
    original,
    diagnosticSourceCommit: process.env.GITHUB_SHA ?? null,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    elapsedMs: Date.now() - started,
    passed: results.every((result) => result.passed),
    results,
  };
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      resultFile: path.join(output, 'result.json'),
      passed: report.passed,
      elapsedMs: report.elapsedMs,
    }),
  );
  process.exitCode = report.passed ? 0 : 1;
}

main();
