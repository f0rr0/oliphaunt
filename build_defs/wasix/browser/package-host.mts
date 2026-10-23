import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { materializeCompilerPackages } from './npm-archives.mts';
import { HOST_FILES, nativeBrowserHostProvenance } from './provenance.mts';

const [
  dist,
  curated,
  license,
  stdReceipt,
  context,
  node,
  nodeVersionFile,
  specificationFile,
  driver,
  output,
] = Bun.argv.slice(2);
assert(
  dist &&
    curated &&
    license &&
    stdReceipt &&
    context &&
    node &&
    nodeVersionFile &&
    specificationFile &&
    driver &&
    output,
);
const metadata = JSON.parse(await readFile(context, 'utf8'));
const std = JSON.parse(await readFile(stdReceipt, 'utf8'));
const specification = JSON.parse(await readFile(specificationFile, 'utf8'));
const destination = resolve(output);
const workspace = await mkdtemp(join(dirname(destination), '.browser-host-abi-'));
await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n');
await cp(dist, join(workspace, 'generated'), { recursive: true, dereference: true });
await mkdir(join(workspace, 'curated'));
await cp(curated, join(workspace, 'curated/index.d.mts'), { dereference: true });
await materializeCompilerPackages(metadata.acquisition, specification.packages, workspace);
const check = Bun.spawnSync([resolve(node), resolve(driver), workspace], {
  cwd: workspace,
  env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' },
  stdout: 'inherit',
  stderr: 'inherit',
});
assert.equal(
  check.exitCode,
  0,
  'Generated browser host ABI differs from curated package declaration',
);
const checked = JSON.parse(await readFile(join(workspace, 'abi-check.json'), 'utf8'));
const nodeVersion = (await readFile(nodeVersionFile, 'utf8')).trim();
assert.equal(checked.compatible, true);
assert.equal(
  checked.typescriptVersion,
  metadata.acquisition.packages[metadata.acquisition.roots.typescript].version,
);
assert.equal(checked.nodeVersion, nodeVersion);
const files: Record<string, Uint8Array> = {};
for (const name of HOST_FILES)
  files[name] = await readFile(
    name === 'index.d.mts' ? curated : name === 'LICENSE' ? license : join(dist, name),
  );
const provenance = nativeBrowserHostProvenance(
  metadata,
  files,
  await readFile(join(dist, 'index.d.mts')),
  std,
  nodeVersion,
);
await mkdir(destination, { recursive: true });
for (const name of HOST_FILES) await writeFile(join(destination, name), files[name]);
await writeFile(join(destination, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
