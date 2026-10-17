import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCommitHistory, readCommitPaths } from './commit-paths.mts';

const capture = path.join(import.meta.dir, 'snapshot-commit-paths.sh');
const historyWrapper = path.join(import.meta.dir, 'with-product-history.sh');
const bunWrapper = path.join(import.meta.dir, '../dev/bun.sh');

function run(
  command: string,
  args: string[],
  cwd: string,
  environment: Record<string, string> = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...environment,
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error ?? result.stderr}`);
  }
  return result.stdout.trim();
}

function repository(check: (root: string, git: (...args: string[]) => string) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-commit-paths-'));
  const git = (...args: string[]) => run('git', args, root);
  git('init', '-q', '-b', 'main');
  try {
    check(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('real Git capture preserves move-out, move-in, rename, deletion and unusual paths', () => {
  repository((root, git) => {
    const source = 'products/alpha/src/query.rs';
    const spaced = 'products/alpha/src/space name.rs';
    const newline = 'products/alpha/src/\nline\nname.rs';
    const leadingNewline = '\nroot\nname.rs';
    mkdirSync(path.join(root, 'products/alpha/src'), { recursive: true });
    for (const file of [source, spaced, newline, leadingNewline])
      writeFileSync(path.join(root, file), file);
    git('add', '.');
    git('commit', '-qm', 'feat: initial source');
    const initial = git('rev-parse', 'HEAD');
    mkdirSync(path.join(root, 'archive'));
    renameSync(path.join(root, source), path.join(root, 'archive/query.rs'));
    git('add', '-A');
    git('commit', '-qm', 'fix: move source outside product');
    const movedOut = git('rev-parse', 'HEAD');
    const movedInPath = 'products/alpha/src/moved.rs';
    renameSync(path.join(root, 'archive/query.rs'), path.join(root, movedInPath));
    git('add', '-A');
    git('commit', '-qm', 'fix: restore source into product');
    const movedIn = git('rev-parse', 'HEAD');
    const renamed = 'products/alpha/src/renamed.rs';
    renameSync(path.join(root, movedInPath), path.join(root, renamed));
    git('add', '-A');
    git('commit', '-qm', 'fix: rename source within product');
    const renamedCommit = git('rev-parse', 'HEAD');
    rmSync(path.join(root, renamed));
    git('add', '-A');
    git('commit', '-qm', 'fix: delete source');
    const deleted = git('rev-parse', 'HEAD');
    git('commit', '--allow-empty', '-qm', 'chore: empty commit');
    const empty = git('rev-parse', 'HEAD');
    const destination = path.join(root, 'capture');
    run('bash', [capture, root, empty, destination], root);
    expect(readCommitPaths(initial, destination).sort()).toEqual(
      [source, spaced, newline, leadingNewline].sort(),
    );
    expect(readCommitPaths(movedOut, destination).sort()).toEqual(
      [source, 'archive/query.rs'].sort(),
    );
    expect(readCommitPaths(movedIn, destination).sort()).toEqual(
      ['archive/query.rs', movedInPath].sort(),
    );
    expect(readCommitPaths(renamedCommit, destination).sort()).toEqual(
      [movedInPath, renamed].sort(),
    );
    expect(readCommitPaths(deleted, destination)).toEqual([renamed]);
    expect(readCommitPaths(empty, destination)).toEqual([]);
    expect(readCommitHistory(destination).head).toBe(empty);
    expect(readdirSync(destination).filter((file) => /^[0-9a-f]{40}$/.test(file))).toHaveLength(6);
  });
});

test('merge capture compares first parent and also records reachable branch commits', () => {
  repository((root, git) => {
    const dated = (date: string, ...args: string[]) =>
      run('git', args, root, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    writeFileSync(path.join(root, 'base.txt'), 'base');
    git('add', '.');
    dated('2020-01-01T00:00:00Z', 'commit', '-qm', 'feat: base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'branch');
    writeFileSync(path.join(root, 'branch.txt'), 'branch');
    git('add', '.');
    dated('2020-01-02T00:00:00Z', 'commit', '-qm', 'feat: branch');
    const branch = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    writeFileSync(path.join(root, 'main.txt'), 'main');
    git('add', '.');
    dated('2020-01-03T00:00:00Z', 'commit', '-qm', 'fix: main');
    const boundary = git('rev-parse', 'HEAD');
    dated('2020-01-04T00:00:00Z', 'merge', '--no-ff', '-qm', 'feat: merge branch', 'branch');
    const merge = git('rev-parse', 'HEAD');
    const destination = path.join(root, 'capture');
    run('bash', [capture, root, merge, destination], root);
    expect(readCommitPaths(merge, destination)).toEqual(['branch.txt']);
    expect(readCommitPaths(branch, destination)).toEqual(['branch.txt']);
    const history = readCommitHistory(destination);
    const after = history.after(boundary);
    expect([...after].sort()).toEqual([merge, branch].sort());
    expect(after.has(base)).toBe(false);
    expect(history.after(boundary)).toBe(after);
    expect(git('log', '--format=%H').split('\n')).toEqual([merge, boundary, branch, base]);
    expect([...history.commits]).toEqual([merge, boundary, branch, base]);
    expect(history.commits.size).toBe(4);
  });
});

test('captured ancestry excludes delivered ancestors even when Git emits them before the boundary', () => {
  repository((root, git) => {
    const dated = (date: string, ...args: string[]) =>
      run('git', args, root, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    git('commit', '--allow-empty', '-qm', 'chore: root');
    git('checkout', '-qb', 'branch');
    writeFileSync(path.join(root, 'branch.txt'), 'old branch');
    git('add', '.');
    dated('2020-01-10T00:00:00Z', 'commit', '-qm', 'feat: delivered branch');
    const delivered = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    dated('2020-01-02T00:00:00Z', 'commit', '--allow-empty', '-qm', 'chore: main');
    dated('2020-01-03T00:00:00Z', 'merge', '--no-ff', '-qm', 'Merge branch', 'branch');
    dated('2020-01-04T00:00:00Z', 'commit', '--allow-empty', '-qm', 'chore(release): alpha1.0.0');
    const boundary = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'branch');
    writeFileSync(path.join(root, 'branch.txt'), 'new branch');
    git('add', '.');
    dated('2020-01-20T00:00:00Z', 'commit', '-qm', 'feat: pending branch');
    const pending = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    dated('2020-01-21T00:00:00Z', 'merge', '--no-ff', '-qm', 'Merge branch again', 'branch');
    const head = git('rev-parse', 'HEAD');
    const order = git('log', '--format=%H').split('\n');
    expect(order.indexOf(delivered)).toBeLessThan(order.indexOf(boundary));
    const destination = path.join(root, 'capture');
    run('bash', [capture, root, head, destination], root);
    const history = readCommitHistory(destination);
    expect([...history.after(boundary)].sort()).toEqual([head, pending].sort());
    expect(history.after(boundary).has(delivered)).toBe(false);
  });
});

test('aggregate product history preserves both paths when source moves outside its owner', () => {
  repository((root, git) => {
    const source = 'products/alpha/src/query.rs';
    const moved = 'archive/query.rs';
    mkdirSync(path.join(root, 'products/alpha/src'), { recursive: true });
    writeFileSync(path.join(root, source), 'source');
    writeFileSync(path.join(root, 'products/alpha/VERSION'), '1.0.0');
    writeFileSync(
      path.join(root, 'release-please-config.json'),
      JSON.stringify({ packages: { 'products/alpha': { component: 'alpha' } } }),
    );
    writeFileSync(
      path.join(root, '.release-please-manifest.json'),
      JSON.stringify({ 'products/alpha': '1.0.0' }),
    );
    git('add', '.');
    git('commit', '-qm', 'feat: initial product');
    git('tag', 'alpha-v1.0.0');
    git('config', 'diff.renames', 'true');
    mkdirSync(path.join(root, 'archive'));
    renameSync(path.join(root, source), path.join(root, moved));
    git('add', '-A');
    git('commit', '-qm', 'fix: move source outside owner');
    const graph = path.join(root, 'graph.json');
    writeFileSync(
      graph,
      JSON.stringify({
        products: {
          alpha: {
            path: 'products/alpha',
            version: '1.0.0',
            tag_prefix: 'alpha-v',
            version_files: ['products/alpha/VERSION'],
          },
        },
      }),
    );
    const check = path.join(root, 'check.mts');
    writeFileSync(
      check,
      `import { historyChanges } from ${JSON.stringify(path.join(import.meta.dir, 'release-history.mts'))};\nconsole.log(JSON.stringify(historyChanges(process.argv[2], 'alpha-v1.0.0', 'HEAD')));\n`,
    );
    const result = run(
      'bash',
      [historyWrapper, root, 'HEAD', '', graph, 'bash', bunWrapper, check, root],
      root,
    );
    expect(JSON.parse(result).sort()).toEqual([source, moved].sort());
  });
});

test('capture rejects shallow history and preserves an existing destination', () => {
  repository((root, git) => {
    git('commit', '--allow-empty', '-qm', 'chore: root');
    git('commit', '--allow-empty', '-qm', 'chore: head');
    const destination = path.join(root, 'capture');
    mkdirSync(destination);
    writeFileSync(path.join(destination, 'keep'), 'existing');
    const existing = spawnSync('bash', [capture, root, 'HEAD', destination], { encoding: 'utf8' });
    expect(existing.status).not.toBe(0);
    expect(existsSync(path.join(destination, 'keep'))).toBe(true);
    const clone = path.join(root, 'shallow');
    run('git', ['clone', '-q', '--depth=1', `file://${root}`, clone], root);
    const failedDestination = path.join(root, 'failed');
    const shallow = spawnSync('bash', [capture, clone, 'HEAD', failedDestination], {
      encoding: 'utf8',
    });
    expect(shallow.status).not.toBe(0);
    expect(shallow.stderr).toContain('complete Git history');
    expect(existsSync(failedDestination)).toBe(false);
  });
});

