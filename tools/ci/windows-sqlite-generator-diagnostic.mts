import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

const base = '56a93d75efc9f8289bfa5438b14a4ccdbb1685fd';
const rulePath = 'build_defs/extensions/postgis/sqlite.bzl';
const workerPath = 'build_defs/extensions/postgis/sqlite_generate.mts';
const target = '//build_defs/extensions/postgis:sqlite_generated';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown) => console.log(JSON.stringify(value));
const stockRule = readFileSync(rulePath),
  normalizedWorker = readFileSync(workerPath);
const originalRuleResult = spawnSync('git', ['show', `${base}:${rulePath}`]);
const originalWorkerResult = spawnSync('git', ['show', `${base}:${workerPath}`]);
assert.equal(originalRuleResult.status, 0);
assert.equal(originalWorkerResult.status, 0);
const strictRule = originalRuleResult.stdout;
assert.equal(
  hash(originalWorkerResult.stdout),
  'e5dca66a9de630fbd5e836690ad6dcce9b62ef64cbbb8fce7f7df03fc93e3eaa',
);
assert.equal(
  hash(normalizedWorker),
  '3bfcabef87ac9a7580df0f95aab8fc72ee4e482744e650004906f49a3b9d1355',
);
assert.equal(hash(strictRule), 'b477d21a03b7fbd82b968c072827b0232c448857849f1792c9690aeda2b8bfa3');
assert.equal(
  stockRule.toString(),
  strictRule
    .toString()
    .replace(
      '        mnemonic = "SqliteUpstreamGenerators",\n',
      '        mnemonic = "SqliteUpstreamGenerators",\n        use_default_shell_env = True,\n',
    ),
);
assert.equal(process.platform, 'win32');
const owned = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'sqlite-diagnostic-'));
const marker = join(owned, 'host-path-marker');
mkdirSync(marker);
const markerInPath = (path: unknown) =>
  String(path ?? '')
    .toLowerCase()
    .includes(basename(marker).toLowerCase());
