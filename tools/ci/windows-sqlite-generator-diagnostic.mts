import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

const sourceCommit = '56a93d75efc9f8289bfa5438b14a4ccdbb1685fd';
const rulePath = 'build_defs/extensions/postgis/sqlite.bzl';
const originalSHA256 = 'b477d21a03b7fbd82b968c072827b0232c448857849f1792c9690aeda2b8bfa3';
const target = '//build_defs/extensions/postgis:sqlite_generated';
const root = process.cwd();
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const candidate = readFileSync(rulePath);
const original = spawnSync('git', ['show', `${sourceCommit}:${rulePath}`], { encoding: null });
assert.equal(original.status, 0, 'Immutable original source is unavailable');
assert.equal(digest(original.stdout), originalSHA256);
assert.equal(
  candidate.toString(),
  original.stdout
    .toString()
    .replace(
      '        mnemonic = "SqliteUpstreamGenerators",\n',
      '        mnemonic = "SqliteUpstreamGenerators",\n        use_default_shell_env = True,\n',
    ),
);
assert.notEqual(digest(candidate), originalSHA256);
assert.equal(process.platform, 'win32', 'This diagnostic requires the production Windows host');
const owned = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'sqlite-diagnostic-'));
const outputBase = join(process.env.RUNNER_TEMP ?? tmpdir(), 'b');
const marker = join(owned, 'host-path-marker');
const markerInPath = (path: unknown) =>
  String(path ?? '')
    .toLowerCase()
    .includes(basename(marker).toLowerCase());
