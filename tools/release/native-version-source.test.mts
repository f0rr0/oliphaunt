import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertNativeVersionSourceTransition,
  collectNativeVersionUpdates,
  commitNativeVersionUpdates,
} from './native-version-source.mts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-version-source-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'generated versions',
    );
    return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  };
  git('init', '-q');
  writeFileSync(path.join(directory, 'package.json'), '{"version":"1.0.0"}\n');
  writeFileSync(path.join(directory, 'source.mts'), 'source unchanged\n');
  const source = commit();
  const collector = collectNativeVersionUpdates();
  const write = (file: string, contents: string) => {
    let before: Buffer | undefined;
    try {
      before = readFileSync(path.join(directory, file));
    } catch {}
    const after = Buffer.from(contents);
    writeFileSync(path.join(directory, file), after);
    collector.observe({ path: file, before, after });
  };
  return {
    directory,
    source,
    collector,
    write,
    commit,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('native commit includes only observed updates and leaves unrelated untracked diagnostics alone', () => {
  const f = fixture();
  try {
    f.write('package.json', '{"version":"1.0.1"}\n');
    f.write('CHANGELOG.md', 'generated notes\n');
    writeFileSync(path.join(f.directory, 'diagnostic.json'), 'private diagnostic\n');
    const bridge = f.collector.freeze(f.source);
    const source = commitNativeVersionUpdates(
      bridge,
      'chore(release): prepare main releases',
      f.directory,
    );
    expect(assertNativeVersionSourceTransition(bridge, source, f.directory).source).toEqual(source);
    const tracked = execFileSync('git', ['ls-files'], { cwd: f.directory, encoding: 'utf8' });
    expect(tracked).toContain('CHANGELOG.md');
    expect(tracked).not.toContain('diagnostic.json');
  } finally {
    f.cleanup();
  }
});

for (const fault of ['tracked', 'staged', 'writer-bytes', 'advanced-head'] as const)
  test(`native commit rejects ${fault} before staging generated outputs`, () => {
    const f = fixture();
    try {
      f.write('package.json', '{"version":"1.0.1"}\n');
      const bridge = f.collector.freeze(f.source);
      if (fault === 'tracked')
        writeFileSync(path.join(f.directory, 'source.mts'), 'ambient change\n');
      if (fault === 'staged') execFileSync('git', ['add', 'package.json'], { cwd: f.directory });
      if (fault === 'writer-bytes')
        writeFileSync(path.join(f.directory, 'package.json'), 'unexpected bytes\n');
      if (fault === 'advanced-head') f.commit();
      expect(() =>
        commitNativeVersionUpdates(bridge, 'chore(release): prepare main releases', f.directory),
      ).toThrow();
    } finally {
      f.cleanup();
    }
  });

test('promotion source is exactly the frozen RP and synchronization writes, including a new changelog written twice', () => {
  const f = fixture();
  try {
    f.write('package.json', '{"version":"1.0.1"}\n');
    f.write('CHANGELOG.md', 'first generated notes\n');
    f.write('CHANGELOG.md', 'final generated notes\n');
    const bridge = f.collector.freeze(f.source);
    expect(bridge.updates.find((row) => row.path === 'CHANGELOG.md')?.before).toBeUndefined();
    const after = f.commit();
    expect(assertNativeVersionSourceTransition(bridge, after, f.directory)).toEqual({
      source: after,
      updatesSha256: bridge.updatesSha256,
    });
    f.source.tree = 'f'.repeat(40);
    expect(bridge.source.tree).not.toBe(f.source.tree);
  } finally {
    f.cleanup();
  }
});

for (const fault of [
  'unrecorded-source',
  'generated-bytes',
  'mode',
  'original-bytes',
  'digest',
  'tree',
  'empty',
] as const)
  test(`source promotion rejects ${fault}`, () => {
    const f = fixture();
    try {
      f.write('package.json', '{"version":"1.0.1"}\n');
      const bridge = f.collector.freeze(f.source);
      if (fault === 'unrecorded-source')
        writeFileSync(path.join(f.directory, 'source.mts'), 'unreviewed source\n');
      if (fault === 'generated-bytes')
        writeFileSync(path.join(f.directory, 'package.json'), '{"version":"9.0.0"}\n');
      if (fault === 'mode') chmodSync(path.join(f.directory, 'package.json'), 0o755);
      const after = f.commit();
      if (fault === 'original-bytes') bridge.updates[0].before!.sha256 = 'f'.repeat(64);
      if (fault === 'digest') bridge.updatesSha256 = 'f'.repeat(64);
      if (fault === 'tree') after.tree = 'f'.repeat(40);
      if (fault === 'empty') bridge.updates = [];
      expect(() => assertNativeVersionSourceTransition(bridge, after, f.directory)).toThrow();
    } finally {
      f.cleanup();
    }
  });

test('the shared writer observer rejects a changed preimage or unsafe generated path', () => {
  const collector = collectNativeVersionUpdates();
  collector.observe({
    path: 'package.json',
    before: Buffer.from('old'),
    after: Buffer.from('new'),
  });
  expect(() =>
    collector.observe({
      path: 'package.json',
      before: Buffer.from('foreign'),
      after: Buffer.from('next'),
    }),
  ).toThrow(/preceding bytes/);
  expect(() => collector.observe({ path: '../source.mts', after: Buffer.from('next') })).toThrow(
    /safe repository path/,
  );
});
