#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exactReleaseMetadata } from "./github-release-mutations.mjs";
import {
  allArtifactTargets,
  exactExtensionProducts,
} from "./release-artifact-targets.mjs";
import { loadGraph } from "./release-graph.mjs";
import {
  FIRST_RELEASE_NOMINAL_CORE_REQUESTS,
  FIRST_RELEASE_TRANSFER_REQUEST_TOTAL,
} from "./github-release-request-budget.mjs";
import { expectedExtensionGithubReleaseAssetCount } from "./publication-lock.mjs";
import {
  assertExactFrozenUploadSelection,
  DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS,
  exactReleaseAssetUploadArgs,
  githubReleaseAssetUploadWindowMs,
  GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS,
  MAX_SAFE_EMBEDDED_RELEASE_ASSETS,
  uploadFrozenReleaseAssetsSync,
  withStagedFrozenAssetSync,
} from "./upload_github_release_assets.mjs";
import { GITHUB_CONTENT_WRITE_INTERVAL_MS } from "./github-content-write-pacer.mjs";

const HEAD = "a".repeat(40);

function budget() {
  return { deadlineMs: 60_000, environment: {}, now: () => 0, startedAtMs: 0 };
}

function frozenAsset(name, index, size = index + 1) {
  return {
    file: `/unused/${name}`,
    name,
    sha256: index.toString(16).padStart(64, "0"),
    size,
  };
}

function plan(
  assets = [frozenAsset("one.tgz", 1)],
  product = "oliphaunt-js",
) {
  const tag = `${product}-v0.1.0`;
  return {
    assets,
    headRef: HEAD,
    lockDigest: "f".repeat(64),
    metadata: exactReleaseMetadata({
      body: "immutable notes",
      headRef: HEAD,
      product,
      tag,
      version: "0.1.0",
    }),
    product,
    repo: "o/r",
    tag,
  };
}

function remoteAsset(asset, id, digest = `sha256:${asset.sha256}`) {
  return {
    digest,
    id,
    name: asset.name,
    size: asset.size,
    state: "uploaded",
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

test("the upload operation window is derived from the exact frozen asset count", () => {
  const assetCount = 19;
  const required = (assetCount * (
    GITHUB_CONTENT_WRITE_INTERVAL_MS + DEFAULT_GITHUB_RELEASE_ASSET_UPLOAD_TIMEOUT_MS
  )) + GITHUB_RELEASE_ASSET_UPLOAD_SNAPSHOT_RESERVE_MS;
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
  const selectedReadAssets = overrides.readAssets ?? (() => new Map(
    (lastRelease?.assets ?? []).map((asset) => [asset.name, asset]),
  ));
  return {
    budget: budget(),
    environment: {},
    readRelease: (...args) => {
      lastRelease = selectedReadRelease(...args);
      return lastRelease;
    },
    readAssets: (...args) => selectedReadAssets(...args),
    snapshotReadOptions: deterministicReads(),
    uploadAsset: ({ asset }) => {
      remote.set(asset.name, remoteAsset(asset, 100 + remote.size));
    },
    withStagedAsset: (asset, operation) => operation(`/staged/${asset.name}`),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) =>
      key !== "readAssets" && key !== "readRelease")),
  };
}

test("an intentional empty frozen upload selection is exact and source-only", () => {
  assert.doesNotThrow(() =>
    assertExactFrozenUploadSelection([], new Set(), "oliphaunt-swift"));
  assert.throws(
    () => assertExactFrozenUploadSelection(
      [{ path: "/frozen/unexpected.tgz", type: "file" }],
      new Set(),
      "oliphaunt-swift",
    ),
    /do not exactly match/u,
  );
  assert.throws(
    () => assertExactFrozenUploadSelection(
      [{ path: "/frozen/tree", type: "directory" }],
      new Set([path.resolve("/frozen/tree")]),
      "oliphaunt-swift",
    ),
    /only regular files/u,
  );
});

test("the upload request is bound to one immutable release id and frozen asset name", () => {
  assert.deepEqual(
    exactReleaseAssetUploadArgs({
      assetName: "one+linux.tgz",
      file: "/staged/one+linux.tgz",
      releaseId: 73,
      repo: "o/r",
    }),
    [
      "api",
      "https://uploads.github.com/repos/o/r/releases/73/assets?name=one%2Blinux.tgz",
      "-X",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "Content-Type: application/octet-stream",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "--input",
      "/staged/one+linux.tgz",
    ],
  );
  assert.throws(
    () => exactReleaseAssetUploadArgs({
      assetName: "one.tgz",
      file: "/staged/two.tgz",
      releaseId: 73,
      repo: "o/r",
    }),
    /retain its frozen asset name/u,
  );
});

