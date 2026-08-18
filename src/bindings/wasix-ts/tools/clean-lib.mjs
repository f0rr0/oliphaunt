import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(packageRoot, 'lib');
if (dirname(output) !== packageRoot) {
  throw new Error(`refusing to clean unexpected TypeScript output path ${output}`);
}
await rm(output, { force: true, recursive: true });
