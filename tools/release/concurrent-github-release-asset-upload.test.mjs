import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ConcurrentGithubReleaseAssetUploadError,
  executeConcurrentGithubReleaseAssetUploadPlan,
  githubReleaseAssetUploadChildEnvironment,
  writeConcurrentGithubReleaseAssetUploadReport,
} from "./concurrent-github-release-asset-upload.mjs";

function plan(waves) {
  const rows = waves.flat();
  return {
    assetCount: rows.reduce((total, row) => total + row.assetCount, 0),
    productCount: rows.length,
    totalWindowMs: waves.length * 1_000,
    waves: waves.map((wave) => ({
      assetCount: wave.reduce((total, row) => total + row.assetCount, 0),
      products: wave.map(({ product }) => product),
      rows: wave,
      windowMs: 1_000,
    })),
  };
}

describe("concurrent GitHub release asset upload execution", () => {
  test("propagates every shared journal/deadline root and pins wave coordination overrides", () => {
    const parent = {
      GH_TOKEN: "secret",
      OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: "/tmp/pacer.json",
      OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: "/tmp/core.json",
      OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS: "untrusted-parent-value",
      OLIPHAUNT_GITHUB_UPLOAD_ABORT_PATH: "/tmp/untrusted-parent-abort",
      REGISTRY_JOB_HARD_DEADLINE_EPOCH: "9999",
      RELEASE_HEAD_SHA: "a".repeat(40),
    };
    expect(githubReleaseAssetUploadChildEnvironment(parent, {
      abortPath: "/tmp/wave-abort.json",
      windowMs: 2_300_000,
    })).toEqual({
      ...parent,
      OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS: "2300000",
      OLIPHAUNT_GITHUB_UPLOAD_ABORT_PATH: "/tmp/wave-abort.json",
    });
  });

  test("drains a failed wave, emits one shared abort, and never starts a later wave", async () => {
    const events = [];
    let releasePeer;
    const peer = new Promise((resolve) => { releasePeer = resolve; });
    const execution = executeConcurrentGithubReleaseAssetUploadPlan(
      plan([
        [
          { product: "failed", assetCount: 2 },
          { product: "in-flight", assetCount: 3 },
        ],
        [{ product: "must-not-start", assetCount: 1 }],
      ]),
      {
        abort: ({ product }) => {
          events.push(`abort:${product}`);
          releasePeer();
        },
        uploadProduct: async ({ product }) => {
          events.push(`start:${product}`);
          if (product === "failed") throw new Error("exact snapshot mismatch");
          if (product === "in-flight") {
            await peer;
            events.push("reconciled:in-flight");
          }
        },
      },
    );
    let failure;
    try {
      await execution;
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ConcurrentGithubReleaseAssetUploadError);
    expect(failure.message).toContain("failed (exact snapshot mismatch)");
    expect(failure.report.status).toBe("failure");
    expect(failure.report.completedWaves).toBe(1);
    expect(failure.report.products.map(({ product, status }) => [product, status])).toEqual([
      ["failed", "failure"],
      ["in-flight", "success"],
    ]);
    expect(events).toContain("abort:failed");
    expect(events).toContain("reconciled:in-flight");
    expect(events).not.toContain("start:must-not-start");
  });

  test("aggregates every same-wave exact snapshot failure", async () => {
    let failure;
    try {
      await executeConcurrentGithubReleaseAssetUploadPlan(
        plan([[
          { product: "alpha", assetCount: 1 },
          { product: "beta", assetCount: 1 },
        ]]),
        {
          uploadProduct: async ({ product }) => {
            throw new Error(`${product} immutable remote asset conflict`);
          },
        },
      );
    } catch (cause) {
      failure = cause;
    }
    expect(failure.report.products).toEqual([
      expect.objectContaining({
        detail: "alpha immutable remote asset conflict",
        product: "alpha",
        status: "failure",
      }),
      expect.objectContaining({
        detail: "beta immutable remote asset conflict",
        product: "beta",
        status: "failure",
      }),
    ]);
    expect(failure.message).toContain("alpha (alpha immutable remote asset conflict)");
    expect(failure.message).toContain("beta (beta immutable remote asset conflict)");
  });

  test("returns complete success evidence in wave order", async () => {
    const result = await executeConcurrentGithubReleaseAssetUploadPlan(
      plan([
        [{ product: "a", assetCount: 1 }],
        [{ product: "b", assetCount: 0 }],
      ]),
      { uploadProduct: async ({ product }) => ({ exact: product }) },
    );
    expect(result.status).toBe("success");
    expect(result.completedWaves).toBe(2);
    expect(result.products.map(({ product }) => product)).toEqual(["a", "b"]);
  });

  test("returns an exact empty success report when every selected product is receipt-only", async () => {
    const result = await executeConcurrentGithubReleaseAssetUploadPlan({
      assetCount: 0,
      productCount: 0,
      selectionVerificationWindowMs: 60_000,
      totalWindowMs: 60_000,
      waves: [],
    }, {
      uploadProduct: async () => {
        throw new Error("an empty plan must not start an uploader");
      },
    });
    expect(result).toEqual({
      assetCount: 0,
      completedWaves: 0,
      productCount: 0,
      products: [],
      status: "success",
      waveCount: 0,
    });
  });

  test("subprocess lanes preserve every shared journal reservation and emit one exact report", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-concurrent-upload-report-"));
    try {
      const pacerPath = path.join(root, "pacer.json");
      const corePath = path.join(root, "core.json");
      const reportPath = path.join(root, "report.json");
      const workerPath = path.join(root, "worker.mjs");
      writeFileSync(workerPath, `
import { reserveGitHubContentWriteSync } from ${JSON.stringify(pathToFileURL(path.resolve("tools/release/github-content-write-pacer.mjs")).href)};
import { reserveGitHubCoreRequestSync } from ${JSON.stringify(pathToFileURL(path.resolve("tools/release/github-core-request-journal.mjs")).href)};
for (let attempt = 0; attempt < 2; attempt += 1) {
  const label = \`upload-\${process.argv[2]}-\${attempt}\`;
  reserveGitHubContentWriteSync({
    environment: process.env,
    label,
    timing: { coldStartMs: 0, intervalMs: 5, maxLockWaitMs: 1_000 },
  });
  reserveGitHubCoreRequestSync({ environment: process.env, label });
}
`);
      const sourceCommit = "e".repeat(40);
      const environment = githubReleaseAssetUploadChildEnvironment({
        ...process.env,
        GITHUB_ACTIONS: "false",
        GITHUB_REPOSITORY: "f0rr0/oliphaunt",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "789",
        GITHUB_SHA: sourceCommit,
        OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH: "1",
        OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH: pacerPath,
        OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_TEST_MODE: "true",
        OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH: corePath,
        OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL: "true",
      }, {
        abortPath: path.join(root, "abort.json"),
        windowMs: 1_000,
      });
      const rows = Array.from({ length: 5 }, (_, index) => ({
        assetCount: 2,
        product: `product-${index}`,
      }));
      const exactPlan = plan([rows]);
      const runWorker = (product) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, product], {
          env: environment,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0 && signal === null) resolve({ product });
          else reject(new Error(`${product} worker failed (${code}/${signal}): ${stderr}`));
        });
      });
      const execution = await executeConcurrentGithubReleaseAssetUploadPlan(exactPlan, {
        uploadProduct: ({ product }) => runWorker(product),
      });
      writeConcurrentGithubReleaseAssetUploadReport(reportPath, {
        execution,
        plan: exactPlan,
        sourceCommit,
      });

      const pacer = JSON.parse(readFileSync(pacerPath, "utf8"));
      const core = JSON.parse(readFileSync(corePath, "utf8"));
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(pacer.sequence).toBe(10);
      expect(pacer.reservations).toHaveLength(10);
      expect(core.sequence).toBe(10);
      expect(core.attempts).toHaveLength(10);
      expect(report).toEqual({
        execution,
        plan: exactPlan,
        schema: "oliphaunt-concurrent-github-release-asset-upload-report-v1",
        sourceCommit,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