test("one product snapshot skips matching assets and uploads missing assets sequentially", () => {
  const assets = [frozenAsset("one.tgz", 1), frozenAsset("two.tgz", 2)];
  const uploadPlan = plan(assets);
  const remote = new Map([[assets[0].name, remoteAsset(assets[0], 80)]]);
  const uploaded = [];
  let activeStages = 0;
  let maximumActiveStages = 0;
  const result = uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
    uploadAsset: ({ asset }) => {
      uploaded.push(asset.name);
      remote.set(asset.name, remoteAsset(asset, 81));
    },
    withStagedAsset: (asset, operation) => {
      activeStages += 1;
      maximumActiveStages = Math.max(maximumActiveStages, activeStages);
      try {
        return operation(`/staged/${asset.name}`);
      } finally {
        activeStages -= 1;
      }
    },
  }));
  assert.deepEqual(uploaded, ["two.tgz"]);
  assert.equal(maximumActiveStages, 1);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 1 });
});

test("a peer abort stops the next mutation only after reconciling an in-flight exact upload", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-upload-peer-abort-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const abortPath = path.join(root, "abort.json");
  const uploadPlan = plan([
    frozenAsset("first.tgz", 1),
    frozenAsset("must-not-upload.tgz", 2),
  ]);
  const remote = new Map();
  let mutationCalls = 0;
  let snapshotReads = 0;
  assert.throws(
    () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
      environment: { OLIPHAUNT_GITHUB_UPLOAD_ABORT_PATH: abortPath },
      readAssets: () => {
        snapshotReads += 1;
        return new Map(remote);
      },
      uploadAsset: ({ asset }) => {
        mutationCalls += 1;
        remote.set(asset.name, remoteAsset(asset, 900 + mutationCalls));
        writeFileSync(abortPath, '{"reason":"peer failed"}\n', { flag: "wx" });
      },
    })),
    /peer product upload lane failed/u,
  );
  assert.equal(mutationCalls, 1);
  assert.deepEqual([...remote.keys()], ["first.tgz"]);
  assert.ok(snapshotReads >= 2, "the completed immutable upload is re-snapshotted before aborting");
});

for (const product of ["oliphaunt-swift", "oliphaunt-kotlin", "oliphaunt-react-native"]) {
  test(`${product} accepts only an exact empty remote GitHub asset set`, () => {
    const emptyPlan = plan([], product);
    const remote = new Map();
    assert.deepEqual(
      uploadFrozenReleaseAssetsSync(emptyPlan, uploadDependencies(emptyPlan, remote, {
        uploadAsset: () => assert.fail("an empty frozen asset set must not upload"),
        withStagedAsset: () => assert.fail("an empty frozen asset set must not stage files"),
      })),
      { recoveredUploads: 0, uploadedAssets: 0 },
    );

    const unexpected = frozenAsset("unexpected.tgz", 9);
    remote.set(unexpected.name, remoteAsset(unexpected, 91));
    assert.throws(
      () => uploadFrozenReleaseAssetsSync(emptyPlan, uploadDependencies(emptyPlan, remote)),
      /excludes unexpected remote assets: unexpected\.tgz/u,
    );
  });
}

test("an applied-but-ambiguous upload is reconciled once without replay", () => {
  const uploadPlan = plan();
  const remote = new Map();
  let mutationCalls = 0;
  const result = uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
    uploadAsset: ({ asset }) => {
      mutationCalls += 1;
      remote.set(asset.name, remoteAsset(asset, 82));
      throw new Error("response timed out after upload");
    },
  }));
  assert.equal(mutationCalls, 1);
  assert.deepEqual(result, { recoveredUploads: 1, uploadedAssets: 1 });
});

test("a failed upload is never replayed while its immutable asset remains absent", () => {
  const uploadPlan = plan();
  const remote = new Map();
  let mutationCalls = 0;
  assert.throws(
    () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
      uploadAsset: () => {
        mutationCalls += 1;
        throw new Error("connection refused before send");
      },
    })),
    /upload failed.*did not reconcile/isu,
  );
  assert.equal(mutationCalls, 1);
});

test("size, digest, and extra-asset conflicts are terminal before mutation", () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  const conflicts = [
    new Map([[asset.name, { ...remoteAsset(asset, 80), size: asset.size + 1 }]]),
    new Map([[asset.name, remoteAsset(asset, 80, `sha256:${"9".repeat(64)}`)]]),
    new Map([["extra.tgz", remoteAsset({ ...asset, name: "extra.tgz" }, 80)]]),
  ];
  for (const remote of conflicts) {
    let mutationCalls = 0;
    assert.throws(
      () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
        uploadAsset: () => { mutationCalls += 1; },
      })),
      /remote size|remote digest|unexpected remote assets/u,
    );
    assert.equal(mutationCalls, 0);
  }
});

