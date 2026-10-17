import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const isElf = (bytes: Buffer) => bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));

async function hostRuntime() {
  return {
    platform: platform(),
    arch: arch(),
    kernel: release(),
    osReleaseSha256: sha256(await readFile('/etc/os-release')),
  };
}

async function version(executable: string) {
  const result = Bun.spawnSync([executable, '--version'], {
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' },
  });
  assert.equal(result.exitCode, 0, 'Chrome did not report its actual version');
  return result.stdout.toString().trim();
}

async function findChrome(selected?: string) {
  // Use the existing browser smoke candidate order, then identify its real ELF.
  for (const candidate of [
    selected ?? process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) {
    if (!candidate) continue;
    try {
      const executable = await realpath(candidate);
      if (isElf(await readFile(executable))) return executable;
      for (const binary of [join(dirname(executable), 'chrome'), '/usr/lib/chromium/chromium']) {
        try {
          const actual = await realpath(binary);
          if (isElf(await readFile(actual))) return actual;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        }
      }
      assert(!selected, 'Selected Chrome must identify its actual Linux ELF executable');
    } catch (cause) {
      if (selected || (cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  throw new Error('Browser qualification requires an installed Chrome/Chromium executable');
}

export async function captureChromeReceipt(
  output: string,
  hostImage: string,
  imageVersion: string,
  selected?: string,
) {
  assert(hostImage?.trim() && imageVersion?.trim(), 'Expected explicit hostImage and ImageVersion');
  const executable = await findChrome(selected);
  const receipt = {
    executable,
    sha256: sha256(await readFile(executable)),
    version: await version(executable),
    hostImage,
    imageVersion,
    hostRuntime: await hostRuntime(),
  };
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function assertChromeReceipt(chromePath: string, file: string) {
  assert(resolve(chromePath) === chromePath, 'Chrome executable must be an absolute path');
  const executable = await realpath(chromePath);
  const bytes = await readFile(executable);
  assert(isElf(bytes), 'Chrome must identify the actual Linux ELF executable');
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(receipt.executable, executable);
  assert.equal(receipt.sha256, sha256(bytes));
  assert(
    receipt.hostImage?.trim() && receipt.imageVersion?.trim(),
    'Chrome requires explicit hostImage and ImageVersion',
  );
  assert.deepEqual(receipt.hostRuntime, await hostRuntime());
  assert.equal(receipt.version, await version(executable));
  return receipt;
}

if (import.meta.main) {
  const [output, hostImage, imageVersion, selected] = Bun.argv.slice(2);
  assert(
    output && hostImage && imageVersion,
    'Expected receipt.json hostImage ImageVersion [Chrome executable]',
  );
  console.log((await captureChromeReceipt(output, hostImage, imageVersion, selected)).executable);
}
