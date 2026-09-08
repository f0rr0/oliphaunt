import { tarArchive } from '../../../tools/test/tar-fixture.mts';
import { zipArchive } from '../../../tools/test/zip-fixture.mts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertHttpsUrl,
  canonicalGnuArchiveFallbackUrl,
  promotePathTransactional,
  sameDirectoryIdentity,
  sha256File,
  validateSource,
} from './source-fetch-core.mts';

const archiveTool = path.join(import.meta.dirname, 'source-archive.mts');
const treeVerifier = path.join(import.meta.dirname, 'verify-source-tree.mts');

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeRoot(label) {
  return mkdtempSync(path.join(os.tmpdir(), `oliphaunt-${label}-`));
}

function directoryMetadata(dev, ino, isDirectory = true) {
  return { dev, ino, isDirectory: () => isDirectory };
}

test('directory identity accepts Windows short and long aliases for the same filesystem object', () => {
  const shortPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\checkout`;
  const longPath = String.raw`C:\Users\runneradmin\AppData\Local\Temp\checkout`;
  const metadata = new Map([
    [shortPath, directoryMetadata(17n, 42n)],
    [longPath, directoryMetadata(17n, 42n)],
  ]);

  assert.equal(
    sameDirectoryIdentity(shortPath, longPath, {
      stat: (candidate) => metadata.get(candidate),
    }),
    true,
  );
});

test('directory identity rejects different filesystem objects', () => {
  assert.equal(
    sameDirectoryIdentity('/expected', '/external', {
      stat: (candidate) =>
        candidate === '/expected' ? directoryMetadata(17n, 42n) : directoryMetadata(17n, 43n),
    }),
    false,
  );
});

test('directory identity rejects unavailable or partial filesystem identifiers', () => {
  const identities = [
    [directoryMetadata(0n, 0n), directoryMetadata(0n, 0n)],
    [directoryMetadata(17n, 0n), directoryMetadata(17n, 0n)],
    [directoryMetadata(0n, 42n), directoryMetadata(0n, 42n)],
    [directoryMetadata(17n, 42n), directoryMetadata(0n, 42n)],
  ];
  for (const [left, right] of identities) {
    assert.equal(
      sameDirectoryIdentity('/left', '/right', {
        stat: (candidate) => (candidate === '/left' ? left : right),
      }),
      false,
    );
  }
});

test('directory identity rejects a matching inode on a different device', () => {
  assert.equal(
    sameDirectoryIdentity('/left', '/right', {
      stat: (candidate) =>
        candidate === '/left' ? directoryMetadata(17n, 42n) : directoryMetadata(18n, 42n),
    }),
    false,
  );
});

test('directory identity rejects non-directories and propagates stat errors', () => {
  assert.equal(
    sameDirectoryIdentity('/directory', '/file', {
      stat: (candidate) =>
        directoryMetadata(17n, candidate === '/directory' ? 42n : 43n, candidate === '/directory'),
    }),
    false,
  );
  assert.throws(
    () =>
      sameDirectoryIdentity('/missing', '/expected', {
        stat: () => {
          throw new Error('stat failed');
        },
      }),
    /stat failed/u,
  );
});

function createTarFixtures(root) {
  const directory = { name: 'pkg/', type: '5', mode: 0o755, data: '' };
  const file = { name: 'pkg/file.txt', data: 'trusted bytes', v7: true };
  const link = (name, linkTarget, type = '2') => ({ name, linkTarget, type, data: '' });
  const fixtures = {
    valid: [
      directory,
      file,
      link('pkg/link.txt', 'file.txt'),
      link('pkg/hard.txt', 'pkg/file.txt', '1'),
    ],
    updated: [directory, { name: 'pkg/file.txt', data: 'updated trusted bytes' }],
    traversal: [{ name: 'pkg/../../escape' }],
    absolute: [{ name: '/tmp/escape' }],
    'outside-prefix': [{ name: 'other/file' }],
    backslash: [{ name: 'pkg\\escape' }],
    duplicate: [{ name: 'pkg/file' }, { name: 'pkg/file', data: 'second' }],
    'case-collision': [{ name: 'pkg/File' }, { name: 'pkg/file', data: 'second' }],
    'windows-ads': [{ name: 'pkg/file:stream' }],
    'windows-device': [{ name: 'pkg/CON.txt' }],
    'escaping-symlink': [link('pkg/link', '../../escape')],
    'dangling-symlink': [link('pkg/link', 'missing')],
    'escaping-hardlink': [link('pkg/link', '../../escape', '1')],
    fifo: [{ name: 'pkg/fifo', type: '6', data: '' }],
    'reserved-git': [{ name: 'pkg/.git/config' }],
    'reserved-stamp': [{ name: 'pkg/.oliphaunt-source-pin' }],
    'symlink-ancestor': [
      { name: 'pkg/dir/', type: '5', mode: 0o755, data: '' },
      link('pkg/link', 'dir'),
      { name: 'pkg/link/child' },
    ],
    huge: [{ name: 'pkg/huge', size: 3 * 1024 ** 3 }],
  };
  for (const [name, entries] of Object.entries(fixtures))
    writeFileSync(path.join(root, name + '.tar.gz'), tarArchive(entries));
}

function validateArchive(archive) {
  return spawnSync(process.execPath, [archiveTool, 'validate', archive, 'pkg'], {
    encoding: 'utf8',
  });
}

function createZipFixtures(root) {
  const ntfs = Buffer.alloc(36);
  ntfs.writeUInt16LE(0x000a, 0);
  ntfs.writeUInt16LE(32, 2);
  ntfs.writeUInt16LE(1, 8);
  ntfs.writeUInt16LE(24, 10);
  writeFileSync(
    path.join(root, 'valid.zip'),
    zipArchive([
      { name: 'LICENSE', data: 'license\n', centralExtra: ntfs, localExtra: ntfs },
      { name: 'payload/data.bin', data: 'trusted bytes' },
    ]),
  );
  writeFileSync(path.join(root, 'traversal.zip'), zipArchive([{ name: '../escape' }]));
  writeFileSync(
    path.join(root, 'symlink.zip'),
    zipArchive([{ name: 'link', externalAttributes: 0o120777 << 16, data: 'payload/data.bin' }]),
  );
}

function validateZipArchive(archive) {
  return spawnSync(process.execPath, [archiveTool, 'validate', archive, '.'], { encoding: 'utf8' });
}

function archiveSource(fixture, name = 'fixture') {
  const sha256 = sha256File(fixture);
  return {
    name,
    kind: 'archive',
    url: `https://example.invalid/${name}.tar.gz`,
    branch: 'archive-1.0',
    commit: sha256,
    sha256,
    stripPrefix: 'pkg',
  };
}

