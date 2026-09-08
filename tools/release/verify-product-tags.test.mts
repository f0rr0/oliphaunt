import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const verifier = path.join(import.meta.dir, 'verify-product-tags.sh');
test('release tags follow the remote, peel annotated commits, and fail closed on drift', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-product-tags-'));
  const remote = `${root}-remote`;
  const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const git = (...args) => {
    const result = run('git', args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const check = (...args) => run('bash', [verifier, '--target', 'HEAD', ...args]);
  try {
    git('init', '--quiet');
    git('init', '--quiet', '--bare', remote);
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('remote', 'add', 'origin', remote);
    writeFileSync(
      path.join(root, 'release-please-config.json'),
      JSON.stringify({
        'include-v-in-tag': true,
        'tag-separator': '-',
        packages: {
          '.': { component: 'fixture', 'release-type': 'simple', 'version-file': 'VERSION' },
        },
      }),
    );
    writeFileSync(path.join(root, 'VERSION'), '1.2.3\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    const release = git('rev-parse', 'HEAD');
    expect(check('fixture').status).not.toBe(0);
    expect(check('--allow-missing', 'fixture').status).toBe(0);
    const tag = 'fixture-v1.2.3';
    git('tag', '-a', tag, '-m', 'release');
    expect(check('fixture').status).not.toBe(0); // Local tags cannot override remote absence.
    git('push', '--quiet', 'origin', `refs/tags/${tag}`);
    expect(check('--products-json', '["fixture","fixture"]').status).toBe(0);
    git('commit', '--quiet', '--allow-empty', '-m', 'next');
    expect(check('--allow-missing', 'fixture').status).not.toBe(0);
    git('tag', '-f', tag);
    git('push', '--quiet', '--force', 'origin', `refs/tags/${tag}`);
    git('tag', '-f', tag, release); // Stale local tag must be refreshed.
    const refreshed = check('fixture');
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(git('rev-parse', `refs/tags/${tag}`)).toBe(git('rev-parse', 'HEAD'));
    git('tag', '-f', tag, git('rev-parse', 'HEAD:VERSION'));
    git('push', '--quiet', '--force', 'origin', `refs/tags/${tag}`);
    expect(check('--allow-missing', 'fixture').status).not.toBe(0); // Blob tags are not absence.
    expect(check('--products-json', '[]').status).not.toBe(0);
    expect(check('--products-json', '["$(touch injected)"]').status).not.toBe(0);
    git('remote', 'remove', 'origin');
    git('tag', '-f', tag);
    expect(check('fixture').status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
