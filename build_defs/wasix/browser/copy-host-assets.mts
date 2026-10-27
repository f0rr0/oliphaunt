import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { HOST_FILES } from './provenance.mts';

const [source, ...outputs] = Bun.argv.slice(2);
const names = [...HOST_FILES, 'provenance.json'];
assert.deepEqual(
  outputs.map((file) => basename(file)),
  names,
);
assert.deepEqual((await readdir(source)).sort(), [...names].sort());
for (const output of outputs) {
  await mkdir(dirname(output), { recursive: true });
  await copyFile(join(source, basename(output)), output);
}
