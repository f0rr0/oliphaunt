import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, source } from './completed-native-publication.fixture.mts';
import {
  prepareNativePublicationMetadata,
  readCompletedNativePublicBaseline,
  writePreparedNativePublicationMetadata,
} from './native-publication-metadata.mts';
import {
  NATIVE_PUBLICATION_METADATA_MAX_BYTES,
  nativePublicationMetadataArtifactRow,
  validateNativePublicationMetadata,
} from './native-publication-metadata-contract.mts';
import { loadPublicationCatalog } from './publication-catalog.mts';
import {
  buildPublicationCandidate,
  discoverProductArtifacts,
  expectedProductArtifactRows,
  freezePublicationCandidate,
  validatePublicationCandidate,
  validatePublicationLock,
} from './publication-lock.mts';
import {
  verifyAttestationBundleSubject,
  writeImmutableReceipt,
} from './verify_github_release_attestations.mts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const preparation = (input) => ({
  envelope: input.publicationLock,
  files: input.publicationFiles,
  repository: input.repository,
  bazelVersion: input.bazelVersion,
  builds: input.builds,
});
const subject = (name, sha256) => ({ name, digest: { sha256 } });
const normalizedSubjects = (subjects) =>
  subjects
    .map(({ name, digest }) => ({ name, sha256: digest.sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name));
function bundle(directory, subjects) {
  const file = path.join(directory, 'attestation.json');
  writeFileSync(
    file,
    JSON.stringify({
      dsseEnvelope: {
        payload: Buffer.from(
          JSON.stringify({
            _type: 'https://in-toto.io/Statement/v1',
            predicateType: 'https://slsa.dev/provenance/v1',
            subject: subjects,
          }),
        ).toString('base64'),
      },
    }),
  );
  return file;
}

test('prepared metadata authenticates actual captured construction and excludes circular envelopes', async () => {
  await fixture(async ({ input, transports, requests }) => {
    const records = await prepareNativePublicationMetadata(preparation(input), transports);
    expect(requests).toEqual(['auth']);
    expect(records.map((record) => record.product.id)).toEqual(['alpha', 'beta']);
    expect(records[0].carriers[0].packageDependencies[0].requirement).toBe('=0.3.2');
    expect(records[1].preEnvelopeCapture).toBe('observed');
    expect(
      records.every(
        (record) =>
          record.baselineAdmission === 'unknown' && record.releaseDecision === 'unverified',
      ),
    ).toBe(true);
    expect(records[0].builds[0].requiredTests).toHaveLength(2);
    expect(records[0].construction[0].inputs.every((input) => !input.path.includes('/beta/'))).toBe(
      true,
    );
    for (const mutate of [
      (record) => {
        record.lockDigest = '9'.repeat(64);
      },
      (record) => {
        record.baselineAdmission = 'admitted';
      },
      (record) => {
        record.productArtifacts.push({ product: record.product.id, kind: 'checksums' });
      },
      (record) => {
        record.productArtifacts.push(nativePublicationMetadataArtifactRow(record.product));
      },
      (record) => {
        record.source.commit = '9'.repeat(40);
      },
    ]) {
      const modified = structuredClone(records[0]);
      mutate(modified);
      expect(() => validateNativePublicationMetadata(modified, { source })).toThrow();
    }
  });
});

test('explicit reviewed controller sealing retains authenticated main assurance without granting release authority', async () => {
  await fixture(
    async ({ input, transports, directory, requests }) => {
      const prepared = { ...preparation(input), reviewedSource: source };
      const artifacts = await writePreparedNativePublicationMetadata(
        path.join(directory, 'reviewed'),
        prepared,
        transports,
      );
      expect(requests).toEqual(['auth']);
      for (const artifact of artifacts) {
        const record = JSON.parse(readFileSync(artifact.path, 'utf8'));
        const assurance = record.builds[0].producerAssurance;
        expect(assurance.scope).toBe('reviewed-producer-assurance');
        expect(assurance.reviewedSource).toEqual(source);
        expect(assurance.event).toBe('push');
        expect(assurance.ref).toBe('refs/heads/main');
        expect(assurance.artifact.name).toBe('native-build-evidence-x86_64');
        expect(assurance.shippingAnalysis).toBe('bound');
        expect(assurance.requiredTests).toEqual(record.builds[0].requiredTests);
        expect(record.builds[0].unverified).not.toContain(
          'immutable input lifetime from the producing build through content capture',
        );
        expect(record.unverified).not.toContain(
          'native action-graph dump bytes authenticated by the producing invocation',
        );
        expect(record.unverified).toContain(
          'qualified mapping from pre-envelope members to every delivered product contract',
        );
        expect(record.baselineAdmission).toBe('unknown');
        expect(record.releaseDecision).toBe('unverified');
        expect(record.carriers[0].packageDependencies[0].requirement).toBe('=0.3.2');
        for (const change of [
          (a) => {
            a.reviewedSource.commit = '9'.repeat(40);
          },
          (a) => {
            a.ref = 'refs/heads/release';
          },
          (a) => {
            a.event = 'pull_request';
          },
          (a) => {
            a.github.job = 'Linux runtime (aarch64)';
          },
          (a) => {
            a.artifact.id += 1;
          },
          (a) => {
            a.evidenceDigest = `sha256:${'9'.repeat(64)}`;
          },
          (a) => {
            a.requiredTests.pop();
          },
          (a) => {
            a.acceptedExecutionAssumptions.push('all products are qualified');
          },
        ]) {
          const altered = structuredClone(record);
          change(altered.builds[0].producerAssurance);
          expect(() => validateNativePublicationMetadata(altered)).toThrow();
        }
        const undefinedAssurance = structuredClone(record);
        undefinedAssurance.builds[0].producerAssurance = undefined;
        expect(() => validateNativePublicationMetadata(undefinedAssurance)).toThrow();
      }
    },
    { producerCapture: true },
  );
});

test('reviewed metadata rejects PR and substituted producer origins before sealing files', async () => {
  for (const change of [
    (input, _origin) => {
      input.builds[0].expected.event = 'pull_request';
      input.builds[0].expected.ref = 'refs/pull/1/merge';
    },
    (input, _origin) => {
      input.builds[0].expected.ref = 'refs/heads/release';
    },
    (_input, origin) => {
      origin.github.runAttempt += 1;
    },
    (_input, origin) => {
      origin.artifact.name = 'native-build-evidence-aarch64';
    },
    (input, _origin) => {
      input.builds[0].requiredTests[0].configuration = '9'.repeat(64);
    },
  ])
    await fixture(
      async ({ input, origin, transports, directory }) => {
        change(input, origin);
        const destination = path.join(directory, 'reviewed');
        await expect(
          writePreparedNativePublicationMetadata(
            destination,
            { ...preparation(input), reviewedSource: source },
            transports,
          ),
        ).rejects.toThrow();
        expect(existsSync(destination)).toBe(false);
      },
      { producerCapture: true },
    );
  await fixture(async ({ input, transports, directory }) => {
    const destination = path.join(directory, 'legacy-analysis');
    await expect(
      writePreparedNativePublicationMetadata(
        destination,
        { ...preparation(input), reviewedSource: source },
        transports,
      ),
    ).rejects.toThrow(/producing-analysis/);
    expect(existsSync(destination)).toBe(false);
  });
});

test('actual controller CLI rejects a substituted checkout before reading suppliers or sealing', () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dir, 'native-publication-metadata.mts'),
      '--lock',
      '/missing/lock.json',
      '--builds',
      '/missing/builds.json',
      '--repository',
      'f0rr0/oliphaunt',
      '--bazel-version',
      '8.8.1',
      '--output-directory',
      '/missing/sealed',
      '--reviewed-source-ref',
      'HEAD',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        OLIPHAUNT_GIT_SOURCE_JSON: JSON.stringify({
          ref: 'HEAD',
          commit: source.commit,
          tree: source.tree,
          checkout: source.commit,
        }),
      },
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('frozen clean exact source checkout');
});

