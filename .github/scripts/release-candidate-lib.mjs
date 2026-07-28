import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function strictJson(file, context) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(`${context} cannot be read at ${file}: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${context} is not strict JSON at ${file}: ${error.message}`);
  }
  assert(value !== null && !Array.isArray(value) && typeof value === "object", `${context} must be a JSON object`);
  return { bytes, value };
}

function sortedUniqueStrings(value, context) {
  assert(Array.isArray(value), `${context} must be a string list`);
  assert(value.every((item) => typeof item === "string" && item.length > 0), `${context} must contain non-empty strings`);
  const sorted = [...new Set(value)].sort();
  assert(sorted.length === value.length, `${context} must not contain duplicates`);
  assert(JSON.stringify(sorted) === JSON.stringify(value), `${context} must be canonically sorted`);
  return sorted;
}

function uniqueStrings(value, context) {
  assert(Array.isArray(value), `${context} must be a string list`);
  assert(value.every((item) => typeof item === "string" && item.length > 0), `${context} must contain non-empty strings`);
  assert(new Set(value).size === value.length, `${context} must not contain duplicates`);
  return value;
}

export function affectedPlanBinding(planPath, wasixReleaseRegressionRequired) {
  assert(typeof wasixReleaseRegressionRequired === "boolean", "WASIX release regression requirement must be boolean");
  const { value: plan } = strictJson(planPath, "affected CI plan");
  const jobs = sortedUniqueStrings(plan.jobs, "affected CI plan jobs");
  const projects = sortedUniqueStrings(plan.projects, "affected CI plan projects");
  const extensionPackageProducts = sortedUniqueStrings(
    plan.extension_package_products ?? [],
    "affected CI plan extension package products",
  );
  const expectedRequirement = jobs.includes("liboliphaunt-wasix-runtime");
  assert(
    wasixReleaseRegressionRequired === expectedRequirement,
    `affected CI plan WASIX requirement mismatch: jobs imply ${expectedRequirement}, workflow reported ${wasixReleaseRegressionRequired}`,
  );
  const canonical = JSON.stringify(canonicalValue(plan));
  return {
    digest: sha256(canonical),
    jobs,
    projects,
    extensionPackageProducts,
    wasixReleaseRegressionRequired,
  };
}