function gnuArchiveSource(fixture) {
  return {
    ...archiveSource(fixture, 'libiconv'),
    url: 'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz',
  };
}

function writeArchiveManifest(manifestPath, source) {
  writeFileSync(
    manifestPath,
    `name = "${source.name}"\nkind = "archive"\nurl = "${source.url}"\nbranch = "${source.branch}"\ncommit = "${source.commit}"\nsha256 = "${source.sha256}"\nstrip_prefix = "${source.stripPrefix}"\n`,
  );
}

function initializeGitRepository(repository, contents, branch = 'old') {
  mkdirSync(repository, { recursive: true });
  command('git', ['init', '--quiet', `--initial-branch=${branch}`], { cwd: repository });
  command('git', ['config', 'user.name', 'Source Fetch Test'], { cwd: repository });
  command('git', ['config', 'user.email', 'source-fetch@example.invalid'], { cwd: repository });
  writeFileSync(path.join(repository, 'source.txt'), contents);
  command('git', ['add', 'source.txt'], { cwd: repository });
  command('git', ['commit', '--quiet', '-m', 'test source'], { cwd: repository });
  return command('git', ['rev-parse', 'HEAD'], { cwd: repository });
}

test('archive validator extracts only the declared safe root', () => {
  const root = makeRoot('source-archive-valid');
  try {
    createTarFixtures(root);
    const archive = path.join(root, 'valid.tar.gz');
    assert.equal(validateArchive(archive).status, 0);
    const destination = path.join(root, 'out');
    const extraction = spawnSync(
      process.execPath,
      [archiveTool, 'extract', archive, 'pkg', destination],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.equal(readFileSync(path.join(destination, 'file.txt'), 'utf8'), 'trusted bytes');
    assert.equal(readFileSync(path.join(destination, 'link.txt'), 'utf8'), 'trusted bytes');
    assert.equal(readFileSync(path.join(destination, 'hard.txt'), 'utf8'), 'trusted bytes');
    assert.equal(existsSync(path.join(destination, 'pkg')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZIP source validator extracts a safe rootless release and rejects unsafe members', () => {
  const root = makeRoot('source-zip-valid');
  try {
    createZipFixtures(root);
    const archive = path.join(root, 'valid.zip');
    assert.equal(validateZipArchive(archive).status, 0);
    const destination = path.join(root, 'out');
    const extraction = spawnSync(
      process.execPath,
      [archiveTool, 'extract', archive, '.', destination],
      { encoding: 'utf8' },
    );
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.equal(readFileSync(path.join(destination, 'payload/data.bin'), 'utf8'), 'trusted bytes');
    assert.notEqual(validateZipArchive(path.join(root, 'traversal.zip')).status, 0);
    assert.notEqual(validateZipArchive(path.join(root, 'symlink.zip')).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive validator rejects traversal, unsafe links and types, duplicates, reserved paths, and expansion abuse', {
  timeout: 30_000,
}, () => {
  const root = makeRoot('source-archive-adversarial');
  try {
    createTarFixtures(root);
    for (const name of [
      'traversal',
      'absolute',
      'outside-prefix',
      'backslash',
      'duplicate',
      'case-collision',
      'windows-ads',
      'windows-device',
      'escaping-symlink',
      'dangling-symlink',
      'escaping-hardlink',
      'fifo',
      'reserved-git',
      'reserved-stamp',
      'symlink-ancestor',
      'huge',
    ]) {
      const archive = path.join(root, `${name}.tar.gz`);
      const validation = validateArchive(archive);
      assert.notEqual(validation.status, 0, `${name} unexpectedly passed validation`);
      const destination = path.join(root, `out-${name}`);
      const extraction = spawnSync(
        process.execPath,
        [archiveTool, 'extract', archive, 'pkg', destination],
        {
          encoding: 'utf8',
        },
      );
      assert.notEqual(extraction.status, 0, `${name} unexpectedly extracted`);
      assert.equal(existsSync(destination), false, `${name} left a partial destination`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transactional promotion restores the prior destination on a normal failure', () => {
  const root = makeRoot('source-promotion');
  try {
    const destination = path.join(root, 'live');
    const candidate = path.join(root, 'candidate');
    mkdirSync(destination);
    mkdirSync(candidate);
    writeFileSync(path.join(destination, 'value'), 'old');
    writeFileSync(path.join(candidate, 'value'), 'new');
    assert.throws(
      () =>
        promotePathTransactional(candidate, destination, {
          afterBackup: () => {
            throw new Error('fault');
          },
        }),
      /fault/u,
    );
    assert.equal(readFileSync(path.join(destination, 'value'), 'utf8'), 'old');
    assert.equal(readFileSync(path.join(candidate, 'value'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(root).sort(), ['candidate', 'live']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Exercise the production Shell entry points. Only network transport and retry
// delays are substituted; archives, Git repositories, and promotion are real.
function runFetch(root, source, options = {}) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['git', 'curl', 'sleep']) {
    writeFileSync(
      path.join(bin, name),
      readFileSync(path.join(import.meta.dirname, 'source-fetch-transport.test.sh')),
      { mode: 0o755 },
    );
  }
  const pin = path.join(root, 'pin.json');
  writeFileSync(pin, JSON.stringify(source));
  return spawnSync(
    'bash',
    [
      '-c',
      'source "$1"; fetch_source "$2" "$3" "$4" "$5"',
      'source-fetch-test',
      path.join(import.meta.dirname, 'fetch-sources.sh'),
      pin,
      path.join(root, 'checkouts'),
      path.join(root, 'archives'),
      options.mode ?? 'fetch',
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + process.env.PATH,
        FETCH_TEST_ROOT: root,
        FETCH_TEST_GIT: command('bash', ['-c', 'command -v git']),
        FETCH_TEST_UPSTREAM: path.join(root, 'upstream'),
        FETCH_TEST_ARCHIVE: options.archive ?? '',
        FETCH_TEST_FAULT: options.fault ?? '',
        FETCH_TEST_COMMIT: options.commit ?? '',
        ...options.env,
      },
    },
  );
}
function passed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function failed(result, pattern) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}
function lines(root, file = 'requests') {
  const p = path.join(root, file);
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
}
function gitSource(commit) {
  return {
    name: 'source',
    kind: 'git',
    url: 'https://primary.example.invalid/source.git',
    mirrorUrl: 'https://mirror.example.invalid/source.git',
    branch: 'pinned',
    commit,
  };
}

test('source pins reject unsafe URLs, branches, names, and archive mirrors', () => {
  const source = gitSource('1'.repeat(40));
  for (const url of [
    'http://example.test/source',
    'https://user:secret@example.test/source',
    'https://example.test\\source',
    'https://example.test/source#fragment',
  ]) {
    assert.throws(() => assertHttpsUrl(url));
    assert.throws(() => validateSource({ ...source, mirrorUrl: url }));
  }
  assert.throws(() => validateSource({ ...source, mirrorUrl: source.url }));
  for (const branch of ['--config', 'a..b', 'a.lock', 'a\nb', '/a'])
    assert.throws(() => validateSource({ ...source, branch }));
  for (const name of ['../outside', '/absolute', 'bad\\name'])
    assert.throws(() => validateSource({ ...source, name }));
  assert.throws(() =>
    validateSource({ ...source, kind: 'archive', sha256: '1'.repeat(64), stripPrefix: 'pkg' }),
  );
  for (const url of [
    'https://example.invalid/libiconv/libiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/nested/libiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.tar.gz?mutable=1',
    'https://ftpmirror.gnu.org/libiconv/%6cibiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/../libiconv-1.19.tar.gz',
    'https://ftpmirror.gnu.org/libiconv/libiconv-1.19.zip',
  ]) {
    assert.equal(canonicalGnuArchiveFallbackUrl(url), undefined);
  }
});

test('Shell archive fetch preserves corrupt cache on failures, verifies fallback bytes, and replaces only clean managed trees', () => {
  const root = makeRoot('shell-archive');
  try {
    createTarFixtures(root);
    const archive = path.join(root, 'valid.tar.gz');
    const source = gnuArchiveSource(archive);
    const checkout = path.join(root, 'checkouts', source.name);
    const cache = path.join(root, 'archives', source.name + '-' + source.sha256 + '.tar.gz');
    mkdirSync(path.dirname(cache));
    writeFileSync(cache, 'prior cache');
    failed(
      runFetch(root, source, { fault: 'all' }),
      /transport fault: https:\/\/ftp.gnu.org.*transport fault: https:\/\/ftpmirror.gnu.org/s,
    );
    assert.equal(readFileSync(cache, 'utf8'), 'prior cache');
    assert.equal(existsSync(checkout), false);
    failed(
      runFetch(root, source, { archive: path.join(root, 'updated.tar.gz'), fault: 'primary' }),
      /archive sha256: expected/,
    );
    assert.equal(readFileSync(cache, 'utf8'), 'prior cache');
    writeFileSync(path.join(root, 'requests'), '');
    passed(runFetch(root, source, { archive, fault: 'primary', env: { RUNNER_OS: 'Windows' } }));
    assert.deepEqual(lines(root), [
      'https://ftp.gnu.org/gnu/libiconv/libiconv-1.19.tar.gz',
      source.url,
    ]);
    assert.equal(sha256File(cache), source.sha256);
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'trusted bytes');
    assert.match(
      readFileSync(path.join(checkout, '.oliphaunt-source-pin'), 'utf8'),
      /url=https:\/\/ftpmirror.gnu.org\//,
    );
    passed(runFetch(root, source, { mode: 'verify', fault: 'all' }));
    const manifest = path.join(root, 'source.toml');
    writeArchiveManifest(manifest, source);
    passed(
      spawnSync(process.execPath, [treeVerifier, '--checkout', checkout, '--manifest', manifest], {
        encoding: 'utf8',
      }),
    );
    // Unsafe replacement must preserve the previous checkout, even when its
    // checksum is correctly pinned to the malicious bytes.
    const unsafeArchive = path.join(root, 'traversal.tar.gz');
    failed(
      runFetch(
        root,
        { ...source, ...archiveSource(unsafeArchive, source.name) },
        { archive: unsafeArchive },
      ),
      /traversal|unsafe|escape/,
    );
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'trusted bytes');
    const updated = path.join(root, 'updated.tar.gz');
    const next = archiveSource(updated, source.name);
    passed(runFetch(root, next, { archive: updated }));
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'updated trusted bytes');
    writeFileSync(path.join(checkout, 'file.txt'), 'local edit');
    failed(runFetch(root, next, { mode: 'verify' }), /was modified/);
    failed(runFetch(root, source, { archive }), /was modified/);
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'local edit');
    assert.deepEqual(readdirSync(path.dirname(checkout)), [source.name]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Shell fetch materializes rootless ZIP and refuses unmanaged source directories', () => {
  const root = makeRoot('shell-zip');
  try {
    createZipFixtures(root);
    const archive = path.join(root, 'valid.zip'),
      sha256 = sha256File(archive);
    const source = {
      ...archiveSource(archive),
      url: 'https://example.invalid/release.zip',
      sha256,
      commit: sha256,
      stripPrefix: '.',
    };
    const checkout = path.join(root, 'checkouts', source.name);
    mkdirSync(checkout, { recursive: true });
    writeFileSync(path.join(checkout, 'local'), 'keep');
    failed(runFetch(root, source, { archive }), /is unmanaged/);
    assert.deepEqual(lines(root), []);
    assert.equal(readFileSync(path.join(checkout, 'local'), 'utf8'), 'keep');
    rmSync(checkout, { recursive: true });
    passed(runFetch(root, source, { archive }));
    assert.equal(readFileSync(path.join(checkout, 'payload/data.bin'), 'utf8'), 'trusted bytes');
    passed(runFetch(root, source, { mode: 'verify' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Shell Git fetch uses exact commits, immediate mirror fallback, bounded retries, and retains local edits', () => {
  const root = makeRoot('shell-git');
  try {
    const commit = initializeGitRepository(path.join(root, 'upstream'), 'new bytes', 'upstream');
    const source = gitSource(commit),
      checkout = path.join(root, 'checkouts', 'source');
    const prior = initializeGitRepository(checkout, 'prior');
    failed(runFetch(root, source, { fault: 'all' }), /transport fault/);
    assert.deepEqual(lines(root), [
      source.url,
      source.mirrorUrl,
      source.url,
      source.mirrorUrl,
      source.url,
    ]);
    assert.deepEqual(lines(root, 'sleeps'), ['5', '10']);
    assert.equal(command('git', ['rev-parse', 'HEAD'], { cwd: checkout }), prior);
    failed(
      runFetch(root, { ...source, commit: '1'.repeat(40) }, { fault: 'primary', commit }),
      /expected exact commit/,
    );
    assert.equal(command('git', ['rev-parse', 'HEAD'], { cwd: checkout }), prior);
    writeFileSync(path.join(root, 'requests'), '');
    writeFileSync(path.join(root, 'sleeps'), '');
    passed(runFetch(root, source, { fault: 'primary' }));
    assert.deepEqual(lines(root), [source.url, source.mirrorUrl]);
    assert.deepEqual(lines(root, 'sleeps'), []);
    assert.equal(command('git', ['rev-parse', 'HEAD'], { cwd: checkout }), commit);
    assert.equal(command('git', ['remote', 'get-url', 'origin'], { cwd: checkout }), source.url);
    assert.equal(command('git', ['branch', '--show-current'], { cwd: checkout }), source.branch);
    writeFileSync(path.join(root, 'requests'), '');
    passed(runFetch(root, source, { mode: 'verify', fault: 'all' }));
    passed(runFetch(root, source, { fault: 'all' }));
    assert.deepEqual(lines(root), []);
    writeFileSync(path.join(checkout, 'source.txt'), 'local edit');
    failed(runFetch(root, source), /uncommitted changes/);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'local edit');
    assert.deepEqual(readdirSync(path.dirname(checkout)), ['source']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Shell Git fetch pins LF bytes independently of ambient configuration and repairs old CRLF policy', () => {
  const root = makeRoot('shell-git-lf');
  try {
    const upstream = path.join(root, 'upstream');
    initializeGitRepository(upstream, 'first line\nsecond line\n', 'upstream');
    writeFileSync(path.join(upstream, '.gitattributes'), '* text=auto\n');
    command('git', ['add', '.gitattributes'], { cwd: upstream });
    command('git', ['commit', '--quiet', '-m', 'text'], { cwd: upstream });
    const source = gitSource(command('git', ['rev-parse', 'HEAD'], { cwd: upstream }));
    const checkout = path.join(root, 'checkouts', source.name);
    passed(runFetch(root, source));
    assert.deepEqual(lines(root), [source.url]);
    assert.equal(
      readFileSync(path.join(checkout, 'source.txt'), 'utf8'),
      'first line\nsecond line\n',
    );
    command('git', ['config', '--local', 'core.autocrlf', 'true'], { cwd: checkout });
    command('git', ['config', '--local', 'core.eol', 'crlf'], { cwd: checkout });
    rmSync(path.join(checkout, 'source.txt'));
    command('git', ['checkout', '--', 'source.txt'], { cwd: checkout });
    assert.equal(
      readFileSync(path.join(checkout, 'source.txt'), 'utf8'),
      'first line\r\nsecond line\r\n',
    );
    passed(runFetch(root, source));
    assert.deepEqual(lines(root), [source.url, source.url]);
    assert.equal(
      readFileSync(path.join(checkout, 'source.txt'), 'utf8'),
      'first line\nsecond line\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Shell Git fetch accepts ancestor aliases and contained dangling links, rejecting external metadata and escaping links', {
  skip: process.platform === 'win32',
}, () => {
  const root = makeRoot('shell-git-links');
  try {
    const upstream = path.join(root, 'upstream');
    initializeGitRepository(upstream, 'trusted', 'upstream');
    mkdirSync(path.join(root, 'outside'));
    mkdirSync(path.join(upstream, 'fixtures'));
    symlinkSync('../missing', path.join(upstream, 'fixtures/dangling'));
    command('git', ['add', '.'], { cwd: upstream });
    command('git', ['commit', '--quiet', '-m', 'dangling'], { cwd: upstream });
    const source = gitSource(command('git', ['rev-parse', 'HEAD'], { cwd: upstream }));
    passed(runFetch(root, source));
    const checkout = path.join(root, 'checkouts', source.name);
    const alias = root + '-alias';
    symlinkSync(root, alias, 'dir');
    try {
      passed(runFetch(alias, source, { fault: 'all' }));
    } finally {
      rmSync(alias);
    }
    for (const transitive of [false, true]) {
      if (!transitive) symlinkSync('../outside', path.join(upstream, 'escape'));
      else {
        rmSync(path.join(upstream, 'escape'));
        symlinkSync('z-escape/missing', path.join(upstream, 'fixtures/a-dangling'));
        symlinkSync('../../../../outside', path.join(upstream, 'fixtures/z-escape'));
      }
      command('git', ['add', '-A'], { cwd: upstream });
      command('git', ['commit', '--quiet', '-m', 'escape'], { cwd: upstream });
      failed(
        runFetch(root, {
          ...source,
          commit: command('git', ['rev-parse', 'HEAD'], { cwd: upstream }),
        }),
        /escaping.*symlink/,
      );
      assert.equal(command('git', ['rev-parse', 'HEAD'], { cwd: checkout }), source.commit);
    }
    rmSync(path.join(checkout, '.git'), { recursive: true });
    symlinkSync(path.join(upstream, '.git'), path.join(checkout, '.git'), 'dir');
    failed(runFetch(root, source), /unsupported non-directory \.git metadata/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
