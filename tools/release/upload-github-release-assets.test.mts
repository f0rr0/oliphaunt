#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GITHUB_CONTENT_WRITE_INTERVAL_MS } from './github-content-write-pacer.mts';
import { readGitHubCoreRequestJournal } from './github-core-request-journal.mts';
import { exactReleaseMetadata, readReleaseByTag } from './github-release-mutations.mts';
import {
  assertExactFrozenUploadSelection,
  DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
  githubReleaseAssetUploadWindowMs,
  MAX_SAFE_EMBEDDED_RELEASE_ASSETS,
  readExactReleaseAssetSnapshot,
  uploadFrozenReleaseAssets,
  withStagedFrozenAsset,
} from './upload_github_release_assets.mts';

const HEAD = 'a'.repeat(40);

function budget(environment = {}) {
  return { deadlineMs: 60_000, environment, now: () => 0, startedAtMs: 0 };
}

function frozenAsset(name, index, size = index + 1) {
  return {
    file: `/unused/${name}`,
    name,
    sha256: index.toString(16).padStart(64, '0'),
    size,
  };
}

function plan(assets = [frozenAsset('one.tgz', 1)], product = 'oliphaunt-js') {
  const tag = `${product}-v0.1.0`;
  return {
    assets,
    headRef: HEAD,
    lockDigest: 'f'.repeat(64),
    metadata: exactReleaseMetadata({
      body: 'immutable notes',
      headRef: HEAD,
      product,
      tag,
      version: '0.1.0',
    }),
    product,
    repo: 'o/r',
    tag,
  };
}

function remoteAsset(asset, id, digest = `sha256:${asset.sha256}`) {
  return {
    digest,
    id,
    name: asset.name,
    size: asset.size,
    state: 'uploaded',
  };
}

function releaseFor(uploadPlan, remote, { draft = true, id = 73 } = {}) {
  return {
    ...uploadPlan.metadata,
    assets: [...remote.values()],
    draft,
    id,
  };
}

function deterministicReads(maxAttempts = 1) {
  return {
    baseDelayMs: 0,
    maxAttempts,
    maxDelayMs: 0,
    sleep: () => {},
  };
}

test('the upload operation window is derived from the exact frozen asset count', () => {
  const assetCount = 19;
  const required =
    assetCount *
      (GITHUB_CONTENT_WRITE_INTERVAL_MS + DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS) +
    GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS;
  assert.equal(githubReleaseAssetUploadWindowMs(assetCount), required);
  assert.ok(required > 20 * 60_000);
  assert.throws(
    () => githubReleaseAssetUploadWindowMs(294),
    /package the product into fewer aggregate assets/u,
  );
});

function uploadDependencies(uploadPlan, remote, overrides = {}) {
  let lastRelease = null;
  const selectedReadRelease = overrides.readRelease ?? (() => releaseFor(uploadPlan, remote));
  const selectedReadAssets =
    overrides.readAssets ??
    (() => new Map((lastRelease?.assets ?? []).map((asset) => [asset.name, asset])));
  return {
    budget: budget(),
    environment: {},
    readReleaseById: (...args) => {
      lastRelease = selectedReadRelease(...args);
      return lastRelease;
    },
    readReleaseMap: (...args) => {
      lastRelease = selectedReadRelease(...args);
      return lastRelease === null ? new Map() : new Map([[lastRelease.tag_name, lastRelease]]);
    },
    readAssets: (...args) => selectedReadAssets(...args),
    snapshotReadOptions: deterministicReads(),
    uploadAsset: ({ asset }) => {
      remote.set(asset.name, remoteAsset(asset, 100 + remote.size));
    },
    withStagedAsset: async (asset, operation) => await operation(`/staged/${asset.name}`),
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== 'readAssets' && key !== 'readRelease'),
    ),
  };
}