test('controller sealing is canonical, immutable and requires initial supplier authentication', async () => {
  await fixture(async ({ input, transports, directory }) => {
    const destination = path.join(directory, 'controller-sealed');
    await expect(
      writePreparedNativePublicationMetadata(destination, preparation(input), {
        authenticate: async () => {
          throw new Error('supplier artifact is unauthenticated');
        },
      }),
    ).rejects.toThrow(/unauthenticated/);
    expect(existsSync(destination)).toBe(false);
    const artifacts = await writePreparedNativePublicationMetadata(
      destination,
      preparation(input),
      transports,
    );
    expect(artifacts.map((row) => row.name)).toEqual([
      'alpha-1.0.0-native-baseline.json',
      'beta-2.0.0-native-baseline.json',
    ]);
    expect(
      artifacts.every(
        (row) => row.role === 'github-release-metadata' && row.kind === 'native-baseline',
      ),
    ).toBe(true);
    const before = readFileSync(artifacts[0].path);
    await writePreparedNativePublicationMetadata(destination, preparation(input), transports);
    expect(readFileSync(artifacts[0].path)).toEqual(before);
    const changed = preparation(structuredClone(input));
    changed.builds[0].requiredTests = changed.builds[0].requiredTests.slice(0, 1);
    await expect(
      writePreparedNativePublicationMetadata(destination, changed, transports),
    ).rejects.toThrow();
    expect(readFileSync(artifacts[0].path)).toEqual(before);
  });
});

