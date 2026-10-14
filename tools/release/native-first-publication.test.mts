import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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

test('a new source owner selects its first release and keeps registry libraries separate from installed helpers', () => {
  const repository = path.resolve(import.meta.dir, '../..');
  const directory = mkdtempSync(path.join(tmpdir(), 'native-first-publication-'));
  const snapshot = path.join(directory, 'source');
  const owner = 'src/query/review-first';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: snapshot, encoding: 'utf8' }).trim();
  try {
    mkdirSync(snapshot);
    execFileSync('git', ['archive', 'HEAD', '--output', path.join(directory, 'source.tar')], {
      cwd: repository,
    });
    execFileSync('tar', ['-xf', path.join(directory, 'source.tar'), '-C', snapshot]);
    // Exercise checked-out readers even before their source change is committed.
    for (const file of [
      'native-completed-delivery.mts',
      'completed-contrib-carrier-context.mts',
      'publication-lock.mts',
      'with-source.mts',
      'publication-catalog.mts',
      'release-graph.mts',
      'release-artifact-targets.mts',
      'native-release-preparation.mts',
      'native-publication-metadata.mts',
      'compatibility-version-parser.mts',
      'testdata/prepare-release-candidate-fixtures.mts',
    ])
      copyFileSync(
        path.join(repository, 'tools/release', file),
        path.join(snapshot, 'tools/release', file),
      );
    // The shared parser has no file dependencies; use its actual current
    // implementation with the checked-out acquisition readers above.
    copyFileSync(
      path.join(repository, 'tools/packaging/cargo-manifest.mts'),
      path.join(snapshot, 'tools/packaging/cargo-manifest.mts'),
    );
    symlinkSync(
      path.join(repository, 'node_modules'),
      path.join(snapshot, 'node_modules'),
      'junction',
    );
    symlinkSync(
      path.join(repository, 'tools/release/node_modules'),
      path.join(snapshot, 'tools/release/node_modules'),
      'junction',
    );
    mkdirSync(path.join(snapshot, owner, 'src'), { recursive: true });
    const config = JSON.parse(
      readFileSync(path.join(snapshot, 'release-please-config.json'), 'utf8'),
    );
    config.packages[owner] = {
      'release-type': 'rust',
      component: 'review-first',
      'package-name': 'review-first',
      'changelog-path': 'CHANGELOG.md',
    };
    writeFileSync(path.join(snapshot, 'release-please-config.json'), JSON.stringify(config));
    const versions = JSON.parse(
      readFileSync(path.join(snapshot, '.release-please-manifest.json'), 'utf8'),
    );
    versions[owner] = '0.0.0';
    writeFileSync(path.join(snapshot, '.release-please-manifest.json'), JSON.stringify(versions));
    writeFileSync(
      path.join(snapshot, owner, 'release.toml'),
      'id = "review-first"\nowner = "@oliphaunt/core"\nkind = "sdk"\npublish_targets = ["crates-io"]\nregistry_packages = ["crates:review-first"]\nrelease_artifacts = ["cargo-crate"]\n[compatibility_versions.current_core]\npublic_support = false\nsource_product = "liboliphaunt-native-bindings"\npath = "src/query/review-first/Cargo.toml"\nparser = "toml:dependencies.liboliphaunt-native-bindings.version"\n',
    );
    writeFileSync(
      path.join(snapshot, owner, 'Cargo.toml'),
      '[package]\nname = "review-first"\nversion = "0.0.0"\nlicense = "MIT"\n[dependencies]\nliboliphaunt-native-bindings = { path = "../../native/rust-bindings", version = "0.2.0" }\n',
    );
    writeFileSync(path.join(snapshot, owner, 'src/lib.rs'), 'pub fn first() -> bool { true }\n');
    writeFileSync(path.join(snapshot, owner, 'CHANGELOG.md'), '');
    git('init', '-q');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'feat: first product fixture',
    );
    const commit = git('rev-parse', 'HEAD');
    const source = { ref: 'HEAD', commit, tree: git('rev-parse', 'HEAD^{tree}'), checkout: commit };
    const script = path.join(snapshot, 'first-publication.mts');
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
import { tarArchive } from './tools/packaging/testdata/tar-fixture.mts';
import { buildPublicationCandidate } from './tools/release/publication-lock.mts';
import { compareNativeCompletedPhysicalDelivery } from './tools/release/native-completed-delivery.mts';
import { acquireNativePublicationInputs } from './tools/release/native-release-preparation.mts';
const acquired = await acquireNativePublicationInputs({ source: { commit: '${source.commit}', tree: '${source.tree}' }, directory: 'current-source-inputs', consumerProducts: ['review-first'] }, {
  readJson: async () => { throw new Error('local Cargo inputs must not request a completed registry publication'); },
  readPages: async () => { throw new Error('local Cargo inputs must not request completed release assets'); },
});
const archive = 'review-first-0.0.0.crate';
writeFileSync(archive, tarArchive([
  { name: 'review-first-0.0.0/Cargo.toml', data: readFileSync('${owner}/Cargo.toml') },
  { name: 'review-first-0.0.0/src/lib.rs', data: readFileSync('${owner}/src/lib.rs') },
]));
const candidate = buildPublicationCandidate({ products: ['review-first'], artifactRoots: [archive], artifactPhase: 'pre-version' });
const initial = await compareNativeCompletedPhysicalDelivery(candidate, [], { unreleasedProducts: ['review-first'] });
const unknown = await compareNativeCompletedPhysicalDelivery(candidate, []);
process.stdout.write(JSON.stringify({ initial: initial.products[0], unknown: unknown.products[0].deliveryStatus, suppliers: acquired.snapshot.supplierPublications }));
`,
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [script], {
        cwd: snapshot,
        encoding: 'utf8',
        env: { ...process.env, OLIPHAUNT_GIT_SOURCE_JSON: JSON.stringify(source) },
      }),
    );
    expect(result.initial.deliveryStatus).toBe('different');
    expect(result.initial.reason).toBe('verified-first-publication');
    expect(result.initial.contractChanges).toEqual({
      added: ['product:review-first'],
      removed: [],
    });
    expect(result.unknown).toBe('unknown');
    expect(result.suppliers).toEqual([]);
    // An aliased registry library and independently held helper belong to the
    // same owner, but request different completed deliveries and surfaces.
    const libraryDescriptor = `id = "review-first"
