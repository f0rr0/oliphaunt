import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validateCargoPayloadPartSets } from '../release/cargo-payload-part-contract.mts';
import { resolveActualCarrier } from '../release/publication-catalog.mts';
import { readPortableArchiveEntries } from './portable-archive.mts';
import { validateCrateSize } from './wasix-cargo-payload.mts';

export interface Carrier {
  product: string;
  ecosystem: string;
  name: string;
  version: string;
  target: string | null;
  role: string;
}
/** Authenticate complete canonical parents and their dynamic Cargo parts together. */
export function readWasixCargoCarrierSet(
  carriers: Carrier[],
  inputs: string[],
  produced?: { name: string; target: string; size: number; sha256: string }[],
) {
  const declared = carriers.filter((row) => row.ecosystem === 'cargo');
  const catalog = {
    carriers: declared.map((row) => ({ ...row, id: `cargo:${row.name}`, declared: true })),
  };
  const parents = new Set(declared.map((row) => row.name));
  const files = inputs.flatMap((input) => {
    const entry = lstatSync(input, { throwIfNoEntry: false });
    if (entry?.isFile()) return [input];
    const parent = path.basename(input);
    assert(parents.has(parent), 'Cargo parts directory has no canonical parent');
    // Bazel runfiles omit empty TreeArtifact directories. Required parts still
    // come from the packed parent manifest and must pass the complete-set check.
    if (!entry) return [];
    const directory = realpathSync(input);
    assert(lstatSync(directory).isDirectory(), 'Cargo parts input must be a directory');
    return readdirSync(directory, { withFileTypes: true }).map((part) => {
      assert(
        (part.isFile() || part.isSymbolicLink()) && part.name.endsWith('.crate'),
        'Cargo parts output must contain only regular part archives',
      );
      assert(
        part.name.startsWith(`${parent}-part-`),
        'Cargo part output belongs to a different parent',
      );
      // Sandboxed runfiles can materialize a Tree as individual file symlinks.
      // Bind each resolved regular file to the same canonical parent and name.
      const file = realpathSync(path.join(directory, part.name));
      assert(lstatSync(file).isFile(), 'Cargo part must resolve to a regular archive');
      assert.equal(path.basename(file), part.name, 'Cargo part changed its archive filename');
      assert.equal(
        path.basename(path.dirname(file)),
        parent,
        'Cargo part resolved outside its canonical parent',
      );
      return file;
    });
  });
  const records = files.map((file) => {
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    validateCrateSize(file);
    const bytes = readFileSync(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entries = readPortableArchiveEntries(file);
    const prefix = path.basename(file, '.crate');
    const entry = entries.get(`${prefix}/Cargo.toml`);
    assert(
      entry?.isFile && !entry.isSymbolicLink,
      'Cargo carrier requires its exact packed manifest',
    );
    const manifest = Bun.TOML.parse(entry.data().toString());
    assert(
      !Object.hasOwn(manifest.package.metadata?.oliphaunt ?? {}, 'qualificationOnly'),
      'Cargo carrier must not contain qualification-only archives',
    );
    assert(
      [...entries.values()].every(
        (entry) =>
          (entry.isDirectory && entry.name === prefix) || entry.name.startsWith(`${prefix}/`),
      ),
      'Cargo carrier has a noncanonical archive root',
    );
    assert.equal(prefix, `${manifest.package.name}-${manifest.package.version}`);
    const carrier = resolveActualCarrier(catalog, 'cargo', manifest.package.name);
    assert.equal(manifest.package.version, carrier.version);
    const packageDependencies = Object.entries({
      ...manifest.dependencies,
      ...manifest['build-dependencies'],
    }).map(([name, declaration]) => {
      const requirement =
        typeof declaration === 'string'
          ? declaration
          : (declaration as { version: string }).version;
      if (name.startsWith(`${carrier.name}-part-`))
        assert.equal(requirement, `=${carrier.version}`);
      return { ecosystem: 'cargo', name, requirement };
    });
    if (produced) {
      const row = produced.find((row) => row.name === carrier.name);
      assert(row, 'Cargo archive has no produced inventory row');
      assert.equal(
        row.target,
        carrier.target,
        'Cargo inventory target differs from its canonical parent',
      );
      assert.equal(row.size, bytes.length);
      assert.equal(row.sha256, sha256);
    }
    return { ...carrier, packageDependencies, entries, prefix, file, size: bytes.length, sha256 };
  });
  assert.equal(
    new Set(records.map((row) => row.id)).size,
    records.length,
    'repeated Cargo carrier',
  );
  if (produced)
    assert.deepEqual(records.map((row) => row.name).sort(), produced.map((row) => row.name).sort());
  assert.deepEqual(
    records
      .filter((row) => row.declared)
      .map((row) => row.name)
      .sort(),
    declared.map((row) => row.name).sort(),
    'Cargo leaves differ from canonical carrier identities',
  );
  validateCargoPayloadPartSets(records);
  return records;
}

/** Read the same complete files/chunks that the canonical Cargo build script consumes. */
export function readWasixCargoCarrierPayload(
  records: ReturnType<typeof readWasixCargoCarrierSet>,
  parent: ReturnType<typeof readWasixCargoCarrierSet>[number],
) {
  const roots = parent.packageDependencies.some((row) =>
    row.name.startsWith(`${parent.name}-part-`),
  )
    ? records.filter((row) => row.parentCarrier === parent.id)
    : [parent];
  const files = new Map<string, Buffer>();
  const chunks = new Map<string, { index: number; bytes: Buffer }[]>();
  for (const owner of roots)
    for (const [name, entry] of owner.entries) {
      const prefix = `${owner.prefix}/payload/`;
      if (!name.startsWith(prefix)) continue;
      assert(entry.isDirectory || (entry.isFile && !entry.isSymbolicLink));
      if (entry.isDirectory) continue;
      const relative = name.slice(prefix.length);
      if (relative.startsWith('files/')) {
        const destination = relative.slice('files/'.length);
        assert(!files.has(destination) && !chunks.has(destination), 'repeated Cargo payload file');
        files.set(destination, Buffer.from(entry.data()));
      } else {
        const match = /^chunks\/(.+)\.part([0-9]{6})$/u.exec(relative);
        assert(match && !files.has(match[1]), 'unexpected Cargo payload member');
        const rows = chunks.get(match[1]) ?? [];
        rows.push({ index: Number(match[2]), bytes: Buffer.from(entry.data()) });
        chunks.set(match[1], rows);
      }
    }
  for (const [name, rows] of chunks) {
    rows.sort((left, right) => left.index - right.index);
    assert.deepEqual(
      rows.map((row) => row.index),
      rows.map((_, index) => index),
      'non-contiguous Cargo payload chunks',
    );
    files.set(name, Buffer.concat(rows.map((row) => row.bytes)));
  }
  return files;
}