test('measured native metadata bound preserves the default receipt limit and immutable reruns', async () => {
  await fixture(async ({ directory }) => {
    const record = { data: 'x'.repeat(17 * 1024 * 1024) };
    const defaultFile = path.join(directory, 'default.json');
    await expect(writeImmutableReceipt(defaultFile, record)).rejects.toThrow(
      /exceeds 16777216 bytes/,
    );
    expect(existsSync(defaultFile)).toBe(false);
    const nativeFile = path.join(directory, 'native.json');
    await writeImmutableReceipt(nativeFile, record, {
      maximumBytes: NATIVE_PUBLICATION_METADATA_MAX_BYTES,
    });
    await writeImmutableReceipt(nativeFile, record, {
      maximumBytes: NATIVE_PUBLICATION_METADATA_MAX_BYTES,
    });
    expect(JSON.parse(readFileSync(nativeFile, 'utf8'))).toEqual(record);
    await expect(writeImmutableReceipt(nativeFile, record, { maximumBytes: 1 })).rejects.toThrow(
      /is \d+ bytes, exceeds 1 bytes/,
    );
    await expect(
      writeImmutableReceipt(nativeFile, record, { maximumBytes: Infinity }),
    ).rejects.toThrow(/positive safe integer/);
    expect(JSON.parse(readFileSync(nativeFile, 'utf8'))).toEqual(record);
  });
});

