import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import { releaseZstdCompressSync } from '../packaging/portable-archive.mts';
import { tarArchive } from '../packaging/testdata/tar-fixture.mts';
import { loadReleaseMetadata } from './bazel-release-metadata.mts';
import {
  deriveQualifiedNativeCurrentExactInputs,
  inspectNativeCurrentExactInputs,
} from './qualified-native-current-exact-inputs.mts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Controlled archives have real manifest/module digests, never authenticated producer status. */
function fixture() {
  const metadata = loadReleaseMetadata(path.resolve(import.meta.dir, '../..'));
  const version = metadata.products['liboliphaunt-wasix'].version;
  metadata.databaseResourceWasixConsumer = { source: 'current', version };
  const module = Buffer.from('controlled WASIX consuming module');
  const runtime = releaseZstdCompressSync(
    gunzipSync(tarArchive([{ name: 'oliphaunt/bin/postgres', data: module }])),
  );
  const manifest = {
    'format-version': 2,
    'source-fingerprint': 'controlled current source',
    runtime: {
      archive: 'oliphaunt.wasix.tar.zst',
      sha256: sha(runtime),
      size: runtime.length,
      'module-sha256': sha(module),
      'postgres-version': '18.4',
      link: { exports: [] },
    },
    'runtime-support': [],
    extensions: [],
  };
  const bytes = releaseZstdCompressSync(
    gunzipSync(
      tarArchive([
        { name: WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive, data: runtime },
        { name: WASIX_PORTABLE_RELEASE_MEMBERS.manifest, data: JSON.stringify(manifest) },
      ]),
    ),
  );
  const core = {
    path: 'bazel-out/core/public.tar.zst',
    label: '//core:public',
    size: bytes.length,
    sha256: sha(bytes),
  };
  const files = new Map([[core.path, bytes]]);
  const descriptors = metadata.databaseResourceArtifacts
    .filter((row) => row.kind === 'wasix-seeds' && String(row.asset).endsWith('.json'))
    .map((row) => {
      const profile = String(row.asset).includes('-standard.') ? 'standard' : 'icu';
      const descriptor = {
        catalogProfile: profile,
        runtime: {
          engineFamily: 'wasix',
          target: 'portable',
          version,
          consumerSha256: sha(module),
          producerSha256: 'b'.repeat(64),
        },
      };
      const data = Buffer.from(JSON.stringify(descriptor));
      const qualified = {
        path: `bazel-out/resources/${profile}.json`,
        label: `//resources:${profile}`,
        size: data.length,
        sha256: sha(data),
      };
      files.set(qualified.path, data);
      return {
        id: `github-release:${String(row.asset).replace('{version}', metadata.products['database-resources'].version)}`,
        qualifiedFiles: [qualified],
        kind: 'wasix-seeds',
        target: 'portable',
      };
    });
  const observation = {
    products: [
      {
        product: metadata.products['liboliphaunt-wasix'],
        productArtifacts: [
          {
            kind: 'wasix-runtime',
            target: 'portable',
            role: 'github-release-asset',
            qualifiedFiles: [core],
          },
        ],
      },
      { product: metadata.products['database-resources'], productArtifacts: descriptors },
    ],
  } as any;
  const suppliers = descriptors.map((row) => ({
    consumer: 'database-resources',
    product: 'liboliphaunt-wasix',
    version,
    configuration: 'portable',
    root: row.qualifiedFiles[0].label,
    binding: 'abi-contract',
    origin: { kind: 'current-source' },
    files: [{ path: 'bazel-out/core/raw.tar.zst' }],
  })) as any;
  return {
    metadata,
    observation,
    suppliers,
    files,
    readOutput: (file: any) => files.get(file.path)!,
    inputIdentity: () => ({ size: core.size, sha256: core.sha256 }),
  };
}

test('both exact current profile descriptors bind the actual archive module and retain original creator identity', () => {
  const value = fixture();
  expect(inspectNativeCurrentExactInputs(value)).toEqual([
    { product: 'database-resources', sourceProduct: 'liboliphaunt-wasix' },
  ]);
  const descriptor = JSON.parse(value.files.get('bazel-out/resources/standard.json')!.toString());
  expect(descriptor.runtime.producerSha256).not.toBe(descriptor.runtime.consumerSha256);
  value.metadata.databaseResourceWasixConsumer = {
    ...value.metadata.databaseResourceWasixConsumer!,
    source: 'completed',
  };
  expect(inspectNativeCurrentExactInputs(value)).toEqual([]);
});
for (const fault of ['one-profile', 'wrong-module', 'held-origin', 'wrong-input', 'wrong-version'])
  test(`current exact consumer fails closed: ${fault}`, () => {
    const value = fixture();
    if (fault === 'one-profile') value.observation.products[1].productArtifacts.pop();
    if (fault === 'wrong-module') {
      const descriptor = JSON.parse(value.files.get('bazel-out/resources/icu.json')!.toString());
      descriptor.runtime.consumerSha256 = 'f'.repeat(64);
      value.files.set('bazel-out/resources/icu.json', Buffer.from(JSON.stringify(descriptor)));
    }
    if (fault === 'held-origin') value.suppliers[1].origin.kind = 'completed-publication';
    if (fault === 'wrong-input')
      value.inputIdentity = () => ({ size: 123, sha256: 'f'.repeat(64) });
    if (fault === 'wrong-version')
      value.metadata.databaseResourceWasixConsumer = {
        ...value.metadata.databaseResourceWasixConsumer!,
        version: '1.2.3',
      };
    expect(() => inspectNativeCurrentExactInputs(value)).toThrow();
  });
test('physical construction data and copied JSON origins cannot mint a controller association', () => {
  const value = fixture();
  const origin = {
    evidence: { source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) }, cohorts: [] },
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
  };
  const preparation = {
    origins: new Map([['/tmp/fake', origin]]),
    observation: { ...value.observation, authenticated: [{ origin, evidence: origin.evidence }] },
    suppliers: { suppliers: value.suppliers, buildBound: new Map(), unknowns: [] },
  } as any;
  expect(() => deriveQualifiedNativeCurrentExactInputs(preparation, value.metadata)).toThrow(
    'authenticated producer transport',
  );
});
