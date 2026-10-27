import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, output] = Bun.argv.slice(2);
assert(source && output);
const stage = await mkdtemp(join(tmpdir(), 'oliphaunt-rn-manifest-'));
try {
  const helpers = join(stage, 'tools/packaging');
  await mkdir(helpers, { recursive: true });
  for (const file of [
    'source-only-sdk-package.mts',
    'release-notices.mts',
    'release-directory-safety.mts',
    'portable-archive.mts',
  ])
    await copyFile(join('tools/packaging', file), join(helpers, file));
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(file, join(stage, file));
  const directory = join(stage, 'package');
  await mkdir(directory);
  await copyFile(source, join(directory, 'package.json'));
  const { prepareSourceOnlyNpmPackage, SOURCE_ONLY_NPM_PROFILES } = await import(
    pathToFileURL(join(helpers, 'source-only-sdk-package.mts')).href
  );
  prepareSourceOnlyNpmPackage(directory, SOURCE_ONLY_NPM_PROFILES['react-native']);
  await mkdir(output, { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await copyFile(join(directory, file), join(output, file));
} finally {
  await rm(stage, { recursive: true, force: true });
}
