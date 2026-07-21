import assert from 'node:assert/strict';
import {spawnSync} from '../test/fd-backed-spawn-sync.mjs';
import {
  copyFileSync,
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
import {test} from 'node:test';

import {
  assertHttpsUrl,
  createSourceFetcher,
  curlDownloadArgs,
  curlPlatformTlsArgs,
  defaultRunProcess,
  promotePathTransactional,
  sameDirectoryIdentity,
  sha256File,
} from './source-fetch-core.mjs';

const archiveTool = path.join(import.meta.dirname, 'source-archive.py');
const treeVerifier = path.join(import.meta.dirname, 'verify-source-tree.py');

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {encoding: 'utf8', ...options});
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function makeRoot(label) {
  return mkdtempSync(path.join(os.tmpdir(), `oliphaunt-${label}-`));
}

function directoryMetadata(dev, ino, isDirectory = true) {
  return {dev, ino, isDirectory: () => isDirectory};
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
      stat: (candidate) => directoryMetadata(17n, candidate === '/directory' ? 42n : 43n, candidate === '/directory'),
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
  const program = String.raw`
import gzip
import io
import pathlib
import tarfile
import sys

root = pathlib.Path(sys.argv[1])

def member(name, data=b"bytes", *, kind=tarfile.REGTYPE, link="", size=None):
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
    info.linkname = link
    info.size = len(data) if size is None else size
    return info, io.BytesIO(data) if kind == tarfile.REGTYPE and size is None else None

def write(name, entries):
    with tarfile.open(root / name, "w:gz") as archive:
        for info, contents in entries:
            archive.addfile(info, contents)

directory = member("pkg/", b"", kind=tarfile.DIRTYPE)
file_entry = member("pkg/file.txt", b"trusted bytes")
valid_link = member("pkg/link.txt", b"", kind=tarfile.SYMTYPE, link="file.txt")
valid_hardlink = member("pkg/hard.txt", b"", kind=tarfile.LNKTYPE, link="pkg/file.txt")
write("valid.tar.gz", [directory, file_entry, valid_link, valid_hardlink])
write("updated.tar.gz", [
    member("pkg/", b"", kind=tarfile.DIRTYPE),
    member("pkg/file.txt", b"updated trusted bytes"),
])
write("traversal.tar.gz", [member("pkg/../../escape")])
write("absolute.tar.gz", [member("/tmp/escape")])
write("outside-prefix.tar.gz", [member("other/file")])
write("backslash.tar.gz", [member(r"pkg\\escape")])
write("duplicate.tar.gz", [member("pkg/file"), member("pkg/file", b"second")])
write("case-collision.tar.gz", [member("pkg/File"), member("pkg/file", b"second")])
write("windows-ads.tar.gz", [member("pkg/file:stream")])
write("windows-device.tar.gz", [member("pkg/CON.txt")])
write("escaping-symlink.tar.gz", [member("pkg/link", b"", kind=tarfile.SYMTYPE, link="../../escape")])
write("dangling-symlink.tar.gz", [member("pkg/link", b"", kind=tarfile.SYMTYPE, link="missing")])
write("escaping-hardlink.tar.gz", [member("pkg/link", b"", kind=tarfile.LNKTYPE, link="../../escape")])
write("fifo.tar.gz", [member("pkg/fifo", b"", kind=tarfile.FIFOTYPE)])
write("reserved-git.tar.gz", [member("pkg/.git/config")])
write("reserved-stamp.tar.gz", [member("pkg/.oliphaunt-source-pin")])
write("symlink-ancestor.tar.gz", [
    member("pkg/dir/", b"", kind=tarfile.DIRTYPE),
    member("pkg/link", b"", kind=tarfile.SYMTYPE, link="dir"),
    member("pkg/link/child"),
])

huge = tarfile.TarInfo("pkg/huge")
huge.type = tarfile.REGTYPE
huge.mode = 0o644
huge.size = 3 * 1024 * 1024 * 1024
with gzip.open(root / "huge.tar.gz", "wb") as stream:
    stream.write(huge.tobuf())
`;
  command('python3', ['-c', program, root]);
}

