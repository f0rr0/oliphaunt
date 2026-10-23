import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  expandDeclaredTrees,
  type RuntimeEntry,
  sourceFacts,
  stageRuntimeArchive,
} from './package.mts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-wasix-package-'));
  roots.push(root);
  const file = path.join(root, 'bytes');
  await writeFile(file, '\0asm\x01\0\0\0');
  const timezone = path.join(root, 'zones');
  for (const name of ['UTC', 'GMT', 'Etc/UTC', 'America/New_York']) {
    const zone = path.join(timezone, name);
    await mkdir(path.dirname(zone), { recursive: true });
    await writeFile(zone, `TZif${name}`);
  }
  const entries: RuntimeEntry[] = [
    ...[
      'bin/postgres',
      'bin/initdb',
      'lib/postgresql/plpgsql.so',
      'lib/postgresql/dict_snowball.so',
    ].map((destination) => ({ source: file, destination, executable: true })),
    ...[
      'postgres.bki',
      'system_constraints.sql',
      'snowball_create.sql',
      'extension/plpgsql.control',
      'extension/plpgsql--1.0.sql',
    ].map((name) => ({ source: file, destination: `share/postgresql/${name}` })),
    { source: timezone, destination: 'share/postgresql/timezone', tree: true },
  ];
  return { root, file, timezone, entries };
}

test('runtime archive has independent readable payload, fixed prefix/modes and deterministic bytes', async () => {
  const { root, file, entries } = await fixture();
  const link = path.join(root, 'projected-input');
  await symlink(file, link);
  entries[0].source = link;
  const first = path.join(root, 'first.tar.zst');
  const second = path.join(root, 'second.tar.zst');
  await stageRuntimeArchive(entries, path.join(root, 'first/oliphaunt'), first);
  await stageRuntimeArchive([...entries].reverse(), path.join(root, 'second/oliphaunt'), second);
  expect(await readFile(first)).toEqual(await readFile(second));
  const raw = zstdDecompressSync(await readFile(first));
  const oracle = await new Bun.Archive(raw).files();
  expect(await oracle.get('oliphaunt/password')?.text()).toBe('password\n');
  const postgres = oracle.get('oliphaunt/bin/postgres');
  if (!postgres) throw new Error('independent archive reader found no postgres module');
  expect(Buffer.from(await postgres.arrayBuffer())).toEqual(await readFile(file));
  expect([...oracle.keys()].filter((name) => !name.endsWith('/')).sort()).toEqual(
    [
      ...entries.filter((entry) => !entry.tree).map((entry) => `oliphaunt/${entry.destination}`),
      ...['UTC', 'GMT', 'Etc/UTC', 'America/New_York'].map(
        (zone) => `oliphaunt/share/postgresql/timezone/${zone}`,
      ),
      'oliphaunt/password',
    ].sort(),
  );
  const strict = readPortableArchiveEntries(first, { format: 'tar.zst' });
  expect(strict.get('oliphaunt/bin/postgres')?.mode).toBe(0o755);
  expect(strict.get('oliphaunt/share/postgresql/postgres.bki')?.mode).toBe(0o644);
});

test('runtime staging rejects omitted files, duplicate and unsafe destinations', async () => {
  const { root, file, entries } = await fixture();
  const run = (items: RuntimeEntry[], name: string) =>
    stageRuntimeArchive(
      items,
      path.join(root, `${name}/oliphaunt`),
      path.join(root, `${name}.tar.zst`),
    );
  await expect(
    run(
      entries.filter((entry) => entry.destination !== 'bin/initdb'),
      'missing',
    ),
  ).rejects.toThrow('missing bin/initdb');
  for (const [index, destination] of [
    'password',
    'bin/postgres',
    '../outside',
    './alias',
    'nested/../outside',
    '/absolute',
    'back\\slash',
  ].entries()) {
    await expect(
      run([...entries, { source: file, destination }], `bad-${index}`),
    ).rejects.toThrow();
  }
});

