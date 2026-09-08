import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('verification preserves receipt arguments and stops at the first failed gate', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-release-verification-'));
  const log = path.join(root, 'calls');
  const products = '["oliphaunt-js", "oliphaunt-rust"]';
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(import.meta.dir, '../..'),
    encoding: 'utf8',
  });
  expect(head.status).toBe(0);
  const headCommit = head.stdout.trim();
  writeFileSync(
    path.join(root, 'bun'),
    `#!/usr/bin/env bash
if [[ "\${1:-}" == --version ]]; then echo '${Bun.version}'; exit 0; fi
printf '%s\\0' "$@" >> "$CALL_LOG"
printf '\\n' >> "$CALL_LOG"
[ "$1" != "\${FAIL_GATE:-}" ] || exit 9
`,
    { mode: 0o755 },
  );
  const run = (script, args, fail = '') => {
    writeFileSync(log, '');
    const result = spawnSync('bash', [path.join(import.meta.dir, script), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        CALL_LOG: log,
        FAIL_GATE: fail,
      },
    });
    return {
      status: result.status,
      calls: readFileSync(log, 'utf8')
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\0').slice(0, -1)),
    };
  };
  try {
    const args = [
      '--products-json',
      products,
      '--head-ref',
      headCommit,
      '--publication-lock=lock file.json',
      '--registry-receipts',
      'registry file.json',
      '--github-release-receipt',
      'github file.json',
    ];
    const verified = run('release-verify.sh', args);
    expect(verified.status).toBe(0);
    expect(verified.calls[0]).toEqual([
      'tools/release/registry-integrity.mts',
      '--lock',
      'lock file.json',
      '--products-json',
      products,
      '--verify-receipts',
      'registry file.json',
      '--sealed-receipts',
    ]);
    expect(verified.calls[2]).toEqual([
      'tools/release/verify_github_release_attestations.mts',
      'finalize',
      '--publication-lock',
      'lock file.json',
      '--products-json',
      products,
      '--head-ref',
      headCommit,
      '--receipt',
      'github file.json',
    ]);
    for (const [index, call] of verified.calls.entries()) {
      const failed = run('release-verify.sh', args, call[0]);
      expect(failed.status).toBe(2);
      expect(failed.calls).toHaveLength(index + 1);
    }
    const incomplete = run('release-verify.sh', args.slice(0, -2));
    expect(incomplete.status).toBe(2);
    expect(incomplete.calls).toEqual([]);
    const registry = run('release-check-registries.sh', [
      '--products-json',
      products,
      '--require-identities',
    ]);
    expect(registry.status).toBe(0);
    expect(registry.calls[1]).toEqual([
      'tools/release/check_registry_publication.mts',
      '--products-json',
      products,
      '--require-identities',
    ]);
    const failed = run(
      'release-check-registries.sh',
      ['--products-json', products, '--require-identities'],
      registry.calls[0][0],
    );
    expect(failed.status).toBe(2);
    expect(failed.calls).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