test('an intentional empty frozen upload selection is exact and source-only', () => {
  assert.doesNotThrow(() => assertExactFrozenUploadSelection([], new Set(), 'oliphaunt-swift'));
  assert.throws(
    () =>
      assertExactFrozenUploadSelection(
        [{ path: '/frozen/unexpected.tgz', type: 'file' }],
        new Set(),
        'oliphaunt-swift',
      ),
    /do not exactly match/u,
  );
  assert.throws(
    () =>
      assertExactFrozenUploadSelection(
        [{ path: '/frozen/tree', type: 'directory' }],
        new Set([path.resolve('/frozen/tree')]),
        'oliphaunt-swift',
      ),
    /only regular files/u,
  );
});

test('draft upload discovery uses the complete release list, then the exact release id', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-draft-upload-discovery-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '123',
    GITHUB_SHA: HEAD,
    OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: path.join(root, 'journal.json'),
    OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: 'true',
  };
  const uploadPlan = plan();
  const draft = releaseFor(uploadPlan, new Map(), { draft: true, id: 73 });
  const endpoints = [];
  const fetchImpl = (url) => {
    const endpoint = String(url).replace('https://api.github.com/', '');
    endpoints.push(endpoint);
    if (endpoint.includes('/releases/tags/')) {
      return new Response('', { status: 404 });
    }
    if (endpoint === 'repos/o/r/releases?per_page=100&page=1') {
      return Response.json([draft]);
    }
    if (endpoint === 'repos/o/r/releases/73') {
      return Response.json(draft);
    }
    if (endpoint === 'repos/o/r/releases/73/assets?per_page=100&page=1') {
      return Response.json([]);
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const readOptions = {
    baseDelayMs: 0,
    coreJournalOptions: { now: () => 20_000 },
    deadlineMs: 10_000,
    environment,
    maxAttempts: 1,
    maxDelayMs: 0,
    now: () => 20_000,
    sleep: () => {},
    fetchImpl,
  };

  assert.equal(
    await readReleaseByTag('o/r', uploadPlan.tag, readOptions),
    null,
    "GitHub's by-tag endpoint does not expose the draft",
  );
  endpoints.length = 0;

  const initial = await readExactReleaseAssetSnapshot(
    {
      budget: budget(environment),
      expectedReleaseId: undefined,
      phase: 'pre-upload',
      plan: uploadPlan,
    },
    { singleReadOptions: readOptions },
  );
  assert.equal(initial.release.draft, true);
  assert.equal(initial.releaseId, 73);
  assert.deepEqual(endpoints, [
    'repos/o/r/releases?per_page=100&page=1',
    'repos/o/r/releases/73/assets?per_page=100&page=1',
  ]);

  endpoints.length = 0;
  const later = await readExactReleaseAssetSnapshot(
    {
      budget: budget(environment),
      expectedReleaseId: 73,
      phase: 'post-upload',
      plan: uploadPlan,
    },
    { singleReadOptions: readOptions },
  );
  assert.equal(later.release.draft, true);
  assert.equal(later.releaseId, 73);
  assert.deepEqual(endpoints, [
    'repos/o/r/releases/73',
    'repos/o/r/releases/73/assets?per_page=100&page=1',
  ]);
  assert.deepEqual(readGitHubCoreRequestJournal({ environment, now: () => 20_000 }), {
    enabled: true,
    rollingCount: 5,
    sequence: 5,
  });
});

test('one product snapshot skips matching assets and uploads missing assets sequentially', async () => {
  const assets = [frozenAsset('one.tgz', 1), frozenAsset('two.tgz', 2)];
  const uploadPlan = plan(assets);
  const remote = new Map([[assets[0].name, remoteAsset(assets[0], 80)]]);
  const uploaded = [];
  let activeStages = 0;
  let maximumActiveStages = 0;
  const result = await uploadFrozenReleaseAssets(
    uploadPlan,
    uploadDependencies(uploadPlan, remote, {
      uploadAsset: ({ asset }) => {
        uploaded.push(asset.name);
        remote.set(asset.name, remoteAsset(asset, 81));
      },
      withStagedAsset: async (asset, operation) => {
        activeStages += 1;
        maximumActiveStages = Math.max(maximumActiveStages, activeStages);
        try {
          return await operation(`/staged/${asset.name}`);
        } finally {
          activeStages -= 1;
        }
      },
    }),
  );
  assert.deepEqual(uploaded, ['two.tgz']);
  assert.equal(maximumActiveStages, 1);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 1 });
});