mkdirSync(marker);
const hostEnvironment = { ...process.env };
const pathKey = Object.keys(hostEnvironment).find((name) => name.toUpperCase() === 'PATH');
assert(pathKey);
hostEnvironment[pathKey] = marker + delimiter + hostEnvironment[pathKey];
const configuration = [
  '-c',
  'opt',
  '--platforms=//build_defs/host:native_windows_x64',
  '--host_platform=//build_defs/host:native_windows_x64',
  '--jobs=2',
  '--incompatible_strict_action_env',
];
const failures: string[] = [];
function record(value: unknown) {
  console.log(JSON.stringify(value));
}
function bazel(command: string, args: string[], capture = false) {
  const flags = ['build', 'cquery', 'aquery'].includes(command) ? configuration : [];
  const result = spawnSync(
    'bash',
    ['tools/dev/bazel.sh', `--output_base=${outputBase}`, command, ...flags, ...args],
    {
      cwd: root,
      env: hostEnvironment,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: capture ? 'pipe' : 'inherit',
    },
  );
  if (result.error) throw result.error;
  return result;
}
function query(expression: string) {
  const result = bazel(
    'cquery',
    [
      expression,
      '--output=starlark',
      '--starlark:expr=str(target.label) + "\\t" + "|".join([f.path for f in target.files.to_list()])',
    ],
    true,
  );
  assert.equal(result.status, 0, result.stderr?.slice(-2048));
  return result.stdout
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [label, paths] = line.split('\t');
      return { label, paths: paths.split('|') };
    });
}
function actionEnvironment() {
  const result = bazel(
    'aquery',
    [
      `mnemonic("SqliteUpstreamGenerators", ${target})`,
      '--output=jsonproto',
      '--include_artifacts=false',
    ],
    true,
  );
  assert.equal(result.status, 0, result.stderr?.slice(-2048));
  const actions = JSON.parse(result.stdout).actions;
  assert.equal(actions.length, 1);
  const declared = Object.fromEntries(
    (actions[0].environmentVariables ?? []).map((row: { name: string; value: string }) => [
      row.name,
      row.value,
    ]),
  );
  // Pinned WindowsLocalEnvProvider overrides only TMP/TEMP with the client temp.
  const temp = process.env.TMP || process.env.TEMP || tmpdir();
  const runtime = { ...declared, TMP: temp, TEMP: temp };
  return {
    declared,
    child: { ...runtime, LC_ALL: 'C', TCLLIBPATH: '', TCL_LIBRARY: '', JIMLIB: '' },
  };
}
function child(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout?.slice(0, 2048),
    stderr: result.stderr?.slice(0, 2048),
  };
}
let firstOutputs: Record<string, string> | undefined;
try {
  for (const round of [1, 2]) {
    if (round === 2) {
      const clean = bazel('clean', []);
      assert.equal(clean.status, 0);
    }
    writeFileSync(rulePath, original.stdout);
    const negative = bazel('build', ['--verbose_failures', target]);
    record({ round, phase: 'original-action', status: negative.status });
    if (negative.status === 0) failures.push(`round${round}: original action did not reproduce`);
    const rootInfo = spawnSync(
      'bash',
      ['tools/dev/bazel.sh', `--output_base=${outputBase}`, 'info', 'execution_root'],
      { env: hostEnvironment, encoding: 'utf8' },
    );
    assert.equal(rootInfo.status, 0, rootInfo.stderr?.slice(-2048));
    const executionRoot = rootInfo.stdout.trim();
    const inputs = query(
      `filter(":sqlite_(jim|mksourceid)$", deps(${target})) union set(@postgis_sqlite//:VERSION)`,
    );
    const file = (suffix: string) => {
      const row = inputs.find((value) => value.label.endsWith(suffix));
      assert(row, `Missing configured file for ${suffix}`);
      const paths =
        suffix === '//:VERSION' ? row.paths : row.paths.filter((path) => path.endsWith('.exe'));
      assert.equal(paths.length, 1, `Expected one configured file for ${suffix}`);
      return resolve(executionRoot, paths[0]);
    };
    const source = dirname(file('//:VERSION'));
    const sourceHashes = {
      manifest: '325966a868551b58876ace098d9ff17c0a4b56dc8b1054ac5497f8cdb5c65547',
      'tool/mksourceid.c': '113053bdb59cc9398af36c22221eb6cf861229f9fb4d04a4bbc54fd1f7db9e99',
      'autosetup/jimsh0.c': '20f8554be6bd4ba142870f1a4ade1e96115cf5a07704e3522c08b25f9f405ae0',
    };
    for (const [path, expected] of Object.entries(sourceHashes))
      assert.equal(
        digest(readFileSync(join(source, path))),
        expected,
        `Pinned source changed: ${path}`,
      );
    const manifest = readFileSync(join(source, 'manifest'), 'utf8');
    const manifestTime = /^D (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/mu.exec(manifest)?.[1];
    assert(manifestTime);
    const manifestUUID = readFileSync(join(source, 'manifest.uuid'), 'utf8').trim();
    assert.equal(manifestUUID, 'c88b22011a54b4f6fbd149e9f8e4de77658ce58143a1af0e3785e4e6475127e9');
    const canonicalSourceID = `${manifestTime.replace('T', ' ')} ${manifestUUID}`;
    if (round === 1)
      record({ phase: 'pinned-upstream-source', hashes: sourceHashes, manifestUUID });
    const jim = file(':sqlite_jim');
    const work = mkdtempSync(join(owned, `round${round}-`));
    const helper = join(work, 'mksourceid.exe');
    copyFileSync(file(':sqlite_mksourceid'), helper);
    const script = join(work, 'exec-probe.tcl');
    writeFileSync(
      script,
      [
        'set work [pwd]',
        'cd [lindex $argv 0]',
        'set status [catch {exec $work/mksourceid.exe manifest > $work/source-id.txt} message]',
        'puts [list status $status message $message]',
        'if {[info exists ::errorCode]} {puts [list errorCode $::errorCode]}',
        'exit $status',
        '',
      ].join('\n'),
    );
    const strict = actionEnvironment();
    record({
      round,
      phase: 'strict-action-environment',
      declaredNames: Object.keys(strict.declared).sort(),
      hostPathMarkerPresent: markerInPath(strict.declared.PATH),
    });
    const direct = child(helper, ['manifest'], source, strict.child);
    const strictJim = child(jim, [script, source], work, strict.child);
    record({ round, phase: 'direct-strict-mksourceid', ...direct });
    record({ round, phase: 'jim-strict-exec', ...strictJim });
    if (direct.status !== 0) failures.push(`round${round}: direct helper failed`);
    assert.equal(
      direct.stdout?.trim(),
      canonicalSourceID,
      'Direct helper did not verify canonical Fossil source',
    );
    if (strictJim.status === 0) failures.push(`round${round}: strict Jim did not reproduce`);

    writeFileSync(rulePath, candidate);
    const positive = bazel('build', ['--verbose_failures', target]);
    record({ round, phase: 'candidate-action', status: positive.status });
    if (positive.status !== 0) {
      failures.push(`round${round}: candidate action failed`);
      continue;
    }
    const standard = actionEnvironment();
    const standardPath = Object.entries(standard.declared).find(
      ([name]) => name.toUpperCase() === 'PATH',
    )?.[1];
    assert(standardPath, 'Candidate must use the stock strict default PATH');
    assert(!markerInPath(standardPath), 'Ambient host PATH marker leaked into action');
    record({
      round,
      phase: 'candidate-action-environment',
      declaredNames: Object.keys(standard.declared).sort(),
      hostPathMarkerPresent: false,
    });
    const standardJim = child(jim, [script, source], work, standard.child);
    record({ round, phase: 'jim-default-shell-exec', ...standardJim });
    if (standardJim.status !== 0) failures.push(`round${round}: stock-environment Jim failed`);
    const outputRows = query(target);
    assert.equal(outputRows.length, 1);
    const outputs = Object.fromEntries(
      outputRows[0].paths.map((path) => [
        basename(path),
        digest(readFileSync(resolve(executionRoot, path))),
      ]),
    );
    assert.equal(Object.keys(outputs).length, 9);
    const headerPath = outputRows[0].paths.find((path) => basename(path) === 'sqlite3.h');
    assert(headerPath);
    const header = readFileSync(resolve(executionRoot, headerPath), 'utf8');
    const sourceID = /^#define SQLITE_SOURCE_ID\s+"([^"]+)"/mu.exec(header)?.[1];
    assert(sourceID, 'Generated header must contain SQLITE_SOURCE_ID');
    assert.equal(
      sourceID,
      direct.stdout?.trim(),
      'Header source ID differs from the direct declared helper',
    );
    if (firstOutputs)
      assert.deepEqual(outputs, firstOutputs, 'Fresh candidate outputs changed across rounds');
    else firstOutputs = outputs;
    record({ round, phase: 'generated-output-parity', sourceID, hashes: outputs });
  }
  record({ result: failures.length ? 'FAIL' : 'PASS', failures });
  if (failures.length) process.exitCode = 1;
} finally {
  writeFileSync(rulePath, candidate);
  rmSync(owned, { recursive: true, force: true });
}