test('reader rejects missing, malformed and truncated captured records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-commit-reader-'));
  const sha = 'a'.repeat(40);
  try {
    expect(() => readCommitPaths('../unsafe', directory)).toThrow('exact SHA');
    expect(() => readCommitPaths(sha, directory)).toThrow();
    writeFileSync(path.join(directory, sha), 'products/alpha/src/query.rs');
    expect(() => readCommitPaths(sha, directory)).toThrow('incomplete');
    writeFileSync(path.join(directory, sha), '../outside\0');
    expect(() => readCommitPaths(sha, directory)).toThrow('unsafe');
    writeFileSync(path.join(directory, sha), 'file\0file\0');
    expect(() => readCommitPaths(sha, directory)).toThrow('duplicate');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ancestry reader rejects incomplete, duplicate and unrelated records', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-commit-ancestry-'));
  const sha = 'a'.repeat(40);
  const parent = 'b'.repeat(40);
  const ledger = path.join(directory, '.parents');
  try {
    writeFileSync(ledger, `head ${sha}\n${sha} ${parent}\n`);
    expect(() => readCommitHistory(directory)).toThrow(`missing ${parent}`);
    writeFileSync(ledger, `head ${sha}\n${sha}\n${sha}\n`);
    expect(() => readCommitHistory(directory)).toThrow('duplicate');
    writeFileSync(ledger, `head ${sha}\n${sha}\n${parent}\n`);
    expect(() => readCommitHistory(directory)).toThrow('outside its head');
    writeFileSync(ledger, `head ${sha}\n${sha}`);
    expect(() => readCommitHistory(directory)).toThrow('incomplete');
    writeFileSync(ledger, `head ${sha}\n${sha}\n`);
    expect(() => readCommitHistory(directory).after(parent)).toThrow(`missing ${parent}`);
    expect(() => readCommitHistory(directory).after('')).toThrow('missing');
    expect(readCommitHistory(directory).after().size).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
