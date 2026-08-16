import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { mergeProductReleaseAssets } from "./merge-product-release-assets.mjs";
import { expectedAssetRows } from "./release-artifact-targets.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-postmaster-release-assets-"));
  const product = "liboliphaunt-wasix-postmaster";
  const version = "0.0.0";
  const rows = expectedAssetRows({ product, version }, "merge-product-release-assets.test.mjs");
  const checksumName = rows.find(({ kind }) => kind === "checksums").assetName;
  const payloadRows = rows.filter(({ assetName }) => assetName !== checksumName);
  return { root, assetDir: root, product, version, checksumName, payloadRows };
}

function writePayloads(root, rows) {
  for (const row of rows) {
    writeFileSync(path.join(root, row.assetName), `${row.target}\n`, "utf8");
  }
}

function cleanup(root) {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
}

test("postmaster aggregation uses the catalog and canonical checksum format", async () => {
  const { root, product, version, checksumName, payloadRows } = fixture();
  try {
    assert.deepEqual(
      payloadRows.map(({ target }) => target).sort(),
      ["linux-arm64-gnu", "linux-x64-gnu", "macos-arm64"],
    );
    assert.equal(
      payloadRows.every(({ assetName }) => assetName.endsWith(".tar.zst")),
      true,
      "published WASIX postmaster carriers must use the normal WASIX Zstandard format",
    );
    writePayloads(root, payloadRows);

    const checksum = await mergeProductReleaseAssets({ assetDir: root, product, version });
    assert.equal(path.basename(checksum), checksumName);
    assert.equal(
      readFileSync(checksum, "utf8"),
      payloadRows
        .map(({ assetName, target }) => `${sha256(`${target}\n`)}  ./${assetName}`)
        .join("\n") + "\n",
    );
    await assert.rejects(
      mergeProductReleaseAssets({ assetDir: root, product, version }),
      /release payload set differs/u,
    );
  } finally {
    cleanup(root);
  }
});

test("postmaster aggregation rejects missing and extra payloads", async () => {
  const missing = fixture();
  const extra = fixture();
  try {
    writePayloads(missing.root, missing.payloadRows.slice(1));
    await assert.rejects(
      mergeProductReleaseAssets(missing),
      /release payload set differs/u,
    );

    writePayloads(extra.root, extra.payloadRows);
    writeFileSync(path.join(extra.root, "unexpected.tar.zst"), "unexpected\n", "utf8");
    await assert.rejects(
      mergeProductReleaseAssets(extra),
      /release payload set differs/u,
    );
  } finally {
    cleanup(missing.root);
    cleanup(extra.root);
  }
});

test("postmaster aggregation rejects non-regular entries", async () => {
  const release = fixture();
  try {
    writePayloads(release.root, release.payloadRows);
    mkdirSync(path.join(release.root, "nested"));
    await assert.rejects(
      mergeProductReleaseAssets(release),
      /asset directory contains a non-regular entry/u,
    );
  } finally {
    cleanup(release.root);
  }
});