test("an already-public release cannot receive a missing frozen asset", () => {
  const uploadPlan = plan();
  const remote = new Map();
  let mutationCalls = 0;
  assert.throws(
    () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
      readRelease: () => releaseFor(uploadPlan, remote, { draft: false }),
      uploadAsset: () => { mutationCalls += 1; },
    })),
    /already public but is missing frozen assets/u,
  );
  assert.equal(mutationCalls, 0);
});

test("missing releases and authentication failures issue no upload", () => {
  const uploadPlan = plan();
  for (const [expected, readRelease] of [
    [/does not exist/u, () => null],
    [/HTTP 401/u, () => { throw Object.assign(new Error("HTTP 401 bad credentials"), { retryable: false }); }],
  ]) {
    let mutationCalls = 0;
    assert.throws(
      () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, new Map(), {
        readRelease,
        uploadAsset: () => { mutationCalls += 1; },
      })),
      expected,
    );
    assert.equal(mutationCalls, 0);
  }
});

test("a pending GitHub SHA-256 digest converges through bounded product snapshots", () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let reads = 0;
  const result = uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, new Map(), {
    readRelease: () => {
      reads += 1;
      const digest = reads === 1 ? null : `sha256:${asset.sha256}`;
      return releaseFor(uploadPlan, new Map([[asset.name, remoteAsset(asset, 80, digest)]]));
    },
    snapshotReadOptions: deterministicReads(2),
    uploadAsset: () => assert.fail("a converged existing asset must not upload"),
  }));
  assert.equal(reads, 2);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 0 });
});

test("GitHub open state and empty digest converge without losing immutable asset identity", () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let reads = 0;
  const result = uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, new Map(), {
    readRelease: () => {
      reads += 1;
      const remote = remoteAsset(asset, 80, reads === 2 ? "" : `sha256:${asset.sha256}`);
      if (reads === 1) {
        remote.digest = null;
        remote.size = 0;
        remote.state = "open";
      }
      return releaseFor(uploadPlan, new Map([[asset.name, remote]]));
    },
    snapshotReadOptions: deterministicReads(3),
    uploadAsset: () => assert.fail("a converging existing asset must not upload"),
  }));
  assert.equal(reads, 3);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 0 });
});

test("a missing GitHub digest fails closed after the bounded snapshot budget", () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let reads = 0;
  assert.throws(
    () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, new Map(), {
      readRelease: () => {
        reads += 1;
        return releaseFor(uploadPlan, new Map([[asset.name, remoteAsset(asset, 80, null)]]));
      },
      snapshotReadOptions: deterministicReads(2),
    })),
    /pending asset metadata/u,
  );
  assert.equal(reads, 2);
});

test("release replacement during upload is terminal even when the asset bytes match", () => {
  const uploadPlan = plan();
  const remote = new Map();
  let releaseReads = 0;
  let mutationCalls = 0;
  assert.throws(
    () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
      readRelease: () => {
        releaseReads += 1;
        return releaseFor(uploadPlan, remote, { id: releaseReads === 1 ? 73 : 99 });
      },
      uploadAsset: ({ asset }) => {
        mutationCalls += 1;
        remote.set(asset.name, remoteAsset(asset, 83));
      },
    })),
    /release id changed from 73 to 99/u,
  );
  assert.equal(mutationCalls, 1);
});

test("asset replacement while GitHub digest metadata converges is terminal", () => {
  const uploadPlan = plan();
  const asset = uploadPlan.assets[0];
  let releaseReads = 0;
  let mutationCalls = 0;
  assert.throws(
    () => uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, new Map(), {
      readRelease: () => {
        releaseReads += 1;
        if (releaseReads === 1) return releaseFor(uploadPlan, new Map());
        const digest = releaseReads === 2 ? null : `sha256:${asset.sha256}`;
        const id = releaseReads === 2 ? 80 : 81;
        return releaseFor(uploadPlan, new Map([[asset.name, remoteAsset(asset, id, digest)]]));
      },
      snapshotReadOptions: deterministicReads(2),
      uploadAsset: () => { mutationCalls += 1; },
    })),
    /remote asset id changed from 80 to 81/u,
  );
  assert.equal(mutationCalls, 1);
});

