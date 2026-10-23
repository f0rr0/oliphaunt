import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assertChromeReceipt } from './chrome-receipt.mts';
import { extractNpmPackage } from './npm-archives.mts';
import { assertNativeBrowserHostProvenance, HOST_FILES } from './provenance.mts';

const [mode, specificationFile, acquisitionFile, node, driver, ...arguments_] = Bun.argv.slice(2);
assert(
  ['tools', 'package', 'archives'].includes(mode) &&
    specificationFile &&
    acquisitionFile &&
    node &&
    driver,
);
const directory = await mkdtemp(
  join(process.env.TEST_TMPDIR ?? tmpdir(), 'oliphaunt-browser-consumer-'),
);
const specification = JSON.parse(await readFile(specificationFile, 'utf8'));
const acquisition = JSON.parse(await readFile(acquisitionFile, 'utf8'));
const runfiles = process.env.OLIPHAUNT_BAZEL_RUNFILES;
assert(runfiles);
if (specification.runtimeAcquisition) {
  const runtime = JSON.parse(
    await readFile(join(runfiles, specification.runtimeAcquisition), 'utf8'),
  );
  for (const [id, row] of Object.entries(runtime)) {
    if (acquisition[id]) assert.deepEqual(acquisition[id], row);
    else acquisition[id] = row;
  }
}
const stores: Record<string, string> = {};
assert.deepEqual(Object.keys(specification.packages).sort(), Object.keys(acquisition).sort());
for (const [id, source] of Object.entries(specification.packages) as [string, string][]) {
  const row = acquisition[id];
  const destination = join(directory, '.compiler', id, 'node_modules', row.package);
  await extractNpmPackage(join(runfiles, source), destination, { allowIdenticalAliases: true });
  const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
  assert.equal(manifest.name, row.package);
  assert.equal(manifest.version, row.version);
  if (row.package === '@esbuild/linux-x64') await chmod(join(destination, 'bin/esbuild'), 0o755);
  stores[id] = destination;
}
for (const [id, row] of Object.entries(acquisition) as [
  string,
  { dependencies: Record<string, string> },
][]) {
  for (const [name, dependency] of Object.entries(row.dependencies)) {
    assert(stores[dependency], `missing consumer compiler dependency ${name}`);
    const destination = join(stores[id], 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(stores[dependency], destination, 'dir');
  }
}
for (const [name, id] of Object.entries(specification.roots) as [string, string][]) {
  assert(stores[id], `missing consumer compiler ${name}`);
  const destination = join(directory, 'node_modules', name);
  await mkdir(dirname(destination), { recursive: true });
  await symlink(stores[id], destination, 'dir');
}

function run(script: string, parameters: string[], environment = {}) {
  const result = Bun.spawnSync([node, script, ...parameters], {
    cwd: directory,
    env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '', ...environment },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  assert.equal(result.exitCode, 0, 'actual browser consumer failed');
}

if (mode === 'tools') {
  const destination = join(directory, 'tool-smoke.mts');
  await copyFile(driver, destination);
  run(destination, []);
} else {
  const [frozenConsumer, cdp, extensions, ...suppliedArchives] =
    mode === 'archives'
      ? arguments_
      : [...arguments_.slice(3, 6), ...arguments_.slice(0, 3), ...arguments_.slice(6)];
  const [sdk, query, runtime, suppliedChromePath, suppliedReceiptFile] =
    mode === 'archives'
      ? [
          suppliedArchives[0],
          suppliedArchives[2],
          suppliedArchives[4],
          ...suppliedArchives.slice(6),
        ]
      : suppliedArchives;
  const chromePath = suppliedChromePath ?? process.env.OLIPHAUNT_BROWSER_CHROME;
  const receiptFile = suppliedReceiptFile ?? process.env.OLIPHAUNT_BROWSER_CHROME_RECEIPT;
  assert(
    sdk && query && runtime && frozenConsumer && cdp && extensions && chromePath && receiptFile,
    'Expected actual SDK/query/runtime archives, existing browser fixture, explicit Chrome executable and host receipt',
  );
  const receipt = await assertChromeReceipt(chromePath, receiptFile);
  await writeFile(
    join(directory, 'chrome-host-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  const archives: Record<string, { path: string; sha256: string }> = {};
  for (const [index, name, archive] of [
    [0, '@oliphaunt/wasix-ts', sdk],
    [1, '@oliphaunt/ts-query', query],
    [2, '@oliphaunt/liboliphaunt-wasix', runtime],
  ] as const) {
    const actual = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    if (mode === 'archives') {
      assert.equal(
        resolve(archive),
        archive,
        `Expected absolute producer archive path for ${name}`,
      );
      const expected = suppliedArchives[index * 2 + 1];
      assert.match(expected, /^[a-f0-9]{64}$/u, `Expected producer SHA256 for ${name}`);
      assert.equal(actual, expected, `Actual producer archive changed: ${name}`);
    }
    archives[name] = { path: archive, sha256: actual };
  }

  for (const [name, archive] of [
    ['@oliphaunt/wasix-ts', sdk],
    ['@oliphaunt/ts-query', query],
    ['@oliphaunt/liboliphaunt-wasix', runtime],
  ])
    await extractNpmPackage(archive, join(directory, 'node_modules', name));
  const manifest = JSON.parse(
    await readFile(join(directory, 'node_modules/@oliphaunt/wasix-ts/package.json'), 'utf8'),
  );
  assert.deepEqual(
    manifest,
    JSON.parse(await readFile(join(runfiles, specification.manifest), 'utf8')),
    'Actual SDK archive manifest differs from its canonical formatter output',
  );
  assert.equal(manifest.name, '@oliphaunt/wasix-ts');
  const host = join(directory, 'node_modules/@oliphaunt/wasix-ts/lib/host');
  assertNativeBrowserHostProvenance(
    JSON.parse(await readFile(join(host, 'provenance.json'), 'utf8')),
    {
      files: Object.fromEntries(
        await Promise.all(HOST_FILES.map(async (name) => [name, await readFile(join(host, name))])),
      ),
    },
  );
  for (const name of ['@oliphaunt/ts-query', '@oliphaunt/liboliphaunt-wasix']) {
    const dependency = JSON.parse(
      await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'),
    );
    assert.equal(dependency.name, name);
    assert.equal(dependency.version, manifest.dependencies[name]);
  }
  for (const [name, id] of Object.entries(specification.runtime) as [string, string][]) {
    const source = acquisition[id];
    assert.equal(source.package, name);
    assert.equal(source.version, manifest.dependencies[name]);
    const destination = join(directory, 'node_modules', name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(stores[id], destination, 'dir');
  }
  await copyFile(frozenConsumer, join(directory, 'consume.mts'));
  await copyFile(cdp, join(directory, 'browser-cdp.mts'));
  await copyFile(extensions, join(directory, 'extensions.mts'));
  for (const [name, source] of Object.entries(specification.storageFixtures) as [
    string,
    string,
  ][]) {
    await copyFile(join(runfiles, source), join(directory, name));
  }
  await mkdir(join(directory, 'public/wasix-assets'), { recursive: true });
  await copyFile(
    join(runfiles, specification.seedArchive),
    join(directory, 'public/wasix-assets/cluster-seed-standard'),
  );
  await copyFile(
    join(runfiles, specification.seedManifest),
    join(directory, 'public/wasix-assets/cluster-seed-standard-manifest'),
  );
  run(join(directory, 'consume.mts'), [directory, '[]', '--opfs'], {
    OLIPHAUNT_BROWSER_CHROME: receipt.executable,
  });
  const proof = join(directory, 'browser-consumer-receipt.json');
  await writeFile(
    proof,
    `${JSON.stringify({ archives, chrome: receipt, exports: ['default', 'worker'], sql: 'SELECT 42::int AS answer', answers: ['42', '42'], opfs: { answers: '1,2,3', transport: 'synchronous-access', crashAnswer: '73', crashRelations: '48' } }, null, 2)}\n`,
  );
  console.log(
    `Browser default and worker SQL qualified with ${receipt.version} on ${receipt.hostImage}`,
  );
  console.log(proof);
}
