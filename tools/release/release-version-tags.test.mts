import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTagCommits, parseTagRefs } from '../../src/shared/product-metadata/git-tag-state.mts';
import { validateVersionTags } from './check_release_versions.mts';

test('Git snapshots preserve nested tags, reject reused versions, and bind SwiftPM tags to their source parent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-version-tags-'));
  const environment = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env: environment, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    git('commit', '--allow-empty', '-qm', 'first');
    const first = git('rev-parse', 'HEAD');
    git('tag', 'product-v0.1.0');
    git('tag', 'liboliphaunt-native-v0.1.0');
    git('commit', '--allow-empty', '-qm', 'release');
    const headCommit = git('rev-parse', 'HEAD');
    git('tag', '-a', 'inner', '-m', 'release');
    git('tag', '-a', 'product-v0.2.0', '-m', 'nested', 'inner');
    git('tag', 'oliphaunt-swift-v0.7.0');
    git('commit', '--allow-empty', '-qm', 'SwiftPM projection');
    git('tag', '-a', '0.7.0', '-m', 'SwiftPM');
    writeFileSync(path.join(root, 'blob'), 'payload');
    git('tag', 'product-v0.3.0', git('hash-object', '-w', 'blob'));
    mkdirSync(path.join(root, 'src/extensions/contrib'), { recursive: true });
    writeFileSync(path.join(root, 'src/extensions/contrib/carriers.toml'), 'fixture');
    git('add', 'src');
    git('commit', '-qm', 'add contrib carrier');
    git('tag', '-a', 'liboliphaunt-native-v0.2.0', '-m', 'with contrib');
    mkdirSync(path.join(root, 'tools/release'), { recursive: true });
    mkdirSync(path.join(root, 'tools/dev'), { recursive: true });
    copyFileSync(
      path.join(import.meta.dir, 'with-release-tags.sh'),
      path.join(root, 'tools/release/with-release-tags.sh'),
    );
    copyFileSync(
      path.join(import.meta.dir, 'check-release-versions.sh'),
      path.join(root, 'check.sh'),
    );
    writeFileSync(
      path.join(root, 'tools/dev/bun.sh'),
      `#!/usr/bin/env bash
set -eu
printf '%s' "$RELEASE_HEAD_COMMIT" > head
cp "$RELEASE_TAG_REFS" refs
cp "$RELEASE_TAG_COMMITS" commits
cp "$RELEASE_TAG_CONTRIB" contrib
`,
      { mode: 0o755 },
    );
    const checked = spawnSync('bash', [path.join(root, 'check.sh'), '--head-ref', headCommit], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...environment,
        PATH: `${root}${path.delimiter}${environment.PATH}`,
        RELEASE_HEAD_COMMIT: first,
      },
    });
    expect(checked.status, checked.stderr).toBe(0);
    const state = {
      headCommit: readFileSync(path.join(root, 'head'), 'utf8'),
      refs: parseTagRefs(readFileSync(path.join(root, 'refs'), 'utf8')),
      commits: parseTagCommits(readFileSync(path.join(root, 'commits'), 'utf8')),
    };
    expect(state.headCommit).toBe(headCommit);
    expect(readFileSync(path.join(root, 'contrib'), 'utf8').split('\0')).toEqual([
      'liboliphaunt-native-v0.1.0',
      'false',
      'liboliphaunt-native-v0.2.0',
      'true',
      '',
    ]);
    expect(validateVersionTags('product', '0.2.0', { tag_prefix: 'product-v' }, state)).toBe(true);
    expect(validateVersionTags('product', '0.4.0', { tag_prefix: 'product-v' }, state)).toBe(false);
    expect(() =>
      validateVersionTags('product', '0.1.5', { tag_prefix: 'product-v' }, state),
    ).toThrow('not newer');
    expect(() =>
      validateVersionTags(
        'product',
        '0.2.0',
        { tag_prefix: 'product-v' },
        { ...state, headCommit: first },
      ),
    ).toThrow('not exact release commit');
    expect(() =>
      validateVersionTags('product', '0.3.0', { tag_prefix: 'product-v' }, state),
    ).toThrow('not exact release commit');
    expect(
      validateVersionTags('oliphaunt-swift', '0.7.0', { tag_prefix: 'oliphaunt-swift-v' }, state),
    ).toBe(true);
    const wrongParent = {
      ...state,
      headCommit: first,
      refs: new Map(state.refs).set('refs/tags/oliphaunt-swift-v0.7.0', first),
    };
    expect(() =>
      validateVersionTags(
        'oliphaunt-swift',
        '0.7.0',
        { tag_prefix: 'oliphaunt-swift-v' },
        wrongParent,
      ),
    ).toThrow('source parent');
    expect(() => parseTagCommits(`${headCommit}\n${headCommit}\n`)).toThrow('repeated');
    expect(() => parseTagCommits('invalid')).toThrow('invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