test("the complete aggregate-extension asset path leaves bounded API headroom", () => {
  const products = exactExtensionProducts("upload-github-release-assets.test");
  const catalog = products.map((product) => ({
    product,
    // Build-derived iOS module/dependency XCFrameworks are release assets in
    // addition to the base target payloads and three metadata files.
    assetCount: expectedExtensionGithubReleaseAssetCount(product),
  }));
  assert.equal(products.length, 8);
  assert.equal(products.includes("oliphaunt-extension-postgis"), true);
  assert.equal(catalog.reduce((total, { assetCount }) => total + assetCount, 0), 108);
  assert.equal(MAX_SAFE_EMBEDDED_RELEASE_ASSETS, 0);
  let requests = 0;
  let assetIndex = 0;
  for (const { assetCount, product } of catalog) {
    const assets = Array.from({ length: assetCount }, () => {
      assetIndex += 1;
      return frozenAsset(`${product}-${assetIndex}.tgz`, assetIndex);
    });
    const uploadPlan = plan(assets, product);
    const remote = new Map();
    uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
      readRelease: () => {
        requests += 1;
        return releaseFor(uploadPlan, remote);
      },
      readAssets: () => {
        requests += 1;
        return new Map(remote);
      },
      uploadAsset: ({ asset }) => {
        requests += 1;
        remote.set(asset.name, remoteAsset(asset, 1_000 + requests));
      },
    }));
  }
  assert.equal(requests, 108 + (4 * products.length));

  const binaryProducts = [
    "liboliphaunt-native",
    "liboliphaunt-wasix",
    "oliphaunt-broker",
    "oliphaunt-node-direct",
  ];
  const binaryAssetCount = binaryProducts.reduce(
    (total, product) => total + allArtifactTargets(
      { product, publishedOnly: true, surface: "github-release" },
      "upload-github-release-assets.test",
    ).length,
    0,
  );
  assert.equal(binaryAssetCount, 33);
  const allUploaderRequests = requests
    + binaryAssetCount
    + (4 * binaryProducts.length)
    // Swift, Kotlin, and React Native each read one release and one dedicated
    // exact asset inventory to prove an empty set.
    + 6;
  assert.equal(allUploaderRequests, 195);

  const selectedProductCount = Object.keys(
    loadGraph("upload-github-release-assets.test").products,
  ).length;
  assert.equal(selectedProductCount, 18);
  // The manager's independently simulated budget is three mutations per
  // selected product plus six batched release-list snapshots across
  // preflight, stage, verify, and promotion. Pre/final receipts each read one
  // release page plus one dedicated asset inventory for all 18 products.
  const releaseApiRequests = allUploaderRequests
    + ((3 * selectedProductCount) + 6)
    + (2 * (1 + selectedProductCount));
  assert.equal(releaseApiRequests, 293);
  assert.ok(
    releaseApiRequests + FIRST_RELEASE_TRANSFER_REQUEST_TOTAL + 6
      <= FIRST_RELEASE_NOMINAL_CORE_REQUESTS,
  );
});

test("large future product inventories use the paginated asset endpoint", () => {
  const assets = Array.from({ length: MAX_SAFE_EMBEDDED_RELEASE_ASSETS + 1 }, (_, index) =>
    frozenAsset(`asset-${index}.tgz`, index + 1));
  const uploadPlan = plan(assets);
  const remote = new Map(assets.map((asset, index) => [asset.name, remoteAsset(asset, index + 1)]));
  let releaseReads = 0;
  let paginatedReads = 0;
  const result = uploadFrozenReleaseAssetsSync(uploadPlan, uploadDependencies(uploadPlan, remote, {
    readAssets: () => {
      paginatedReads += 1;
      return new Map(remote);
    },
    readRelease: () => {
      releaseReads += 1;
      return { ...releaseFor(uploadPlan, remote), assets: [] };
    },
  }));
  assert.equal(releaseReads, 1);
  assert.equal(paginatedReads, 1);
  assert.deepEqual(result, { recoveredUploads: 0, uploadedAssets: 0 });
});

test("staged upload bytes are verified and temporary state is removed on failure", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-upload-stage-test-"));
  const source = path.join(root, "one.tgz");
  writeFileSync(source, "exact bytes");
  const asset = {
    file: source,
    name: "one.tgz",
    sha256: createHash("sha256").update("exact bytes").digest("hex"),
    size: Buffer.byteLength("exact bytes"),
  };
  const stages = [];
  try {
    assert.throws(
      () => withStagedFrozenAssetSync(asset, () => {
        throw new Error("simulated upload interruption");
      }, {
        mkdtemp: () => {
          const directory = mkdtempSync(path.join(root, "stage-"));
          stages.push(directory);
          return directory;
        },
      }),
      /simulated upload interruption/u,
    );
    assert.equal(stages.length, 1);
    assert.equal(existsSync(stages[0]), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
