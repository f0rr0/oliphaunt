import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

export function runWorkflowLinters(root: string, tools: string[], capture = false) {
  assert.equal(tools.length, 3, 'Expected declared actionlint, zizmor and ShellCheck Files');
  const [actionlint, zizmor, shellcheck] = tools.map((file) => path.resolve(file));
  const workflows = readdirSync(path.join(root, '.github/workflows'))
    .filter((file) => /[.]ya?ml$/u.test(file))
    .sort()
    .map((file) => path.join(root, '.github/workflows', file));
  assert(workflows.length > 0, 'Workflow qualification needs declared workflow sources');
  const commands = [
    [
      actionlint,
      '-shellcheck',
      shellcheck,
      '-pyflakes',
      '',
      '-ignore',
      'unexpected key "queue" for "concurrency" section',
      ...workflows,
    ],
    [
      zizmor,
      '--offline',
      '--config',
      path.join(root, '.github/zizmor.yml'),
      '--min-severity',
      'medium',
      '--persona',
      'auditor',
      path.join(root, '.github/workflows'),
      path.join(root, '.github/actions'),
    ],
  ];
  for (const [binary, ...args] of commands) {
    const result = spawnSync(binary, args, {
      cwd: root,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: capture ? 'pipe' : 'inherit',
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    assert(
      result.status !== null && !result.signal,
      'Workflow linter terminated without an exit status',
    );
    if (result.status !== 0)
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

if (import.meta.main)
  process.exitCode = runWorkflowLinters(
    path.resolve(import.meta.dir, '../..'),
    Bun.argv.slice(2),
  ).status;