owner = "@oliphaunt/core"
kind = "sdk"
publish_targets = ["crates-io"]
registry_packages = ["crates:review-first"]
release_artifacts = ["cargo-crate"]
[compatibility_versions.broker_library]
public_support = false
source_product = "oliphaunt-broker"
path = "${owner}/Cargo.toml"
parser = "toml:dependencies.broker-library.version"
`;
    writeFileSync(path.join(snapshot, owner, 'release.toml'), libraryDescriptor);
    writeFileSync(
      path.join(snapshot, owner, 'Cargo.toml'),
      `[package]\nname = "review-first"\nversion = "0.0.0"\nlicense = "MIT"\n[dependencies]\nbroker-library = { package = "oliphaunt-broker", version = "0.3.1" }\n`,
    );
    const scriptRoles = path.join(snapshot, 'source-role-inputs.mts');
    writeFileSync(
      scriptRoles,
      `import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireNativePublicationInputs } from './tools/release/native-release-preparation.mts';
import { fileIdentity } from './tools/release/native-file-identity.mts';
import { fixtureCompletedNativeInventory } from './tools/release/testdata/prepare-release-candidate-fixtures.mts';
import { tarArchive } from './tools/packaging/testdata/tar-fixture.mts';
const downloads = [];
const registries = [];
const publication = { product: 'oliphaunt-broker', version: '0.3.2', tagName: 'oliphaunt-broker-v0.3.2', publicationSha: 'c'.repeat(40), publicationTree: 'd'.repeat(40), releaseSha: 'c'.repeat(40) };
const helperRows = (await fixtureCompletedNativeInventory(publication)).publicRows.filter(row => row.kind === 'broker-helper');
const assets = helperRows.map((row, index) => ({ id: index + 1, name: row.name, state: 'uploaded', size: Buffer.byteLength(row.name), url: 'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/' + (index + 1) }));
const transports = {
  inventory: fixtureCompletedNativeInventory,
  readJson: async endpoint => ({ id: endpoint.endsWith('0.3.2') ? 32 : 31, target_commitish: 'c'.repeat(40), tag_name: decodeURIComponent(endpoint.split('/').at(-1)) }),
  readPages: async endpoint => endpoint.includes('/32/') ? assets : [],
  assertCompleted: async request => ({ ...request, publicationTree: 'd'.repeat(40), releaseSha: request.publicationSha }),
  materialize: async (carrier, options) => {
    registries.push(carrier.id + '@' + carrier.version);
    mkdirSync(options.directory, { recursive: true });
    const file = path.join(options.directory, carrier.artifacts[0].path);
    writeFileSync(file, tarArchive([{ name: carrier.name + '-' + carrier.version + '/Cargo.toml', data: '[package]\\nname = ' + JSON.stringify(carrier.name) + '\\nversion = ' + JSON.stringify(carrier.version) + '\\n' }]));
    const { size, sha256 } = fileIdentity(file);
    return { carrier: { ...carrier, artifacts: [{ path: file, size, sha256 }] }, receipt: {}, metadata: {} };
  },
  proveAsset: async (_url, name, size, options) => {
    downloads.push(name);
    mkdirSync(path.dirname(options.retainedPath), { recursive: true });
    writeFileSync(options.retainedPath, name);
    const actual = fileIdentity(options.retainedPath);
    assert.equal(actual.size, size);
    return { bytes: actual.size, sha256: actual.sha256 };
  },
};
const request = { source: { commit: '${source.commit}', tree: '${source.tree}' }, consumerProducts: ['review-first'] };
const library = await acquireNativePublicationInputs({ ...request, directory: 'library-only-inputs' }, transports);
assert.deepEqual(registries, ['cargo:oliphaunt-broker@0.3.1']);
assert.deepEqual(downloads, []);
await assert.rejects(acquireNativePublicationInputs({ ...request, directory: 'missing-library-inputs' }, { ...transports, inventory: async (publication, options) => { const value = await fixtureCompletedNativeInventory(publication, options); return { ...value, carriers: value.carriers.filter(row => row.id !== 'cargo:oliphaunt-broker') }; } }), /requested Cargo supplier is absent/);
writeFileSync('${owner}/release.toml', readFileSync('${owner}/release.toml', 'utf8') + '\\n[compatibility_versions.broker_helper]\\npublic_support = false\\nsource_product = "oliphaunt-broker"\\npath = "${owner}/Cargo.toml"\\nparser = "toml:package.metadata.oliphaunt.broker-version"\\n');
writeFileSync('${owner}/Cargo.toml', readFileSync('${owner}/Cargo.toml', 'utf8') + '\\n[package.metadata.oliphaunt]\\nbroker-version = "0.3.2"\\n');
const mixed = await acquireNativePublicationInputs({ ...request, directory: 'mixed-role-inputs' }, transports);
assert.deepEqual(registries, ['cargo:oliphaunt-broker@0.3.1', 'cargo:oliphaunt-broker@0.3.1']);
assert.deepEqual(downloads, helperRows.map(row => row.name));
process.stdout.write(JSON.stringify({ library: library.snapshot.supplierArtifacts.map(row => [row.artifact, row.publication.version]), mixed: mixed.snapshot.supplierArtifacts.map(row => [row.artifact, row.publication.version]), helpers: helperRows.map(row => row.id), publications: mixed.snapshot.supplierPublications.map(row => row.version).sort() }));
`,
    );
    const roles = JSON.parse(
      execFileSync(process.execPath, [scriptRoles], { cwd: snapshot, encoding: 'utf8' }),
    );
    expect(roles.library).toEqual([['cargo:oliphaunt-broker', '0.3.1']]);
    expect(roles.mixed).toEqual([
      ['cargo:oliphaunt-broker', '0.3.1'],
      ...roles.helpers.map((id: string) => [id, '0.3.2']),
    ]);
    expect(roles.publications).toEqual(['0.3.1', '0.3.2']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
