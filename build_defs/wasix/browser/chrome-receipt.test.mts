import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertChromeReceipt, captureChromeReceipt } from './chrome-receipt.mts';

test('Chrome operational receipt requires explicit image identity and binds the executable before launch', async () => {
  await expect(captureChromeReceipt('/unused', '', 'image-version')).rejects.toThrow('hostImage');
  await expect(captureChromeReceipt('/unused', 'host-image', '')).rejects.toThrow('ImageVersion');
  const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-chrome-receipt-test-'));
  try {
    const executable = join(directory, 'chrome');
    const receipt = join(directory, 'receipt.json');
    await writeFile(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    await writeFile(receipt, JSON.stringify({ executable, sha256: '0'.repeat(64) }));
    await expect(assertChromeReceipt(executable, receipt)).rejects.toThrow();
    await expect(assertChromeReceipt('relative/chrome', receipt)).rejects.toThrow('absolute');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
