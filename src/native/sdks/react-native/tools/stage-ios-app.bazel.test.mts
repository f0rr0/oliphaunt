import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const inputs = process.argv.slice(2).map((file) => resolve(file));
assert.equal(inputs.length, 6, 'Expected the declared React Native helpers and metadata');
const sourceRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const scratch = await mkdtemp(join(process.env.TEST_TMPDIR ?? tmpdir(), 'rn-ios-stager-'));
const tree = join(scratch, 'workspace');
const sdk = 'src/native/sdks/react-native';
const payload = join(scratch, 'payload');
const env = { ...process.env, OLIPHAUNT_TEST_IOS_STAGE_ROOT: payload };

try {
  const sources = [
    `${sdk}/package.json`,
    `${sdk}/tools/stage-ios-app.test.mts`,
    `${sdk}/tools/stage-ios-app.mts`,
    `${sdk}/tools/native-resource-closure.mts`,
    `${sdk}/tools/verify-ios-package.mts`,
    'tools/packaging/archive-directory.mts',
    'tools/packaging/portable-archive.mts',
    'tools/packaging/testdata/tar-fixture.mts',
    'tools/packaging/testdata/zip-fixture.mts',
  ];
  const generated = [
    // The existing fixture imports this CJS helper under its authored name.
    // Preserve the built File's bytes while giving it the fixture's local path.
    `${sdk}/app.plugin.cts`,
    `${sdk}/tools/stage-ios-app.mjs`,
    `${sdk}/tools/native-resource-closure.mjs`,
    `${sdk}/tools/verify-ios-package.mjs`,
    `${sdk}/src/generated/extensions.json`,
    `${sdk}/src/generated/ios-static-dependencies.json`,
  ];
  for (const [source, relative] of [
    ...sources.map((relative) => [join(sourceRoot, relative), relative]),
    ...generated.map((relative, index) => [inputs[index], relative]),
  ]) {
    const destination = join(tree, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const run = (relative, args = []) =>
    Bun.spawnSync(
      [process.execPath, '--no-install', '--no-env-file', join(tree, relative), ...args],
      {
        cwd: tree,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
  for (const [relative, args] of [
    [`${sdk}/tools/stage-ios-app.test.mts`, []],
    [
      `${sdk}/tools/verify-ios-package.mjs`,
      ['--payload-dir', join(payload, 'consumer/ios/oliphaunt')],
    ],
  ]) {
    const result = run(relative, args);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    process.stdout.write(result.stdout);
  }
  const tampered = run(`${sdk}/tools/verify-ios-package.mjs`, [
    '--payload-dir',
    join(payload, 'tampered-legal-notice-output'),
  ]);
  assert.notEqual(tampered.exitCode, 0, 'Tampered legal notice unexpectedly verified');
  assert.match(tampered.stderr.toString(), /does not exactly index the frozen legal selection/u);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
