import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  cargoPackageRelativePathParts,
  createDeterministicTar,
  fitCargoPayloadParts,
  packageGeneratedCargoSource,
} from './cargo-source-package.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';

function fixture(t, name) {
  const root = mkdtempSync(path.join(os.tmpdir(), `oliphaunt-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  mkdirSync(path.join(source, 'src'), { recursive: true });
  return { root, source };
}

function manifest(name, extra = []) {
  return [
    '[package]',
    `name = ${JSON.stringify(name)}`,
    'version = "0.1.0"',
    'edition = "2024"',
    'license = "MIT"',
    ...extra,
    '',
    '[lib]',
    'path = "src/lib.rs"',
    '',
  ].join('\n');
}

function packageSource(root, source, output) {
  const result = spawnSync(
    'bash',
    [
      path.join(import.meta.dirname, 'package-cargo-source.sh'),
      path.join(source, 'Cargo.toml'),
      output,
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test('payload splitting follows compressed crate size and preserves every byte', (t) => {
  const { root } = fixture(t, 'compressed-parts');
  for (const payload of [Buffer.alloc(20 * 1024 * 1024, 42), randomBytes(20 * 1024 * 1024)]) {
    const parts = fitCargoPayloadParts(
      (budget) => {
        const directories = [];
        for (let offset = 0; offset < payload.length; offset += budget) {
          const directory = path.join(root, `part-${offset}`);
          mkdirSync(directory, { recursive: true });
          writeFileSync(path.join(directory, 'payload'), payload.subarray(offset, offset + budget));
          directories.push(directory);
        }
        return directories;
      },
      (directory) => {
        const archive = `${directory}.crate`;
        writeFileSync(
          archive,
          gzipSync(
            createDeterministicTar(directory, 'part', {
              fail: (message) => {
                throw new Error(message);
              },
            }),
          ),
        );
        return archive;
      },
    );
    assert.equal(parts.length, payload[0] === 42 && payload.every((byte) => byte === 42) ? 1 : 3);
    assert.deepEqual(
      Buffer.concat(parts.map((directory) => readFileSync(path.join(directory, 'payload')))),
      payload,
    );
    for (const directory of parts)
      assert.ok(statSync(`${directory}.crate`).size <= 9 * 1024 * 1024);
  }
});

test("uses Cargo's file selection, preserves modes, and emits deterministic exact members", (t) => {
  const { root, source } = fixture(t, 'cargo-source-selection');
  writeFileSync(
    path.join(source, 'Cargo.toml'),
    manifest('selected-package', ['exclude = ["forbidden.txt", "tools/**"]']),
  );
  writeFileSync(path.join(source, 'src/lib.rs'), 'pub fn selected() {}\n');
  chmodSync(path.join(source, 'src/lib.rs'), 0o755);
  writeFileSync(path.join(source, 'forbidden.txt'), 'must not ship\n');
  mkdirSync(path.join(source, 'tools'));
  writeFileSync(path.join(source, 'tools/check.sh'), 'must not ship\n');

  const first = packageSource(root, source, path.join(root, 'first'));
  const second = packageSource(root, source, path.join(root, 'second'));
  assert.deepEqual(readFileSync(first), readFileSync(second));
  assert.equal(
    readFileSync(first).subarray(0, 10).toString('hex'),
    '1f8b0800000000000003',
    'Cargo source packages must use the canonical cross-platform gzip header',
  );

  const entries = readPortableArchiveEntries(first);
  assert.deepEqual(
    [...entries.keys()],
    ['selected-package-0.1.0/Cargo.toml', 'selected-package-0.1.0/src/lib.rs'],
  );
  const sourceMode = statSync(path.join(source, 'src/lib.rs')).mode & 0o777;
  assert.equal(entries.get('selected-package-0.1.0/src/lib.rs').mode, sourceMode);
  if (process.platform !== 'win32') {
    assert.equal(sourceMode, 0o755);
  }
});

test('fixed tar file mode is host-independent while the default preserves filesystem modes', (t) => {
  const { root } = fixture(t, 'deterministic-tar-modes');
  const stage = path.join(root, 'stage');
  mkdirSync(stage);
  const writable = path.join(stage, 'writable.txt');
  const executable = path.join(stage, 'executable.sh');
  writeFileSync(writable, 'writable\n');
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(writable, 0o666);
  chmodSync(executable, 0o755);
  assert.equal(statSync(writable).mode & 0o777, 0o666);

  const fail = (message) => {
    throw new Error(message);
  };
  const fixedArchive = path.join(root, 'fixed.tar.gz');
  writeFileSync(
    fixedArchive,
    gzipSync(createDeterministicTar(stage, 'carrier', { fail, fixedFileMode: 0o644 }), {
      mtime: 0,
    }),
  );
  const fixedEntries = readPortableArchiveEntries(fixedArchive);
  assert.deepEqual(
    [...fixedEntries].map(([name, entry]) => [name, entry.mode]),
    [
      ['carrier/executable.sh', 0o644],
      ['carrier/writable.txt', 0o644],
    ],
  );

  const defaultArchive = path.join(root, 'default.tar.gz');
  writeFileSync(
    defaultArchive,
    gzipSync(createDeterministicTar(stage, 'cargo', { fail }), { mtime: 0 }),
  );
  const defaultEntries = readPortableArchiveEntries(defaultArchive);
  assert.equal(defaultEntries.get('cargo/writable.txt').mode, statSync(writable).mode & 0o777);
  assert.equal(defaultEntries.get('cargo/executable.sh').mode, statSync(executable).mode & 0o777);
  if (process.platform !== 'win32') {
    assert.equal(defaultEntries.get('cargo/executable.sh').mode, 0o755);
  }

  assert.throws(
    () => createDeterministicTar(stage, 'invalid', { fail, fixedFileMode: 0o1000 }),
    /fixed deterministic tar file mode/u,
  );
});

test('rejects Cargo-selected symbolic links and special-file targets', (t) => {
  const linked = fixture(t, 'cargo-source-link');
  writeFileSync(path.join(linked.source, 'Cargo.toml'), manifest('linked-package'));
  writeFileSync(path.join(linked.source, 'real.rs'), 'pub fn linked() {}\n');
  rmSync(path.join(linked.source, 'src/lib.rs'), { force: true });
  symlinkSync(path.join('..', 'real.rs'), path.join(linked.source, 'src/lib.rs'));
  assert.throws(
    () => packageSource(linked.root, linked.source, path.join(linked.root, 'output')),
    /must not be a symbolic link/u,
  );

  const special = fixture(t, 'cargo-source-special');
  const fifo = path.join(special.source, 'src/lib.rs');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (created.error?.code === 'ENOENT') {
    t.diagnostic('mkfifo unavailable; special-file case skipped');
    return;
  }
  assert.equal(created.status, 0, created.stderr);
  writeFileSync(path.join(special.source, 'Cargo.toml'), manifest('special-package'));
  assert.throws(
    () => packageSource(special.root, special.source, path.join(special.root, 'output')),
    /target .* source src\/lib[.]rs is absent from Cargo's package selection/u,
  );
});

test('rejects absolute, parent, backslash, and non-portable Cargo member paths', () => {
  assert.deepEqual(cargoPackageRelativePathParts('src/lib.rs'), ['src', 'lib.rs']);
  for (const candidate of ['../escape', '/absolute', 'C:/absolute', 'src\\escape', 'bad:name']) {
    assert.throws(() => cargoPackageRelativePathParts(candidate), /Cargo package path/u);
  }
});

test('generated Cargo carriers match Cargo-selected source bytes and reject links', (t) => {
  const { root, source } = fixture(t, 'generated-cargo');
  writeFileSync(path.join(source, 'Cargo.toml'), manifest('generated-carrier'));
  writeFileSync(path.join(source, 'src/lib.rs'), 'pub const VALUE: u32 = 42;\n');
  writeFileSync(path.join(source, 'README.md'), 'Generated carrier\n');
  const actual = packageGeneratedCargoSource(
    path.join(source, 'Cargo.toml'),
    path.join(root, 'generated'),
  );
  const expected = packageSource(root, source, path.join(root, 'cargo-selected'));
  assert.deepEqual(readFileSync(actual), readFileSync(expected));
  symlinkSync('lib.rs', path.join(source, 'src/link.rs'));
  assert.throws(
    () => packageGeneratedCargoSource(path.join(source, 'Cargo.toml'), path.join(root, 'unsafe')),
    /regular files/,
  );
  assert.throws(() => createDeterministicTar(source, 'unsafe', {}), /regular files/);
});
