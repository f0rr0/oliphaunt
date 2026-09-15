import { parseMavenArtifactManifest } from './maven-artifact-manifest.mts';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stageMavenArtifactManifest } from './maven-artifact-staging.mts';
import { validateMavenCentralPublication } from './maven-central-contract.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-maven-carrier-'));
  roots.push(root);
  const artifact = path.join(root, 'runtime.tar.gz');
  const manifest = path.join(root, 'manifest.tsv');
  const output = path.join(root, 'maven');
  writeFileSync(artifact, 'exact runtime carrier\n');
  const licenses = [
    {
      name: 'MIT & PostgreSQL',
      url: 'https://example.invalid/license?a=1&b=2',
      distribution: 'repo',
    },
  ];
  writeFileSync(
    manifest,
    [
      'dev.oliphaunt.extensions',
      'oliphaunt-extension-example-android-arm64-v8a',
      '1.2.3',
      artifact,
      'Oliphaunt <example>',
      'Exact extension & runtime carrier.',
      'liboliphaunt-native',
      '4.5.6',
      'MIT AND PostgreSQL',
      JSON.stringify(licenses),
    ].join('\t') + '\n',
  );
  return { artifact, manifest, output, root };
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function files(directory) {
  return readdirSync(directory)
    .sort()
    .map((name) => path.join(directory, name));
}

test('stages a deterministic exact Maven Central carrier closure without Gradle', async () => {
  const value = fixture();
  const first = await stageMavenArtifactManifest(value.manifest, value.output);
  expect(first).toHaveLength(1);
  const directory = first[0].directory;
  const stagedFiles = files(directory);
  expect(stagedFiles.map((file) => path.basename(file))).toEqual([
    'oliphaunt-extension-example-android-arm64-v8a-1.2.3-javadoc.jar',
    'oliphaunt-extension-example-android-arm64-v8a-1.2.3-sources.jar',
    'oliphaunt-extension-example-android-arm64-v8a-1.2.3.pom',
    'oliphaunt-extension-example-android-arm64-v8a-1.2.3.tar.gz',
  ]);
  expect(
    readFileSync(
      stagedFiles.find((file) => file.endsWith('.tar.gz')),
      'utf8',
    ),
  ).toBe('exact runtime carrier\n');

  const pom = stagedFiles.find((file) => file.endsWith('.pom'));
  expect(readFileSync(pom, 'utf8')).toContain('Oliphaunt &lt;example&gt;');
  expect(readFileSync(pom, 'utf8')).toContain('MIT &amp; PostgreSQL');
  expect(
    validateMavenCentralPublication({
      context: 'fixture',
      files: stagedFiles.map((file) => ({ name: path.basename(file), size: lstatSync(file).size })),
      pomText: readFileSync(pom, 'utf8'),
    }),
  ).toEqual({
    artifactId: 'oliphaunt-extension-example-android-arm64-v8a',
    groupId: 'dev.oliphaunt.extensions',
    packaging: 'tar.gz',
    version: '1.2.3',
  });

  for (const jar of stagedFiles.filter((file) => file.endsWith('.jar'))) {
    const entries = readPortableArchiveEntries(jar);
    expect(entries.has('META-INF/MANIFEST.MF')).toBe(true);
    expect(entries.has('META-INF/LICENSE')).toBe(true);
    expect(entries.has('META-INF/THIRD_PARTY_NOTICES.md')).toBe(true);
    expect([...entries.values()].every((entry) => entry.isSymbolicLink === false)).toBe(true);
  }

  const firstDigests = Object.fromEntries(
    stagedFiles.map((file) => [path.basename(file), digest(file)]),
  );
  await stageMavenArtifactManifest(value.manifest, value.output);
  expect(
    Object.fromEntries(files(directory).map((file) => [path.basename(file), digest(file)])),
  ).toEqual(firstDigests);
});

test('rejects duplicate coordinates, malformed licenses, missing artifacts, and symlinks', () => {
  const value = fixture();
  const row = readFileSync(value.manifest, 'utf8');
  writeFileSync(value.manifest, row + row);
  expect(() => parseMavenArtifactManifest(value.manifest)).toThrow(/repeats Maven coordinate/u);

  const fields = row.trimEnd().split('\t');
  writeFileSync(value.manifest, `${fields.with(9, '{}').join('\t')}\n`);
  expect(() => parseMavenArtifactManifest(value.manifest)).toThrow(/non-empty JSON array/u);

  writeFileSync(
    value.manifest,
    `${fields.with(3, path.join(value.root, 'missing.tar.gz')).join('\t')}\n`,
  );
  expect(() => parseMavenArtifactManifest(value.manifest)).toThrow(/is missing/u);

  const link = path.join(value.root, 'linked.tar.gz');
  symlinkSync(value.artifact, link);
  writeFileSync(value.manifest, `${fields.with(3, link).join('\t')}\n`);
  expect(() => parseMavenArtifactManifest(value.manifest)).toThrow(/non-symlink/u);
});

test('rejects coordinate dot segments before staging any path', async () => {
  const value = fixture();
  const fields = readFileSync(value.manifest, 'utf8').trimEnd().split('\t');
  for (const [field, invalid] of [
    [0, '.'],
    [0, '..'],
    [0, '.dev.oliphaunt'],
    [0, 'dev..oliphaunt'],
    [0, 'dev.oliphaunt.'],
    [1, '.'],
    [1, '..'],
    [2, '.'],
    [2, '..'],
  ]) {
    writeFileSync(value.manifest, `${fields.with(field, invalid).join('\t')}\n`);
    expect(() => parseMavenArtifactManifest(value.manifest)).toThrow(/non-dot|dot-separated/u);
    await expect(stageMavenArtifactManifest(value.manifest, value.output)).rejects.toThrow(
      /non-dot|dot-separated/u,
    );
  }
  expect(() => lstatSync(value.output)).toThrow();
});

test('failed staging leaves the last complete output untouched', async () => {
  const value = fixture();
  await stageMavenArtifactManifest(value.manifest, value.output);
  const marker = path.join(value.output, 'complete.marker');
  writeFileSync(marker, 'keep\n');
  const fields = readFileSync(value.manifest, 'utf8').trimEnd().split('\t');
  writeFileSync(
    value.manifest,
    `${fields.with(3, path.join(value.root, 'missing.tar.gz')).join('\t')}\n`,
  );
  await expect(stageMavenArtifactManifest(value.manifest, value.output)).rejects.toThrow(
    /is missing/u,
  );
  expect(readFileSync(marker, 'utf8')).toBe('keep\n');
});
