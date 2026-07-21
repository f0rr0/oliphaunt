#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {spawnSync} from '../test/fd-backed-spawn-sync.mjs';
import {createHash} from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
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
import {after, test} from 'node:test';

import {ROOT} from './release-graph.mjs';

const installer = path.join(ROOT, 'tools/dev/install-pinned-maintainer-tool.sh');
const bootstrap = path.join(ROOT, 'tools/dev/bootstrap-tools.sh');
const actionlintInstaller = path.join(ROOT, 'tools/dev/install-actionlint.sh');
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, {recursive: true, force: true});
});

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function executable(file, contents) {
  writeFileSync(file, contents, 'utf8');
  chmodSync(file, 0o755);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {encoding: 'utf8', ...options});
  if (result.error !== undefined) throw result.error;
  return result;
}

function requireSuccess(result, context) {
  assert.equal(
    result.status,
    0,
    `${context} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function createTar(archive, source, members) {
  const result = command('tar', ['-czf', archive, '-C', source, ...members]);
  requireSuccess(result, `creating ${path.basename(archive)}`);
}

function writeManifest(fixture, overrides = {}) {
  const cargoArchiveSha = overrides.cargoArchiveSha ?? fixture.cargoArchiveSha;
  const cargoBinarySha = overrides.cargoBinarySha ?? fixture.cargoBinarySha;
  const actionArchiveSha = overrides.actionArchiveSha ?? fixture.actionArchiveSha;
  const actionBinarySha = overrides.actionBinarySha ?? fixture.actionBinarySha;
  const cargoMaxArchive = overrides.cargoMaxArchive ?? '1048576';
  writeFileSync(
    fixture.manifest,
    `[cargo-binstall]\nversion = "1.19.1"\nsource_fallback = "cargo install cargo-binstall --version 1.19.1 --locked"\n\n` +
      `[cargo-binstall.assets.x86_64-unknown-linux-musl]\n` +
      `url = "https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.1/cargo-binstall-x86_64-unknown-linux-musl.tgz"\n` +
      `sha256 = "${cargoArchiveSha}"\nbinary_sha256 = "${cargoBinarySha}"\nformat = "tgz"\n` +
      `binary_path = "cargo-binstall"\nentry_count = "1"\nmax_archive_bytes = "${cargoMaxArchive}"\nmax_binary_bytes = "1048576"\n\n` +
      `[actionlint]\nversion = "1.7.12"\nsource_fallback = "none"\n\n` +
      `[actionlint.assets.linux-amd64]\n` +
      `url = "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz"\n` +
      `sha256 = "${actionArchiveSha}"\nbinary_sha256 = "${actionBinarySha}"\nformat = "tgz"\n` +
      `binary_path = "actionlint"\nentry_count = "11"\nmax_archive_bytes = "1048576"\nmax_binary_bytes = "1048576"\n`,
    'utf8',
  );
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-maintainer-tools-test-'));
  temporaryRoots.push(root);
  const fixture = {
    root,
    bin: path.join(root, 'bin'),
    fakeBin: path.join(root, 'fake-bin'),
    archives: path.join(root, 'archives'),
    manifest: path.join(root, 'maintainer-tools.toml'),
    curlLog: path.join(root, 'curl.log'),
    cargoLog: path.join(root, 'cargo.log'),
    goLog: path.join(root, 'go.log'),
    mvFailureMarker: path.join(root, 'mv-failed-once'),
  };
  mkdirSync(fixture.bin);
  mkdirSync(fixture.fakeBin);
  mkdirSync(fixture.archives);

  const cargoSource = path.join(root, 'cargo-source');
  mkdirSync(cargoSource);
  const cargoBinary = path.join(cargoSource, 'cargo-binstall');
  executable(
    cargoBinary,
    '#!/usr/bin/env bash\nif [ "${1:-}" = -V ]; then printf "%s\\n" "cargo-binstall 1.19.1"; else exit 0; fi\n',
  );
  fixture.cargoArchive = path.join(fixture.archives, 'cargo.tgz');
  createTar(fixture.cargoArchive, cargoSource, ['cargo-binstall']);
  fixture.cargoArchiveSha = sha256(fixture.cargoArchive);
  fixture.cargoBinarySha = sha256(cargoBinary);

  const actionSource = path.join(root, 'action-source');
  for (const directory of ['docs', 'man']) mkdirSync(path.join(actionSource, directory), {recursive: true});
  const actionMembers = [
    'LICENSE.txt',
    'README.md',
    'actionlint',
    'docs/README.md',
    'docs/api.md',
    'docs/checks.md',
    'docs/config.md',
    'docs/install.md',
    'docs/reference.md',
    'docs/usage.md',
    'man/actionlint.1',
  ];
  for (const member of actionMembers) {
    const target = path.join(actionSource, member);
    if (member === 'actionlint') {
      executable(
        target,
        '#!/usr/bin/env bash\nif [ "${1:-}" = -version ]; then printf "%s\\n" "actionlint version 1.7.12"; else exit 0; fi\n',
      );
    } else {
      writeFileSync(target, `${member}\n`, 'utf8');
    }
  }
  fixture.actionArchive = path.join(fixture.archives, 'actionlint.tar.gz');
  createTar(fixture.actionArchive, actionSource, actionMembers);
  fixture.actionArchiveSha = sha256(fixture.actionArchive);
  fixture.actionBinarySha = sha256(path.join(actionSource, 'actionlint'));

  const badCargoSource = path.join(root, 'bad-cargo-source');
  mkdirSync(badCargoSource);
  writeFileSync(path.join(badCargoSource, 'cargo-binstall'), readFileSync(cargoBinary));
  writeFileSync(path.join(badCargoSource, 'unexpected'), 'not allowed\n');
  fixture.badCargoArchive = path.join(fixture.archives, 'bad-cargo.tgz');
  createTar(fixture.badCargoArchive, badCargoSource, ['cargo-binstall', 'unexpected']);

  const linkCargoSource = path.join(root, 'link-cargo-source');
  mkdirSync(linkCargoSource);
  symlinkSync('/tmp/oliphaunt-must-not-be-read', path.join(linkCargoSource, 'cargo-binstall'));
  fixture.linkCargoArchive = path.join(fixture.archives, 'link-cargo.tgz');
  createTar(fixture.linkCargoArchive, linkCargoSource, ['cargo-binstall']);

  const badActionSource = path.join(root, 'bad-action-source');
  command('cp', ['-R', `${actionSource}/.`, badActionSource]);
  writeFileSync(path.join(badActionSource, 'unexpected'), 'not allowed\n');
  fixture.badActionArchive = path.join(fixture.archives, 'bad-actionlint.tar.gz');
  createTar(fixture.badActionArchive, badActionSource, [...actionMembers, 'unexpected']);

  executable(
    path.join(fixture.fakeBin, 'uname'),
    '#!/usr/bin/env bash\ncase "${1:-}" in -s) printf "%s\\n" "${FAKE_UNAME_OS:-Linux}";; -m) printf "%s\\n" "${FAKE_UNAME_ARCH:-x86_64}";; *) exit 2;; esac\n',
  );
  executable(
    path.join(fixture.fakeBin, 'curl'),
    `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$@" >>"$FAKE_CURL_LOG"\noutput=\nprevious=\nfor argument in "$@"; do\n  if [ "$previous" = --output ]; then output="$argument"; fi\n  previous="$argument"\ndone\n[ -n "$output" ] || exit 2\ncase "\${FAKE_CURL_MODE:-success}" in\n  success) cp "$FAKE_CURL_SOURCE" "$output";;\n  transport) printf partial >"$output"; exit 28;;\n  http) exit 22;;\n  oversized) printf partial >"$output"; exit 63;;\n  interrupt) printf partial >"$output"; kill -TERM "$PPID"; sleep 0.1; exit 143;;\n  *) exit 2;;\nesac\n`,
  );
  executable(
    path.join(fixture.fakeBin, 'cargo'),
    `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "$*" >>"$FAKE_CARGO_LOG"\n[ "\${FAKE_CARGO_MODE:-success}" = success ] || exit 42\nroot=\nprevious=\nfor argument in "$@"; do\n  if [ "$previous" = --root ]; then root="$argument"; fi\n  previous="$argument"\ndone\n[ -n "$root" ] || exit 2\nmkdir -p "$root/bin"\nprintf '%s\\n' '#!/usr/bin/env bash' 'if [ "\${1:-}" = -V ]; then printf "%s\\n" "cargo-binstall 1.19.1"; else exit 0; fi' >"$root/bin/cargo-binstall"\nchmod 0755 "$root/bin/cargo-binstall"\n`,
  );
  executable(
    path.join(fixture.fakeBin, 'go'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$FAKE_GO_LOG"\nexit 99\n',
  );
  executable(
    path.join(fixture.fakeBin, 'mv'),
    `#!/usr/bin/env bash\nset -eu\nlast=\nfor argument in "$@"; do last="$argument"; done\nif [ -n "\${FAKE_MV_FAIL_TARGET:-}" ] && [ "$last" = "$FAKE_MV_FAIL_TARGET" ] && [ ! -e "$FAKE_MV_FAILURE_MARKER" ]; then\n  : >"$FAKE_MV_FAILURE_MARKER"\n  exit 91\nfi\nexec /usr/bin/mv "$@"\n`,
  );

  writeManifest(fixture);
  return fixture;
}

function environment(fixture, extra = {}) {
  return {
    ...process.env,
    PATH: `${fixture.fakeBin}:${process.env.PATH}`,
    HOME: fixture.root,
    CARGO_HOME: path.join(fixture.root, 'cargo-home'),
    OLIPHAUNT_MAINTAINER_TOOLS_ROOT: fixture.root,
    OLIPHAUNT_MAINTAINER_TOOLS_MANIFEST: fixture.manifest,
    OLIPHAUNT_MAINTAINER_BIN_DIR: fixture.bin,
    OLIPHAUNT_MAINTAINER_TOOLS_CURL: path.join(fixture.fakeBin, 'curl'),
    FAKE_CURL_LOG: fixture.curlLog,
    FAKE_CARGO_LOG: fixture.cargoLog,
    FAKE_GO_LOG: fixture.goLog,
    FAKE_MV_FAILURE_MARKER: fixture.mvFailureMarker,
    ...extra,
  };
}

function runInstaller(fixture, tool, extra = {}) {
  const source = tool === 'cargo-binstall' ? fixture.cargoArchive : fixture.actionArchive;
  return command('bash', [installer, tool], {
    cwd: ROOT,
    env: environment(fixture, {FAKE_CURL_SOURCE: source, ...extra}),
  });
}

function assertNoInstallerDebris(fixture) {
  assert.deepEqual(
    readdirSync(fixture.bin).filter((entry) => /^\.(?:cargo-binstall|actionlint)\.(?:download|install)\./u.test(entry)),
    [],
  );
}

test('release archives are bounded, verified, identity-cached, and corruption-repaired', () => {
  const fixture = makeFixture();
  requireSuccess(runInstaller(fixture, 'cargo-binstall'), 'cargo-binstall binary install');
  const final = path.join(fixture.bin, 'cargo-binstall');
  assert.equal(sha256(final), fixture.cargoBinarySha);
  const marker = readFileSync(path.join(fixture.bin, '.cargo-binstall.oliphaunt-source'), 'utf8');
  assert.match(marker, /source=release-asset/u);
  assert.match(marker, new RegExp(`archive_sha256=${fixture.cargoArchiveSha}`, 'u'));
  const flags = readFileSync(fixture.curlLog, 'utf8');
  for (const required of [
    '--max-time',
    '--max-filesize',
    '--proto',
    '=https',
    '--proto-redir',
    '--tlsv1.2',
    '--remove-on-error',
  ]) assert.match(flags, new RegExp(`^${required.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'));

  const firstCurlLog = readFileSync(fixture.curlLog, 'utf8');
  requireSuccess(runInstaller(fixture, 'cargo-binstall'), 'identity cache hit');
  assert.equal(readFileSync(fixture.curlLog, 'utf8'), firstCurlLog);

  appendFileSync(final, '\n# same version string, different identity\n');
  assert.match(command(final, ['-V']).stdout, /1\.19\.1/u);
  requireSuccess(runInstaller(fixture, 'cargo-binstall'), 'corrupt cache repair');
  assert.equal(sha256(final), fixture.cargoBinarySha);
  assertNoInstallerDebris(fixture);
});

test('checksum, size, member-layout, and member-type failures preserve the prior install', () => {
  const fixture = makeFixture();
  requireSuccess(runInstaller(fixture, 'cargo-binstall'), 'initial cargo-binstall install');
  const final = path.join(fixture.bin, 'cargo-binstall');
  const marker = path.join(fixture.bin, '.cargo-binstall.oliphaunt-source');
  const originalBinary = readFileSync(final);
  const originalMarker = readFileSync(marker);

  let result = runInstaller(fixture, 'cargo-binstall', {
    FAKE_CURL_SOURCE: path.join(fixture.root, 'not-used'),
  });
  requireSuccess(result, 'valid cache before faults');

  appendFileSync(final, '\n# force refresh\n');
  const priorCorruptBinary = readFileSync(final);
  const mismatch = path.join(fixture.archives, 'checksum-mismatch');
  writeFileSync(mismatch, 'not the pinned archive');
  result = runInstaller(fixture, 'cargo-binstall', {FAKE_CURL_SOURCE: mismatch});
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(final), priorCorruptBinary);
  assert.deepEqual(readFileSync(marker), originalMarker);

  writeManifest(fixture, {cargoArchiveSha: sha256(fixture.badCargoArchive)});
  result = runInstaller(fixture, 'cargo-binstall', {FAKE_CURL_SOURCE: fixture.badCargoArchive});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected member layout/u);
  assert.deepEqual(readFileSync(final), priorCorruptBinary);

  writeManifest(fixture, {cargoArchiveSha: sha256(fixture.linkCargoArchive)});
  result = runInstaller(fixture, 'cargo-binstall', {FAKE_CURL_SOURCE: fixture.linkCargoArchive});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a regular file/u);
  assert.deepEqual(readFileSync(final), priorCorruptBinary);

  writeManifest(fixture, {cargoMaxArchive: '1'});
  result = runInstaller(fixture, 'cargo-binstall');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds its maximum size/u);
  assert.deepEqual(readFileSync(final), priorCorruptBinary);
  assertNoInstallerDebris(fixture);
  assert.notDeepEqual(priorCorruptBinary, originalBinary);
});

test('transport failure, interruption, and promotion failure clean up and roll back', () => {
  const fixture = makeFixture();
  let result = runInstaller(fixture, 'cargo-binstall', {FAKE_CURL_MODE: 'transport'});
  assert.equal(result.status, 75);
  assert.equal(existsSync(path.join(fixture.bin, 'cargo-binstall')), false);
  assertNoInstallerDebris(fixture);

  result = runInstaller(fixture, 'cargo-binstall', {FAKE_CURL_MODE: 'interrupt'});
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(path.join(fixture.bin, 'cargo-binstall')), false);
  assertNoInstallerDebris(fixture);

  requireSuccess(runInstaller(fixture, 'cargo-binstall'), 'install before rollback fault');
  const final = path.join(fixture.bin, 'cargo-binstall');
  const marker = path.join(fixture.bin, '.cargo-binstall.oliphaunt-source');
  appendFileSync(final, '\n# force promotion\n');
  const previousBinary = readFileSync(final);
  const previousMarker = readFileSync(marker);
  result = runInstaller(fixture, 'cargo-binstall', {FAKE_MV_FAIL_TARGET: marker});
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(final), previousBinary);
  assert.deepEqual(readFileSync(marker), previousMarker);
  assertNoInstallerDebris(fixture);
});

test('Cargo fallback is exact, locked, isolated, atomic, and never reuses a partial download', () => {
  const fixture = makeFixture();
  const cargoHome = path.join(fixture.root, 'cargo-home');
  const env = environment(fixture, {
    CARGO_HOME: cargoHome,
    OLIPHAUNT_MAINTAINER_BIN_DIR: path.join(cargoHome, 'bin'),
    OLIPHAUNT_BOOTSTRAP_CARGO_BINSTALL_ONLY: '1',
    FAKE_CURL_SOURCE: fixture.cargoArchive,
    FAKE_CURL_MODE: 'transport',
  });
  const result = command('bash', [bootstrap], {cwd: ROOT, env});
  requireSuccess(result, 'locked cargo-binstall source fallback');
  const final = path.join(cargoHome, 'bin', 'cargo-binstall');
  assert.match(command(final, ['-V']).stdout, /1\.19\.1/u);
  const cargoArgs = readFileSync(fixture.cargoLog, 'utf8');
  assert.match(cargoArgs, /^install cargo-binstall --version 1\.19\.1 --locked --root \/.+/mu);
  const marker = readFileSync(path.join(cargoHome, 'bin', '.cargo-binstall.oliphaunt-source'), 'utf8');
  assert.match(marker, /source=locked-cargo-install/u);
  assert.match(marker, /source_ref=cargo-binstall@1\.19\.1/u);
  assert.doesNotMatch(readFileSync(final, 'utf8'), /partial/u);
  assertNoInstallerDebris({...fixture, bin: path.join(cargoHome, 'bin')});

  const curlBefore = readFileSync(fixture.curlLog, 'utf8');
  requireSuccess(
    command('bash', [installer, 'cargo-binstall'], {cwd: ROOT, env}),
    'locked source identity cache hit',
  );
  assert.equal(readFileSync(fixture.curlLog, 'utf8'), curlBefore);
});

test('permanent asset and integrity failures cannot bypass pinning through a source build', () => {
  for (const mode of ['http', 'oversized', 'checksum']) {
    const fixture = makeFixture();
    const mismatch = path.join(fixture.archives, 'mismatch');
    writeFileSync(mismatch, 'not the pinned release archive', 'utf8');
    const result = command('bash', [bootstrap], {
      cwd: ROOT,
      env: environment(fixture, {
        CARGO_HOME: path.join(fixture.root, 'cargo-home'),
        OLIPHAUNT_MAINTAINER_BIN_DIR: path.join(fixture.root, 'cargo-home', 'bin'),
        OLIPHAUNT_BOOTSTRAP_CARGO_BINSTALL_ONLY: '1',
        FAKE_CURL_SOURCE: mode === 'checksum' ? mismatch : fixture.cargoArchive,
        FAKE_CURL_MODE: mode === 'checksum' ? 'success' : mode,
      }),
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(fixture.cargoLog), false);
    assertNoInstallerDebris({...fixture, bin: path.join(fixture.root, 'cargo-home', 'bin')});
  }
});

test('failed locked source fallback preserves prior state', () => {
  const fixture = makeFixture();
  const cargoHome = path.join(fixture.root, 'cargo-home');
  const bin = path.join(cargoHome, 'bin');
  mkdirSync(bin, {recursive: true});
  const final = path.join(bin, 'cargo-binstall');
  const marker = path.join(bin, '.cargo-binstall.oliphaunt-source');
  executable(final, '#!/usr/bin/env bash\nprintf "%s\\n" "old install"\n');
  writeFileSync(marker, 'old marker\n');
  const previousBinary = readFileSync(final);
  const previousMarker = readFileSync(marker);
  const result = command('bash', [bootstrap], {
    cwd: ROOT,
    env: environment(fixture, {
      CARGO_HOME: cargoHome,
      OLIPHAUNT_MAINTAINER_BIN_DIR: bin,
      OLIPHAUNT_BOOTSTRAP_CARGO_BINSTALL_ONLY: '1',
      FAKE_CURL_SOURCE: fixture.cargoArchive,
      FAKE_CURL_MODE: 'transport',
      FAKE_CARGO_MODE: 'fail',
    }),
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(final), previousBinary);
  assert.deepEqual(readFileSync(marker), previousMarker);
  assertNoInstallerDebris({...fixture, bin});
});

test('actionlint uses the same verified path and has no unpinned Go fallback', () => {
  const fixture = makeFixture();
  let result = runInstaller(fixture, 'actionlint');
  requireSuccess(result, 'actionlint binary install');
  const final = path.join(fixture.bin, 'actionlint');
  assert.equal(sha256(final), fixture.actionBinarySha);
  appendFileSync(final, '\n# force refresh\n');
  const previousBinary = readFileSync(final);
  writeManifest(fixture, {actionArchiveSha: sha256(fixture.badActionArchive)});
  result = runInstaller(fixture, 'actionlint', {FAKE_CURL_SOURCE: fixture.badActionArchive});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unexpected member layout/u);
  assert.deepEqual(readFileSync(final), previousBinary);
  assertNoInstallerDebris(fixture);

  const cleanFixture = makeFixture();
  result = command('bash', [actionlintInstaller], {
    cwd: ROOT,
    env: environment(cleanFixture, {
      FAKE_CURL_SOURCE: cleanFixture.actionArchive,
      FAKE_CURL_MODE: 'transport',
    }),
  });
  assert.equal(result.status, 75);
  assert.equal(existsSync(cleanFixture.goLog), false);
  assertNoInstallerDebris(cleanFixture);
});

test('unsupported hosts fail before network access', () => {
  const fixture = makeFixture();
  const result = runInstaller(fixture, 'cargo-binstall', {FAKE_UNAME_OS: 'FreeBSD'});
  assert.equal(result.status, 69);
  assert.equal(existsSync(fixture.curlLog), false);
  assertNoInstallerDebris(fixture);
});

test('Taplo uses its locked source directly without probing cargo-quickinstall', () => {
  const text = readFileSync(bootstrap, 'utf8');
  assert.match(
    text,
    /install_cargo_tool taplo-cli taplo "\$TAPLO_VERSION" source-only/u,
  );
  assert.match(
    text,
    /if \[ "\$install_mode" = binary-first \] && has_command cargo-binstall; then/u,
  );
  assert.match(
    text,
    /elif \[ "\$install_mode" = source-only \]; then[\s\S]*no declared binary asset/u,
  );
});
