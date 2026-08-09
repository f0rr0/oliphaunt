import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  affectedPlanBinding,
  assertBindingMatches,
  assertCandidateBindingShape,
  candidateQualificationMode,
  wasixEvidenceBinding,
} from "../../.github/scripts/release-candidate-lib.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-release-candidate-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, cleanup };
}

function promotedExtensions() {
  const catalog = JSON.parse(readFileSync("src/extensions/generated/extensions.catalog.json", "utf8"));
  return catalog.extensions
    .filter((extension) => extension?.promotion?.promoted === true)
    .map((extension) => extension.id)
    .sort();
}

function writeEvidence(
  root,
  {
    extensions = promotedExtensions(),
    runAttempt = 1,
    job = "wasix-release-regression",
  } = {},
) {
  const runDirectory = path.join(root, "src/extensions/evidence/runs");
  mkdirSync(runDirectory, { recursive: true });
  const run = {
    schema: "oliphaunt-extension-evidence-v1",
    id: "2026-07-14T120000Z-ci-123456789-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    evidenceTier: "wasix-full-lifecycle-v1",
    status: "passed",
    sourceDigest: `sha256:${"b".repeat(64)}`,
    sourceDigestInputs: ["z-input", "a-input"],
    sourceCommit: "a".repeat(40),
    sourceTree: "c".repeat(40),
    observedAt: "2026-07-14T12:00:00Z",
    collector: "src/extensions/tools/collect-wasix-evidence.sh",
    github: {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: 123456789,
      runAttempt,
      job,
    },
    results: extensions.map((extension) => ({
      extension,
      sqlName: extension,
      postgresMajor: 18,
      artifactFamily: "wasix-runtime",
      platformTarget: "portable",
      runtimeModeStatuses: {
        direct: "passed",
        server: "passed",
        restart: "passed",
        "dump-restore": "passed",
      },
    })),
  };
  writeFileSync(path.join(runDirectory, `${run.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

test("binds the canonical affected plan and conditional WASIX evidence", () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, "ci-plan.json");
    writeFileSync(planPath, `${JSON.stringify({
      projects: ["liboliphaunt-wasix"],
      jobs: ["affected", "liboliphaunt-wasix-runtime"],
      extension_package_products: [],
      reason: "test",
    }, null, 2)}\n`);
    const plan = affectedPlanBinding(planPath, true);
    writeEvidence(root);
    const evidence = wasixEvidenceBinding(root, {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: "123456789",
      runAttempt: 1,
      sha: "a".repeat(40),
      tree: "c".repeat(40),
    });
    const candidate = {
      schemaVersion: 2,
      affectedPlan: plan,
      evidenceRequirements: {
        wasixReleaseRegression: true,
        artifacts: ["wasix-release-regression-evidence"],
      },
      evidence: { wasixReleaseRegression: evidence },
    };
    expect(() => assertCandidateBindingShape(candidate)).not.toThrow();
    expect(evidence.github.runId).toBe(123456789);
    expect(evidence.resultCount).toBe(promotedExtensions().length);
  } finally {
    cleanup();
  }
});

test("rejects an incomplete WASIX evidence result set", () => {
  const { root, cleanup } = fixture();
  try {
    writeEvidence(root, { extensions: promotedExtensions().slice(1) });
    expect(() => wasixEvidenceBinding(root, {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: "123456789",
      runAttempt: 1,
      sha: "a".repeat(40),
      tree: "c".repeat(40),
    })).toThrow("every and only promoted public extension");
  } finally {
    cleanup();
  }
});

test("rejects a plan requirement that disagrees with selected jobs", () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, "ci-plan.json");
    writeFileSync(planPath, JSON.stringify({
      projects: ["oliphaunt-js"],
      jobs: ["affected", "js-sdk-package"],
      extension_package_products: [],
    }));
    expect(() => affectedPlanBinding(planPath, true)).toThrow("jobs imply false");
  } finally {
    cleanup();
  }
});

test("rejects substituted evidence bytes even when provenance fields still match", () => {
  const { root, cleanup } = fixture();
  try {
    writeEvidence(root);
    const expected = wasixEvidenceBinding(root, {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: "123456789",
      runAttempt: 1,
      sha: "a".repeat(40),
      tree: "c".repeat(40),
    });
    const evidencePath = path.join(root, expected.file);
    const substituted = JSON.parse(readFileSync(evidencePath, "utf8"));
    substituted.notes = "substituted bytes with otherwise matching provenance";
    writeFileSync(evidencePath, `${JSON.stringify(substituted, null, 2)}\n`);
    const actual = wasixEvidenceBinding(root, {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: "123456789",
      runAttempt: 1,
      sha: "a".repeat(40),
      tree: "c".repeat(40),
    });
    expect(() => assertBindingMatches(expected, actual, "WASIX evidence")).toThrow("does not match");
  } finally {
    cleanup();
  }
});

test("rejects evidence from another run attempt or job", () => {
  const attemptFixture = fixture();
  try {
    writeEvidence(attemptFixture.root, { runAttempt: 2 });
    expect(() => wasixEvidenceBinding(attemptFixture.root, {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: "123456789",
      runAttempt: 1,
      sha: "a".repeat(40),
      tree: "c".repeat(40),
    })).toThrow("runAttempt mismatch");
  } finally {
    attemptFixture.cleanup();
  }

  const jobFixture = fixture();
  try {
    writeEvidence(jobFixture.root, { job: "different-job" });
    expect(() => wasixEvidenceBinding(jobFixture.root, {
      repository: "f0rr0/oliphaunt",
      workflow: "CI",
      runId: "123456789",
      runAttempt: 1,
      sha: "a".repeat(40),
      tree: "c".repeat(40),
    })).toThrow("GitHub job mismatch");
  } finally {
    jobFixture.cleanup();
  }
});

test("rejects a changed selected-product set even when WASIX remains required", () => {
  const { root, cleanup } = fixture();
  try {
    const firstPath = path.join(root, "first-plan.json");
    const secondPath = path.join(root, "second-plan.json");
    const base = {
      projects: ["extensions"],
      jobs: ["affected", "liboliphaunt-wasix-runtime"],
    };
    writeFileSync(firstPath, JSON.stringify({
      ...base,
      extension_package_products: ["oliphaunt-extension-vector"],
    }));
    writeFileSync(secondPath, JSON.stringify({
      ...base,
      extension_package_products: ["oliphaunt-extension-postgis"],
    }));
    const expected = affectedPlanBinding(firstPath, true);
    const actual = affectedPlanBinding(secondPath, true);
    expect(() => assertBindingMatches(expected, actual, "affected plan")).toThrow("does not match");
  } finally {
    cleanup();
  }
});

test("keeps legacy F4 qualification plans backward-compatible as full-payload", () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, "legacy-plan.json");
    writeFileSync(planPath, JSON.stringify({
      projects: [],
      jobs: ["affected"],
      extension_package_products: [],
    }));
    const affectedPlan = affectedPlanBinding(planPath, false);
    const candidate = {
      schemaVersion: 2,
      affectedPlan,
      evidenceRequirements: {
        wasixReleaseRegression: false,
        artifacts: [],
      },
      evidence: { wasixReleaseRegression: null },
    };
    expect(affectedPlan.qualification).toBeUndefined();
    expect(candidateQualificationMode(candidate)).toBe("full-payload");
    expect(() => assertCandidateBindingShape(candidate)).not.toThrow();
  } finally {
    cleanup();
  }
});

test("binds recovery-control to an exact source/controller range without payload jobs", () => {
  const { root, cleanup } = fixture();
  try {
    const releaseSha = "1".repeat(40);
    const controllerSha = "2".repeat(40);
    const planPath = path.join(root, "recovery-plan.json");
    writeFileSync(planPath, JSON.stringify({
      qualification_mode: "recovery-control",
      qualification_base_sha: releaseSha,
      qualification_head_sha: controllerSha,
      projects: ["release-tools"],
      jobs: ["affected"],
      extension_package_products: [],
    }));
    const affectedPlan = affectedPlanBinding(planPath, false);
    const candidate = {
      schemaVersion: 2,
      sha: controllerSha,
      affectedPlan,
      evidenceRequirements: {
        wasixReleaseRegression: false,
        artifacts: [],
      },
      evidence: { wasixReleaseRegression: null },
    };
    expect(candidateQualificationMode(candidate)).toBe("recovery-control");
    expect(affectedPlan.qualification).toEqual({
      mode: "recovery-control",
      baseSha: releaseSha,
      headSha: controllerSha,
    });
    expect(() => assertCandidateBindingShape(candidate)).not.toThrow();

    const substituted = structuredClone(candidate);
    substituted.affectedPlan.qualification.headSha = "3".repeat(40);
    expect(() => assertCandidateBindingShape(substituted)).toThrow(
      "controller does not match candidate SHA",
    );
  } finally {
    cleanup();
  }
});

test("rejects recovery-control plans that select any payload job", () => {
  const { root, cleanup } = fixture();
  try {
    const planPath = path.join(root, "invalid-recovery-plan.json");
    writeFileSync(planPath, JSON.stringify({
      qualification_mode: "recovery-control",
      qualification_base_sha: "1".repeat(40),
      qualification_head_sha: "2".repeat(40),
      projects: [],
      jobs: ["affected", "js-sdk-package"],
      extension_package_products: [],
    }));
    expect(() => affectedPlanBinding(planPath, false)).toThrow(
      "must not select builder or E2E payload jobs",
    );
  } finally {
    cleanup();
  }
});