test('a peer abort stops the next mutation only after reconciling an in-flight exact upload', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-upload-peer-abort-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const abortPath = path.join(root, 'abort.json');
  const uploadPlan = plan([frozenAsset('first.tgz', 1), frozenAsset('must-not-upload.tgz', 2)]);
  const remote = new Map();
  let mutationCalls = 0;
  let snapshotReads = 0;
  await assert.rejects(
    async () =>
      await uploadFrozenReleaseAssets(
        uploadPlan,
        uploadDependencies(uploadPlan, remote, {
          environment: { OLIPHAUNT_GITHUB_UPLOAD_ABORT_PATH: abortPath },
          readAssets: () => {
            snapshotReads += 1;
            return new Map(remote);
          },
          uploadAsset: ({ asset }) => {
            mutationCalls += 1;
            remote.set(asset.name, remoteAsset(asset, 900 + mutationCalls));
            writeFileSync(abortPath, '{"reason":"peer failed"}\n', { flag: 'wx' });
          },
        }),
      ),
    /peer product upload lane failed/u,
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual([...remote.keys()], ['first.tgz']);
  assert.ok(snapshotReads >= 2, 'the completed immutable upload is re-snapshotted before aborting');
});

for (const product of ['oliphaunt-swift', 'oliphaunt-kotlin', 'oliphaunt-react-native']) {
  test(`${product} accepts only an exact empty remote GitHub asset set`, async () => {
    const emptyPlan = plan([], product);
    const remote = new Map();
    assert.deepEqual(
      await uploadFrozenReleaseAssets(
        emptyPlan,
        uploadDependencies(emptyPlan, remote, {
          uploadAsset: () => assert.fail('an empty frozen asset set must not upload'),
          withStagedAsset: () => assert.fail('an empty frozen asset set must not stage files'),
        }),
      ),
      { recoveredUploads: 0, uploadedAssets: 0 },
    );

    const unexpected = frozenAsset('unexpected.tgz', 9);
    remote.set(unexpected.name, remoteAsset(unexpected, 91));
    await assert.rejects(
      async () => await uploadFrozenReleaseAssets(emptyPlan, uploadDependencies(emptyPlan, remote)),
      /excludes unexpected remote assets: unexpected\.tgz/u,
    );
  });
}

test('an applied-but-ambiguous upload is reconciled once without replay', async () => {
  const uploadPlan = plan();
  const remote = new Map();
  let mutationCalls = 0;
  const result = await uploadFrozenReleaseAssets(
    uploadPlan,
    uploadDependencies(uploadPlan, remote, {
      uploadAsset: ({ asset }) => {
        mutationCalls += 1;
        remote.set(asset.name, remoteAsset(asset, 82));
        throw new Error('response timed out after upload');
      },
    }),
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { recoveredUploads: 1, uploadedAssets: 1 });
});

test('a failed upload is never replayed while its immutable asset remains absent', async () => {
  const uploadPlan = plan();
  const remote = new Map();
  let mutationCalls = 0;
  await assert.rejects(
    async () =>
      await uploadFrozenReleaseAssets(
        uploadPlan,
        uploadDependencies(uploadPlan, remote, {
          uploadAsset: () => {
            mutationCalls += 1;
            throw new Error('connection refused before send');
          },
        }),
      ),
    /upload failed.*did not reconcile/isu,
  );
  assert.equal(mutationCalls, 1);
});

