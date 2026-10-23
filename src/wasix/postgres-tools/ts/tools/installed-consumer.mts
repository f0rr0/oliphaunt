import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { extractNpmPackage } from '../../../../../build_defs/wasix/browser/npm-archives.mts';
import { assertWasixToolsTypescriptNpmArchive } from './wasix-tools-typescript-package.mts';

const [specificationFile, node, compiler] = Bun.argv.slice(2);
assert(specificationFile && node && compiler);
assert(process.env.TEST_TMPDIR && process.env.OLIPHAUNT_BAZEL_RUNFILES);
const root = join(process.env.TEST_TMPDIR, 'wasix-tools-installed');
const runfiles = process.env.OLIPHAUNT_BAZEL_RUNFILES;
const specification = JSON.parse(await readFile(specificationFile, 'utf8'));
const acquisition: Record<
  string,
  { package: string; version: string; integrity: string; dependencies: Record<string, string> }
> = {};
for (const file of specification.acquisitions) {
  for (const [id, row] of Object.entries(
    JSON.parse(await readFile(join(runfiles, file), 'utf8')),
  )) {
    if (acquisition[id]) assert.deepEqual(acquisition[id], row);
    else acquisition[id] = row as (typeof acquisition)[string];
  }
}
const receipt: Record<string, string> = {};
const stores: Record<string, string> = {};
for (const [id, input] of Object.entries(specification.packages) as [string, string][]) {
  const row = acquisition[id];
  assert(row, `undeclared installed package ${id}`);
  assert.match(row.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u);
  const destination = join(root, '.packages', id, 'node_modules', row.package);
  const source = await realpath(join(runfiles, input));
  await extractNpmPackage(source, destination, { allowIdenticalAliases: true });
  const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  assert.equal(manifest.name, row.package);
  assert.equal(manifest.version, row.version);
  receipt[`${row.package}@${row.version}`] = await verifyBytes(source, destination);
  stores[id] = destination;
}
for (const [id, directory] of Object.entries(stores)) {
  for (const [name, target] of Object.entries(acquisition[id].dependencies)) {
    assert(stores[target], `missing declared installed dependency ${name}`);
    const destination = join(directory, 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(stores[target], destination, 'dir');
  }
}
for (const [name, id] of Object.entries(specification.roots) as [string, string][]) {
  assert(stores[id], `missing declared installed root ${name}`);
  const destination = join(root, 'node_modules', name);
  await mkdir(dirname(destination), { recursive: true });
  await symlink(stores[id], destination, 'dir');
}
const archives: Record<string, string> = {};
for (const [name, input] of Object.entries(specification.archives) as [string, string][]) {
  assert(!Object.hasOwn(specification.roots, name), `candidate replaces public fixture ${name}`);
  const source = await realpath(join(runfiles, input));
  archives[name] = source;
  const destination = join(root, 'node_modules', name);
  await extractNpmPackage(source, destination);
  const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name);
  receipt[`${name}@${manifest.version}`] = await verifyBytes(source, destination);
}
const tools = '@oliphaunt/wasix-tools';
const carrier = '@oliphaunt/liboliphaunt-wasix-tools';
const aot = `${carrier}-linux-x64-gnu`;
const manifest = assertWasixToolsTypescriptNpmArchive(archives[tools]);
const sdk = acquisition[specification.roots['@oliphaunt/wasix-ts']];
assert.equal(sdk.version, manifest.peerDependencies['@oliphaunt/wasix-ts']);
const runtime = Object.values(acquisition).find(
  (row) => row.package === '@oliphaunt/liboliphaunt-wasix',
);
assert(runtime);
assert.equal(runtime.version, manifest.oliphaunt.runtimeVersion);
const facadeRequire = createRequire(join(root, 'node_modules', tools, 'lib/index.js'));
assert.equal(facadeRequire.resolve(carrier), join(root, 'node_modules', carrier, 'native.js'));
assert.equal(
  facadeRequire.resolve('@oliphaunt/wasix-ts/internal/tools'),
  join(stores[specification.roots['@oliphaunt/wasix-ts']], 'lib/internal.node.js'),
);
assert.equal(
  JSON.parse(await readFile(join(root, 'node_modules', carrier, 'package.json'), 'utf8')).version,
  manifest.version,
);
const carrierRequire = createRequire(facadeRequire.resolve(carrier));
assert.equal(
  carrierRequire.resolve(`${aot}/package.json`),
  join(root, 'node_modules', aot, 'package.json'),
);
assert.equal(
  JSON.parse(await readFile(carrierRequire.resolve(`${aot}/package.json`), 'utf8')).version,
  manifest.version,
);

await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
const consumer = join(root, 'tests/installed/consumer.mts');
await mkdir(dirname(consumer), { recursive: true });
await copyFile(join(runfiles, specification.consumer), consumer);
const helper = specification.helpers.find((path: string) =>
  path.endsWith('/tests/direct-pg-dump-smoke.ts'),
);
assert(helper);
await copyFile(join(runfiles, helper), join(root, 'tests/direct-pg-dump-smoke.ts'));

const source = join(root, 'source/ts');
for (const name of ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'src/index.ts']) {
  const input = specification.helpers.find((path: string) =>
    path.endsWith(`/src/wasix/postgres-tools/ts/${name}`),
  );
  assert(input);
  const destination = join(source, name);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(runfiles, input), destination);
}
await mkdir(join(root, 'source/npm'), { recursive: true });
for (const name of ['package.json', 'index.d.ts'])
  await copyFile(join(root, 'node_modules', carrier, name), join(root, 'source/npm', name));
const environment = { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' };
function run(arguments_: string[], label: string) {
  const result = spawnSync(node, arguments_, {
    cwd: root,
    env: environment,
    timeout: 60_000,
    stdio: 'inherit',
  });
  assert.equal(result.status, 0, label);
}
run(
  [join(compiler, 'bin/tsc'), '-p', join(source, 'tsconfig.build.json')],
  'source facade must compile against the public held SDK',
);
run(
  [
    join(compiler, 'bin/tsc'),
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    '--lib',
    'ES2023,DOM',
    '--types',
    'node',
    '--strict',
    '--skipLibCheck',
    '--allowImportingTsExtensions',
    '--noEmit',
    consumer,
  ],
  'installed tools public types must compile against the public held SDK',
);
run([consumer], 'actual installed tools pg_dump/psql consumer failed');
await writeFile(join(root, 'inputs.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`installed WASIX tools with public SDK ${sdk.version}: PASS`, receipt);

async function verifyBytes(source: string, destination: string): Promise<string> {
  const hash = createHash('sha256');
  if (source.endsWith('.tgz')) {
    const bytes = await readFile(source);
    hash.update(bytes);
    for (const [name, content] of await new Bun.Archive(bytes).files()) {
      const relative = name
        .split('/')
        .slice(1)
        .filter((part) => part !== '.')
        .join('/');
      assert.deepEqual(
        await readFile(join(destination, relative)),
        Buffer.from(await content.bytes()),
      );
    }
  } else {
    await visit(source, '');
  }
  return hash.digest('hex');
  async function visit(directory: string, prefix: string) {
    for (const name of (await readdir(directory)).sort()) {
      const input = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(input);
      if (stat.isDirectory()) await visit(input, relative);
      else {
        assert(stat.isFile(), `nonregular installed input ${input}`);
        const bytes = await readFile(input);
        assert.deepEqual(await readFile(join(destination, relative)), bytes);
        hash.update(`${relative}\0${bytes.length}\0`);
        hash.update(bytes);
      }
    }
  }
}
