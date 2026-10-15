import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Preserve the numeric feature switches consumed by the maintained checker.
const source = readFileSync(new URL('./host_config.bzl', import.meta.url), 'utf8');
function featureSwitchValue(policy: string): unknown {
  const value = /checks\.AC_DEFINE\(d,\s*([^\n)]+)\)\s+for d in definitions\s*\+/u.exec(
    policy,
  )?.[1];
  if (!value) throw new Error('host feature-switch AC_DEFINE declaration is missing');
  return JSON.parse(value);
}
assert.equal(featureSwitchValue(source), 1);
assert.notEqual(
  featureSwitchValue(source.replace(/checks\.AC_DEFINE\(d,\s*1\)/u, 'checks.AC_DEFINE(d, "1")')),
  1,
);

const [checker] = process.argv.slice(2);
assert(checker, 'Expected the declared maintained checker executable');
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'autoconf-diagnostics-'));
try {
  const compiler = path.join(root, 'controlled compiler.mts');
  const diagnostic = 'controlled compiler diagnostic';
  writeFileSync(
    compiler,
    `import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const [mode,calls,...args]=Bun.argv.slice(2);
const previous=existsSync(calls)?readFileSync(calls,'utf8').trim().split('\\n').filter(Boolean):[];
appendFileSync(calls,JSON.stringify(readFileSync(args[args.indexOf('-c')+1],'utf8'))+'\\n');
console.log('controlled compiler stdout');
console.error('${diagnostic}');
process.exit(mode==='pass'||(mode==='late-pass'&&previous.length===4)?0:1);
`,
  );
  const template =
    '#include <errno.h>\n{$EILSEQ}\ntypedef char result[({lhs} < {rhs}) ? 1 : -1];\n';
  for (const [name, type, mode, status, success, invocations, visible] of [
    ['positive', 'compile', 'pass', 0, true, 1, false],
    ['optional-negative', 'compile', 'fail', 0, false, 1, false],
    ['optional-sizeof', 'sizeof', 'fail', 0, false, 4, false],
    ['fatal', 'compute_int', 'fail', 1, undefined, 5, true],
    ['fatal-retry-passes', 'compute_int', 'late-pass', 1, undefined, 5, true],
  ] as const) {
    const directory = path.join(root, name);
    mkdirSync(directory);
    const calls = path.join(directory, 'calls.jsonl');
    const configuration = path.join(directory, 'config.json');
    const check = path.join(directory, 'check.json');
    const resultFile = path.join(directory, 'result.json');
    const flags = ['--no-env-file', compiler, mode, calls];
    writeFileSync(
      configuration,
      JSON.stringify({
        c_compiler: process.execPath,
        cpp_compiler: process.execPath,
        c_flags: flags,
        cpp_flags: flags,
        c_link_flags: [],
        cpp_link_flags: [],
        linker: process.execPath,
        compiler_type: 'clang',
      }),
    );
    writeFileSync(
      check,
      JSON.stringify({
        name: 'controlled_probe',
        type,
        code: type === 'compile' ? 'int main(void) { return 0; }' : template,
      }),
    );
    const result = spawnSync(
      path.resolve(checker),
      ['--config', configuration, '--check', check, '--results', resultFile],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env: { ...process.env, RULES_CC_AUTOCONF_DEBUG: undefined },
      },
    );
    assert.equal(result.status, status, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.split(diagnostic).length - 1, visible ? 1 : 0, name);
    const probes = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(probes.length, invocations, name);
    if (visible) {
      assert.equal(
        probes[4],
        probes[2],
        'the diagnostic must replay the exact previously failed comparison',
      );
      assert.match(result.stderr, /EILSEQ.*can't be evaluated/u);
      assert.equal(
        existsSync(resultFile),
        false,
        'diagnostic replay must never admit the failed check',
      );
    } else {
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).success, success);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
