import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractNpmPackage } from '../../../../../build_defs/wasix/browser/npm-archives.mts';
import { readPortableArchiveEntries } from '../../../../../tools/packaging/portable-archive.mts';

const [archive, query, sourceManifest, node, typescript, specificationFile] = Bun.argv.slice(2);
assert(archive && query && sourceManifest && node && typescript && specificationFile);
assert(process.env.TEST_TMPDIR && process.env.OLIPHAUNT_BAZEL_RUNFILES);
const root = join(process.env.TEST_TMPDIR, 'react-native-installed-consumer');
const specification = JSON.parse(await readFile(specificationFile, 'utf8'));
const canonical = JSON.parse(await readFile(sourceManifest, 'utf8'));
const installed = join(root, 'node_modules/@oliphaunt/react-native');
await mkdir(root, { recursive: true });
const installedArchive = join(root, 'react-native.tgz');
await copyFile(archive, installedArchive);
const entries = [...readPortableArchiveEntries(installedArchive).values()];
assert(entries.length > 0);
assert(
  !entries.some((entry) => /\.(?:so|a|node|dylib|dll)$/u.test(entry.name)),
  'Source envelope must omit compiled native payload',
);
await extractNpmPackage(installedArchive, installed);
await extractNpmPackage(query, join(root, 'node_modules/@oliphaunt/ts-query'));
const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
assert.equal(manifest.name, specification.name);
assert.equal(manifest.version, specification.version);
assert.deepEqual(manifest.oliphaunt, canonical.oliphaunt);
assert.deepEqual(manifest.dependencies, canonical.dependencies);
assert.deepEqual(manifest.peerDependencies, canonical.peerDependencies);
assert.deepEqual(manifest.scripts, {
  'package:verify-ios': 'node ./tools/verify-ios-package.mjs --package-dir .',
});
assert.equal(manifest.devDependencies, undefined);
const stores: Record<string, string> = {};
for (const [id, row] of Object.entries(specification.packages) as [
  string,
  { package: string; source: string },
][]) {
  const destination = join(root, '.compiler', id, 'node_modules', row.package);
  stores[id] = destination;
  await extractNpmPackage(join(process.env.OLIPHAUNT_BAZEL_RUNFILES, row.source), destination, {
    allowIdenticalAliases: true,
  });
}
for (const [id, row] of Object.entries(specification.packages) as [
  string,
  { dependencies: Record<string, string> },
][]) {
  for (const [name, dependency] of Object.entries(row.dependencies)) {
    assert(stores[dependency], `Missing declared dependency ${name}`);
    const link = join(stores[id], 'node_modules', name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(stores[dependency], link, 'dir');
  }
}
for (const [name, id] of Object.entries(specification.roots) as [string, string][]) {
  const link = join(root, 'node_modules', name);
  await mkdir(dirname(link), { recursive: true });
  await symlink(stores[id], link, 'dir');
}
function run(script: string, args: string[], cwd = root) {
  const execution = Bun.spawnSync([node, script, ...args], {
    cwd,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(execution.exitCode, 0, `Installed consumer failed: ${script}`);
}
const consumer = join(root, 'consumer.ts');
await writeFile(
  consumer,
  `
import Oliphaunt, { directory, applicationData, type OliphauntClient, type OliphauntDatabase } from '@oliphaunt/react-native';
import { extensions } from '@oliphaunt/react-native/extensions';
const client: OliphauntClient = Oliphaunt;
const storage = [directory('file:///data/db'), applicationData('main')];
async function query(db: OliphauntDatabase) { return db.query('SELECT 42', [], { rowMode: 'array' }); }
void [client, storage, extensions.hstore, query];
`,
);
run(join(typescript, 'bin/tsc'), [
  '--module',
  'ESNext',
  '--moduleResolution',
  'Bundler',
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
]);
const javascript = join(root, 'consumer.cjs');
await writeFile(
  javascript,
  `
const assert = require('node:assert/strict');
const { directory, applicationData } = require('@oliphaunt/react-native/storage');
const { extensions } = require('@oliphaunt/react-native/extensions');
assert.deepEqual(directory('file:///data/my%20db'), { kind: 'directory', path: '/data/my db' });
assert.deepEqual(applicationData('primary'), { kind: 'applicationData', name: 'primary' });
assert.throws(() => directory('https://example.invalid/db'), /filesystem path or local file URI/);
assert(extensions.hstore);
assert.equal(typeof require('./node_modules/@oliphaunt/react-native/app.plugin.js'), 'function');
assert.equal(typeof require('./node_modules/@oliphaunt/react-native/react-native.config.js'), 'object');
`,
);
run(javascript, []);
run(join(installed, 'tools/verify-ios-package.mjs'), ['--package-dir', installed]);
run(join(installed, 'tools/stage-ios-app.mjs'), ['--help']);
const schema = join(root, 'schema.json');
run(
  join(installed, 'tools/codegen-check.cjs'),
  [schema, 'src/specs/NativeOliphaunt.ts'],
  installed,
);
const generated = JSON.parse(await readFile(schema, 'utf8'));
assert.equal(Object.keys(generated.modules).length, 1);
assert.equal(Object.values(generated.modules)[0].type, 'NativeModule');
console.log(
  'Installed React Native source package: public types, CommonJS helpers, iOS verifier/stager and real codegen passed; native TurboModule execution requires installed mobile app',
);
