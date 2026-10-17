import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { materializeCompilerPackages } from './npm-archives.mts';

const [input, output, compiler, context, specificationFile, driver] = Bun.argv.slice(2);
assert(input && output && compiler && context && specificationFile && driver);
const outputPath = resolve(output);
const metadata = JSON.parse(await readFile(context, 'utf8'));
const specification: { sources: Record<string, string>; packages: Record<string, string> } =
  JSON.parse(await readFile(specificationFile, 'utf8'));
const workspace = await mkdtemp(join(dirname(outputPath), '.browser-rollup-'));
for (const [name, file] of Object.entries(specification.sources)) {
  assert(!name.startsWith('/') && !name.split('/').some((part) => part === '..' || part === '.'));
  const destination = join(workspace, name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(file, destination);
}
await cp(input, join(workspace, 'pkg'), { recursive: true, dereference: true });
await materializeCompilerPackages(metadata.acquisition, specification.packages, workspace);
const result = Bun.spawnSync([resolve(compiler), resolve(driver), workspace], {
  cwd: workspace,
  env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' },
  stdout: 'inherit',
  stderr: 'inherit',
});
assert.equal(result.exitCode, 0, 'Pinned Rollup compiler failed');
await cp(join(workspace, 'dist'), outputPath, { recursive: true, dereference: true });