test('size, digest, and extra-asset conflicts are terminal before mutation', async () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  const conflicts = [
    new Map([[asset.name, { ...remoteAsset(asset, 80), size: asset.size + 1 }]]),
    new Map([[asset.name, remoteAsset(asset, 80, `sha256:${'9'.repeat(64)}`)]]),
    new Map([['extra.tgz', remoteAsset({ ...asset, name: 'extra.tgz' }, 80)]]),
  ];
  for (const remote of conflicts) {
    let mutationCalls = 0;
    await assert.rejects(
      async () =>
        await uploadFrozenReleaseAssets(
          uploadPlan,
          uploadDependencies(uploadPlan, remote, {
            uploadAsset: () => {
              mutationCalls += 1;
            },
          }),
        ),
      /remote size|remote digest|unexpected remote assets/u,
    );
    assert.equal(mutationCalls, 0);
  }
});

test('an already-public release cannot receive a missing frozen asset', async () => {
  const uploadPlan = plan();
  const remote = new Map();
  let mutationCalls = 0;
  await assert.rejects(
    async () =>
      await uploadFrozenReleaseAssets(
        uploadPlan,
        uploadDependencies(uploadPlan, remote, {
          readRelease: () => releaseFor(uploadPlan, remote, { draft: false }),
          uploadAsset: () => {
            mutationCalls += 1;
          },
        }),
      ),
    /already public but is missing frozen assets/u,
  );
  assert.equal(mutationCalls, 0);
});

test('missing releases and authentication failures issue no upload', async () => {
  const uploadPlan = plan();
  for (const [expected, readRelease] of [
    [/does not exist/u, () => null],
    [
      /HTTP 401/u,
      () => {
        throw Object.assign(new Error('HTTP 401 bad credentials'), { retryable: false });
      },
    ],
  ]) {
    let mutationCalls = 0;
    await assert.rejects(
      async () =>
        await uploadFrozenReleaseAssets(
          uploadPlan,
          uploadDependencies(uploadPlan, new Map(), {
            readRelease,
            uploadAsset: () => {
              mutationCalls += 1;
            },
          }),
        ),
      expected,
    );
    assert.equal(mutationCalls, 0);
  }
});

test('a pending GitHub SHA-256 digest converges through bounded product snapshots', async () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let reads = 0;
  const result = await uploadFrozenReleaseAssets(
    uploadPlan,
    uploadDependencies(uploadPlan, new Map(), {
      readRelease: () => {
        reads += 1;
        const digest = reads === 1 ? null : `sha256:${asset.sha256}`;
        return releaseFor(uploadPlan, new Map([[asset.name, remoteAsset(asset, 80, digest)]]));
      },
      snapshotReadOptions: deterministicReads(2),
      uploadAsset: () => assert.fail('a converged existing asset must not upload'),
    }),
  );
  assert.equal(reads, 2);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 0 });
});

test('GitHub open state and empty digest converge without losing immutable asset identity', async () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let reads = 0;
  const result = await uploadFrozenReleaseAssets(
    uploadPlan,
    uploadDependencies(uploadPlan, new Map(), {
      readRelease: () => {
        reads += 1;
        const remote = remoteAsset(asset, 80, reads === 2 ? '' : `sha256:${asset.sha256}`);
        if (reads === 1) {
          remote.digest = null;
          remote.size = 0;
          remote.state = 'open';
        }
        return releaseFor(uploadPlan, new Map([[asset.name, remote]]));
      },
      snapshotReadOptions: deterministicReads(3),
      uploadAsset: () => assert.fail('a converging existing asset must not upload'),
    }),
  );
  assert.equal(reads, 3);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 0 });
});

