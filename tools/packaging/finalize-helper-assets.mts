import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  artifactTargets,
  compareText,
  currentProductVersionSync,
  expectedAssets,
} from '../release/release-artifact-targets.mts';
import { writeChecksumManifest } from './write-checksum-manifest.mts';

export function assertExactFilenames(actual, expected, label) {
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify([...actual].sort(compareText)) !==
      JSON.stringify([...expected].sort(compareText))
  )
    throw new Error(
      `${label} must be exact: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`,
    );
}

export function exactRegularDirectoryFilenames(directory, label) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const invalid = entries
    .filter((entry) => !entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareText);
  if (invalid.length)
    throw new Error(`${label} must contain only regular non-symlink files: ${invalid.join(', ')}`);
  return entries.map((entry) => entry.name).sort(compareText);
}

// Each producer owns its validator; this shared step only assembles the complete
// downloaded target set and returns the files for that producer to validate.
export async function finalizeHelperAssets(product, kind, argv, { assetDir, npmPackageDir }) {
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--aggregate') continue;
    if (
      !['--asset-dir', '--npm-package-dir'].includes(flag) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--')
    )
      throw new Error(`unsupported aggregate option: ${flag}`);
    if (flag === '--asset-dir') assetDir = argv[++index];
    else {
      if (npmPackageDir === undefined)
        throw new Error(`${product} has no optional npm package directory`);
      npmPackageDir = argv[++index];
    }
  }
  assetDir = path.resolve(assetDir);
  const version = currentProductVersionSync(product);
  const expected = expectedAssets(product, kind, version, 'finalize-helper-assets');
  const actual = exactRegularDirectoryFilenames(assetDir, `${product} aggregate asset directory`);
  const payloads = expected.filter((name) => !name.endsWith('.sha256'));
  const checksums = expected.filter((name) => name.endsWith('.sha256'));
  assertExactFilenames(
    actual.filter((name) => !checksums.includes(name)),
    payloads,
    `${product} aggregate payloads`,
  );
  const result = ['--asset-dir', assetDir];
  if (npmPackageDir !== undefined) {
    npmPackageDir = path.resolve(npmPackageDir);
    const names = artifactTargets(product, kind, 'finalize-helper-assets').map((target) => {
      if (!target.npmPackage) throw new Error(`${target.id} must declare an npm package`);
      return `${target.npmPackage.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`;
    });
    assertExactFilenames(
      exactRegularDirectoryFilenames(npmPackageDir, `${product} npm package directory`),
      names,
      `${product} optional npm packages`,
    );
    for (const name of names.sort(compareText))
      result.push('--npm-package', path.join(npmPackageDir, name));
  }
  await writeChecksumManifest([
    '--asset-dir',
    assetDir,
    '--output',
    `${product}-${version}-release-assets.sha256`,
    '--pattern',
    `${product}-*.tar.gz`,
    '--pattern',
    `${product}-*.zip`,
  ]);
  assertExactFilenames(
    exactRegularDirectoryFilenames(assetDir, `${product} aggregate asset directory`),
    expected,
    `${product} aggregate assets`,
  );
  return result;
}
