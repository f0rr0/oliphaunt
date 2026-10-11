import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPortableArchiveEntries } from '../packaging/portable-archive.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import { createCompletedPublicationChecker } from './completed-release-publication.mts';
import {
  compareNativeCompletedSourceDelivery,
  sourceCarrierMembers,
} from './native-source-carrier-changes.mts';
import { buildPublicationCandidate, freezePublicationCandidate } from './publication-lock.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';

const fixture = fileURLToPath(new URL('./testdata/native-source-carriers/', import.meta.url));
const captured = JSON.parse(readFileSync(path.join(fixture, 'captured-publication.json'), 'utf8'));
const publicationSha = 'c51052fe8b8ffc7e992266c5ab3d7a63b47441e7';
const cargo = { ecosystem: 'cargo', name: 'oliphaunt-query', version: '0.1.1' };
const npm = { ecosystem: 'npm', name: '@oliphaunt/ts-query', version: '0.1.1' };
const cargoFile = path.join(fixture, 'oliphaunt-query-0.1.1.crate');
const npmFile = path.join(fixture, 'oliphaunt-ts-query-0.1.1.tgz');
const baselines = {
  'oliphaunt-query': {
    version: '0.1.1',
    tagName: 'oliphaunt-query-v0.1.1',
    publicationSha,
    archives: { 'cargo:oliphaunt-query': cargoFile },
  },
  'oliphaunt-query-ts': {
    version: '0.1.1',
    tagName: 'oliphaunt-query-ts-v0.1.1',
    publicationSha,
    archives: { 'npm:@oliphaunt/ts-query': npmFile },
  },
};

const candidateDirectories: string[] = [];
after(() => {
  for (const directory of candidateDirectories) rmSync(directory, { recursive: true, force: true });
});

function environment(
  changes: { responses?: any; pullRequests?: any; registryMetadata?: any } = {},
) {
  const responses = changes.responses ?? captured.responses;
  const readJson = async (endpoint: string) => {
    assert.ok(Object.hasOwn(responses, endpoint), `unexpected GitHub fixture read ${endpoint}`);
    return structuredClone(responses[endpoint]);
  };
  return {
    repository: 'f0rr0/oliphaunt',
    readJson,
    assertCompletedPublication: createCompletedPublicationChecker({
      repository: 'f0rr0/oliphaunt',
      readJson,
      listPullRequests: async () => structuredClone(changes.pullRequests ?? captured.pullRequests),
      readPages: async () => {
        throw new Error('captured recovery history is complete');
      },
    }),
    registryOptions: {
      cratesIoReadGate: null,
      fetchImpl: async (url: string) => {
        const metadata = changes.registryMetadata ?? captured.registryMetadata;
        if (url === 'https://crates.io/api/v1/crates/oliphaunt-query/0.1.1')
          return Response.json(metadata.cargo);
        assert.equal(url, 'https://registry.npmjs.org/%40oliphaunt%2Fts-query/0.1.1');
        return Response.json(metadata.npm);
      },
    },
  };
}

function candidate(roots = [fixture], products = Object.keys(baselines)) {
  const versions = new Map(
    loadPublicationCatalog('source fixture', { products }).products.map(({ id, version }) => [
      id,
      version,
    ]),
  );
  let artifactRoots = roots;
  if (products.some((product) => versions.get(product) !== baselines[product].version)) {
    // Keep authenticated historical archives immutable; simulate only current own stamps.
    const directory = mkdtempSync(path.join(tmpdir(), 'native-source-current-fixture-'));
    candidateDirectories.push(directory);
    for (const root of roots)
      for (const file of readdirSync(root)) {
        if (!/\.(?:crate|tgz)$/u.test(file)) continue;
        const product = file.endsWith('.crate') ? 'oliphaunt-query' : 'oliphaunt-query-ts';
        const version = versions.get(product) ?? baselines[product].version;
        const rows = archiveRows(path.join(root, file)).map((row) => {
          const member = row.name.slice(
            file.endsWith('.crate') ? 'oliphaunt-query-0.1.1/'.length : 'package/'.length,
          );
          let data = row.data;
          if (['Cargo.toml', 'Cargo.toml.orig', 'Cargo.lock'].includes(member))
            data = Buffer.from(
              data.toString().replace('version = "0.1.1"', `version = "${version}"`),
            );
          else if (row.name === 'package/package.json')
            data = Buffer.from(
              data.toString().replace('"version": "0.1.1"', `"version": "${version}"`),
            );
          return {
            ...row,
            name: row.name.replace(/^oliphaunt-query-0\.1\.1/u, `oliphaunt-query-${version}`),
            data,
          };
        });
        writeFileSync(path.join(directory, file), tarArchive(rows));
      }
    artifactRoots = [directory];
  }
  return {
    ...buildPublicationCandidate({ products, artifactRoots }),
    scope: 'construction',
  };
}

