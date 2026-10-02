import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertExactFilenames, exactRegularDirectoryFilenames } from './finalize-helper-assets.mts';

const scratch = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('native helper aggregate release assets', () => {
  test('accepts only an exact, duplicate-free carrier filename set', () => {
    const expected = ['first.tgz', 'second.tgz'];
    expect(() =>
      assertExactFilenames([...expected].reverse(), expected, 'Node carriers'),
    ).not.toThrow();
    expect(() => assertExactFilenames(expected.slice(1), expected, 'Node carriers')).toThrow(
      /must be exact/u,
    );
    expect(() =>
      assertExactFilenames([...expected, expected[0]], expected, 'Node carriers'),
    ).toThrow(/must be exact/u);
    expect(() =>
      assertExactFilenames([...expected, 'unexpected.tgz'], expected, 'Node carriers'),
    ).toThrow(/must be exact/u);
  });

  test('rejects non-file and symlink entries instead of hiding them from closure checks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-native-helper-closure-'));
    scratch.push(root);
    writeFileSync(path.join(root, 'carrier.tgz'), 'carrier');
    expect(exactRegularDirectoryFilenames(root, 'carrier directory')).toEqual(['carrier.tgz']);

    mkdirSync(path.join(root, 'unexpected-directory'));
    expect(() => exactRegularDirectoryFilenames(root, 'carrier directory')).toThrow(
      /only regular non-symlink files: unexpected-directory/u,
    );
    rmSync(path.join(root, 'unexpected-directory'), { recursive: true });

    symlinkSync(path.join(root, 'carrier.tgz'), path.join(root, 'unexpected-link.tgz'));
    expect(() => exactRegularDirectoryFilenames(root, 'carrier directory')).toThrow(
      /only regular non-symlink files: unexpected-link[.]tgz/u,
    );
  });
});

test.each([
  ['oliphaunt-broker', 'broker-helper'],
  ['postgres-tools-native', 'native-tools'],
  ['postgres-tools-wasix', 'wasix-tools'],
])('aggregate finalization hashes every %s payload and rejects extras before rewriting it', async (product, kind) => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const { allArtifactTargets, currentProductVersionSync } = await import(
    '../release/release-artifact-targets.mts'
  );
  const { finalizeHelperAssets } = await import('./finalize-helper-assets.mts');
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-helper-finalize-'));
  scratch.push(root);
  const version = currentProductVersionSync(product);
  const assets = allArtifactTargets({ product, surface: 'github-release' }).map((row) =>
    row.asset.replaceAll('{version}', version),
  );
  const checksum = assets.find((name) => name.endsWith('.sha256'));
  for (const name of assets) writeFileSync(path.join(root, name), name);
  const args = await finalizeHelperAssets(product, kind, ['--aggregate'], {
    assetDir: root,
  });
  expect(args).toEqual(['--asset-dir', root]);
  const manifest = readFileSync(path.join(root, checksum), 'utf8');
  for (const name of assets.filter((name) => name !== checksum)) {
    expect(manifest).toContain(`${createHash('sha256').update(name).digest('hex')}  ./${name}`);
  }
  writeFileSync(path.join(root, 'unexpected.tar.gz'), 'unexpected');
  await expect(
    finalizeHelperAssets(product, kind, ['--aggregate'], { assetDir: root }),
  ).rejects.toThrow(/must be exact/);
  expect(readFileSync(path.join(root, checksum), 'utf8')).toBe(manifest);
});
