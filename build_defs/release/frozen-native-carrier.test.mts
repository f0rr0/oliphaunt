import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frozenNativeCarrierSource, readFrozenNativeCarrier } from './frozen-native-carrier.mts';

const root = import.meta.dir;
function fixture(tag = '0.8.1') {
  const expectedVersion = tag === '0.8.1' ? '0.3.2' : '0.3.3';
  return {
    source: JSON.parse(readFileSync(path.join(root, `swift-${tag}-source.json`), 'utf8')),
    carrierBytes: readFileSync(path.join(root, `testdata/swift-${tag}-carrier.json`)),
    expectedVersion,
    publicationContext: {
      nativeCompletion: JSON.parse(
        readFileSync(
          path.join(root, `native-${expectedVersion}-completed-publication.json`),
          'utf8',
        ),
      ),
      nativeReleases: JSON.parse(
        readFileSync(path.join(root, `native-${expectedVersion}-releases.json`), 'utf8'),
      ),
      swiftSource: JSON.parse(
        readFileSync(path.join(root, `swift-${tag}-publication-source.json`), 'utf8'),
      ),
    },
  };
}
function changed(update) {
  const value = fixture();
  const document = JSON.parse(value.carrierBytes.toString());
  update(document);
  value.carrierBytes = Buffer.from(JSON.stringify(document));
  value.source = {
    ...value.source,
    bytes: value.carrierBytes.length,
    sha256: createHash('sha256').update(value.carrierBytes).digest('hex'),
    source_blob: createHash('sha1')
      .update(`blob ${value.carrierBytes.length}\0`)
      .update(value.carrierBytes)
      .digest('hex'),
  };
  // Model a different externally captured publication, rather than asking the
  // incoming document to supply its own expected blob or asset declarations.
  value.publicationContext.swiftSource.member.sha = value.source.source_blob;
  for (const asset of document.base.assets) {
    const row = value.publicationContext.nativeReleases[0].assets.find(
      ({ name }) => name === asset.name,
    );
    row.sha256 = asset.sha256;
    row.size = asset.bytes;
  }
  return value;
}

test('reads exact published source members for the independently held and current runtime pins', () => {
  for (const tag of ['0.8.1', '0.8.2']) {
    const value = fixture(tag);
    const carrier = readFrozenNativeCarrier(value);
    expect(carrier.base.version).toBe(value.expectedVersion);
    expect(frozenNativeCarrierSource(value.source)).toContain(
      `/${value.source.source_commit}/${value.source.source_member}`,
    );
    expect(carrier.base.assets).toHaveLength(2);
  }
  expect(() => readFrozenNativeCarrier({ ...fixture(), expectedVersion: '0.3.3' })).toThrow(
    'matching authenticated publication context',
  );
});

test('declared publication inputs independently bind the source blob, parent and native assets', () => {
  const value = fixture();
  expect(() => readFrozenNativeCarrier({ ...value, publicationContext: undefined })).toThrow(
    'matching authenticated publication context',
  );
  for (const update of [
    (context) => {
      context.swiftSource.member.sha = 'f'.repeat(40);
    },
    (context) => {
      context.swiftSource.commit.parents[0].sha = 'f'.repeat(40);
    },
    (context) => {
      context.swiftSource.publication.publicationSha = 'f'.repeat(40);
    },
    (context) => {
      context.nativeCompletion.publicationSha = 'f'.repeat(40);
    },
    (context) => {
      context.nativeReleases[0].assets.find(({ name }) =>
        name.endsWith('apple-spm-xcframework.zip'),
      ).sha256 = 'f'.repeat(64);
    },
  ]) {
    const publicationContext = structuredClone(value.publicationContext);
    update(publicationContext);
    expect(() => readFrozenNativeCarrier({ ...value, publicationContext })).toThrow();
  }
  const incoming = changed((carrier) => {
    carrier.legal.base[0].files[0].sha256 = 'f'.repeat(64);
  });
  expect(() =>
    readFrozenNativeCarrier({ ...incoming, publicationContext: value.publicationContext }),
  ).toThrow('matching authenticated publication context');
});

test('source membership and bytes are immutable', () => {
  const value = fixture();
  for (const field of [
    'repository',
    'source_tag',
    'source_commit',
    'source_tree',
    'source_member',
    'source_blob',
    'sha256',
    'bytes',
  ])
    expect(() => frozenNativeCarrierSource({ ...value.source, [field]: '' })).toThrow(
      'exact immutable published source facts',
    );
  for (const field of ['sha256', 'source_blob'])
    expect(() =>
      readFrozenNativeCarrier({
        ...value,
        source: { ...value.source, [field]: 'f'.repeat(field === 'sha256' ? 64 : 40) },
      }),
    ).toThrow('immutable source member');
  expect(() =>
    readFrozenNativeCarrier({
      ...value,
      carrierBytes: Buffer.concat([value.carrierBytes, Buffer.from(' ')]),
    }),
  ).toThrow('immutable source member');
});

test('frozen legal digests may differ from current source but retain strict legal locators', () => {
  const value = changed((carrier) => {
    carrier.legal.base[0].files[0].sha256 = 'f'.repeat(64);
  });
  expect(readFrozenNativeCarrier(value).legal.base[0].files[0].sha256).toBe('f'.repeat(64));
  for (const update of [
    (carrier) => {
      carrier.legal.base[0].files[0].member = 'elsewhere/LICENSE';
    },
    (carrier) => {
      carrier.legal.base[1].files[0].member = '../LICENSE';
    },
    (carrier) => {
      carrier.legal.base[0].files[0].kind = 'payload';
    },
    (carrier) => {
      carrier.legal.base[0].files[0].bytes = 0;
    },
    (carrier) => {
      carrier.legal.base[0].files[0].sha256 = 'missing';
    },
    (carrier) => {
      carrier.legal.base[0].assetRole = 'runtime-resources';
    },
    (carrier) => {
      carrier.legal.base[1].files.push({ ...carrier.legal.base[1].files[0] });
    },
  ])
    expect(() => readFrozenNativeCarrier(changed(update))).toThrow();
});

test('every materialized asset must match the exact frozen bytes and size', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-published-assets-'));
  try {
    const value = changed((carrier) => {
      for (const asset of carrier.base.assets) {
        const bytes = Buffer.from(asset.role);
        asset.bytes = bytes.length;
        asset.sha256 = createHash('sha256').update(bytes).digest('hex');
        writeFileSync(path.join(directory, asset.name), bytes);
      }
    });
    expect(
      readFrozenNativeCarrier({ ...value, assetDirectory: directory }).base.assets,
    ).toHaveLength(2);
    const name = readFrozenNativeCarrier(value).base.assets[1].name;
    writeFileSync(path.join(directory, name), 'changed runtime resources');
    expect(() => readFrozenNativeCarrier({ ...value, assetDirectory: directory })).toThrow(name);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
