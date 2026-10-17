import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [, , metadata, output, ...artifacts] = process.argv;
const receipt = await Bun.file(metadata).json();
receipt.stdlib = await Promise.all(
  artifacts.sort().map(async (path) => ({
    path: `lib/rustlib/${receipt.target}/lib/${basename(path)}`,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
  })),
);
await Bun.write(output, `${JSON.stringify(receipt)}\n`);