test('runtime directory artifacts cannot add linked files or directories', async () => {
  const { root, file, timezone, entries } = await fixture();
  await symlink(file, path.join(timezone, 'linked-file'));
  await expect(
    stageRuntimeArchive(
      entries,
      path.join(root, 'file-link/oliphaunt'),
      path.join(root, 'file.tar.zst'),
    ),
  ).rejects.toThrow('input tree contains a link');
  await rm(path.join(timezone, 'linked-file'));
  await symlink(root, path.join(timezone, 'linked-directory'));
  await expect(
    stageRuntimeArchive(
      entries,
      path.join(root, 'directory-link/oliphaunt'),
      path.join(root, 'directory.tar.zst'),
    ),
  ).rejects.toThrow('input tree contains a link');
});

test('declared TreeArtifact leaves preserve nested destinations and reject undeclared or duplicate paths', async () => {
  const { root, file, entries, timezone } = await fixture();
  const leaves = ['UTC', 'GMT', 'Etc/UTC', 'America/New_York'].map((name) =>
    path.join(timezone, name),
  );
  const projected = expandDeclaredTrees(entries, leaves);
  expect(projected.some((entry) => entry.tree)).toBe(false);
  expect(
    projected.find((entry) => entry.source.endsWith(path.join('America', 'New_York')))?.destination,
  ).toBe('share/postgresql/timezone/America/New_York');
  await expect(
    stageRuntimeArchive(
      projected,
      path.join(root, 'declared/oliphaunt'),
      path.join(root, 'declared.tar.zst'),
    ),
  ).resolves.toBeUndefined();
  expect(() => expandDeclaredTrees(entries, [file])).toThrow(
    'outside its unique declared directory',
  );
  expect(() => expandDeclaredTrees(entries, [leaves[0], leaves[0]])).toThrow(
    'duplicate declared runtime tree leaf',
  );
  expect(() =>
    expandDeclaredTrees(
      [...entries, { source: timezone, destination: 'overlap', tree: true }],
      leaves,
    ),
  ).toThrow('outside its unique declared directory');
});

test('source receipt hashes only the declared series in order and normalizes CRLF like the Rust authority', async () => {
  const { root } = await fixture();
  const postgresSource = path.join(root, 'postgres.toml');
  const postgresSeries = path.join(root, 'series');
  const icuSource = path.join(root, 'icu.toml');
  const patch = path.join(root, 'one.patch');
  const sourceSha = 'a'.repeat(64);
  const series = 'src/wasix/runtime/one.patch\n';
  const bytes = '--- old\n+++ new\n';
  await writeFile(
    postgresSource,
    `[postgresql]\nversion = "18.4"\nurl = "https://source.test/pg.tar.bz2"\nsha256 = "${sourceSha}"\n`,
  );
  await writeFile(
    icuSource,
    'name = "icu"\nurl = "https://source.test/icu.git"\nbranch = "release-76-1"\ncommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"\n',
  );
  await writeFile(postgresSeries, series);
  await writeFile(patch, bytes);
  const facts = {
    postgresSource,
    postgresSeries,
    icuSource,
    patches: { 'src/wasix/runtime/one.patch': patch },
  };
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const patchSha = digest(`${digest(series)}\n${digest(bytes)}\n`);
  const result = await sourceFacts(facts);
  expect(result.source_fingerprint).toBe(`18.4:${sourceSha}:${patchSha}`);
  expect(result.postgres_version).toBe('18.4');
  expect(result.sources.at(-1)?.commit).toBe(patchSha);
  await writeFile(postgresSeries, series.replaceAll('\n', '\r\n'));
  await writeFile(patch, bytes.replaceAll('\n', '\r\n'));
  expect(await sourceFacts(facts)).toEqual(result);
  await expect(sourceFacts({ ...facts, patches: {} })).rejects.toThrow(
    'undeclared PostgreSQL patch',
  );
  await writeFile(patch, bytes.replaceAll('\n', '\r'));
  expect((await sourceFacts(facts)).source_fingerprint).not.toBe(result.source_fingerprint);
});
