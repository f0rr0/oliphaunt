import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { currentProductVersionSync } from '../../src/shared/product-metadata/release-artifact-targets.mts';
import { inspectSwiftpmRemoteTag } from './publish_swiftpm_source_tag.mts';
import releaseBot from './release-bot.json' with { type: 'json' };

const script = path.join(import.meta.dir, 'publish-swiftpm-source-tag.sh');
const version = currentProductVersionSync('oliphaunt-swift', 'SwiftPM fixture');
const ref = 'refs/tags/' + version;
const environment = {
  ...process.env,
  GITHUB_ACTIONS: 'false',
  GITHUB_SHA: '',
  OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: '',
  REGISTRY_JOB_HARD_DEADLINE_EPOCH: '',
};
function git(root, args, env = environment) {
  const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test('real SwiftPM Shell preserves deterministic trees, preflight, resumption and one-push reconciliation', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'swiftpm-shell.'));
  const root = path.join(scratch, 'repo');
  const remote = path.join(scratch, 'remote');
  mkdirSync(root);
  mkdirSync(remote);
  const invoke = (args = [], env = {}) =>
    spawnSync(
      'bash',
      [
        script,
        '--target',
        'HEAD',
        '--manifest',
        'Package.swift.release',
        '--include-tree',
        'frozen-tree',
        ...args,
      ],
      { cwd: root, env: { ...environment, ...env }, encoding: 'utf8', timeout: 20000 },
    );
  const pass = (result) => {
    expect(result.stderr).not.toContain('error:');
    expect(result.status).toBe(0);
  };
  try {
    git(root, ['init', '-q']);
    git(remote, ['init', '-q', '--bare']);
    git(root, ['remote', 'add', 'origin', remote]);
    git(root, ['config', 'user.name', 'fixture']);
    git(root, ['config', 'user.email', 'fixture@example.invalid']);
    mkdirSync(path.join(root, 'Sources'));
    writeFileSync(path.join(root, 'Package.swift'), '// development manifest\n');
    writeFileSync(path.join(root, 'Sources/Base.swift'), 'public let base = true\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'release source'], {
      ...environment,
      GIT_AUTHOR_DATE: '1700000000 +0000',
      GIT_COMMITTER_DATE: '1700000000 +0000',
    });
    const source = git(root, ['rev-parse', 'HEAD']);
    const manifest =
      '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Oliphaunt", targets: [\n  .binaryTarget(name: "COliphaunt", url: "https://example.invalid/liboliphaunt-native-v0.1.0/apple-spm-xcframework.zip", checksum: "abc")\n])\n';
    writeFileSync(path.join(root, 'Package.swift.release'), manifest);
    mkdirSync(path.join(root, 'frozen-tree/generated/swiftpm'), { recursive: true });
    const frozen = path.join(root, 'frozen-tree/generated/swiftpm/Frozen.swift');
    writeFileSync(frozen, 'public let frozen = true\n');
    const index = readFileSync(path.join(root, '.git/index'));
    pass(invoke(['--preflight']));
    expect(git(root, ['tag', '--list', version])).toBe('');
    expect(git(root, ['ls-remote', '--refs', '--tags', 'origin', ref])).toBe('');
    pass(
      invoke([], {
        GIT_AUTHOR_DATE: '946684800 +0000',
        GIT_COMMITTER_DATE: '946684800 +0000',
        GIT_AUTHOR_NAME: 'ambient',
      }),
    );
    const first = git(root, ['rev-parse', ref]);
    expect(git(root, ['show', '-s', '--format=%P', first])).toBe(source);
    expect(git(root, ['show', first + ':Package.swift'])).toBe(manifest.trim());
    expect(git(root, ['show', first + ':Sources/Base.swift'])).toBe('public let base = true');
    expect(git(root, ['show', first + ':generated/swiftpm/Frozen.swift'])).toBe(
      'public let frozen = true',
    );
    expect(git(root, ['show', '-s', '--format=%an <%ae>', first])).toBe(
      'oliphaunt-release-bot <oliphaunt-release-bot@users.noreply.github.com>',
    );
    expect(readFileSync(path.join(root, '.git/index'))).toEqual(index);
    git(root, ['tag', '-d', version]);
    pass(
      invoke([], { GIT_AUTHOR_DATE: '1893456000 +0000', GIT_COMMITTER_DATE: '1893456000 +0000' }),
    );
    expect(git(root, ['rev-parse', ref])).toBe(first);
    pass(invoke());

    // The real push applies to a private bare repository, then loses its response.
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const log = path.join(scratch, 'pushes');
    writeFileSync(
      path.join(bin, 'git'),
      '#!/usr/bin/env bash\nif [[ "$1" == push ]]; then\n echo push >> "$SWIFT_PUSH_LOG"\n "$SWIFT_REAL_GIT" "$@"\n exit 7\nfi\nexec "$SWIFT_REAL_GIT" "$@"\n',
      { mode: 0o755 },
    );
    const pushEnv = {
      PATH: bin + path.delimiter + process.env.PATH,
      SWIFT_REAL_GIT: realGit,
      SWIFT_PUSH_LOG: log,
    };
    const denied = invoke(['--push'], {
      ...pushEnv,
      REGISTRY_JOB_HARD_DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 90),
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('requires two complete');
    expect(git(root, ['ls-remote', '--refs', '--tags', 'origin', ref])).toBe('');
    const pushed = invoke(['--push'], pushEnv);
    pass(pushed);
    expect(pushed.stdout).toContain('failure reconciled');
    expect(readFileSync(log, 'utf8')).toBe('push\n');
    expect(git(root, ['ls-remote', '--refs', '--tags', 'origin', ref])).toBe(first + '\t' + ref);
    git(root, ['tag', '-d', version]);
    pass(invoke(['--preflight']));
    expect(git(root, ['tag', '--list', version])).toBe('');
    pass(invoke());
    writeFileSync(frozen, 'public let frozen = false\n');
    expect(invoke().status).not.toBe(0);
    expect(invoke(['--preflight']).status).not.toBe(0);
    expect(git(root, ['rev-parse', ref])).toBe(first);
    writeFileSync(frozen, 'public let frozen = true\n');

    // Identity comes from the source commit, including during controller repairs.
    mkdirSync(path.join(root, 'tools/release'), { recursive: true });
    const identity = path.join(root, 'tools/release/release-bot.json');
    writeFileSync(identity, JSON.stringify(releaseBot));
    git(root, ['add', 'tools/release/release-bot.json']);
    git(root, ['commit', '-qm', 'configure App identity']);
    git(root, ['tag', '-d', version]);
    writeFileSync(identity, 'invalid ambient identity');
    pass(invoke());
    expect(git(root, ['show', '-s', '--format=%an <%ae>', ref])).toBe(
      releaseBot.name + ' <' + releaseBot.email + '>',
    );
    expect(invoke(['--preflight', '--push']).status).not.toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30000);

test('SwiftPM reconciliation accepts only a complete single exact remote ref', () => {
  const sha = 'a'.repeat(40);
  const exact = sha + '\t' + ref + '\n';
  expect(inspectSwiftpmRemoteTag(exact, version, sha)).toBe('exact');
  expect(inspectSwiftpmRemoteTag('', version, sha, { allowMissing: true })).toBe('absent');
  for (const text of [
    '',
    exact.trim(),
    exact + exact,
    exact.replace(sha, 'b'.repeat(40)),
    'not-a-sha\t' + ref + '\n',
  ]) {
    expect(() => inspectSwiftpmRemoteTag(text, version, sha)).toThrow();
  }
});
