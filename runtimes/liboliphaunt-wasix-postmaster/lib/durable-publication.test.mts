import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, spyOn } from 'bun:test';
import {
  anchorDirectory,
  writePrivate,
  sourceIdentity,
  publish,
  publishSet,
  removePrivate,
  parseToken,
} from './durable-publication.mts';
async function fixture(check: (root: string, fd: number) => Promise<void> | void) {
  const previous = process.cwd(),
    root = fs.mkdtempSync(join(tmpdir(), 'durable-publication-'));
  const fd = anchorDirectory(root);
  try {
    await check(root, fd);
  } finally {
    fs.closeSync(fd);
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const bytes = Buffer.from('exact durable evidence\n');
const write = (name: string, fd: number) => writePrivate(name, [bytes], fd);
test('identified publication preserves sealed bytes and never replaces a destination or a new source generation', async () =>
  fixture(async (_root, fd) => {
    const identity = await write('pending', fd);
    assert.deepEqual(sourceIdentity('pending'), identity);
    assert.equal(fs.statSync('pending').mode & 0o7777, 0o444);
    publish('pending', 'admitted', identity, fd);
    assert(fs.readFileSync('admitted').equals(bytes));
    assert(!fs.existsSync('pending'));
    const replay = await write('pending', fd);
    assert.throws(() => publish('pending', 'admitted', replay, fd), /exists/);
    fs.renameSync('pending', 'old-pending');
    await write('pending', fd);
    assert.throws(() => publish('pending', 'other', replay, fd), /generation/);
    assert.throws(() => removePrivate('pending', replay, fd), /generation/);
    assert(fs.readFileSync('pending').equals(bytes));
    assert(!fs.existsSync('other'));
    fs.symlinkSync('admitted', 'link');
    await assert.rejects(() => write('link', fd));
    assert.throws(() => sourceIdentity('link'));
    for (const token of [
      ['0', '1', '1', 'a'.repeat(64)],
      ['1', '01', '1', 'a'.repeat(64)],
      ['1', '1', '268435457', 'a'.repeat(64)],
    ])
      assert.throws(() => parseToken(token));
  }));
test('publication stays in the opened directory when its original path is replaced', async () =>
  fixture(async (root, fd) => {
    const renamed = `${root}.renamed`;
    fs.renameSync(root, renamed);
    fs.mkdirSync(root);
    fs.writeFileSync(join(root, 'pending'), 'competitor');
    try {
      const identity = await write('pending', fd);
      publish('pending', 'admitted', identity, fd);
      assert.equal(fs.readFileSync(join(root, 'pending'), 'utf8'), 'competitor');
      assert(fs.readFileSync(join(renamed, 'admitted')).equals(bytes));
    } finally {
      // Return the fixture's original directory to its name for cleanup.
      fs.rmSync(root, { recursive: true });
      fs.renameSync(renamed, root);
    }
  }));
test('publication sets preflight conflicts, recover partial admission, and retain replaced private generations', async () =>
  fixture(async (_root, fd) => {
    const one = await write('one', fd);
    publish('one', 'first', one, fd);
    await write('one', fd);
    await write('two', fd);
    publishSet(
      [
        { source: 'one', destination: 'first' },
        { source: 'two', destination: 'second' },
      ],
      fd,
    );
    assert(!fs.existsSync('one') && !fs.existsSync('two'));
    assert(fs.readFileSync('second').equals(bytes));
    await write('one', fd);
    await write('two', fd);
    fs.writeFileSync('conflict', 'other', { mode: 0o444 });
    assert.throws(() =>
      publishSet(
        [
          { source: 'one', destination: 'missing' },
          { source: 'two', destination: 'conflict' },
        ],
        fd,
      ),
    );
    assert(!fs.existsSync('missing'));
    const realLink = fs.linkSync;
    const spy = spyOn(fs, 'linkSync').mockImplementation((source, dest) => {
      if (source === 'two') {
        fs.renameSync('two', 'original-two');
        fs.writeFileSync('two', 'replacement', { mode: 0o444 });
      }
      realLink(source, dest);
    });
    try {
      assert.throws(() =>
        publishSet(
          [
            { source: 'one', destination: 'missing' },
            { source: 'two', destination: 'third' },
          ],
          fd,
        ),
      );
      assert(fs.readFileSync('missing').equals(bytes));
      assert(!fs.existsSync('third'));
      assert.equal(fs.readFileSync('two', 'utf8'), 'replacement');
    } finally {
      spy.mockRestore();
    }
  }));
test('failed post-link synchronization rolls back only the name this publisher created', async () =>
  fixture(async (_root, fd) => {
    const realSync = fs.fsyncSync;
    for (const replace of [false, true]) {
      const expected = await write('pending', fd);
      let calls = 0;
      const spy = spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
        if (++calls === 2) {
          if (replace) {
            fs.unlinkSync('admitted');
            fs.writeFileSync('admitted', 'competitor', { mode: 0o444 });
          }
          throw Error('injected destination fsync failure');
        }
        realSync(descriptor);
      });
      try {
        assert.throws(() => publish('pending', 'admitted', expected, fd), /injected/);
      } finally {
        spy.mockRestore();
      }
      assert.equal(fs.existsSync('admitted'), replace);
      if (replace) assert.equal(fs.readFileSync('admitted', 'utf8'), 'competitor');
      removePrivate('pending', expected, fd);
    }
  }));
