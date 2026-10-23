import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [archivePath, consumerPath, node] = process.argv.slice(2);
assert(archivePath && consumerPath && node && process.env.TEST_TMPDIR);
const directory = join(process.env.TEST_TMPDIR, 'query-consumer');
const packageDirectory = join(directory, 'node_modules', '@oliphaunt', 'ts-query');
const files = await new Bun.Archive(await readFile(archivePath)).files();
for (const [path, content] of files) {
  assert(path.startsWith('package/') && !path.split('/').includes('..'));
  const destination = join(packageDirectory, path.slice('package/'.length));
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, await content.bytes());
}
const consumer = join(directory, 'consumer.mjs');
const source = new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(
  await readFile(consumerPath, 'utf8'),
);
await writeFile(consumer, source);
const result = Bun.spawnSync([node, consumer], {
  cwd: directory,
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
});
assert.equal(result.exitCode, 0, 'packed query consumer failed');
