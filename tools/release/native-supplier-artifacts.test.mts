import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadReleaseMetadata,
  nativePublicationInputProjection,
  renderReleaseMetadata,
} from './bazel-release-metadata.mts';
import {
  projectNativeSupplierArtifacts,
  validateNativeSupplierArtifacts,
} from './native-supplier-artifacts.mts';

const metadata = loadReleaseMetadata(path.resolve(import.meta.dir, '../..'));
const catalog = {
  publicationCarriers: metadata.publicationCarriers,
  githubArtifacts: metadata.nativeRuntimeArtifacts as { product: string; asset: string }[],
};
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'completed-supplier-alias-'));
  const publication = {
    product: 'liboliphaunt-native',
    version: '9.2.1',
    tagName: 'liboliphaunt-native-v9.2.1',
    publicationSha: 'a'.repeat(40),
    publicationTree: 'b'.repeat(40),
    releaseSha: 'c'.repeat(40),
  };
  const name = 'liboliphaunt-9.2.1-apple-spm-xcframework.zip';
  const bytes = Buffer.from('controlled physical archive fixture, not authentication');
  const file = {
    path: path.join(directory, name),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeFileSync(file.path, bytes);
  return { directory, row: { publication, artifact: `github-release:${name}`, file } };
}

test('canonical old-version Files join the existing snapshot without current-version or producer assumptions', () => {
  const { directory, row } = fixture();
  try {
    const snapshot = {
      source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) },
      selectedProducts: ['liboliphaunt-native'],
      supplierArtifacts: [row],
    };
    const projected = nativePublicationInputProjection(snapshot, metadata);
    const key = `${row.publication.product}/${row.publication.version}/${row.artifact}`;
    expect(projected.supplierArtifacts[key].publication).toEqual(row.publication);
    expect(projected.supplierArtifacts[key].file.path).toStartWith(
      '@oliphaunt_metadata//:supplier-artifacts/',
    );
    expect(projected.files[0]).toEqual({
      source: row.file.path,
      path: projected.supplierArtifacts[key].file.path.slice('@oliphaunt_metadata//:'.length),
      size: row.file.size,
      sha256: row.file.sha256,
    });
    const rendered = renderReleaseMetadata(metadata, '@identity//:identity.bzl', projected);
    expect(rendered.bzl).toContain('COMPLETED_SUPPLIER_ARTIFACTS =');
    expect(JSON.parse(rendered.completedSupplierArtifacts)).toEqual(projected.supplierArtifacts);
    expect(rendered.build).toContain('"completed-supplier-artifacts.json"');
    expect(rendered.build).toContain(projected.files[0].path);
    expect(row.file.path).toStartWith(directory);
    expect(() => projectNativeSupplierArtifacts([row])).toThrow(/catalog/);
    expect(() =>
      nativePublicationInputProjection({ ...snapshot, supplierArtifacts: null }, metadata),
    ).toThrow();
    expect(() =>
      nativePublicationInputProjection(
        { ...snapshot, supplierPublications: [{ ...row.publication, releaseSha: 'f'.repeat(40) }] },
        metadata,
      ),
    ).toThrow(/conflicts/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical held NAPI names retain publication origin and byte identity', () => {
  const { directory, row } = fixture();
  try {
    const publication = {
      ...row.publication,
      product: 'oliphaunt-wasix-napi',
      version: '0.3.2',
      tagName: 'oliphaunt-wasix-napi-v0.3.2',
    };
    const held = { ...row, publication, artifact: 'npm:@oliphaunt/wasix-napi-linux-x64-gnu' };
    const projected = projectNativeSupplierArtifacts([held], catalog);
    expect(Object.values(projected.artifacts)[0].publication).toEqual(publication);
    expect(projected.files[0].sha256).toBe(row.file.sha256);
    expect(() =>
      projectNativeSupplierArtifacts([{ ...held, publication: row.publication }], catalog),
    ).toThrow(/canonical/);
    expect(() =>
      projectNativeSupplierArtifacts(
        [{ ...held, artifact: 'npm:@oliphaunt/nonexistent' }],
        catalog,
      ),
    ).toThrow(/canonical/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate, contradictory completion, guessed filename and serialized authentication facts fail closed', () => {
  const { directory, row } = fixture();
  try {
    const name = 'liboliphaunt-9.2.1-runtime-resources-ios-datum64.tar.gz';
    const file = { ...row.file, path: path.join(directory, name) };
    writeFileSync(file.path, 'controlled physical archive fixture, not authentication');
    for (const rows of [
      [row, row],
      [
        row,
        {
          ...row,
          artifact: `github-release:${name}`,
          file,
          publication: { ...row.publication, publicationTree: 'f'.repeat(40) },
        },
      ],
      [{ ...row, artifact: `github-release:${name}` }],
      [{ ...row, authenticated: true }],
      [{ ...row, publication: { ...row.publication, tagName: 'latest' } }],
      [{ ...row, file: { ...row.file, producer: {} } }],
    ])
      expect(() => projectNativeSupplierArtifacts(rows, catalog)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('changed bytes, size, traversal and symlink inputs cannot become File aliases', () => {
  const { directory, row } = fixture();
  try {
    const link = path.join(directory, 'symlink.zip');
    symlinkSync(row.file.path, link);
    for (const file of [
      { ...row.file, sha256: '0'.repeat(64) },
      { ...row.file, size: row.file.size + 1 },
      { ...row.file, path: '../archive.zip' },
      { ...row.file, path: link },
    ])
      expect(() =>
        projectNativeSupplierArtifacts(
          [{ ...row, artifact: 'npm:@oliphaunt/liboliphaunt-linux-x64-gnu', file }],
          catalog,
        ),
      ).toThrow();
    writeFileSync(row.file.path, 'substituted public bytes');
    expect(() => projectNativeSupplierArtifacts([row], catalog)).toThrow(/bytes differ/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sourceTagFixture() {
  const { directory, row } = fixture();
  return {
    directory,
    row: {
      ...row,
      publication: {
        ...row.publication,
        product: 'oliphaunt-swift',
        version: '0.8.2',
        tagName: 'oliphaunt-swift-v0.8.2',
      },
      artifact: 'swift-source-tag:0.8.2',
      source: {
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        member: 'src/sdks/swift/Carriers/oliphaunt-react-native-ios-carriers.json',
        blob: '3'.repeat(40),
      },
    },
  };
}

test('retained source-tag Files preserve their distinct Git source and existing snapshot aliases', () => {
  const { directory, row } = sourceTagFixture();
  try {
    const projected = nativePublicationInputProjection(
      { source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) }, supplierArtifacts: [row] },
      metadata,
    );
    const key = `${row.publication.product}/${row.publication.version}/${row.artifact}`;
    const alias = projected.supplierArtifacts[key];
    expect(alias.publication).toEqual(row.publication);
    expect(alias.source).toEqual(row.source);
    expect(alias.source.commit).not.toBe(row.publication.publicationSha);
    expect(projected.files[0].source).toBe(row.file.path);
    expect(alias.file.path).toBe(`@oliphaunt_metadata//:${projected.files[0].path}`);
    const rendered = renderReleaseMetadata(metadata, '@identity//:identity.bzl', projected);
    expect(JSON.parse(rendered.completedSupplierArtifacts)[key]).toEqual(alias);
    const originalSource = structuredClone(row.source);
    row.source.tree = 'f'.repeat(40);
    expect(alias.source).toEqual(originalSource);
    expect(() =>
      projectNativeSupplierArtifacts([row], { ...catalog, sourceTagProducts: [] }),
    ).toThrow(/canonical/);
    expect(() => projectNativeSupplierArtifacts([row], catalog)).toThrow(/canonical/);
    const unpromised = structuredClone(metadata);
    unpromised.products['oliphaunt-swift'].publish_targets = ['github-release'];
    expect(() =>
      nativePublicationInputProjection(
        { source: { commit: 'd'.repeat(40), tree: 'e'.repeat(40) }, supplierArtifacts: [row] },
        unpromised,
      ),
    ).toThrow(/canonical/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source-tag references require exact namespace, owner, version and safe immutable Git facts', () => {
  const { directory, row } = sourceTagFixture();
  try {
    const { source: _source, ...missingSource } = row;
    for (const bad of [
      missingSource,
      { ...row, source: undefined },
      { ...row, source: { ...row.source, authenticated: true } },
      { ...row, artifact: 'swift-source-tag:0.8.3' },
      {
        ...row,
        publication: {
          ...row.publication,
          product: 'liboliphaunt-native',
          tagName: 'liboliphaunt-native-v0.8.2',
        },
      },
      { ...row, artifact: 'github-release:oliphaunt-swift-0.8.2-bindings.xcframework.zip' },
      { ...row, source: { ...row.source, commit: 'main' } },
      { ...row, source: { ...row.source, tree: 'A'.repeat(40) } },
      { ...row, source: { ...row.source, blob: '0'.repeat(64) } },
      { ...row, source: { ...row.source, member: '../carrier.json' } },
      { ...row, source: { ...row.source, member: '/carrier.json' } },
    ])
      expect(() => validateNativeSupplierArtifacts([bad])).toThrow();
    const sourceCatalog = { ...catalog, sourceTagProducts: ['oliphaunt-swift'] };
    expect(() => projectNativeSupplierArtifacts([row, row], sourceCatalog)).toThrow(/duplicate/);
    writeFileSync(row.file.path, 'substituted retained source delivery');
    expect(() => projectNativeSupplierArtifacts([row], sourceCatalog)).toThrow(/bytes differ/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
