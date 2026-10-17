import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { extractNpmPackage } from '../../../../../build_defs/wasix/browser/npm-archives.mts';

const [archive, specificationFile, output] = Bun.argv.slice(2);
assert(archive && specificationFile && output);
const specification: Record<string, string> = JSON.parse(await readFile(specificationFile, 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-rn-bundle-'));
try {
  const tool = join(directory, 'compiler');
  await extractNpmPackage(archive, tool);
  for (const [relative, source] of Object.entries(specification)) {
    assert(
      !relative.startsWith('/') &&
        !relative.split('/').some((part) => part === '..' || part === '.' || !part),
    );
    const destination = join(directory, relative);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  const binary = join(tool, 'bin', process.platform === 'win32' ? 'esbuild.exe' : 'esbuild');
  await chmod(binary, 0o755);
  const result = Bun.spawnSync(
    [
      binary,
      'src/native/sdks/react-native/tools/stage-ios-app.mts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=es2022',
      '--external:node:*',
      `--outfile=${resolve(output)}`,
    ],
    {
      cwd: directory,
      env: { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  assert.equal(result.exitCode, 0, 'Declared esbuild helper compilation failed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
