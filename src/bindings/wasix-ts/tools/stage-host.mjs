import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../../..');
const source = resolve(repositoryRoot, 'target/oliphaunt-wasix-ts/host/wasmer-sdk');
const destination = resolve(packageRoot, 'lib/host');

await rm(destination, { force: true, recursive: true });
await mkdir(destination, { recursive: true });

for (const name of [
  'dist/index.mjs',
  'dist/worker.mjs',
  'dist/wasmer_js_bg.wasm',
  'LICENSE',
  'provenance.json',
]) {
  await copyFile(resolve(source, name), resolve(destination, name.replace(/^dist\//, '')));
}

console.log(`wasix-ts host stage: wrote package-relative host to ${destination}`);
