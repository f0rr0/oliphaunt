import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [file] = process.argv.slice(2);
assert(file && process.env.TEST_TMPDIR && process.env.OLIPHAUNT_BAZEL_RUNFILES);
const inputs = JSON.parse(readFileSync(file, 'utf8')) as {
  sdk: string;
  configuration: string | null;
  sources: Record<string, string>;
  packageManifests: string[];
  tests: string[];
  packages: Array<{ name: string; version: string; archive: string }>;
};
const root = path.join(process.env.TEST_TMPDIR, 'sdk-unit-source');
const runfiles = process.env.OLIPHAUNT_BAZEL_RUNFILES;
function relative(value: string): string {
  assert(
    value &&
      !path.isAbsolute(value) &&
      !value.includes('\\') &&
      !value.split('/').some((part) => !part || part === '.' || part === '..'),
  );
  return value;
}
for (const [destination, source] of Object.entries(inputs.sources)) {
  const output = path.join(root, relative(destination));
  mkdirSync(path.dirname(output), { recursive: true });
  // Each File becomes a regular module; Bun must not import undeclared siblings through a source symlink.
  copyFileSync(path.join(runfiles, relative(source)), output);
}
const sdk = path.join(root, relative(inputs.sdk));
for (const source of inputs.packageManifests) {
  const manifest = JSON.parse(readFileSync(path.join(root, relative(source)), 'utf8'));
  const destination = path.join(sdk, 'node_modules', relative(manifest.name), 'package.json');
  mkdirSync(path.dirname(destination), { recursive: true });
  // Existing resolver units create their own dummy payloads from this authored metadata.
  // This is neither an installed native carrier nor a publication qualification.
  copyFileSync(path.join(root, source), destination);
}
for (const dependency of inputs.packages) {
  const directory = path.join(sdk, 'node_modules', relative(dependency.name));
  const entries = await new Bun.Archive(
    readFileSync(path.join(runfiles, relative(dependency.archive))),
  ).files();
  assert(entries.size, `empty declared package ${dependency.name}`);
  for (const [name, content] of entries) {
    assert(
      name.startsWith('package/'),
      `package ${dependency.name} lacks its conventional npm prefix`,
    );
    const target = path.join(directory, relative(name.slice('package/'.length)));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, await content.bytes());
  }
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, dependency.name);
  assert.equal(manifest.version, dependency.version);
}
const configuration = inputs.configuration
  ? path.join(root, relative(inputs.configuration))
  : path.join(sdk, 'unit-bunfig.toml');
if (!inputs.configuration) writeFileSync(configuration, '');
assert(inputs.tests.length > 0, 'SDK unit root must include source-owned behavioral tests');
const tests = inputs.tests.map((test) => {
  assert(
    (test.startsWith(`${inputs.sdk}/src/__tests__/`) || test.startsWith(`${inputs.sdk}/tools/`)) &&
      /\.test\.(?:ts|mts)$/u.test(test),
  );
  assert(Object.hasOwn(inputs.sources, test));
  return path.join(root, relative(test));
});
const result = Bun.spawnSync(
  [
    process.execPath,
    'test',
    '--no-install',
    '--no-env-file',
    `--config=${configuration}`,
    '--isolate',
    '--timeout=30000',
    ...tests,
  ],
  {
    cwd: sdk,
    env: {
      ...process.env,
      NODE_PATH: '',
      NODE_OPTIONS: '',
      XDG_CACHE_HOME: path.join(process.env.TEST_TMPDIR, 'cache'),
      TMPDIR: process.env.TEST_TMPDIR,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
assert.equal(result.exitCode, 0, 'source-owned SDK unit suite failed');
const summary = `${result.stdout.toString()}\n${result.stderr.toString()}`.match(
  /Ran (\d+) tests? across (\d+) files?/u,
);
assert(
  summary && Number(summary[1]) > 0 && Number(summary[2]) === inputs.tests.length,
  'every declared SDK unit file must execute',
);
console.log(
  `Source SDK units: ${summary[1]} cases across all ${summary[2]} declared files; no runtime producer inputs`,
);
