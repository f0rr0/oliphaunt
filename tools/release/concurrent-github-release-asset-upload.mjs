import {
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const FULL_SHA = /^[0-9a-f]{40}$/u;

export class ConcurrentGithubReleaseAssetUploadError extends Error {
  constructor(message, report, options = {}) {
    super(`concurrent-github-release-asset-upload: ${message}`, options);
    this.name = "ConcurrentGithubReleaseAssetUploadError";
    this.report = report;
  }
}

function error(message, report, options = {}) {
  return new ConcurrentGithubReleaseAssetUploadError(message, report, options);
}

function validatePlan(plan) {
  if (
    plan === null
    || Array.isArray(plan)
    || typeof plan !== "object"
    || !Array.isArray(plan.waves)
    || !Number.isSafeInteger(plan.assetCount)
    || plan.assetCount < 0
    || !Number.isSafeInteger(plan.productCount)
    || plan.productCount < 0
    || (plan.waves.length === 0 && (plan.productCount !== 0 || plan.assetCount !== 0))
    || (plan.waves.length > 0 && plan.productCount < 1)
  ) {
    throw error("plan is malformed", null);
  }
  const products = new Set();
  let assetCount = 0;
  for (const [waveIndex, wave] of plan.waves.entries()) {
    if (
      wave === null
      || Array.isArray(wave)
      || typeof wave !== "object"
      || !Array.isArray(wave.rows)
      || wave.rows.length === 0
      || !Number.isSafeInteger(wave.windowMs)
      || wave.windowMs < 1
    ) {
      throw error(`wave ${waveIndex + 1} is malformed`, null);
    }
    let waveAssetCount = 0;
    const waveProducts = [];
    for (const row of wave.rows) {
      if (
        row === null
        || Array.isArray(row)
        || typeof row !== "object"
        || typeof row.product !== "string"
        || row.product.length === 0
        || !Number.isSafeInteger(row.assetCount)
        || row.assetCount < 0
        || products.has(row.product)
      ) {
        throw error(`wave ${waveIndex + 1} contains a malformed or duplicate product`, null);
      }
      products.add(row.product);
      waveProducts.push(row.product);
      waveAssetCount += row.assetCount;
    }
    if (
      wave.assetCount !== waveAssetCount
      || !Array.isArray(wave.products)
      || wave.products.length !== waveProducts.length
      || wave.products.some((product, index) => product !== waveProducts[index])
    ) {
      throw error(`wave ${waveIndex + 1} summary disagrees with its rows`, null);
    }
    assetCount += waveAssetCount;
  }
  if (products.size !== plan.productCount || assetCount !== plan.assetCount) {
    throw error("plan product or asset count disagrees with its waves", null);
  }
}

function failureDetail(cause) {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function validateExecution(plan, execution) {
  if (
    execution === null
    || Array.isArray(execution)
    || typeof execution !== "object"
    || execution.assetCount !== plan.assetCount
    || execution.productCount !== plan.productCount
    || execution.waveCount !== plan.waves.length
    || !Number.isSafeInteger(execution.completedWaves)
    || execution.completedWaves < 0
    || execution.completedWaves > plan.waves.length
    || !new Set(["failure", "success"]).has(execution.status)
    || !Array.isArray(execution.products)
  ) {
    throw error("execution report is malformed or disagrees with its plan", execution);
  }
  const completedRows = plan.waves
    .slice(0, execution.completedWaves)
    .flatMap(({ rows }) => rows);
  if (
    execution.products.length !== completedRows.length
    || execution.products.some((outcome, index) => {
      const row = completedRows[index];
      return outcome === null
        || Array.isArray(outcome)
        || typeof outcome !== "object"
        || outcome.product !== row.product
        || outcome.assetCount !== row.assetCount
        || !new Set(["failure", "success"]).has(outcome.status);
    })
    || (execution.status === "success"
      && (execution.completedWaves !== plan.waves.length
        || execution.products.some(({ status }) => status !== "success")))
    || (execution.status === "failure"
      && !execution.products.some(({ status }) => status === "failure"))
  ) {
    throw error("execution outcomes do not exactly cover the completed plan waves", execution);
  }
}

export function writeConcurrentGithubReleaseAssetUploadReport(
  file,
  { execution, plan, sourceCommit },
) {
  if (
    typeof file !== "string"
    || file.length === 0
    || file.includes("\0")
    || typeof sourceCommit !== "string"
    || !FULL_SHA.test(sourceCommit)
  ) {
    throw error("report requires a path and exact lowercase source commit", execution ?? null);
  }
  validatePlan(plan);
  validateExecution(plan, execution);
  const destination = path.resolve(file);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify({
      execution,
      plan,
      schema: "oliphaunt-concurrent-github-release-asset-upload-report-v1",
      sourceCommit,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function githubReleaseAssetUploadChildEnvironment(
  parentEnvironment,
  { abortPath, windowMs },
) {
  if (
    parentEnvironment === null
    || Array.isArray(parentEnvironment)
    || typeof parentEnvironment !== "object"
    || typeof abortPath !== "string"
    || abortPath.length === 0
    || abortPath.includes("\0")
    || !Number.isSafeInteger(windowMs)
    || windowMs < 1
  ) {
    throw error("child environment requires a parent environment, abort path, and positive window", null);
  }
  return {
    ...parentEnvironment,
    OLIPHAUNT_GITHUB_MUTATION_WINDOW_MS: String(windowMs),
    OLIPHAUNT_GITHUB_UPLOAD_ABORT_PATH: abortPath,
  };
}

/**
 * Execute complete product waves. A lane failure publishes the shared abort
 * signal immediately, but the current wave is always drained so an immutable
 * upload already in flight can finish exact-state reconciliation. No later wave
 * starts after any failure.
 */
export async function executeConcurrentGithubReleaseAssetUploadPlan(
  plan,
  {
    abort = () => {},
    uploadProduct,
  } = {},
) {
  validatePlan(plan);
  if (typeof uploadProduct !== "function" || typeof abort !== "function") {
    throw error("uploadProduct and abort must be functions", null);
  }
  const report = {
    assetCount: plan.assetCount,
    completedWaves: 0,
    productCount: plan.productCount,
    products: [],
    status: "running",
    waveCount: plan.waves.length,
  };
  if (plan.waves.length === 0) {
    report.status = "success";
    return report;
  }
  let aborted = false;
  for (const [waveIndex, wave] of plan.waves.entries()) {
    const outcomes = await Promise.all(wave.rows.map(async (row) => {
      try {
        const value = await uploadProduct(row, {
          aborted: () => aborted,
          wave,
          waveIndex,
        });
        return { assetCount: row.assetCount, product: row.product, status: "success", value };
      } catch (cause) {
        const outcome = {
          assetCount: row.assetCount,
          detail: failureDetail(cause),
          product: row.product,
          status: "failure",
        };
        if (!aborted) {
          aborted = true;
          try {
            await abort(outcome);
          } catch (abortCause) {
            outcome.abortDetail = failureDetail(abortCause);
          }
        }
        return outcome;
      }
    }));
    report.products.push(...outcomes);
    report.completedWaves += 1;
    const failures = outcomes.filter(({ status }) => status === "failure");
    if (failures.length > 0) {
      report.status = "failure";
      throw error(
        `wave ${waveIndex + 1} failed after draining all in-flight lanes: `
          + failures.map(({ detail, product }) => `${product} (${detail})`).join(", "),
        report,
      );
    }
  }
  report.status = "success";
  return report;
}
