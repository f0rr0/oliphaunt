import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SourceMetadata,
  selectedSourceEntries,
  sourceEnvelope,
  sourceManifest,
} from './source-package.mts';

const original =
  '[package]\nname="sdk"\nversion="0.3.2"\nedition.workspace=true\nlicense.workspace=true\n[dependencies]\nquery={path="../query",version="0.1.1"}\nserde={workspace=true,features=["rc"]}\n';
const workspace =
  '[workspace.package]\nedition="2024"\nlicense="MIT"\n[workspace.dependencies]\nserde={version="1",features=["derive"]}\n';
const metadata: SourceMetadata = {
  product: 'sdk',
  version: '0.3.2',
  compatibility: { runtime: '0.3.2', broker: '0.3.1' },
  dependencyOwners: {},
};

test('public source manifests preserve dependency ranges/features and resolve workspace values', () => {
  const manifest = sourceManifest(original, workspace, metadata);
  expect(manifest.package).toEqual({
    name: 'sdk',
    version: '0.3.2',
    edition: '2024',
    license: 'MIT',
  });
  expect(manifest.dependencies.query).toEqual({ version: '0.1.1' });
  expect(manifest.dependencies.serde).toEqual({ version: '1', features: ['derive', 'rc'] });
  expect(manifest.workspace).toEqual({});
  expect(() => sourceManifest(original, workspace, { ...metadata, version: '0.3.3' })).toThrow(
    'owner',
  );
  expect(() =>
    sourceManifest(original.replace(',version="0.1.1"', ''), workspace, metadata),
  ).toThrow('Unversioned');
});

test('SDK carriers retain installed pins even when another workspace release version is newer', () => {
  const delivery = {
    ...metadata,
    nativeArtifacts: [
      { sourceProduct: 'runtime', target: 'linux-x64-gnu', packageName: 'runtime-linux-x64-gnu' },
    ],
    brokerArtifacts: [
      { sourceProduct: 'broker', target: 'linux-x64-gnu', packageName: 'broker-linux-x64-gnu' },
    ],
  };
  const manifest = sourceManifest(original, workspace, delivery);
  const dependencies =
    manifest.target['cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))']
      .dependencies;
  expect(dependencies).toEqual({
    'runtime-linux-x64-gnu': { version: '=0.3.2' },
    'broker-linux-x64-gnu': { version: '=0.3.1' },
  });
  expect(() =>
    sourceManifest(original, workspace, {
      ...delivery,
      brokerArtifacts: [{ ...delivery.brokerArtifacts[0], target: 'macos-arm64' }],
    }),
  ).toThrow('mismatch');
  expect(() => sourceManifest(original, workspace, { ...delivery, compatibility: {} })).toThrow(
    'Missing installed',
  );
});

test('wildcard path carriers resolve to their consumer compatibility contract', () => {
  const source = original.replace('version="0.1.1"', 'version="*"');
  expect(
    sourceManifest(source, workspace, { ...metadata, dependencyOwners: { query: 'runtime' } })
      .dependencies.query.version,
  ).toBe('=0.3.2');
  expect(() => sourceManifest(source, workspace, metadata)).toThrow('Missing installed');
});

test('inherited string requirements keep optionality and target feature additions', () => {
  const manifest = sourceManifest(
    '[package]\nname="sdk"\nversion="0.3.2"\nworkspace="../adapters"\n[dependencies]\nquery={workspace=true,optional=true}\n[target.\'cfg(unix)\'.build-dependencies]\nquery={workspace=true,features=["std"]}\n',
    '[workspace.dependencies]\nquery="=0.1.1"\n',
    metadata,
  );
  expect(manifest.dependencies.query).toEqual({ version: '=0.1.1', optional: true });
  expect(manifest.target['cfg(unix)']['build-dependencies'].query).toEqual({
    version: '=0.1.1',
    features: ['std'],
  });
  expect(manifest.package.workspace).toBeUndefined();
  expect(manifest.workspace).toEqual({});
  expect(() =>
    sourceManifest(
      '[package]\nname="sdk"\nversion="0.3.2"\n[dependencies]\nquery.workspace=true\n',
      '[workspace]\n',
      metadata,
    ),
  ).toThrow('Missing inherited');
});

test('admits exactly Cargo-listed declared bytes and rejects undeclared source or duplicate entries', () => {
  const entries = {
    'Cargo.toml': Buffer.from('manifest'),
    'src/lib.rs': Buffer.from('pub fn api() {}'),
    'tests/private.rs': Buffer.from('private checkout test'),
  };
  expect(
    selectedSourceEntries('Cargo.lock\nCargo.toml\nCargo.toml.orig\nsrc/lib.rs\n', entries),
  ).toEqual({
    'Cargo.toml': entries['Cargo.toml'],
    'src/lib.rs': entries['src/lib.rs'],
  });
  expect(() => selectedSourceEntries('Cargo.toml\n../ambient.rs\n', entries)).toThrow('undeclared');
  expect(() => selectedSourceEntries('Cargo.toml\nCargo.toml\n', entries)).toThrow('repeated');
  expect(() => selectedSourceEntries('src/lib.rs\n', entries)).toThrow('omitted');
});

test('native source envelopes are deterministic, retain manifests and reject undeclared/unsafe entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cargo-source-'));
  try {
    const manifest = join(directory, 'Cargo.toml');
    const root = join(directory, 'workspace.toml');
    const readme = join(directory, 'README.md');
    const license = join(directory, 'LICENSE');
    await writeFile(manifest, original);
    await writeFile(root, workspace);
    await writeFile(readme, 'SDK');
    await writeFile(license, 'MIT');
    const entries = { 'Cargo.toml': manifest, 'README.md': readme, LICENSE: license };
    const first = await sourceEnvelope(manifest, root, entries, metadata);
    expect(await sourceEnvelope(manifest, root, entries, metadata)).toEqual(first);
    const files = await new Bun.Archive(first).files();
    expect(await files.get('sdk-0.3.2/Cargo.toml.orig')?.text()).toBe(
      await readFile(manifest, 'utf8'),
    );
    expect(
      Bun.TOML.parse((await files.get('sdk-0.3.2/Cargo.toml')?.text()) ?? '').dependencies.query
        .path,
    ).toBeUndefined();
    await expect(
      sourceEnvelope(manifest, root, { ...entries, '../unsafe': readme }, metadata),
    ).rejects.toThrow('Unsafe');
    await expect(
      sourceEnvelope(manifest, root, { 'Cargo.toml': manifest }, metadata),
    ).rejects.toThrow('Missing public');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