function jsonFiles(root) {
  assert(existsSync(root), `WASIX evidence artifact root does not exist: ${root}`);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function expectedPublicExtensions(catalogPath) {
  const { value: catalog } = strictJson(catalogPath, "extension catalog");
  assert(Array.isArray(catalog.extensions), "extension catalog extensions must be a list");
  return catalog.extensions
    .filter((extension) => extension?.promotion?.promoted === true)
    .map((extension) => extension.id)
    .sort();
}

function same(actual, expected, context) {
  assert(actual === expected, `${context} mismatch: expected ${expected}, got ${actual}`);
}

function positiveInteger(value, context) {
  assert(Number.isSafeInteger(value) && value > 0, `${context} must be a positive safe integer`);
}

function findEvidenceRun(root) {
  const matches = [];
  for (const file of jsonFiles(root)) {
    let value;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (value?.schema === "oliphaunt-extension-evidence-v1" && value?.evidenceTier === "wasix-full-lifecycle-v1") {
      matches.push({ file, value, bytes: readFileSync(file) });
    }
  }
  assert(matches.length === 1, `WASIX evidence artifact must contain exactly one full-lifecycle run, found ${matches.length}`);
  return matches[0];
}

export function wasixEvidenceBinding(
  evidenceRoot,
  {
    repository,
    workflow,
    runId,
    runAttempt,
    sha,
    tree,
    catalogPath = "src/extensions/generated/extensions.catalog.json",
  },
) {
  const expectedRunId = Number.parseInt(String(runId), 10);
  positiveInteger(expectedRunId, "expected evidence runId");
  positiveInteger(runAttempt, "expected evidence runAttempt");
  const root = path.resolve(evidenceRoot);
  const { file, value: evidence, bytes } = findEvidenceRun(root);
  same(evidence.status, "passed", "WASIX evidence status");
  same(evidence.sourceCommit, sha, "WASIX evidence sourceCommit");
  same(evidence.sourceTree, tree, "WASIX evidence sourceTree");
  assert(/^sha256:[0-9a-f]{64}$/u.test(evidence.sourceDigest), "WASIX evidence sourceDigest must be SHA-256");
  uniqueStrings(evidence.sourceDigestInputs, "WASIX evidence sourceDigestInputs");
  same(evidence.github?.repository, repository, "WASIX evidence GitHub repository");
  same(evidence.github?.workflow, workflow, "WASIX evidence GitHub workflow");
  same(evidence.github?.runId, expectedRunId, "WASIX evidence GitHub runId");
  same(evidence.github?.runAttempt, runAttempt, "WASIX evidence GitHub runAttempt");
  same(evidence.github?.job, "wasix-release-regression", "WASIX evidence GitHub job");

  assert(Array.isArray(evidence.results) && evidence.results.length > 0, "WASIX evidence results must be non-empty");
  const extensions = [];
  for (const result of evidence.results) {
    assert(typeof result?.extension === "string" && result.extension.length > 0, "WASIX evidence result extension is invalid");
    same(result.postgresMajor, 18, `${result.extension} PostgreSQL major`);
    same(result.artifactFamily, "wasix-runtime", `${result.extension} artifact family`);
    same(result.platformTarget, "portable", `${result.extension} platform target`);
    for (const mode of ["direct", "server", "restart", "dump-restore"]) {
      same(result.runtimeModeStatuses?.[mode], "passed", `${result.extension} ${mode} status`);
    }
    extensions.push(result.extension);
  }
  extensions.sort();
  assert(new Set(extensions).size === extensions.length, "WASIX evidence results must not repeat extensions");
  const expectedExtensions = expectedPublicExtensions(catalogPath);
  assert(
    JSON.stringify(extensions) === JSON.stringify(expectedExtensions),
    "WASIX evidence results must cover every and only promoted public extension",
  );

  return {
    artifact: "wasix-release-regression-evidence",
    file: path.relative(root, file).split(path.sep).join("/"),
    digest: sha256(bytes),
    id: evidence.id,
    sourceDigest: evidence.sourceDigest,
    sourceCommit: evidence.sourceCommit,
    sourceTree: evidence.sourceTree,
    github: {
      repository: evidence.github.repository,
      workflow: evidence.github.workflow,
      runId: evidence.github.runId,
      runAttempt: evidence.github.runAttempt,
      job: evidence.github.job,
    },
    resultCount: extensions.length,
    extensionsDigest: sha256(JSON.stringify(extensions)),
  };
}

export function assertCandidateBindingShape(candidate) {
  assert(candidate?.schemaVersion === 2, `release candidate schemaVersion must be 2, got ${candidate?.schemaVersion}`);
  assert(candidate.affectedPlan !== null && typeof candidate.affectedPlan === "object", "release candidate affectedPlan is missing");
  assert(/^sha256:[0-9a-f]{64}$/u.test(candidate.affectedPlan.digest), "release candidate plan digest is invalid");
  const jobs = sortedUniqueStrings(candidate.affectedPlan.jobs, "release candidate affectedPlan.jobs");
  sortedUniqueStrings(candidate.affectedPlan.projects, "release candidate affectedPlan.projects");
  sortedUniqueStrings(
    candidate.affectedPlan.extensionPackageProducts,
    "release candidate affectedPlan.extensionPackageProducts",
  );
  assert(
    typeof candidate.affectedPlan.wasixReleaseRegressionRequired === "boolean",
    "release candidate affectedPlan WASIX requirement must be boolean",
  );
  assert(
    candidate.affectedPlan.wasixReleaseRegressionRequired === jobs.includes("liboliphaunt-wasix-runtime"),
    "release candidate affectedPlan WASIX requirement is inconsistent with selected jobs",
  );
  const requirements = candidate.evidenceRequirements;
  assert(requirements !== null && typeof requirements === "object", "release candidate evidenceRequirements is missing");
  assert(
    requirements.wasixReleaseRegression === candidate.affectedPlan.wasixReleaseRegressionRequired,
    "release candidate WASIX evidence requirement is inconsistent with affected plan",
  );
  const expectedArtifacts = requirements.wasixReleaseRegression ? ["wasix-release-regression-evidence"] : [];
  assert(
    JSON.stringify(requirements.artifacts) === JSON.stringify(expectedArtifacts),
    "release candidate evidence artifact requirements are inconsistent",
  );
  if (requirements.wasixReleaseRegression) {
    assert(candidate.evidence?.wasixReleaseRegression !== null, "release candidate is missing required WASIX evidence binding");
    assert(/^sha256:[0-9a-f]{64}$/u.test(candidate.evidence.wasixReleaseRegression.digest), "release candidate WASIX evidence digest is invalid");
    positiveInteger(candidate.evidence.wasixReleaseRegression.github?.runId, "release candidate WASIX evidence runId");
    positiveInteger(candidate.evidence.wasixReleaseRegression.github?.runAttempt, "release candidate WASIX evidence runAttempt");
  } else {
    assert(candidate.evidence?.wasixReleaseRegression === null, "release candidate carries WASIX evidence that its plan did not require");
  }
}

export function assertBindingMatches(actual, expected, context) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${context} binding does not match the recomputed same-run content`,
  );
}
