import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [profile, source, directory] = Bun.argv.slice(2);
if (!['js', 'wasix-ts', 'wasix-tools'].includes(profile) || !source || !directory)
  throw new Error('Expected SDK profile, source manifest and output directory');
const inputs = process.cwd();
const staging = await mkdtemp(join(tmpdir(), 'oliphaunt-sdk-manifest-'));
try {
  // Release notice validation requires real files. Materialize only declared
  // inputs rather than weakening that boundary for Bazel's sandbox symlinks.
  const helpers = join(staging, 'tools/packaging');
  await mkdir(helpers, { recursive: true });
  for (const name of [
    'release-notices.mts',
    'release-directory-safety.mts',
    'portable-archive.mts',
  ])
    await copyFile(join(inputs, 'tools/packaging', name), join(helpers, name));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await copyFile(join(inputs, name), join(staging, name));
  const packageDirectory = join(staging, 'package');
  await mkdir(packageDirectory);
  await copyFile(source, join(packageDirectory, 'package.json'));
  if (profile === 'js') {
    await copyFile(
      join(inputs, 'tools/packaging/source-only-sdk-package.mts'),
      join(helpers, 'source-only-sdk-package.mts'),
    );
    const { prepareSourceOnlyNpmPackage, SOURCE_ONLY_NPM_PROFILES } = await import(
      pathToFileURL(join(helpers, 'source-only-sdk-package.mts')).href
    );
    prepareSourceOnlyNpmPackage(packageDirectory, SOURCE_ONLY_NPM_PROFILES.js);
  } else {
    const canonical =
      profile === 'wasix-ts'
        ? 'src/wasix/sdks/ts/tools/package.mts'
        : 'src/wasix/postgres-tools/ts/tools/package.mts';
    const projected = join(staging, canonical);
    await mkdir(join(projected, '..'), { recursive: true });
    await copyFile(join(inputs, canonical), projected);
    const canonicalWriter = await import(pathToFileURL(projected).href);
    const prepare =
      profile === 'wasix-ts'
        ? canonicalWriter.prepareWasixTypescriptPackage
        : canonicalWriter.prepareWasixToolsTypescriptPackage;
    prepare(packageDirectory);
  }
  await mkdir(directory, { recursive: true });
  for (const name of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await copyFile(join(packageDirectory, name), join(directory, name));
} finally {
  await rm(staging, { recursive: true, force: true });
}
