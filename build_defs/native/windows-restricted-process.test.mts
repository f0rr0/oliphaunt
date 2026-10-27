import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

if (process.argv[2] === '--child') {
  const input = await Bun.stdin.text();
  await Bun.write(Bun.stdout, JSON.stringify({ input, args: process.argv.slice(3) }));
  await Bun.write(Bun.stderr, 'restricted child stderr\n');
  process.exit(7);
}

assert.equal(process.platform, 'win32');
const [source] = process.argv.slice(2);
assert(source);
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'restricted-process-'));
try {
  const directory = join(root, 'launcher with spaces');
  mkdirSync(directory);
  const launcher = join(directory, 'restricted process.exe');
  const child = join(root, 'child script with spaces.mts');
  copyFileSync(source, launcher);
  copyFileSync(import.meta.path, child);
  const systemRoot = Object.entries(process.env).find(
    ([name]) => name.toLowerCase() === 'systemroot',
  )?.[1];
  assert(systemRoot && win32.isAbsolute(systemRoot));
  const env = {
    SystemRoot: systemRoot,
    PATH: [win32.join(systemRoot, 'System32'), systemRoot].join(';'),
    TEMP: root,
    TMP: root,
  };
  const args = [
    'argument with spaces',
    'quote "inside"',
    'backslash before quote \\"',
    'trailing backslash \\',
    'Unicode Ω-é-雪',
  ];
  const input = 'restricted pipe input Ω-é-雪\n';
  for (const stdin of [Buffer.from(input), 'ignore'] as const) {
    const result = Bun.spawnSync(
      [launcher, process.execPath, '--no-install', '--no-env-file', child, '--child', ...args],
      {
        cwd: root,
        env,
        stdin,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
      },
    );
    assert.equal(result.exitCode, 7, text(result.stderr));
    assert.deepEqual(JSON.parse(text(result.stdout)), {
      input: stdin === 'ignore' ? '' : input,
      args,
    });
    assert.equal(text(result.stderr), 'restricted child stderr\n');
  }
  const empty = Bun.spawnSync([launcher], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(empty.exitCode, 2);
  const missing = Bun.spawnSync([launcher, join(root, 'missing program.exe')], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  });
  assert.equal(missing.exitCode, 1);
  assert.match(text(missing.stderr), /restricted process launch failed: Windows error \d+/u);
  console.log(
    'Restricted process: pipe and ignored stdin, stdout, stderr, Unicode/quoted argv, exit status and missing program PASS',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
