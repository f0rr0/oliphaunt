import { spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  generationIdentity,
  installedClosureIdentity,
  requiredModules,
} from './guest-build-provenance.mts';

function fixture(run: (root: string) => void) {
  const root = fs.mkdtempSync(join(tmpdir(), 'guest-provenance-'));
  try {
    for (const relative of [
      ...requiredModules,
      'share/postgresql/postgres.bki',
      'share/postgresql/nested/data.txt',
    ]) {
      fs.mkdirSync(dirname(join(root, relative)), { recursive: true });
      fs.writeFileSync(join(root, relative), `module:${relative}\n`);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('generation identity binds headers, tools, modes and contained links without changing runtime identity', () =>
  fixture((root) => {
    const runtime = installedClosureIdentity(root);
    fs.mkdirSync(join(root, 'include'));
    fs.writeFileSync(join(root, 'include/postgres.h'), 'header one');
    fs.writeFileSync(join(root, 'bin/psql'), 'client tool');
    const original = generationIdentity(root, true);
    assert.equal(generationIdentity(root), original);
    fs.writeFileSync(join(root, 'include/postgres.h'), 'header two');
    assert.notEqual(generationIdentity(root), original);
    assert.equal(installedClosureIdentity(root), runtime);
    const withHeader = generationIdentity(root);
    fs.chmodSync(join(root, 'bin/psql'), 0o755);
    assert.notEqual(generationIdentity(root), withHeader);
    fs.symlinkSync('psql', join(root, 'bin/client'));
    const withLink = generationIdentity(root, true);
    fs.unlinkSync(join(root, 'bin/client'));
    fs.symlinkSync('postgres', join(root, 'bin/client'));
    assert.notEqual(generationIdentity(root), withLink);
    fs.unlinkSync(join(root, 'bin/client'));
    fs.symlinkSync('/etc/passwd', join(root, 'bin/client'));
    assert.throws(() => generationIdentity(root), /absolute generation link/);
  }));

test('guest seal preserves the published closure hash and synchronizes files before directories', () =>
  fixture((root) => {
    const sync = fs.fsyncSync;
    const order: string[] = [];
    const spy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      order.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
      sync(fd);
    });
    try {
      const expected = 'fe88edce48c0306782f68aad3d76960909946932928142022c8c2d3e77a0f949';
      assert.equal(installedClosureIdentity(root), expected);
      assert.equal(order.length, 0);
      assert.equal(installedClosureIdentity(root, true), expected);
      assert.equal(order.filter((type) => type === 'file').length, requiredModules.length + 2);
      assert(!order.slice(order.indexOf('directory')).includes('file'));
      assert(order.filter((type) => type === 'directory').length >= 7);
    } finally {
      spy.mockRestore();
    }
  }));

test('guest seal rejects symlinked directories and non-regular share entries', () =>
  fixture((root) => {
    const directory = join(root, 'lib/postgresql');
    fs.renameSync(directory, `${directory}.actual`);
    fs.symlinkSync('postgresql.actual', directory);
    assert.throws(() => installedClosureIdentity(root, true), /non-regular guest directory/);
    fs.unlinkSync(directory);
    fs.renameSync(`${directory}.actual`, directory);
    fs.symlinkSync('postgres.bki', join(root, 'share/postgresql/alias'));
    assert.throws(() => installedClosureIdentity(root, true), /non-regular guest closure/);
  }));

test('guest seal rejects same-byte file replacement after directory synchronization', () =>
  fixture((root) => {
    const sync = fs.fsyncSync;
    let replaced = false;
    const spy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      sync(fd);
      if (!replaced && fs.fstatSync(fd).isDirectory()) {
        replaced = true;
        const postgres = join(root, 'bin/postgres');
        fs.writeFileSync(`${postgres}.replacement`, fs.readFileSync(postgres));
        fs.renameSync(`${postgres}.replacement`, postgres);
      }
    });
    try {
      assert.throws(() => installedClosureIdentity(root, true), /guest closure changed after sync/);
    } finally {
      spy.mockRestore();
    }
  }));