test('public baseline joins completed source and signed public bytes without an expiring Actions read', async () => {
  await fixture(
    async ({ input, transports, directory, requests }) => {
      const [artifact] = await writePreparedNativePublicationMetadata(
        path.join(directory, 'sealed'),
        { ...preparation(input), reviewedSource: source },
        transports,
      );
      requests.length = 0;
      const publication = {
        product: 'alpha',
        version: '1.0.0',
        tagName: 'alpha-v1.0.0',
        publicationSha: source.commit,
        publicationTree: source.tree,
        releaseSha: 'f'.repeat(40),
      };
      const subjects = [
        subject(artifact.name, artifact.sha256),
        subject('other-product.tgz', '9'.repeat(64)),
      ];
      const bundlePath = bundle(directory, subjects);
      const release = {
        id: 20,
        tag_name: publication.tagName,
        target_commitish: source.commit,
        draft: false,
        prerelease: false,
      };
      const asset = {
        id: 30,
        name: artifact.name,
        state: 'uploaded',
        url: 'https://api.github.com/repos/f0rr0/oliphaunt/releases/assets/30',
        size: artifact.size,
        digest: `sha256:${artifact.sha256}`,
      };
      let signatures = 0;
      const publicTransports = {
        assertCompleted: async (requested) => {
          requests.push('completion');
          return requested;
        },
        readJson: async () => release,
        readPages: async () => [asset],
        proveAsset: async () => {
          throw new Error('digest-bearing API asset needs no fallback download');
        },
        verifyAttestation: async ({ file, artifact, repository, publisherSha }) => {
          signatures++;
          return verifyAttestationBundleSubject(
            {
              file,
              name: artifact.name,
              sha256: artifact.sha256,
              repo: repository,
              publisherSha,
              bundlePath,
            },
            { verifyBundleImpl: async () => normalizedSubjects(subjects) },
          );
        },
      };
      const request = {
        publication,
        file: artifact.path,
        publisherSha: 'e'.repeat(40),
        bundlePaths: [bundlePath],
      };
      const result = await readCompletedNativePublicBaseline(request, publicTransports);
      expect(requests).toEqual(['completion']);
      expect(signatures).toBe(1);
      expect(result.metadata.builds[0].artifact.id).toBe(101);
      expect(result.metadata.builds[0].producerAssurance.ref).toBe('refs/heads/main');
      expect(result.publicOrigin.sha256).toBe(artifact.sha256);
      expect(result.baselineAdmission).toBe('unknown');
      for (const overrides of [
        {
          assertCompleted: async (requested) => ({ ...requested, publicationTree: '9'.repeat(40) }),
        },
        { readJson: async () => ({ ...release, target_commitish: '9'.repeat(40) }) },
        { readJson: async () => ({ ...release, draft: true }) },
        { readPages: async () => [] },
        { readPages: async () => [asset, asset] },
        { readPages: async () => [{ ...asset, digest: `sha256:${'9'.repeat(64)}` }] },
        { verifyAttestation: async () => true },
        { verifyAttestation: async () => ({ subjects: [subject(artifact.name, '9'.repeat(64))] }) },
      ])
        await expect(
          readCompletedNativePublicBaseline(request, { ...publicTransports, ...overrides }),
        ).rejects.toThrow();
      await expect(
        readCompletedNativePublicBaseline(request, {
          ...publicTransports,
          verifyAttestation: async () => {
            writeFileSync(
              artifact.path,
              Buffer.concat([readFileSync(artifact.path), Buffer.from(' ')]),
            );
            return { subjects: normalizedSubjects(subjects) };
          },
        }),
      ).rejects.toThrow(/changed/);
    },
    { producerCapture: true },
  );
});

test('a single public metadata subject may share a bundle without accepting substituted verified subjects', async () => {
  await fixture(async ({ directory }) => {
    const file = path.join(directory, 'metadata.json');
    const bytes = Buffer.from('{}');
    writeFileSync(file, bytes);
    const subjects = [subject('metadata.json', hash(bytes)), subject('other.tgz', '9'.repeat(64))];
    const bundlePath = bundle(directory, subjects);
    const request = {
      bundlePath,
      file,
      name: 'metadata.json',
      sha256: hash(bytes),
      repo: 'f0rr0/oliphaunt',
      publisherSha: 'e'.repeat(40),
    };
    const verified = await verifyAttestationBundleSubject(request, {
      verifyBundleImpl: async () => normalizedSubjects(subjects),
    });
    expect(verified.subjects).toEqual(normalizedSubjects(subjects));
    await expect(
      verifyAttestationBundleSubject(
        { ...request, sha256: '8'.repeat(64) },
        { verifyBundleImpl: async () => subjects },
      ),
    ).rejects.toThrow(/exact subject digest/);
    await expect(
      verifyAttestationBundleSubject(request, { verifyBundleImpl: async () => [subjects[0]] }),
    ).rejects.toThrow(/verified asset subjects differ/);
  });
});