function validateArchive(archive) {
  return spawnSync('python3', [archiveTool, 'validate', archive, 'pkg'], {encoding: 'utf8'});
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

function writeArchiveManifest(manifestPath, source) {
  writeFileSync(
    manifestPath,
    `name = "${source.name}"\nkind = "archive"\nurl = "${source.url}"\nbranch = "${source.branch}"\ncommit = "${source.commit}"\nsha256 = "${source.sha256}"\nstrip_prefix = "${source.stripPrefix}"\n`,
  );
}

function sourceFetcher(root, overrides = {}) {
  return createSourceFetcher({
    workspaceRoot: path.resolve(import.meta.dirname, '..', '..'),
    checkoutRoot: path.join(root, 'checkouts'),
    archiveRoot: path.join(root, 'archives'),
    archiveTool,
    gitAttempts: 1,
    sleep: async () => {},
    ...overrides,
  });
}

function initializeGitRepository(repository, contents, branch = 'old') {
  mkdirSync(repository, {recursive: true});
  command('git', ['init', '--quiet', `--initial-branch=${branch}`], {cwd: repository});
  command('git', ['config', 'user.name', 'Source Fetch Test'], {cwd: repository});
  command('git', ['config', 'user.email', 'source-fetch@example.invalid'], {cwd: repository});
  writeFileSync(path.join(repository, 'source.txt'), contents);
  command('git', ['add', 'source.txt'], {cwd: repository});
  command('git', ['commit', '--quiet', '-m', 'test source'], {cwd: repository});
  return command('git', ['rev-parse', 'HEAD'], {cwd: repository});
}

test('archive validator extracts only the declared safe root', () => {
  const root = makeRoot('source-archive-valid');
  try {
    createTarFixtures(root);
    const archive = path.join(root, 'valid.tar.gz');
    assert.equal(validateArchive(archive).status, 0);
    const destination = path.join(root, 'out');
    const extraction = spawnSync('python3', [archiveTool, 'extract', archive, 'pkg', destination], {
      encoding: 'utf8',
    });
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.equal(readFileSync(path.join(destination, 'file.txt'), 'utf8'), 'trusted bytes');
    assert.equal(readFileSync(path.join(destination, 'link.txt'), 'utf8'), 'trusted bytes');
    assert.equal(readFileSync(path.join(destination, 'hard.txt'), 'utf8'), 'trusted bytes');
    assert.equal(existsSync(path.join(destination, 'pkg')), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test(
  'archive validator rejects traversal, unsafe links and types, duplicates, reserved paths, and expansion abuse',
  {timeout: 30_000},
  () => {
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
        const extraction = spawnSync('python3', [archiveTool, 'extract', archive, 'pkg', destination], {
          encoding: 'utf8',
        });
        assert.notEqual(extraction.status, 0, `${name} unexpectedly extracted`);
        assert.equal(existsSync(destination), false, `${name} left a partial destination`);
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  },
);

test('archive transport is HTTPS-only and bounded', () => {
  assert.throws(() => assertHttpsUrl('http://example.test/source.tar.gz'), /must use HTTPS/u);
  assert.throws(() => assertHttpsUrl('https://user:secret@example.test/source.tar.gz'), /credentials/u);
  assert.throws(() => assertHttpsUrl('https://example.test\\source.tar.gz'), /canonical/u);
  const args = curlDownloadArgs('https://example.test/source.tar.gz', '/tmp/candidate');
  assert.equal(args[0], '--disable');
  for (const token of [
    '--retry-max-time',
    '--connect-timeout',
    '--max-time',
    '--speed-limit',
    '--speed-time',
    '--max-filesize',
    '--proto',
    '--proto-redir',
    '=https',
    '--tlsv1.2',
    '--remove-on-error',
  ]) {
    assert.ok(args.includes(token), `missing bounded transport argument ${token}`);
  }
});

test('Windows transport tolerates only an unavailable Schannel revocation service', () => {
  assert.deepEqual(curlPlatformTlsArgs('win32'), ['--ssl-revoke-best-effort']);
  assert.deepEqual(curlPlatformTlsArgs('linux'), []);
  assert.deepEqual(curlPlatformTlsArgs('darwin'), []);

  const windows = curlDownloadArgs(
    'https://example.test/source.tar.gz',
    'C:/candidate',
    {platform: 'win32'},
  );
  assert.equal(windows.includes('--ssl-revoke-best-effort'), true);
  assert.equal(windows.includes('--insecure'), false);
  assert.equal(windows.includes('-k'), false);

  const linux = curlDownloadArgs(
    'https://example.test/source.tar.gz',
    '/tmp/candidate',
    {platform: 'linux'},
  );
  assert.equal(linux.includes('--ssl-revoke-best-effort'), false);
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
      () => promotePathTransactional(candidate, destination, {afterBackup: () => { throw new Error('fault'); }}),
      /fault/u,
    );
    assert.equal(readFileSync(path.join(destination, 'value'), 'utf8'), 'old');
    assert.equal(readFileSync(path.join(candidate, 'value'), 'utf8'), 'new');
    assert.deepEqual(readdirSync(root).sort(), ['candidate', 'live']);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('a corrupt archive cache is retained on download failure and replaced only by a verified candidate', async () => {
  const root = makeRoot('source-cache-repair');
  try {
    createTarFixtures(root);
    const fixture = path.join(root, 'valid.tar.gz');
    const source = archiveSource(fixture);
    const archiveRoot = path.join(root, 'archives');
    mkdirSync(archiveRoot);
    const cached = path.join(archiveRoot, `${source.name}-${source.sha256}.tar.gz`);
    writeFileSync(cached, 'corrupt previous bytes');

    const failing = sourceFetcher(root, {downloadFile: () => { throw new Error('network fault'); }});
    await assert.rejects(failing.ensureArchive(source), /network fault/u);
    assert.equal(readFileSync(cached, 'utf8'), 'corrupt previous bytes');

    const repairing = sourceFetcher(root, {downloadFile: (_source, output) => copyFileSync(fixture, output)});
    assert.equal(await repairing.ensureArchive(source), cached);
    assert.equal(sha256File(cached), source.sha256);
    assert.deepEqual(readdirSync(archiveRoot), [`${source.name}-${source.sha256}.tar.gz`]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('archive extraction failure preserves the prior checkout', async () => {
  const root = makeRoot('source-extract-rollback');
  try {
    createTarFixtures(root);
    const fixture = path.join(root, 'valid.tar.gz');
    const source = archiveSource(fixture);
    const checkout = path.join(root, 'checkouts', source.name);
    await sourceFetcher(root, {downloadFile: (_source, output) => copyFileSync(fixture, output)}).materialize(source);
    const updatedFixture = path.join(root, 'updated.tar.gz');
    const updatedSource = archiveSource(updatedFixture);
    const fetcher = sourceFetcher(root, {
      downloadFile: (_source, output) => copyFileSync(updatedFixture, output),
      extractArchive: () => { throw new Error('extract fault'); },
    });
    await assert.rejects(fetcher.materialize(updatedSource), /extract fault/u);
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'trusted bytes');
    assert.deepEqual(readdirSync(path.dirname(checkout)), [source.name]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('modified stamped archive checkout is rejected and preserved', async () => {
  const root = makeRoot('source-archive-dirty');
  try {
    createTarFixtures(root);
    const fixture = path.join(root, 'valid.tar.gz');
    const source = archiveSource(fixture);
    const checkout = path.join(root, 'checkouts', source.name);
    const fetcher = sourceFetcher(root, {downloadFile: (_source, output) => copyFileSync(fixture, output)});
    await fetcher.materialize(source);
    writeFileSync(path.join(checkout, 'file.txt'), 'local modification');
    await assert.rejects(fetcher.materialize(source), /was modified/u);
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'local modification');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('offline checkout verifier agrees with the source fetcher and detects modification', async () => {
  const root = makeRoot('source-archive-offline-verify');
  try {
    createTarFixtures(root);
    const fixture = path.join(root, 'valid.tar.gz');
    const source = archiveSource(fixture);
    const checkout = path.join(root, 'checkouts', source.name);
    const manifest = path.join(root, 'source.toml');
    writeArchiveManifest(manifest, source);
    await sourceFetcher(root, {downloadFile: (_source, output) => copyFileSync(fixture, output)}).materialize(source);
    const verified = spawnSync(
      'python3',
      [treeVerifier, '--checkout', checkout, '--manifest', manifest],
      {encoding: 'utf8'},
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^[0-9a-f]{64}\r?\n$/u);
    writeFileSync(path.join(checkout, 'file.txt'), 'modified after verification');
    const modified = spawnSync(
      'python3',
      [treeVerifier, '--checkout', checkout, '--manifest', manifest],
      {encoding: 'utf8'},
    );
    assert.notEqual(modified.status, 0);
    assert.match(modified.stderr, /was modified/u);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('unmanaged durable directory is rejected without download or replacement', async () => {
  const root = makeRoot('source-archive-unmanaged');
  try {
    createTarFixtures(root);
    const fixture = path.join(root, 'valid.tar.gz');
    const source = archiveSource(fixture);
    const checkout = path.join(root, 'checkouts', source.name);
    mkdirSync(checkout, {recursive: true});
    writeFileSync(path.join(checkout, 'prior'), 'unmanaged bytes');
    let downloaded = false;
    const fetcher = sourceFetcher(root, {
      downloadFile: () => {
        downloaded = true;
        throw new Error('must not download');
      },
    });
    await assert.rejects(fetcher.materialize(source), /is unmanaged/u);
    assert.equal(downloaded, false);
    assert.equal(readFileSync(path.join(checkout, 'prior'), 'utf8'), 'unmanaged bytes');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('stale clean managed archive pin updates transactionally', async () => {
  const root = makeRoot('source-archive-stale');
  try {
    createTarFixtures(root);
    const firstFixture = path.join(root, 'valid.tar.gz');
    const secondFixture = path.join(root, 'updated.tar.gz');
    const first = archiveSource(firstFixture);
    const second = archiveSource(secondFixture);
    const checkout = path.join(root, 'checkouts', first.name);
    await sourceFetcher(root, {
      downloadFile: (_source, output) => copyFileSync(firstFixture, output),
    }).materialize(first);
    await sourceFetcher(root, {
      downloadFile: (_source, output) => copyFileSync(secondFixture, output),
    }).materialize(second);
    assert.equal(readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'updated trusted bytes');
    assert.equal(existsSync(path.join(checkout, 'link.txt')), false);
    assert.deepEqual(readdirSync(path.dirname(checkout)), [first.name]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('source mirror transport is HTTPS-only, distinct, and Git-only', async () => {
  const root = makeRoot('source-mirror-validation');
  try {
    const gitSource = {
      name: 'source',
      kind: 'git',
      url: 'https://example.invalid/source.git',
      branch: 'pinned',
      commit: '1111111111111111111111111111111111111111',
    };
    for (const [mirrorUrl, pattern] of [
      ['http://example.invalid/source.git', /must use HTTPS/u],
      ['https://user:secret@example.invalid/source.git', /credentials/u],
      ['https://example.invalid/source.git#mutable', /fragment/u],
      ['https://example.invalid\\source.git', /canonical/u],
      [gitSource.url, /must differ from its primary URL/u],
    ]) {
      await assert.rejects(
        sourceFetcher(root).materialize({...gitSource, mirrorUrl}),
        pattern,
      );
    }

    const sha256 = '2'.repeat(64);
    await assert.rejects(
      sourceFetcher(root).materialize({
        name: 'archive',
        kind: 'archive',
        url: 'https://example.invalid/archive.tar.gz',
        mirrorUrl: 'https://mirror.invalid/archive.tar.gz',
        branch: 'archive-1.0',
        commit: sha256,
        sha256,
        stripPrefix: 'archive',
      }),
      /must not set mirror_url/u,
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Git fetch uses a healthy primary without contacting or delaying for its mirror', async () => {
  const root = makeRoot('source-git-primary');
  try {
    const upstream = path.join(root, 'upstream');
    const commit = initializeGitRepository(upstream, 'exact primary bytes', 'upstream');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://primary.example.invalid/source.git',
      mirrorUrl: 'https://mirror.example.invalid/source.git',
      branch: 'pinned',
      commit,
    };
    const fetchedUrls = [];
    const sleeps = [];
    const runProcess = (specification) => {
      if (specification.command === 'git' && specification.args.includes('fetch')) {
        const requestedUrl = specification.args.at(-2);
        fetchedUrls.push(requestedUrl);
        assert.equal(requestedUrl, source.url);
        return defaultRunProcess({
          ...specification,
          args: [
            '-c',
            'protocol.file.allow=always',
            'fetch',
            '--no-tags',
            '--depth=1',
            upstream,
            commit,
          ],
        });
      }
      return defaultRunProcess(specification);
    };

    await sourceFetcher(root, {
      gitAttempts: 5,
      runProcess,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    }).materialize(source);

    const checkout = path.join(root, 'checkouts', source.name);
    assert.deepEqual(fetchedUrls, [source.url]);
    assert.deepEqual(sleeps, []);
    assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), commit);
    assert.equal(command('git', ['branch', '--show-current'], {cwd: checkout}), source.branch);
    assert.equal(command('git', ['remote', 'get-url', 'origin'], {cwd: checkout}), source.url);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'exact primary bytes');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Git fetch fails over immediately to an exact mirror commit and retains the canonical origin', async () => {
  const root = makeRoot('source-git-mirror');
  try {
    const upstream = path.join(root, 'upstream');
    const commit = initializeGitRepository(upstream, 'exact mirror bytes', 'upstream');
    const checkout = path.join(root, 'checkouts', 'source');
    const priorCommit = initializeGitRepository(checkout, 'prior durable bytes');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://primary.example.invalid/source.git',
      mirrorUrl: 'https://mirror.example.invalid/source.git',
      branch: 'pinned',
      commit,
    };
    const fetchedUrls = [];
    const sleeps = [];
    const runProcess = (specification) => {
      if (specification.command === 'git' && specification.args.includes('fetch')) {
        const requestedUrl = specification.args.at(-2);
        fetchedUrls.push(requestedUrl);
        if (requestedUrl === source.url) {
          throw new Error('injected primary transport fault');
        }
        assert.equal(requestedUrl, source.mirrorUrl);
        return defaultRunProcess({
          ...specification,
          args: [
            '-c',
            'protocol.file.allow=always',
            'fetch',
            '--no-tags',
            '--depth=1',
            upstream,
            commit,
          ],
        });
      }
      return defaultRunProcess(specification);
    };

    await sourceFetcher(root, {
      gitAttempts: 5,
      runProcess,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    }).materialize(source);

    assert.notEqual(priorCommit, commit);
    assert.deepEqual(fetchedUrls, [source.url, source.mirrorUrl]);
    assert.deepEqual(sleeps, []);
    assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), commit);
    assert.equal(command('git', ['branch', '--show-current'], {cwd: checkout}), source.branch);
    assert.equal(command('git', ['remote', 'get-url', 'origin'], {cwd: checkout}), source.url);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'exact mirror bytes');
    assert.deepEqual(readdirSync(path.dirname(checkout)), [source.name]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Git fetch bounds alternating transport failures and preserves durable state', async () => {
  const root = makeRoot('source-git-mirror-fault');
  try {
    const checkout = path.join(root, 'checkouts', 'source');
    const priorCommit = initializeGitRepository(checkout, 'prior durable bytes');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://primary.example.invalid/source.git',
      mirrorUrl: 'https://mirror.example.invalid/source.git',
      branch: 'pinned',
      commit: '1111111111111111111111111111111111111111',
    };
    const fetchedUrls = [];
    const sleeps = [];
    const runProcess = (specification) => {
      if (specification.command === 'git' && specification.args.includes('fetch')) {
        fetchedUrls.push(specification.args.at(-2));
        throw new Error('injected transport fault');
      }
      return defaultRunProcess(specification);
    };

    await assert.rejects(
      sourceFetcher(root, {
        gitAttempts: 5,
        runProcess,
        sleep: async (milliseconds) => sleeps.push(milliseconds),
      }).materialize(source),
      /injected transport fault/u,
    );

    assert.deepEqual(fetchedUrls, [
      source.url,
      source.mirrorUrl,
      source.url,
      source.mirrorUrl,
      source.url,
    ]);
    assert.deepEqual(sleeps, [5_000, 10_000]);
    assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), priorCommit);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'prior durable bytes');
    assert.deepEqual(readdirSync(path.dirname(checkout)), [source.name]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Git mirror cannot promote a different commit than the exact pin', async () => {
  const root = makeRoot('source-git-mirror-wrong-commit');
  try {
    const upstream = path.join(root, 'upstream');
    const mirrorCommit = initializeGitRepository(upstream, 'wrong mirror bytes', 'upstream');
    const checkout = path.join(root, 'checkouts', 'source');
    const priorCommit = initializeGitRepository(checkout, 'prior durable bytes');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://primary.example.invalid/source.git',
      mirrorUrl: 'https://mirror.example.invalid/source.git',
      branch: 'pinned',
      commit: '1111111111111111111111111111111111111111',
    };
    const fetchedUrls = [];
    const runProcess = (specification) => {
      if (specification.command === 'git' && specification.args.includes('fetch')) {
        const requestedUrl = specification.args.at(-2);
        fetchedUrls.push(requestedUrl);
        if (requestedUrl === source.url) {
          throw new Error('injected primary transport fault');
        }
        return defaultRunProcess({
          ...specification,
          args: [
            '-c',
            'protocol.file.allow=always',
            'fetch',
            '--no-tags',
            '--depth=1',
            upstream,
            mirrorCommit,
          ],
        });
      }
      return defaultRunProcess(specification);
    };

    await assert.rejects(
      sourceFetcher(root, {gitAttempts: 2, runProcess, sleep: async () => {}}).materialize(source),
      /expected exact commit/u,
    );

    assert.deepEqual(fetchedUrls, [source.url, source.mirrorUrl]);
    assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), priorCommit);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'prior durable bytes');
    assert.deepEqual(readdirSync(path.dirname(checkout)), [source.name]);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('dirty durable Git checkout is rejected before staging', async () => {
  const root = makeRoot('source-git-dirty');
  try {
    const checkout = path.join(root, 'checkouts', 'source');
    const commit = initializeGitRepository(checkout, 'committed');
    command('git', ['remote', 'add', 'origin', 'https://example.invalid/source.git'], {cwd: checkout});
    writeFileSync(path.join(checkout, 'source.txt'), 'dirty');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://example.invalid/source.git',
      branch: 'old',
      commit,
    };
    await assert.rejects(sourceFetcher(root).materialize(source), /uncommitted changes/u);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'dirty');
    assert.deepEqual(readdirSync(path.join(root, 'checkouts')), ['source']);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test(
  'durable Git checkout accepts a canonical alias in an ancestor path',
  {skip: process.platform === 'win32'},
  async () => {
    const root = makeRoot('source-git-ancestor-alias');
    try {
      const durableRoot = path.join(root, 'durable');
      const aliasRoot = path.join(root, 'alias');
      mkdirSync(durableRoot);
      symlinkSync(durableRoot, aliasRoot, 'dir');
      const checkout = path.join(aliasRoot, 'checkouts', 'source');
      const commit = initializeGitRepository(checkout, 'committed');
      const source = {
        name: 'source',
        kind: 'git',
        url: 'https://example.invalid/source.git',
        branch: 'old',
        commit,
      };
      command('git', ['remote', 'add', 'origin', source.url], {cwd: checkout});
      let fetched = false;
      const runProcess = (specification) => {
        if (specification.command === 'git' && specification.args.includes('fetch')) {
          fetched = true;
          throw new Error('an exact durable checkout must not be fetched again');
        }
        return defaultRunProcess(specification);
      };

      await sourceFetcher(aliasRoot, {runProcess}).materialize(source);

      assert.equal(fetched, false);
      assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'committed');
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  },
);

test(
  'durable Git checkout rejects linked metadata even when it resolves to a real repository',
  {skip: process.platform === 'win32'},
  async () => {
    const root = makeRoot('source-git-linked-metadata');
    try {
      const external = path.join(root, 'external');
      const commit = initializeGitRepository(external, 'external');
      const checkout = path.join(root, 'checkouts', 'source');
      mkdirSync(checkout, {recursive: true});
      symlinkSync(path.join(external, '.git'), path.join(checkout, '.git'), 'dir');
      const source = {
        name: 'source',
        kind: 'git',
        url: 'https://example.invalid/source.git',
        branch: 'old',
        commit,
      };

      await assert.rejects(sourceFetcher(root).materialize(source), /unsupported non-directory \.git metadata/u);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  },
);

test('failed staged Git fetch leaves a stale clean durable checkout unchanged', async () => {
  const root = makeRoot('source-git-fetch-fault');
  try {
    const checkout = path.join(root, 'checkouts', 'source');
    const priorCommit = initializeGitRepository(checkout, 'prior');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://example.invalid/source.git',
      branch: 'pinned',
      commit: '1111111111111111111111111111111111111111',
    };
    const runProcess = (specification) => {
      if (specification.command === 'git' && specification.args.includes('fetch')) {
        throw new Error('injected fetch fault');
      }
      return defaultRunProcess(specification);
    };
    await assert.rejects(sourceFetcher(root, {runProcess}).materialize(source), /injected fetch fault/u);
    assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), priorCommit);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'prior');
    assert.deepEqual(readdirSync(path.join(root, 'checkouts')), ['source']);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('Git fetch stages and verifies the exact commit before replacing a clean checkout', {timeout: 15_000}, async () => {
  const root = makeRoot('source-git-exact');
  try {
    const upstream = path.join(root, 'upstream');
    const commit = initializeGitRepository(upstream, 'exact upstream bytes', 'upstream');
    const checkout = path.join(root, 'checkouts', 'source');
    initializeGitRepository(checkout, 'prior durable bytes');
    const source = {
      name: 'source',
      kind: 'git',
      url: 'https://example.invalid/source.git',
      branch: 'pinned',
      commit,
    };
    const runProcess = (specification) => {
      if (specification.command === 'git' && specification.args.includes('fetch')) {
        return defaultRunProcess({
          ...specification,
          args: [
            '-c',
            'protocol.file.allow=always',
            'fetch',
            '--no-tags',
            '--depth=1',
            upstream,
            commit,
          ],
        });
      }
      return defaultRunProcess(specification);
    };
    await sourceFetcher(root, {runProcess}).materialize(source);
    assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), commit);
    assert.equal(command('git', ['branch', '--show-current'], {cwd: checkout}), 'pinned');
    assert.equal(command('git', ['remote', 'get-url', 'origin'], {cwd: checkout}), source.url);
    assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'exact upstream bytes');
    assert.deepEqual(readdirSync(path.join(root, 'checkouts')), ['source']);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test(
  'staged Git checkout rejects an escaping symlink without replacing durable state',
  {skip: process.platform === 'win32'},
  async () => {
    const root = makeRoot('source-git-unsafe-link');
    try {
      const upstream = path.join(root, 'upstream');
      initializeGitRepository(upstream, 'upstream bytes', 'upstream');
      symlinkSync('../outside', path.join(upstream, 'escape'));
      command('git', ['add', 'escape'], {cwd: upstream});
      command('git', ['commit', '--quiet', '-m', 'unsafe link'], {cwd: upstream});
      const commit = command('git', ['rev-parse', 'HEAD'], {cwd: upstream});
      const checkout = path.join(root, 'checkouts', 'source');
      const priorCommit = initializeGitRepository(checkout, 'prior durable bytes');
      const source = {
        name: 'source',
        kind: 'git',
        url: 'https://example.invalid/source.git',
        branch: 'pinned',
        commit,
      };
      const runProcess = (specification) => {
        if (specification.command === 'git' && specification.args.includes('fetch')) {
          return defaultRunProcess({
            ...specification,
            args: [
              '-c',
              'protocol.file.allow=always',
              'fetch',
              '--no-tags',
              '--depth=1',
              upstream,
              commit,
            ],
          });
        }
        return defaultRunProcess(specification);
      };
      await assert.rejects(sourceFetcher(root, {runProcess}).materialize(source), /escaping symlink/u);
      assert.equal(command('git', ['rev-parse', 'HEAD'], {cwd: checkout}), priorCommit);
      assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'prior durable bytes');
      assert.deepEqual(readdirSync(path.join(root, 'checkouts')), ['source']);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  },
);
