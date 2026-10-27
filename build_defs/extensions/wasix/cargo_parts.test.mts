import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import {
  readWasixCargoCarrierPayload,
  readWasixCargoCarrierSet,
  stageWasixCargoCarrierSet,
} from '../wasix_carriers.mts';

test('canonical Cargo parents bind their complete bounded parts and reconstructed physical payload', () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-cargo-parts-'));
  const parent = {
    product: 'fixture',
    ecosystem: 'cargo',
    name: 'fixture-aot-linux-x64',
    version: '1.0.0',
    role: 'aot-leaf',
    target: 'x86_64-unknown-linux-gnu',
  };
  function archive(name: string, dependencies: string[], payload: Record<string, string> = {}) {
    const source = path.join(root, name);
    rmSync(source, { recursive: true, force: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(
      path.join(source, 'Cargo.toml'),
      `[package]\nname=${JSON.stringify(name)}\nversion="1.0.0"\n[build-dependencies]\n${dependencies.map((name) => `${name}={version="=1.0.0"}`).join('\n')}\n`,
    );
    for (const [relative, bytes] of Object.entries(payload)) {
      const file = path.join(source, 'payload', relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    const file = path.join(root, `${name}-1.0.0.crate`);
    writeFileSync(
      file,
      canonicalGzipSync(
        createDeterministicTar(source, `${name}-1.0.0`, {
          fail: (message: string) => {
            throw new Error(message);
          },
        }),
      ),
    );
    return file;
  }
  try {
    const first = `${parent.name}-part-001`,
      second = `${parent.name}-part-002`;
    const base = archive(parent.name, [first, second]);
    const part1 = archive(first, [], { 'files/one': 'one', 'chunks/two.part000000': 'tw' });
    const part2 = archive(second, [], { 'chunks/two.part000001': 'o' });
    const files = [base, part1, part2];
    const rows = readWasixCargoCarrierSet([parent], files);
    const declared = rows.find((row) => row.declared);
    assert(declared);
    assert.deepEqual(
      [...readWasixCargoCarrierPayload(rows, declared)].map(([name, bytes]) => [
        name,
        bytes.toString(),
      ]),
      [
        ['one', 'one'],
        ['two', 'two'],
      ],
    );
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [base, part1]),
      /complete Cargo payload part set/u,
    );
    const extra = archive(`${parent.name}-part-003`, []);
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [...files, extra]),
      /complete Cargo payload part set/u,
    );
    const invalid = archive(`${parent.name}-part-1000`, []);
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [...files, invalid]),
      /not a Cargo payload part crate/u,
    );
    const zero = archive(`${parent.name}-part-000`, []);
    assert.throws(() => readWasixCargoCarrierSet([parent], [...files, zero]), /1-based/u);
    const oversized = path.join(root, 'oversized.crate');
    writeFileSync(oversized, Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.throws(() => readWasixCargoCarrierSet([parent], [oversized]), /10 MiB package limit/u);
    const produced = rows.map((row) => ({
      name: row.name,
      target: row.target,
      size: row.size,
      sha256: row.sha256,
    }));
    const output = {
      cargo: path.join(root, 'declared', 'cargo'),
      cargoParts: { [parent.name]: path.join(root, 'declared', 'parts', parent.name) },
    };
    stageWasixCargoCarrierSet(
      [parent],
      produced.map((row, index) => ({ ...row, cratePath: files[index] })),
      output,
    );
    const retained = readWasixCargoCarrierSet(
      [parent],
      [path.join(output.cargo, path.basename(base)), output.cargoParts[parent.name]],
    );
    const retainedParent = retained.find((row) => row.declared);
    assert(retainedParent);
    assert.deepEqual(
      readWasixCargoCarrierPayload(retained, retainedParent),
      readWasixCargoCarrierPayload(rows, declared),
    );
    assert.throws(
      () =>
        stageWasixCargoCarrierSet(
          [parent],
          produced.map((row, index) => ({ ...row, cratePath: files[index] })),
          { cargo: path.join(root, 'undeclared') },
        ),
      /require their declared parent outputs/u,
    );
    assert.throws(
      () =>
        readWasixCargoCarrierSet(
          [parent],
          files,
          produced.map((row, index) =>
            index === 1 ? { ...row, target: 'aarch64-apple-darwin' } : row,
          ),
        ),
      /inventory target/u,
    );
    assert.throws(
      () =>
        readWasixCargoCarrierSet(
          [parent],
          files,
          produced.map((row, index) => (index === 1 ? { ...row, sha256: '0'.repeat(64) } : row)),
        ),
      /AssertionError/u,
    );
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [...files, part1]),
      /repeated Cargo carrier/u,
    );
    const missingChunk = archive(second, [], { 'chunks/two.part000002': 'o' });
    const missingRows = readWasixCargoCarrierSet([parent], [base, part1, missingChunk]);
    const missingParent = missingRows.find((row) => row.declared);
    assert(missingParent);
    assert.throws(
      () => readWasixCargoCarrierPayload(missingRows, missingParent),
      /non-contiguous Cargo payload chunks/u,
    );
    assert.equal(createHash('sha256').update(readFileSync(base)).digest('hex'), produced[0].sha256);
    const omittedDirectory = path.join(root, 'omitted-runfiles', parent.name);
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [base, omittedDirectory]),
      /must have between 1 and 999 Cargo payload parts/u,
    );
    const partsDirectory = path.join(root, 'parts', parent.name);
    mkdirSync(partsDirectory, { recursive: true });
    copyFileSync(part1, path.join(partsDirectory, path.basename(part1)));
    copyFileSync(
      archive(second, [], { 'chunks/two.part000001': 'o' }),
      path.join(partsDirectory, path.basename(part2)),
    );
    const directoryRows = readWasixCargoCarrierSet([parent], [base, partsDirectory]);
    assert.equal(directoryRows.length, 3);
    const directoryParent = directoryRows.find((row) => row.declared);
    assert(directoryParent);
    assert.equal(
      readWasixCargoCarrierPayload(directoryRows, directoryParent).get('two')?.toString(),
      'two',
    );
    mkdirSync(path.dirname(omittedDirectory), { recursive: true });
    symlinkSync(partsDirectory, omittedDirectory, 'dir');
    assert.equal(readWasixCargoCarrierSet([parent], [base, omittedDirectory]).length, 3);
    rmSync(omittedDirectory);
    mkdirSync(omittedDirectory);
    for (const file of [part1, part2])
      symlinkSync(
        path.join(partsDirectory, path.basename(file)),
        path.join(omittedDirectory, path.basename(file)),
      );
    assert.equal(readWasixCargoCarrierSet([parent], [base, omittedDirectory]).length, 3);
    rmSync(omittedDirectory, { recursive: true });
    const unsplit = archive(parent.name, [], { 'files/one': 'one' });
    const unsplitRows = readWasixCargoCarrierSet([parent], [unsplit, omittedDirectory]);
    assert.equal(unsplitRows.length, 1);
    assert.equal(
      readWasixCargoCarrierPayload(unsplitRows, unsplitRows[0]).get('one')?.toString(),
      'one',
    );
    mkdirSync(omittedDirectory);
    assert.equal(readWasixCargoCarrierSet([parent], [unsplit, omittedDirectory]).length, 1);
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [unsplit, `${omittedDirectory}-wrong-parent`]),
      /Cargo parts directory has no canonical parent/u,
    );
    symlinkSync(part1, path.join(omittedDirectory, path.basename(part1)));
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [unsplit, omittedDirectory]),
      /outside its canonical parent/u,
    );
    const alias = path.join(omittedDirectory, path.basename(part1));
    rmSync(alias);
    symlinkSync(path.join(partsDirectory, path.basename(part2)), alias);
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [unsplit, omittedDirectory]),
      /changed its archive filename/u,
    );
    rmSync(alias);
    symlinkSync(partsDirectory, alias, 'dir');
    assert.throws(
      () => readWasixCargoCarrierSet([parent], [unsplit, omittedDirectory]),
      /resolve to a regular archive/u,
    );
    console.log(
      'Canonical dynamic Cargo parts: complete parents, physical hashes, targets, bounds, chunk reconstruction and omitted empty runfiles directories PASS',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
