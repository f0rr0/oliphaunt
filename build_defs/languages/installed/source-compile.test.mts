import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeterministicTar } from '../../../tools/packaging/archive-directory.mts';
import { renderCargoToml } from '../../../tools/packaging/cargo-manifest.mts';
import { canonicalGzipSync } from '../../../tools/packaging/portable-archive.mts';
import { cargoCandidate } from './consumer.mts';
import { sourceCandidates, sourceCompile, sourceLock } from './source-compile.mts';

const directory = mkdtempSync(path.join(tmpdir(), 'source-lock-selection-'));
async function archive(
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
  source = '',
) {
  const tree = path.join(
    directory,
    `${name}-${version}-${Math.random().toString(16).slice(2)}`,
    `${name}-${version}`,
  );
  mkdirSync(path.join(tree, 'src'), { recursive: true });
  writeFileSync(
    path.join(tree, 'Cargo.toml'),
    renderCargoToml({ package: { name, version }, dependencies }),
  );
  writeFileSync(path.join(tree, 'src/lib.rs'), source);
  const file = `${tree}.crate`;
  writeFileSync(file, canonicalGzipSync(await createDeterministicTar(tree, { keepParent: true })));
  return cargoCandidate(file);
}
const child = await archive('fixture-child', '0.1.0');
const childNext = await archive('fixture-child', '0.1.1');
const parent = await archive('fixture-parent', '0.2.0', { 'fixture-child': '=0.1.0' });
const parentNext = await archive('fixture-parent', '0.2.1', { 'fixture-child': '=0.1.0' });
const parentAdopts = await archive('fixture-parent', '0.2.1', { 'fixture-child': '=0.1.1' });
const server = await archive('fixture-server', '0.3.0', {
  'fixture-parent': '0.2.0',
  'fixture-child': '0.1.0',
});
const serverNext = await archive('fixture-server', '0.3.1', {
  'fixture-parent': '0.2.0',
  'fixture-child': '0.1.0',
});
const serverAdopts = await archive('fixture-server', '0.3.1', {
  'fixture-parent': '=0.2.1',
  'fixture-child': '=0.1.1',
});
const registry = {
  name: 'fixture-registry',
  version: '1.0.0',
  source: 'registry+https://github.com/rust-lang/crates.io-index',
  checksum: 'a'.repeat(64),
};
const lock = (packages: (typeof child)[]) =>
  renderCargoToml({
    version: 4,
    package: [...packages.map((row) => ({ name: row.name, version: row.version })), registry],
  });
const parentLock = lock([parent, child]);
const serverLock = lock([server, parent, child]);
const identities = (rows: (typeof child)[]) =>
  rows.map((row) => `${row.name}@${row.version}`).sort();

