import assert from 'node:assert/strict';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [archive, query, consumerSource, node, compiler, acquisitionFile, typesFile] =
  Bun.argv.slice(2);
assert(archive && query && consumerSource && node && compiler && acquisitionFile && typesFile);
assert(process.env.TEST_TMPDIR && process.env.OLIPHAUNT_BAZEL_RUNFILES);
const directory = join(process.env.TEST_TMPDIR, 'native-sdk-consumer');

async function extract(file: string, destination: string, publicEnvelope = true) {
  const entries = await new Bun.Archive(await readFile(file)).files();
  assert(entries.size > 0);
  const prefix = publicEnvelope ? 'package/' : `${entries.keys().next().value?.split('/')[0]}/`;
  for (const [name, content] of entries) {
    assert(
      name.startsWith(prefix) && !name.split('/').some((part) => part === '..' || part === '.'),
    );
    const target = join(destination, name.slice(prefix.length));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await content.bytes());
  }
}

await extract(archive, join(directory, 'node_modules/@oliphaunt/ts'));
await extract(query, join(directory, 'node_modules/@oliphaunt/ts-query'));
const manifest = JSON.parse(
  await readFile(join(directory, 'node_modules/@oliphaunt/ts/package.json'), 'utf8'),
);
assert.equal(manifest.type, 'module');
assert.equal(manifest.scripts, undefined);
assert.equal(manifest.devDependencies, undefined);
assert(
  Object.values(manifest.optionalDependencies).every((version) =>
    /^\d+\.\d+\.\d+$/.test(String(version)),
  ),
);

const packages = JSON.parse(await readFile(acquisitionFile, 'utf8'));
const specification: { packages: Record<string, string>; types: Record<string, string> } =
  JSON.parse(await readFile(typesFile, 'utf8'));
const stores: Record<string, string> = {};
for (const [id, source] of Object.entries(specification.packages)) {
  assert(packages[id], `undeclared type package ${id}`);
  const destination = join(directory, '.types', id, 'node_modules', packages[id].package);
  stores[id] = destination;
  const input = join(process.env.OLIPHAUNT_BAZEL_RUNFILES, source);
  if (input.endsWith('.tgz')) await extract(input, destination, false);
  else {
    await mkdir(dirname(destination), { recursive: true });
    await cp(input, destination, { recursive: true });
  }
}
for (const [id, row] of Object.entries(packages) as [
  string,
  { package: string; dependencies: Record<string, string> },
][]) {
  assert(stores[id], `missing type package ${id}`);
  for (const [name, target] of Object.entries(row.dependencies)) {
    const link = join(stores[id], 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(stores[target], link, 'dir');
  }
}
for (const [name, id] of Object.entries(specification.types)) {
  assert(stores[id], `missing direct SDK type package ${name}`);
  const link = join(directory, 'node_modules', name);
  await mkdir(dirname(link), { recursive: true });
  await symlink(stores[id], link, 'dir');
}

const consumer = join(directory, 'consumer.mts');
const original = await readFile(consumerSource, 'utf8');
await writeFile(consumer, original);
const environment = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' };
const types = Bun.spawnSync(
  [
    node,
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
    'node,bun',
    '--strict',
    '--skipLibCheck',
    '--noEmit',
    consumer,
  ],
  {
    cwd: directory,
    env: environment,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);
assert.equal(types.exitCode, 0, 'packed SDK public type consumer failed');
const executable = join(directory, 'consumer.mjs');
await writeFile(
  executable,
  new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(original),
);
const runtime = Bun.spawnSync([node, executable], {
  cwd: directory,
  env: environment,
  stdout: 'inherit',
  stderr: 'inherit',
});
assert.equal(runtime.exitCode, 0, 'packed SDK Node consumer failed');
