import { afterEach, expect, it } from 'bun:test';
import {
  emptyOpfsJournal,
  OpfsJournal,
  openOpfsAccess,
  readOpfsJournal,
} from '../storage/opfs-journal.js';
import { installOpfs, type FakeIo } from './opfs-test-helpers.js';
import { restoreGlobals } from './test-globals.js';

afterEach(() => restoreGlobals());

it('retains a complete committed view at every interrupted append byte', async () => {
  const metadata = { upsert: [], deleted: [], images: [{ backing: 'test', length: 3 }] };
  const payload = Uint8Array.of(7, 8, 9);
  const appendBytes =
    24 + new TextEncoder().encode(JSON.stringify(metadata)).byteLength + payload.byteLength + 24;
  for (let cut = 0; cut <= appendBytes; cut++) {
    const io: FakeIo = {};
    const root = installOpfs(io);
    const file = await root.getFileHandle('j-test', { create: true });
    const writable = await file.createWritable();
    await writable.write(emptyOpfsJournal());
    await writable.close();
    const journal = new OpfsJournal(await openOpfsAccess(file.asHandle()));
    journal.append({ previous: true }, []);
    io.journalWriteBudget = cut;
    let interrupted = false;
    try {
      journal.append(metadata, [payload]);
    } catch (error) {
      interrupted = true;
      expect(String(error)).toContain('interrupted journal write');
    }
    expect(interrupted).toBe(cut < appendBytes);
    journal.close();
    const frames = [];
    for await (const frame of readOpfsJournal(file.asHandle())) frames.push(frame);
    expect(frames[0]?.metadata).toEqual({ previous: true });
    expect([1, 2]).toContain(frames.length);
    if (frames.length === 2) {
      expect(frames[1]?.metadata).toEqual(metadata);
      expect(frames[1]?.data).toEqual(payload);
    }
    restoreGlobals();
  }
});

it('rejects damaged committed data rather than resetting the database', async () => {
  const file = await installOpfs().getFileHandle('j-test', { create: true });
  const writable = await file.createWritable();
  await writable.write(emptyOpfsJournal());
  await writable.close();
  const access = await openOpfsAccess(file.asHandle());
  const journal = new OpfsJournal(access);
  journal.append({ value: 1 }, [Uint8Array.of(7)]);
  access.write(Uint8Array.of(0), { at: access.getSize() - 1 });
  journal.close();
  await expect(async () => {
    for await (const _frame of readOpfsJournal(file.asHandle())) {
    }
  }).toThrow('invalid committed metadata');
});

it('retains either complete view at every interrupted redundant-log reset byte', async () => {
  for (let cut = 0; cut <= 48; cut++) {
    const io: FakeIo = {};
    const file = await installOpfs(io).getFileHandle('j-test', { create: true });
    const writable = await file.createWritable();
    await writable.write(emptyOpfsJournal());
    await writable.close();
    const journal = new OpfsJournal(await openOpfsAccess(file.asHandle()));
    journal.append({ temporaryCreate: true }, []);
    journal.append({ temporaryDelete: true }, []);
    io.journalWriteBudget = cut;
    try {
      journal.resetRedundant();
    } catch (error) {
      expect(String(error)).toContain('interrupted journal write');
    }
    journal.close();
    const frames = [];
    for await (const frame of readOpfsJournal(file.asHandle())) frames.push(frame);
    expect([0, 2]).toContain(frames.length);
    if (frames.length === 2) expect(frames[1]?.metadata).toEqual({ temporaryDelete: true });
    restoreGlobals();
  }
});
