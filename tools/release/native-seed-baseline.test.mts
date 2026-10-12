import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  captureSeedConstructionIntent,
  captureSeedContentIntent,
  SEED_CONSTRUCTION_ANCHOR_SCHEMA,
  selectCompletedSeed,
  writeSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import {
  bootstrapFiles,
  fixture,
  identity,
  publication,
} from '../../build_defs/resources/seed-construction-fixture.mts';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { createDeterministicTar } from '../packaging/archive-directory.mts';
import {
  assertDeclaredSeedConstructionAnchor,
  assertSeedConstructionBaseline,
  readDeclaredSeedConstructionAnchor,
  seedArchiveHasChangedDeclaredContents,
  seedConstructionAnchorPath,
} from './native-seed-baseline.mts';

test('signed-looking serialized constructor metadata cannot replace the actual completed publisher capability', () => {
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  expect(() =>
    assertSeedConstructionBaseline(
      {
        metadata: {
          publication: { product: 'database-resources' },
          metadata: { construction: [] },
          publicOrigin: { attestation: { subjects: [] } },
        },
        files: {},
      } as any,
      source,
    ),
  ).toThrow('authenticated completed metadata');
});

test('one committed adoption contract survives unrelated commits, rejects source/receipt edits and cannot be removed or cloned into authority', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-anchor-source-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  };
  try {
    git('init', '-q');
    writeFileSync(path.join(root, 'source.mts'), '// initial source');
    let current = commit();
    expect(readDeclaredSeedConstructionAnchor(current, root)).toBeUndefined();
    const workspace = mkdtempSync(path.join(tmpdir(), 'seed-anchor-bytes-'));
    try {
      const pgdata = path.join(workspace, 'pgdata');
      mkdirSync(path.join(pgdata, 'global'), { recursive: true });
      // The receipt writer requires the canonical full directory contract.
      const contract = JSON.parse(
        readFileSync(
          new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
          'utf8',
        ),
      );
      for (const dir of contract.pgdataDirectories)
        mkdirSync(path.join(pgdata, dir), { recursive: true });
      writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
      writeFileSync(path.join(pgdata, 'global/pg_control'), 'fixed actual bytes');
      const input = path.join(workspace, 'bootstrap.sql');
      writeFileSync(input, 'bootstrap actual bytes');
      const intent = captureSeedConstructionIntent(
        { family: 'native', target: 'linux-x64-gnu', profile: 'standard' },
        { contract: 'PG18' },
        { bootstrap: input },
      );
      const frozen = path.join(workspace, 'seed.tar');
      writeFileSync(frozen, await createDeterministicTar(pgdata));
      const publication = {
        product: 'database-resources',
        version: '0.2.2',
        tagName: 'database-resources-v0.2.2',
        publicationSha: 'a'.repeat(40),
        publicationTree: 'b'.repeat(40),
        releaseSha: 'c'.repeat(40),
      };
      const archive = { size: 42, sha256: 'd'.repeat(64) },
        manifest = { size: 43, sha256: 'e'.repeat(64) };
      const receiptPath = path.join(workspace, 'receipt.json');
      writeSeedConstructionReceipt(
        receiptPath,
        intent,
        frozen,
        pgdata,
        { kind: 'completed-publication', operation: 'adopted', publication, archive, manifest },
        intent,
      );
      const contents = readFileSync(receiptPath, 'utf8');
      const anchor = {
        schema: SEED_CONSTRUCTION_ANCHOR_SCHEMA,
        source: current,
        publication,
        seeds: [
          {
            family: intent.family,
            target: intent.target,
            profile: intent.profile,
            archive,
            manifest,
            receipt: {
              size: Buffer.byteLength(contents),
              sha256: createHash('sha256').update(contents).digest('hex'),
              contents,
            },
            producer: {
              evidenceDigest: `sha256:${'f'.repeat(64)}`,
              invocationId: 'original-PR-observation',
              root: '//resource:root',
              configuration: 'real-config',
              output: 'seed.seed-construction.json',
            },
          },
        ],
      };
      const file = path.join(root, seedConstructionAnchorPath);
      mkdirSync(path.dirname(file), { recursive: true });
      const bytes = JSON.stringify(anchor);
      writeFileSync(file, bytes);
      expect(() => readDeclaredSeedConstructionAnchor(current, root)).toThrow('must be committed');
      current = commit();
      const declared = readDeclaredSeedConstructionAnchor(current, root);
      expect(assertDeclaredSeedConstructionAnchor(declared, current).anchor.source).toEqual(
        anchor.source,
      );
      expect(() =>
        assertDeclaredSeedConstructionAnchor(structuredClone(declared), current),
      ).toThrow('actual immutable');
      expect(() =>
        readDeclaredSeedConstructionAnchor({ ...current, tree: '1'.repeat(40) }, root),
      ).toThrow('tree differs');
      writeFileSync(path.join(root, 'source.mts'), '// unrelated comments after many releases');
      current = commit();
      expect(readDeclaredSeedConstructionAnchor(current, root)?.anchor).toEqual(anchor);
      writeFileSync(file, `${bytes}\n`);
      expect(() => readDeclaredSeedConstructionAnchor(current, root)).toThrow(
        'differs from committed',
      );
      current = commit();
      expect(() => readDeclaredSeedConstructionAnchor(current, root)).toThrow('changed after');
      writeFileSync(file, bytes);
      current = commit();
      expect(readDeclaredSeedConstructionAnchor(current, root)?.anchor).toEqual(anchor);
      rmSync(file);
      current = commit();
      expect(() => readDeclaredSeedConstructionAnchor(current, root)).toThrow('removed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual archive/receipt/source join distinguishes changed content from fresh control/WAL entropy', async () => {
  const f = await fixture('native');
  const repository = mkdtempSync(path.join(tmpdir(), 'seed-causal-source-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'source',
    );
    return { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  };
  try {
    git('init', '-q');
    writeFileSync(path.join(repository, 'source.mts'), '// source');
    const originalSource = commit();
    const share = bootstrapFiles(f.root);
    const oldContent = captureSeedContentIntent(
      f.intent,
      { contract: 'actual desired contents' },
      share,
    );
    const adopted = selectCompletedSeed(
      f.intent,
      { ...f.control(), metadata: undefined, operation: 'adopt' },
      oldContent,
    );
    writeSeedConstructionReceipt(
      f.receiptPath,
      f.intent,
      f.frozen,
      f.pgdata,
      adopted?.origin,
      oldContent,
    );
    const contents = readFileSync(f.receiptPath, 'utf8');
    const plain = (file: string) => {
      const { path: _, ...value } = identity(file);
      return value;
    };
    const anchor = {
      schema: SEED_CONSTRUCTION_ANCHOR_SCHEMA,
      source: originalSource,
      publication,
      seeds: [
        {
          family: 'native',
          target: f.intent.target,
          profile: f.intent.profile,
          archive: plain(f.assets.archive),
          manifest: plain(f.assets.manifest),
          receipt: { ...plain(f.receiptPath), contents },
          producer: {
            evidenceDigest: `sha256:${'f'.repeat(64)}`,
            invocationId: 'original-PR-construction',
            root: '//resource:seed',
            configuration: 'config',
            output: 'seed.seed-construction.json',
          },
        },
      ],
    };
    const file = path.join(repository, seedConstructionAnchorPath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(anchor));
    const source = commit();
    const declaration = readDeclaredSeedConstructionAnchor(source, repository)!;
    writeFileSync(path.join(share, 'postgres.bki'), 'changed desired bootstrap catalog');
    const newContent = captureSeedContentIntent(
      f.intent,
      { contract: 'actual desired contents' },
      share,
    );
    writeFileSync(path.join(f.pgdata, 'global/pg_control'), 'fresh actual control');
    writeFileSync(path.join(f.pgdata, 'pg_wal/000000010000000000000001'), 'fresh actual WAL');
    writeFileSync(f.frozen, await createDeterministicTar(f.pgdata));
    const current = await packageClusterSeed({
      family: 'native',
      target: f.intent.target,
      profile: 'standard',
      pgdata: f.pgdata,
      runtime: path.dirname(path.dirname(f.inputs.postgres)),
      contract: f.invocation.contract,
      version: publication.version,
      runtimeVersion: '0.3.2',
      outputDir: path.join(f.root, 'current-assets'),
    });
    const receipt = writeSeedConstructionReceipt(
      f.receiptPath,
      f.intent,
      f.frozen,
      f.pgdata,
      undefined,
      newContent,
    );
    const qualified = (file: string) => ({
      frozenPath: file,
      label: '//resource:seed',
      ...plain(file),
    });
    const observation: any = {
      products: [
        {
          product: { id: publication.product },
          productArtifacts: [
            {
              id: 'current-archive',
              kind: 'native-seeds',
              target: f.intent.target,
              name: path.basename(current.archive),
              qualifiedFiles: [qualified(current.archive)],
            },
            {
              id: 'current-descriptor',
              kind: 'native-seeds',
              target: f.intent.target,
              name: path.basename(current.manifest),
              qualifiedFiles: [qualified(current.manifest)],
            },
          ],
          construction: [
            {
              roots: [{ label: '//resource:seed' }],
              seedConstructions: [
                { path: 'seed.seed-construction.json', contents: JSON.stringify(receipt) },
              ],
            },
          ],
        },
      ],
    };
    const input = { declaration, source, publication, observation, artifactId: 'current-archive' };
    expect(seedArchiveHasChangedDeclaredContents(input)).toBe(true);
    const entropyOnly = writeSeedConstructionReceipt(
      f.receiptPath,
      f.intent,
      f.frozen,
      f.pgdata,
      undefined,
      oldContent,
    );
    observation.products[0].construction[0].seedConstructions[0].contents =
      JSON.stringify(entropyOnly);
    expect(seedArchiveHasChangedDeclaredContents(input)).toBe(false);
    expect(() =>
      seedArchiveHasChangedDeclaredContents({
        ...input,
        publication: { ...publication, publicationSha: '1'.repeat(40) },
      }),
    ).toThrow('completed origin differs');
    const wrongTree = structuredClone(entropyOnly);
    wrongTree.pgdata.treeSha256 = '1'.repeat(64);
    observation.products[0].construction[0].seedConstructions[0].contents =
      JSON.stringify(wrongTree);
    expect(() => seedArchiveHasChangedDeclaredContents(input)).toThrow('PGDATA differs');
    writeFileSync(current.archive, 'substituted physical archive');
    expect(() => seedArchiveHasChangedDeclaredContents(input)).toThrow('public File changed');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(repository, { recursive: true, force: true });
  }
});