const hostEnvironment = { ...process.env };
const pathKey = Object.keys(hostEnvironment).find((name) => name.toUpperCase() === 'PATH');
assert(pathKey);
hostEnvironment[pathKey] = marker + delimiter + hostEnvironment[pathKey];
const outputBase = join(process.env.RUNNER_TEMP ?? tmpdir(), 'b');
const configuration = [
  '-c',
  'opt',
  '--platforms=//build_defs/host:native_windows_x64',
  '--host_platform=//build_defs/host:native_windows_x64',
  '--jobs=2',
  '--incompatible_strict_action_env',
];
function bazel(command: string, args: string[], capture = false) {
  const result = spawnSync(
    'bash',
    [
      'tools/dev/bazel.sh',
      `--output_base=${outputBase}`,
      command,
      ...(['build', 'cquery', 'aquery'].includes(command) ? configuration : []),
      ...args,
    ],
    {
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
function environment() {
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
    (actions[0].environmentVariables ?? []).map((row: { key: string; value?: string }) => {
      assert(
        typeof row.key === 'string' && row.key.length > 0,
        'aquery environment entry requires a key',
      );
      assert(
        row.value === undefined || typeof row.value === 'string',
        'aquery environment value must be a string',
      );
      return [row.key, row.value ?? ''];
    }),
  );
  const temp = process.env.TMP || process.env.TEMP || tmpdir();
  return {
    declared,
    child: {
      ...declared,
      TMP: temp,
      TEMP: temp,
      LC_ALL: 'C',
      TCLLIBPATH: '',
      TCL_LIBRARY: '',
      JIMLIB: '',
    },
  };
}
function nativeChild(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin: 'ignore' | 'pipe' = 'ignore',
) {
  try {
    const result = Bun.spawnSync([executable, ...args], {
      cwd,
      env,
      stdin,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      status: result.exitCode,
      stdout: result.stdout.toString().slice(0, 2048),
      stderr: result.stderr.toString().slice(0, 2048),
    };
  } catch (error) {
    return { status: null, error: String(error) };
  }
}
let executionRoot = '',
  source = '',
  canonicalSourceID = '';
let firstOutputs: Record<string, string> | undefined;
const successes: Record<string, number> = { strict: 0, stock: 0 };
const statuses: { round: number; mode: string; status: number | null }[] = [];
let manualWork: string | undefined;
try {
  for (const round of [1, 2]) {
    if (round === 2) assert.equal(bazel('clean', []).status, 0);
    for (const [mode, rule] of [
      ['strict', strictRule],
      ['stock', stockRule],
    ] as const) {
      writeFileSync(rulePath, rule);
      const result = bazel('build', ['--verbose_failures', target]);
      statuses.push({ round, mode, status: result.status });
      record({ round, phase: 'normalized-worker-action', mode, status: result.status });
      const env = environment();
      const declaredPath = Object.entries(env.declared).find(
        ([name]) => name.toUpperCase() === 'PATH',
      )?.[1];
      if (mode === 'stock') assert(declaredPath, 'Stock default shell PATH missing');
      assert(!markerInPath(declaredPath), 'Ambient host PATH marker entered action');
      record({
        round,
        phase: 'action-environment',
        mode,
        declaredNames: Object.keys(env.declared).sort(),
        hostPathMarkerPresent: false,
      });
      if (round === 1 && mode === 'strict') {
        const info = bazel('info', ['execution_root'], true);
        assert.equal(info.status, 0);
        executionRoot = info.stdout.trim();
        const inputs = query(
          `filter(":sqlite_(jim|mksourceid)$", deps(${target})) union set(@postgis_sqlite//:VERSION)`,
        );
        const file = (suffix: string) => {
          const row = inputs.find((value) => value.label.endsWith(suffix));
          assert(row);
          const paths =
            suffix === '//:VERSION' ? row.paths : row.paths.filter((path) => path.endsWith('.exe'));
          assert.equal(paths.length, 1);
          return resolve(executionRoot, paths[0]);
        };
        source = dirname(file('//:VERSION'));
        const sourceHashes = {
          manifest: '325966a868551b58876ace098d9ff17c0a4b56dc8b1054ac5497f8cdb5c65547',
          'tool/mksourceid.c': '113053bdb59cc9398af36c22221eb6cf861229f9fb4d04a4bbc54fd1f7db9e99',
          'autosetup/jimsh0.c': '20f8554be6bd4ba142870f1a4ade1e96115cf5a07704e3522c08b25f9f405ae0',
        };
        for (const [path, digest] of Object.entries(sourceHashes))
          assert.equal(
            hash(readFileSync(join(source, path))),
            digest,
            `Pinned source changed: ${path}`,
          );
        const time = /^D (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/mu.exec(
          readFileSync(join(source, 'manifest'), 'utf8'),
        )?.[1];
        assert(time);
        const uuid = readFileSync(join(source, 'manifest.uuid'), 'utf8').trim();
        assert.equal(uuid, 'c88b22011a54b4f6fbd149e9f8e4de77658ce58143a1af0e3785e4e6475127e9');
        canonicalSourceID = `${time.replace('T', ' ')} ${uuid}`;
        record({ phase: 'pinned-upstream-source', hashes: sourceHashes, manifestUUID: uuid });
        // Match the worker's OS temp location and production Bun API/stdio.
        manualWork = mkdtempSync(join(env.child.TEMP, 'sqlite-generators-'));
        const helper = join(manualWork, 'mksourceid.exe');
        copyFileSync(file(':sqlite_mksourceid'), helper);
        const direct = nativeChild(helper, ['manifest'], source, env.child);
        record({ phase: 'direct-native-bun-ignore', ...direct });
        if (direct.status === 0) assert.equal(direct.stdout?.trim(), canonicalSourceID);
        const script = join(manualWork, 'upstream-probe.tcl');
        writeFileSync(
          script,
          [
            'set script [lindex $argv 0]',
            'set argv [lrange $argv 1 end]',
            'foreach name {PATH COMSPEC SYSTEMROOT} {',
            '  set found 0',
            '  foreach key [array names env] {if {[string equal -nocase $name $key]} {set found 1}}',
            '  puts [list childEnvPresent $name $found]',
            '}',
            'set status [catch {source $script} message]',
            'puts [list status $status message $message]',
            'if {[info exists ::errorCode]} {puts [list errorCode $::errorCode]}',
            'exit $status',
            '',
          ].join('\n'),
        );
        const args = [
          script,
          join(source, 'tool/mksqlite3h.tcl'),
          source,
          '-o',
          join(manualWork, 'sqlite3.h'),
        ].map((path) => path.replaceAll('\\', '/'));
        for (const stdin of ['ignore', 'pipe'] as const)
          record({
            phase: 'manual-full-upstream-script',
            stdin,
            authority: 'observational-only; full Bazel actions determine viability',
            ...nativeChild(file(':sqlite_jim'), args, manualWork, env.child, stdin),
          });
      }
      if (result.status !== 0) continue;
      const rows = query(target);
      assert.equal(rows.length, 1);
      const outputs = Object.fromEntries(
        rows[0].paths.map((path) => [
          basename(path),
          hash(readFileSync(resolve(executionRoot, path))),
        ]),
      );
      assert.equal(Object.keys(outputs).length, 9);
      const headerPath = rows[0].paths.find((path) => basename(path) === 'sqlite3.h');
      assert(headerPath);
      const sourceID = /^#define SQLITE_SOURCE_ID\s+"([^"]+)"/mu.exec(
        readFileSync(resolve(executionRoot, headerPath), 'utf8'),
      )?.[1];
      assert.equal(sourceID, canonicalSourceID, 'Generated header is not canonical Fossil source');
      if (firstOutputs) assert.deepEqual(outputs, firstOutputs, 'Fresh generated outputs differ');
      else firstOutputs = outputs;
      successes[mode]++;
      record({ round, phase: 'generated-output-parity', mode, sourceID, hashes: outputs });
    }
  }
  const selected =
    successes.strict === 2
      ? 'normalize-arguments-only'
      : successes.stock === 2
        ? 'normalize-arguments-and-stock-default-environment'
        : null;
  record({
    result: selected ? 'PASS' : 'FAIL',
    selectedMinimumCandidate: selected,
    successes,
    statuses,
  });
  if (!selected) process.exitCode = 1;
} finally {
  writeFileSync(rulePath, stockRule);
  writeFileSync(workerPath, normalizedWorker);
  if (manualWork) rmSync(manualWork, { recursive: true, force: true });
  rmSync(owned, { recursive: true, force: true });
}
