import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RegistryContext {
  schema: string;
  cargo: string;
  repository: string;
  target: string;
  archives: { name: string; version: string }[];
  config: Record<string, unknown>;
  indexes: { path: string; header: string; records: Record<string, any>[] }[];
}

export function validateRegistryContext(lockText: string, context: RegistryContext) {
  assert.equal(context.schema, 'oliphaunt-installed-cargo-fixture-v1');
  assert.equal(context.repository, 'index.crates.io-1949cf8c6b5b557f');
  assert.equal(context.target, 'x86_64-unknown-linux-gnu');
  const lock = Bun.TOML.parse(lockText);
  const records = new Map<string, Record<string, any>>();
  const indexPaths = new Set<string>();
  for (const index of context.indexes) {
    assert(/^(?:1|2|3\/[a-z0-9_-]|[a-z0-9_-]{2}\/[a-z0-9_-]{2})\/[a-z0-9_-]+$/u.test(index.path));
    assert(!indexPaths.has(index.path), `duplicate sparse index: ${index.path}`);
    indexPaths.add(index.path);
    const header = Buffer.from(index.header, 'base64');
    assert(header.subarray(0, 5).equals(Buffer.from([3, 2, 0, 0, 0])));
    assert.equal(header.at(-1), 0);
    for (const record of index.records) {
      const id = `${record.name}@${record.vers}`;
      assert(!records.has(id), `duplicate registry record: ${id}`);
      const name = String(record.name).toLowerCase();
      const key =
        name.length === 1
          ? `1/${name}`
          : name.length === 2
            ? `2/${name}`
            : name.length === 3
              ? `3/${name[0]}/${name}`
              : `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
      assert.equal(index.path, key);
      records.set(id, record);
    }
  }
  const archives = [];
  for (const pkg of lock.package ?? []) {
    if (!pkg.source) continue;
    assert.equal(pkg.source, 'registry+https://github.com/rust-lang/crates.io-index');
    assert(/^[a-f0-9]{64}$/u.test(pkg.checksum));
    const id = `${pkg.name}@${pkg.version}`;
    assert.equal(records.get(id)?.cksum, pkg.checksum, `locked registry identity differs: ${id}`);
    records.delete(id);
    archives.push({ name: pkg.name, version: pkg.version, sha256: pkg.checksum });
  }
  assert.equal(records.size, 0, 'registry snapshot contains unlocked records');
  const archiveIds = new Set(
    context.archives.map((archive) => `${archive.name}@${archive.version}`),
  );
  assert.equal(archiveIds.size, context.archives.length, 'duplicate acquired registry identity');
  const selected = archives.filter((archive) =>
    archiveIds.has(`${archive.name}@${archive.version}`),
  );
  assert.equal(selected.length, archiveIds.size, 'acquisition includes an unlocked archive');
  return selected;
}

export function writeRegistryIndex(context: RegistryContext, directory: string) {
  const root = path.join(directory, 'registry/index', context.repository);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(context.config)}\n`);
  for (const index of context.indexes) {
    const file = path.join(root, '.cache', index.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(index.header, 'base64'),
        ...index.records.flatMap((record) => [
          Buffer.from(`${record.vers}\0`),
          Buffer.from(`${JSON.stringify(record)}\0`),
        ]),
      ]),
    );
  }
}

if (import.meta.main) {
  const [lock, index, output] = process.argv.slice(2);
  assert(lock && index && output);
  const context = JSON.parse(readFileSync(index, 'utf8')) as RegistryContext;
  const archives = validateRegistryContext(readFileSync(lock, 'utf8'), context);
  writeRegistryIndex(context, output);
  writeFileSync(path.join(output, 'archives.json'), `${JSON.stringify(archives)}\n`);
}
