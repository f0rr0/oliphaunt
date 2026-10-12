import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  readDeclaredSeedConstructionAnchor,
  assertDeclaredSeedConstructionAnchor,
  assertSeedConstructionBaseline,
  seedConstructionAnchorPath,
} from './native-seed-baseline.mts';
import {
  SEED_CONSTRUCTION_ANCHOR_SCHEMA,
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from '../../build_defs/resources/seed_construction.mts';
import { createDeterministicTar } from '../packaging/archive-directory.mts';

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