test('native metadata inventory is explicit, separate from payload checksums and cannot authorize freeze', async () => {
  await fixture(async ({ input, transports, directory }) => {
    const [record] = await prepareNativePublicationMetadata(preparation(input), transports);
    // This controller-preview fixture uses a real canonical owner/catalog, but
    // its observation remains synthetic construction, never admission proof.
    const product = loadPublicationCatalog('native-metadata fixture', {
      products: ['oliphaunt-query'],
    }).products[0];
    record.product = product;
    for (const carrier of record.carriers) {
      carrier.product = product.id;
      carrier.version = product.version;
    }
    for (const construction of record.construction)
      for (const root of construction.roots) {
        root.package.product = product.id;
        root.package.version = product.version;
      }
    const row = nativePublicationMetadataArtifactRow(product);
    const sealedDirectory = path.join(directory, 'controller-sealed');
    mkdirSync(sealedDirectory);
    const file = path.join(sealedDirectory, row.name);
    writeFileSync(file, JSON.stringify(record));
    expect(expectedProductArtifactRows([product])).toEqual([]);
    expect(
      expectedProductArtifactRows([product], { nativeMetadataProducts: [product.id] }),
    ).toEqual([row]);
    expect(() =>
      expectedProductArtifactRows([product], { nativeMetadataProducts: ['unknown'] }),
    ).toThrow(/selected product IDs/);
    expect(() =>
      expectedProductArtifactRows([product], { nativeMetadataProducts: [product.id, product.id] }),
    ).toThrow(/unique selected/);
    expect(discoverProductArtifacts([sealedDirectory], [product])).toEqual([]);
    const discovered = discoverProductArtifacts([sealedDirectory], [product], {
      nativeMetadataProducts: [product.id],
      nativeMetadataSource: source,
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0].sha256).toBe(hash(readFileSync(file)));
    expect(() =>
      discoverProductArtifacts([sealedDirectory], [product], {
        nativeMetadataProducts: [product.id],
        nativeMetadataSource: { ...source, commit: '9'.repeat(40) },
      }),
    ).toThrow(/source/);
    const before = process.env.OLIPHAUNT_GIT_SOURCE_JSON;
    process.env.OLIPHAUNT_GIT_SOURCE_JSON = JSON.stringify({
      ...source,
      checkout: source.commit,
      ref: source.commit,
    });
    try {
      const legacy = buildPublicationCandidate({
        products: [product.id],
        artifactRoots: [sealedDirectory],
        allowMissing: true,
        headRef: source.commit,
      });
      expect(legacy.scope).toBeUndefined();
      expect(legacy.productArtifacts).toEqual([]);
      const candidate = buildPublicationCandidate({
        products: [product.id],
        artifactRoots: [sealedDirectory],
        allowMissing: true,
        headRef: source.commit,
        nativeMetadataProducts: [product.id],
      });
      expect(validatePublicationCandidate(candidate).scope).toBe('construction');
      expect(() => freezePublicationCandidate(candidate)).toThrow(/cannot freeze/);
      delete candidate.scope;
      expect(() => freezePublicationCandidate(candidate)).toThrow(/requires construction scope/);
      expect(() => validatePublicationLock(candidate)).toThrow(/construction evidence/);
    } finally {
      if (before === undefined) delete process.env.OLIPHAUNT_GIT_SOURCE_JSON;
      else process.env.OLIPHAUNT_GIT_SOURCE_JSON = before;
    }
  });
});