function archiveRows(file: string) {
  return [...readPortableArchiveEntries(file).values()].map((entry) => ({
    name: entry.name + (entry.isDirectory && !entry.name.endsWith('/') ? '/' : ''),
    type: entry.isFile ? '0' : '5',
    mode: entry.mode,
    data: entry.isFile ? entry.data() : Buffer.alloc(0),
  }));
}

function repack(t: any, file: string, transform: (rows: any[]) => any[]) {
  const directory = mkdtempSync(path.join(tmpdir(), 'native-source-carrier-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, path.basename(file));
  writeFileSync(output, tarArchive(transform(archiveRows(file))));
  return output;
}

function differentMembers(before: any[], after: any[]) {
  const old = new Map(before.map((row) => [row.member, JSON.stringify(row)]));
  const current = new Map(after.map((row) => [row.member, JSON.stringify(row)]));
  return [...new Set([...old.keys(), ...current.keys()])]
    .filter((name) => old.get(name) !== current.get(name))
    .sort();
}

test('authentic completed tagged publications and registry bytes bridge source packages only', async () => {
  const input = candidate();
  const report = await compareNativeCompletedSourceDelivery(input, baselines, environment());
  assert.equal(report.scope, 'construction');
  assert.equal(report.releaseDecision, 'unverified');
  assert.deepEqual(report.source, input.source);
  assert.deepEqual(
    report.products.map(({ deliveryStatus }) => deliveryStatus),
    ['identical', 'identical'],
  );
  for (const product of report.products) {
    assert.equal(product.origin.publicationSha, publicationSha);
    assert.equal(product.origin.publicationTree, '59791800860832994b48b8009bb48c5a74a7764e');
    assert.equal(product.origin.releaseSha, '7b192697ff522f71f9c694593d352aa30469cea1');
    assert.deepEqual(product.carriers[0].differentMembers, []);
  }
  assert.deepEqual(
    report.products.map(({ carriers }) => carriers[0].registryProof.registryProof.source),
    ['crates.io-version-checksum', 'npm-dist-integrity'],
  );
  assert.ok(report.unverified.includes('completed native configured producer/input provenance'));
  assert.throws(
    () => freezePublicationCandidate({ ...input, comparison: report }),
    /construction|qualified producer/u,
  );
});

test('neutralizes only typed Cargo own identity across manifest, original and lock', (t) => {
  const updated = repack(t, cargoFile, (rows) =>
    rows.map((row) => {
      const member = row.name.slice('oliphaunt-query-0.1.1/'.length);
      const data = ['Cargo.toml', 'Cargo.toml.orig', 'Cargo.lock'].includes(member)
        ? Buffer.from(row.data.toString().replace(/version = "0\.1\.1"/u, 'version = "0.2.0"'))
        : row.data;
      return {
        ...row,
        name: row.name.replace('oliphaunt-query-0.1.1', 'oliphaunt-query-0.2.0'),
        data,
      };
    }),
  );
  assert.deepEqual(
    sourceCarrierMembers(updated, { ...cargo, version: '0.2.0' }),
    sourceCarrierMembers(cargoFile, cargo),
  );
  const vcs = sourceCarrierMembers(updated, { ...cargo, version: '0.2.0' }).find(
    ({ member }) => member === '.cargo_vcs_info.json',
  );
  assert.equal(
    vcs.sha256,
    createHash('sha256')
      .update(
        readPortableArchiveEntries(cargoFile)
          .get('oliphaunt-query-0.1.1/.cargo_vcs_info.json')
          .data(),
      )
      .digest('hex'),
  );
});

test('neutralizes only npm top-level version while preserving other manifest bytes', (t) => {
  const updated = repack(t, npmFile, (rows) =>
    rows.map((row) =>
      row.name === 'package/package.json'
        ? {
            ...row,
            data: Buffer.from(
              row.data.toString().replace('"version": "0.1.1"', '"version": "0.2.0"'),
            ),
          }
        : row,
    ),
  );
  assert.deepEqual(
    sourceCarrierMembers(updated, { ...npm, version: '0.2.0' }),
    sourceCarrierMembers(npmFile, npm),
  );
  const formatChange = repack(t, npmFile, (rows) =>
    rows.map((row) =>
      row.name === 'package/package.json'
        ? { ...row, data: Buffer.from(`${row.data.toString()}\n`) }
        : row,
    ),
  );
  assert.deepEqual(
    differentMembers(sourceCarrierMembers(npmFile, npm), sourceCarrierMembers(formatChange, npm)),
    ['package.json'],
  );
});

test('real shipped source, legal, modes, dependency pins and VCS changes remain reasons', (t) => {
  const original = [...readPortableArchiveEntries(cargoFile).values()];
  const source = original.find((row) => row.isFile && row.name.endsWith('.rs')).name;
  const legal = original.find((row) => row.isFile && /LICENSE|NOTICE/u.test(row.name)).name;
  const updated = repack(t, cargoFile, (rows) =>
    rows.map((row) => {
      if (row.name === source)
        return {
          ...row,
          data: Buffer.concat([row.data, Buffer.from('\n// consumed source change\n')]),
        };
      if (row.name === legal) return { ...row, mode: 0o600 };
      if (row.name.endsWith('/.cargo_vcs_info.json'))
        return {
          ...row,
          data: Buffer.from(
            row.data.toString().replace('79c340949f4121e962741b75d80e686b5ba023c2', publicationSha),
          ),
        };
      if (row.name.endsWith('/Cargo.lock'))
        return {
          ...row,
          data: Buffer.concat([
            row.data,
            Buffer.from(
              '\n[[package]]\nname = "held-library"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
            ),
          ]),
        };
      return row;
    }),
  );
  assert.deepEqual(
    differentMembers(sourceCarrierMembers(cargoFile, cargo), sourceCarrierMembers(updated, cargo)),
    [
      '.cargo_vcs_info.json',
      'Cargo.lock',
      legal.slice('oliphaunt-query-0.1.1/'.length),
      source.slice('oliphaunt-query-0.1.1/'.length),
    ].sort(),
  );
  const npmUpdated = repack(t, npmFile, (rows) =>
    rows.map((row) =>
      row.name === 'package/package.json'
        ? {
            ...row,
            data: Buffer.from(
              row.data
                .toString()
                .replace(
                  '"version": "0.1.1",',
                  '"version": "0.1.1",\n  "dependencies": { "held-library": "=1.0.0" },',
                ),
            ),
          }
        : row,
    ),
  );
  assert.deepEqual(
    differentMembers(sourceCarrierMembers(npmFile, npm), sourceCarrierMembers(npmUpdated, npm)),
    ['package.json'],
  );
});

test('reports actual changed package members through the existing candidate adapter', async (t) => {
  const modified = repack(t, cargoFile, (rows) =>
    rows.map((row) =>
      row.name.endsWith('/src/lib.rs')
        ? { ...row, data: Buffer.concat([row.data, Buffer.from('\n// actual shipped change\n')]) }
        : row,
    ),
  );
  const report = await compareNativeCompletedSourceDelivery(
    candidate([path.dirname(modified)], ['oliphaunt-query']),
    baselines,
    environment(),
  );
  assert.equal(report.products[0].deliveryStatus, 'different');
  assert.deepEqual(report.products[0].carriers[0].differentMembers, ['src/lib.rs']);
  assert.equal(report.releaseDecision, 'unverified');
});

test('an unrelated-commit provenance stamp differs in delivery without asserting release necessity', async (t) => {
  const { commits, sourceTree, scope } = captured.provenanceOnlyExample;
  assert.notEqual(commits[0], commits[1]);
  assert.match(sourceTree, /^[0-9a-f]{40}$/u);
  assert.match(scope, /not configured producer/u);
  const updated = repack(t, cargoFile, (rows) =>
    rows.map((row) => {
      if (!row.name.endsWith('/.cargo_vcs_info.json')) return row;
      const vcs = JSON.parse(row.data.toString());
      assert.equal(vcs.git.sha1, commits[0]);
      return { ...row, data: Buffer.from(row.data.toString().replace(commits[0], commits[1])) };
    }),
  );
  const report = await compareNativeCompletedSourceDelivery(
    candidate([path.dirname(updated)], ['oliphaunt-query']),
    baselines,
    environment(),
  );
  assert.equal(report.products[0].deliveryStatus, 'different');
  assert.deepEqual(report.products[0].carriers[0].differentMembers, ['.cargo_vcs_info.json']);
  assert.equal(report.releaseDecision, 'unverified');
  assert.equal(Object.hasOwn(report, 'selectedProducts'), false);
  assert.ok(report.unverified.includes('completed native configured producer/input provenance'));
});

test('missing origins stay unknown and incomplete candidates fail closed', async () => {
  const input = candidate();
  const report = await compareNativeCompletedSourceDelivery(input, {}, environment());
  assert.ok(
    report.products.every(
      ({ deliveryStatus, reason }) =>
        deliveryStatus === 'unknown' && reason === 'missing-completed-publication',
    ),
  );
  const incomplete = structuredClone(input);
  incomplete.carriers.pop();
  await assert.rejects(
    compareNativeCompletedSourceDelivery(incomplete, baselines, environment()),
    /missing carrier set mismatch/u,
  );
});

test('a completed source publication cannot supply missing native binary or seed producer facts', async () => {
  for (const kind of ['runtime-tree', 'database-seed']) {
    const responses = structuredClone(captured.responses);
    const descriptor =
      responses[`repos/f0rr0/oliphaunt/contents/src/query/rust/release.toml?ref=${publicationSha}`];
    // Deliberately vary the classification input; archive identity is still genuine.
    const bytes = Buffer.from(
      Buffer.from(descriptor.content, 'base64')
        .toString()
        .replace(
          'release_artifacts = ["cargo-crate"]',
          `release_artifacts = ["cargo-crate", "${kind}"]`,
        ),
    );
    descriptor.content = bytes.toString('base64');
    descriptor.sha = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    const report = await compareNativeCompletedSourceDelivery(
      candidate([fixture], ['oliphaunt-query']),
      baselines,
      environment({ responses }),
    );
    assert.equal(report.products[0].deliveryStatus, 'unknown');
    assert.equal(report.products[0].reason, 'first-native-producer-baseline-required');
    assert.equal(report.products[0].origin.publicationSha, publicationSha);
    assert.equal(report.products[0].carriers, undefined);
  }
});

test('registry integrity authenticates completed archives independently of the candidate', async (t) => {
  const substituted = repack(t, cargoFile, (rows) =>
    rows.map((row) =>
      row.name.endsWith('/src/lib.rs')
        ? { ...row, data: Buffer.concat([row.data, Buffer.from('\n// counterfeit baseline\n')]) }
        : row,
    ),
  );
  await assert.rejects(
    compareNativeCompletedSourceDelivery(
      candidate(),
      {
        ...baselines,
        'oliphaunt-query': {
          ...baselines['oliphaunt-query'],
          archives: { 'cargo:oliphaunt-query': substituted },
        },
      },
      environment(),
    ),
    /registry checksum mismatch/u,
  );
  const registryMetadata = structuredClone(captured.registryMetadata);
  registryMetadata.npm.dist.integrity = 'sha512-invalid';
  await assert.rejects(
    compareNativeCompletedSourceDelivery(candidate(), baselines, environment({ registryMetadata })),
    /registry integrity mismatch/u,
  );
});

test('pending completion and substituted historical Git blobs cannot establish an origin', async () => {
  const pending = structuredClone(captured.pullRequests);
  pending[0].labels = [{ name: 'autorelease: pending' }];
  await assert.rejects(
    compareNativeCompletedSourceDelivery(
      candidate(),
      baselines,
      environment({ pullRequests: pending }),
    ),
    /publication is not complete/u,
  );
  const responses = structuredClone(captured.responses);
  responses[
    `repos/f0rr0/oliphaunt/contents/src/query/rust/Cargo.toml?ref=${publicationSha}`
  ].content = Buffer.from('[package]\nname="counterfeit"\nversion="0.1.1"\n').toString('base64');
  await assert.rejects(
    compareNativeCompletedSourceDelivery(candidate(), baselines, environment({ responses })),
    /Git blob differs/u,
  );
});

test('own identity, original/lock identity and qualification markers are validated before normalization', (t) => {
  assert.throws(
    () => sourceCarrierMembers(cargoFile, { ...cargo, version: '0.2.0' }),
    /missing packed/u,
  );
  for (const member of ['Cargo.toml.orig', 'Cargo.lock']) {
    const wrong = repack(t, cargoFile, (rows) =>
      rows.map((row) =>
        row.name.endsWith(`/${member}`)
          ? {
              ...row,
              data: Buffer.from(
                row.data.toString().replace('version = "0.1.1"', 'version = "9.0.0"'),
              ),
            }
          : row,
      ),
    );
    assert.throws(() => sourceCarrierMembers(wrong, cargo), /package version differs/u);
  }
  const cargoQualified = repack(t, cargoFile, (rows) =>
    rows.map((row) =>
      row.name.endsWith('/Cargo.toml')
        ? {
            ...row,
            data: Buffer.concat([
              row.data,
              Buffer.from('\n[package.metadata.oliphaunt]\nqualificationOnly = false\n'),
            ]),
          }
        : row,
    ),
  );
  assert.throws(() => sourceCarrierMembers(cargoQualified, cargo), /qualification-only/u);
  const npmQualified = repack(t, npmFile, (rows) =>
    rows.map((row) =>
      row.name === 'package/package.json'
        ? {
            ...row,
            data: Buffer.from(
              row.data
                .toString()
                .replace(
                  '"version": "0.1.1",',
                  '"version": "0.1.1",\n  "oliphaunt": { "qualificationOnly": false },',
                ),
            ),
          }
        : row,
    ),
  );
  assert.throws(() => sourceCarrierMembers(npmQualified, npm), /qualification-only/u);
});

test('normalization preserves valid replacement characters and rejects malformed UTF-8 bytes', (t) => {
  for (const member of ['Cargo.toml', 'Cargo.toml.orig', 'Cargo.lock', 'package.json']) {
    const descriptor = member === 'package.json' ? npm : cargo;
    const archive = member === 'package.json' ? npmFile : cargoFile;
    const packedPath = `${member === 'package.json' ? 'package' : 'oliphaunt-query-0.1.1'}/${member}`;
    const valid = repack(t, archive, (rows) =>
      rows.map((row) =>
        row.name === packedPath
          ? {
              ...row,
              data:
                member === 'package.json'
                  ? Buffer.from(row.data.toString().replace('{', '{"utf8-proof":"\ufffd",'))
                  : Buffer.concat([row.data, Buffer.from('\n# UTF-8 proof: \ufffd\n')]),
            }
          : row,
      ),
    );
    assert.deepEqual(
      differentMembers(
        sourceCarrierMembers(archive, descriptor),
        sourceCarrierMembers(valid, descriptor),
      ),
      [member],
    );
    const malformed = repack(t, valid, (rows) =>
      rows.map((row) => {
        if (row.name !== packedPath) return row;
        const offset = row.data.indexOf(Buffer.from('\ufffd'));
        assert.ok(offset >= 0);
        return {
          ...row,
          data: Buffer.concat([
            row.data.subarray(0, offset),
            Buffer.from([0xff]),
            row.data.subarray(offset + 3),
          ]),
        };
      }),
    );
    assert.throws(() => sourceCarrierMembers(malformed, descriptor), /encoded data was not valid/u);
  }
});

test('the versioned outer Cargo directory retains its delivered mode', (t) => {
  const root = 'oliphaunt-query-0.1.1/';
  const before = repack(t, cargoFile, (rows) => [
    { name: root, type: '5', mode: 0o755, data: '' },
    ...rows.filter(({ name }) => name !== root),
  ]);
  const after = repack(t, before, (rows) =>
    rows.map((row) => (row.name === root ? { ...row, mode: 0o700 } : row)),
  );
  assert.deepEqual(
    differentMembers(sourceCarrierMembers(before, cargo), sourceCarrierMembers(after, cargo)),
    ['.'],
  );
});