test('a missing GitHub digest fails closed after the bounded snapshot budget', async () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let reads = 0;
  await assert.rejects(
    async () =>
      await uploadFrozenReleaseAssets(
        uploadPlan,
        uploadDependencies(uploadPlan, new Map(), {
          readRelease: () => {
            reads += 1;
            return releaseFor(uploadPlan, new Map([[asset.name, remoteAsset(asset, 80, null)]]));
          },
          snapshotReadOptions: deterministicReads(2),
        }),
      ),
    /pending asset metadata/u,
  );
  assert.equal(reads, 2);
});

test('release replacement during upload is terminal even when the asset bytes match', async () => {
  const uploadPlan = plan();
  const remote = new Map();
  let releaseReads = 0;
  let mutationCalls = 0;
  await assert.rejects(
    async () =>
      await uploadFrozenReleaseAssets(
        uploadPlan,
        uploadDependencies(uploadPlan, remote, {
          readRelease: () => {
            releaseReads += 1;
            return releaseFor(uploadPlan, remote, { id: releaseReads === 1 ? 73 : 99 });
          },
          uploadAsset: ({ asset }) => {
            mutationCalls += 1;
            remote.set(asset.name, remoteAsset(asset, 83));
          },
        }),
      ),
    /release id changed from 73 to 99/u,
  );
  assert.equal(mutationCalls, 1);
});

test('asset replacement while GitHub digest metadata converges is terminal', async () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let releaseReads = 0;
  let mutationCalls = 0;
  await assert.rejects(
    async () =>
      await uploadFrozenReleaseAssets(
        uploadPlan,
        uploadDependencies(uploadPlan, new Map(), {
          readRelease: () => {
            releaseReads += 1;
            if (releaseReads === 1) return releaseFor(uploadPlan, new Map());
            const digest = releaseReads === 2 ? null : `sha256:${asset.sha256}`;
            const id = releaseReads === 2 ? 80 : 81;
            return releaseFor(uploadPlan, new Map([[asset.name, remoteAsset(asset, id, digest)]]));
          },
          snapshotReadOptions: deterministicReads(2),
          uploadAsset: () => {
            mutationCalls += 1;
          },
        }),
      ),
    /remote asset id changed from 80 to 81/u,
  );
  assert.equal(mutationCalls, 1);
});

test('large future product inventories use the paginated asset endpoint', async () => {
  const assets = Array.from({ length: MAX_SAFE_EMBEDDED_RELEASE_ASSETS + 1 }, (_, index) =>
    frozenAsset(`asset-${index}.tgz`, index + 1),
  );
  const uploadPlan = plan(assets);
  const remote = new Map(assets.map((asset, index) => [asset.name, remoteAsset(asset, index + 1)]));
  let releaseReads = 0;
  let paginatedReads = 0;
  const result = await uploadFrozenReleaseAssets(
    uploadPlan,
    uploadDependencies(uploadPlan, remote, {
      readAssets: () => {
        paginatedReads += 1;
        return new Map(remote);
      },
      readRelease: () => {
        releaseReads += 1;
        return { ...releaseFor(uploadPlan, remote), assets: [] };
      },
    }),
  );
  assert.equal(releaseReads, 1);
  assert.equal(paginatedReads, 1);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 0 });
});

test('staged upload bytes are verified and temporary state is removed on failure', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-upload-stage-test-'));
  const source = path.join(root, 'one.tgz');
  writeFileSync(source, 'exact bytes');
  const asset = {
    file: source,
    name: 'one.tgz',
    sha256: createHash('sha256').update('exact bytes').digest('hex'),
    size: Buffer.byteLength('exact bytes'),
  };
  const stages = [];
  try {
    await assert.rejects(
      async () =>
        await withStagedFrozenAsset(
          asset,
          () => {
            throw new Error('simulated upload interruption');
          },
          {
            mkdtemp: () => {
              const directory = mkdtempSync(path.join(root, 'stage-'));
              stages.push(directory);
              return directory;
            },
          },
        ),
      /simulated upload interruption/u,
    );
    assert.equal(stages.length, 1);
    assert.equal(existsSync(stages[0]), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
