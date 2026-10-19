import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import {
  makeSealedExportFixture,
  makeLinearMemoryFixture,
} from '../testdata/make-sealed-export-fixture.mts';
import { AGGREGATE_RELATIVE } from './receipt-files.mts';
import {
  receiptRelative,
  sha256,
  readRegular,
  sideManifestPaths,
  validateExportChain,
  linearMemorySourceHashes,
  parseJson,
} from './sealed-export-chain.mts';
const project = join(import.meta.dirname, '..');
test('sealed export and memory receipts bind actual modules, proofs and inventoried inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'sealed-export-chain-'));
  try {
    const module = Buffer.from('0061736d0100000002120103656e76066d656d6f7279020301808004', 'hex');
    for (const relative of ['bin/initdb', 'bin/postgres', 'lib/libpq.so.5.18']) {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), module);
    }
    makeSealedExportFixture(root, project);
    const paths = ['bin/initdb', 'bin/postgres', ...sideManifestPaths(project)].sort();
    const hashes = new Map(paths.map((path) => [path, sha256(readRegular(root, path))]));
    validateExportChain(root, project, hashes);
    const receipt = makeLinearMemoryFixture(root),
      modules = receipt.modules;
    hashes.set('bin/pg_config', hashes.get('bin/initdb')!);
    const writeMemory = () =>
      writeFileSync(join(root, AGGREGATE_RELATIVE), JSON.stringify(receipt));
    writeMemory();
    assert.deepEqual(linearMemorySourceHashes(root), hashes);
    validateExportChain(root, project, linearMemorySourceHashes(root));
    for (const invalid of [true, 4097]) {
      (modules[0] as any)['initial-pages'] = invalid;
      writeMemory();
      assert.throws(() => linearMemorySourceHashes(root));
    }
    modules[0]['initial-pages'] = 1;
    writeMemory();
    writeFileSync(join(root, 'bin/initdb'), Buffer.concat([module, Buffer.from('changed')]));
    assert.throws(() => linearMemorySourceHashes(root), /bytes differ/);
    const proofPath = 'share/postgresql/wasix-postmaster.sealed-export.seed-proof.json';
    const proof = parseJson(readRegular(root, proofPath));
    proof['analyzer-version'] = 'different';
    writeFileSync(join(root, proofPath), JSON.stringify(proof));
    const structural = parseJson(readRegular(root, receiptRelative));
    structural['seed-proof-sha256'] = sha256(readRegular(root, proofPath));
    writeFileSync(join(root, receiptRelative), JSON.stringify(structural));
    assert.throws(() => validateExportChain(root, project, hashes), /proof identity/);
    symlinkSync('bin/postgres', join(root, 'link'));
    assert.throws(() => readRegular(root, 'link'));
    assert.throws(() =>
      readRegular(
        root,
        'bin/postgres',
        new Map([['bin/postgres', { size: 1, sha256: '0'.repeat(64) }]]),
      ),
    );
    assert.throws(() => readRegular(root, 'bin/postgres', new Map()));
    assert.throws(() => parseJson(Buffer.from('{"a":1,"a":2}')), /duplicate/i);
    assert.throws(() => parseJson(Buffer.from('{"a":9007199254740993}')), /unsafe JSON integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