test('query-only own version retargets one local row and preserves registry resolution', () => {
  const original = lock([child]);
  const result = Bun.TOML.parse(sourceLock(original, sourceCandidates(childNext, [], original)));
  expect(result.package).toEqual([{ name: child.name, version: childNext.version }, registry]);
});
test('SDK-only bump retains exact query even when a newer candidate is present', () => {
  expect(identities(sourceCandidates(parentNext, [childNext, child], parentLock, [child]))).toEqual(
    ['fixture-child@0.1.0', 'fixture-parent@0.2.1'],
  );
});
test('server-only bump retains SDK and query through conventional caret requirements', () => {
  expect(
    identities(
      sourceCandidates(serverNext, [parentNext, childNext, parent, child], serverLock, [
        parent,
        child,
      ]),
    ),
  ).toEqual(['fixture-child@0.1.0', 'fixture-parent@0.2.0', 'fixture-server@0.3.1']);
});
test('coordinated adoption selects new query only after packaged requirement changes', () => {
  expect(identities(sourceCandidates(parentAdopts, [childNext, child], parentLock))).toEqual([
    'fixture-child@0.1.1',
    'fixture-parent@0.2.1',
  ]);
  expect(
    identities(
      sourceCandidates(serverAdopts, [parentAdopts, childNext, parent, child], serverLock),
    ),
  ).toEqual(['fixture-child@0.1.1', 'fixture-parent@0.2.1', 'fixture-server@0.3.1']);
});
test('same-version completed bytes win over unselected current source bytes', async () => {
  const changed = await archive(child.name, child.version, {}, '// current unpublished source\n');
  const selected = sourceCandidates(parentNext, [changed], parentLock, [child]);
  expect(selected.find((row) => row.name === child.name)?.sha256).toBe(child.sha256);
});
test('missing exact held identity fails instead of adopting a compatible newer version', () => {
  expect(() => sourceCandidates(serverNext, [parentNext, childNext], serverLock)).toThrow(
    'Missing actual held',
  );
});
test('same-version current bytes never stand in for missing completed dependency bytes', () => {
  expect(() => sourceCandidates(parentNext, [child], parentLock)).toThrow('Missing actual held');
  expect(() => sourceCandidates(serverNext, [parent, child], serverLock)).toThrow(
    'Missing actual held',
  );
});
test('missing adopted candidate and conflicting identities fail closed', () => {
  expect(() => sourceCandidates(parentAdopts, [child], parentLock)).toThrow('Missing or ambiguous');
  expect(() =>
    sourceCandidates(parentNext, [child, { ...child, sha256: '0'.repeat(64) }], parentLock),
  ).toThrow('Conflicting actual');
  expect(() =>
    sourceCandidates(parentNext, [child, { ...child, name: 'undeclared' }], parentLock),
  ).toThrow('Undeclared local');
});
test('registry identities and missing captured local rows cannot be retargeted', () => {
  expect(() => sourceLock(parentLock, [{ ...child, name: registry.name }])).toThrow(
    'Registry package cannot',
  );
  expect(() => sourceLock(parentLock, [{ ...child, name: 'absent' }])).toThrow('ambiguous');
});
test('qualified local references follow own versions without touching registry references', () => {
  const original = renderCargoToml({
    version: 4,
    package: [
      {
        name: parent.name,
        version: parent.version,
        dependencies: [`${child.name} ${child.version}`, registry.name],
      },
      { name: child.name, version: child.version },
      registry,
    ],
  });
  const result = Bun.TOML.parse(sourceLock(original, [parentAdopts, childNext]));
  expect(result.package[0].dependencies).toEqual([
    `${child.name} ${childNext.version}`,
    registry.name,
  ]);
  expect(result.package[2]).toEqual(registry);
});
test('unchanged candidate identities preserve the original Cargo lock bytes', () => {
  expect(sourceLock(parentLock, [parent, child])).toBe(parentLock);
  expect(readFileSync(child.file).length).toBeGreaterThan(0);
});
test('failure removes only owned work and retains diagnostics outside it', async () => {
  const scratch = mkdtempSync(path.join(directory, 'cleanup-'));
  const specification = path.join(scratch, 'spec.json');
  writeFileSync(specification, JSON.stringify({ archives: [] }));
  const previousTemporary = process.env.TEST_TMPDIR;
  const previousDiagnostics = process.env.TEST_UNDECLARED_OUTPUTS_DIR;
  process.env.TEST_TMPDIR = scratch;
  delete process.env.TEST_UNDECLARED_OUTPUTS_DIR;
  try {
    await expect(sourceCompile(specification, scratch)).rejects.toThrow();
    const members = readdirSync(scratch);
    expect(members.some((name) => name.startsWith('installed-source-compile-'))).toBe(false);
    expect(members.some((name) => name.startsWith('installed-source-diagnostics-'))).toBe(true);
    expect(readFileSync(specification, 'utf8')).toBe('{"archives":[]}');
  } finally {
    if (previousTemporary === undefined) delete process.env.TEST_TMPDIR;
    else process.env.TEST_TMPDIR = previousTemporary;
    if (previousDiagnostics === undefined) delete process.env.TEST_UNDECLARED_OUTPUTS_DIR;
    else process.env.TEST_UNDECLARED_OUTPUTS_DIR = previousDiagnostics;
  }
});
