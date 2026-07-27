import { describe, expect, test } from "bun:test";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  auditGitHubReleaseControls,
  collectGitHubReleaseControls,
  formatAudit,
  githubApiArguments,
  summarizeFindings,
} from "./audit-github-release-controls.mjs";

const FIXTURES = path.join(import.meta.dir, "fixtures/github-release-controls");
const TOOL = path.join(import.meta.dir, "audit-github-release-controls.mjs");

function fixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
}

function graphqlPayload(source) {
  return {
    data: {
      repository: {
        nameWithOwner: source.branchProtectionGraphql.nameWithOwner,
        ref: {
          name: source.branchProtectionGraphql.refName,
          branchProtectionRule: structuredClone(source.branchProtectionGraphql.rule),
        },
      },
    },
  };
}

function expectGraphqlCollectionFailure(payload, expected) {
  const source = fixture("desired-solo");
  const apiGet = (endpoint) => {
    if (endpoint === "repos/f0rr0/oliphaunt") return source.repository;
    if (endpoint === "repos/f0rr0/oliphaunt/branches/main/protection") {
      return source.branchProtection;
    }
    throw new Error(`unexpected endpoint after malformed GraphQL response: ${endpoint}`);
  };
  expect(() => collectGitHubReleaseControls(
    apiGet,
    () => JSON.stringify(payload),
  )).toThrow(expected);
}

describe("GitHub release controls", () => {
  test("accepts the desired solo-maintainer controls without team-only ceremony", () => {
    const findings = auditGitHubReleaseControls(fixture("desired-solo"), {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(summarizeFindings(findings)).toEqual({ PASS: 40, WARN: 0, FAIL: 0 });
  });

  test("rejects a solo approval rule that the only collaborator cannot satisfy", () => {
    const snapshot = fixture("desired-solo");
    snapshot.branchProtection.required_pull_request_reviews.required_approving_review_count = 1;
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    const finding = findings.find(({ id }) => id === "branch.pr-review");
    expect(finding?.status).toBe("FAIL");
    expect(finding?.message).toContain("unmergeable");
  });

  test("accepts independent review when team governance is available", () => {
    const findings = auditGitHubReleaseControls(fixture("desired-team"), {
      bootstrapState: "ready",
      governance: "team",
    });
    expect(summarizeFindings(findings)).toEqual({ PASS: 42, WARN: 0, FAIL: 0 });
  });

  test("classifies the known unsafe configuration as hard failures and hygiene warnings", () => {
    const findings = auditGitHubReleaseControls(fixture("current-bad"), {
      bootstrapState: "ready",
      governance: "solo",
    });
    const summary = summarizeFindings(findings);
    expect(summary.FAIL).toBeGreaterThanOrEqual(8);
    expect(summary.WARN).toBeGreaterThanOrEqual(4);
    expect(findings.find(({ id }) => id === "environment.release-bootstrap.exists")?.status).toBe("FAIL");
    expect(findings.find(({ id }) => id === "environment.release-dry-run.secrets-isolated")?.status).toBe("PASS");
    expect(findings.find(({ id }) => id === "branch.aggregate-only")?.status).toBe("WARN");
  });

  test("rejects credentials in the dry-run environment", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-dry-run"].secretNames = ["LEAKED_WRITE_TOKEN"];
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(findings.find(({ id }) => id === "environment.release-dry-run.secrets-isolated")?.status).toBe("FAIL");
  });

  test("continuation environments allow only main and the deterministic transport-tag namespace", () => {
    for (const environmentName of ["release-bootstrap", "release-publish"]) {
      for (const branchPolicies of [
        [{ name: "main", type: "branch" }],
        [
          { name: "main", type: "branch" },
          { name: "*", type: "tag" },
        ],
        [
          { name: "main", type: "branch" },
          { name: "oliphaunt-release-transport/*", type: "branch" },
        ],
      ]) {
        const snapshot = fixture("desired-solo");
        snapshot.environments[environmentName].branchPolicies = branchPolicies;
        const findings = auditGitHubReleaseControls(snapshot, {
          bootstrapState: "ready",
          governance: "solo",
        });
        const finding = findings.find(
          ({ id }) => id === `environment.${environmentName}.branch-policy`,
        );
        expect(finding?.status).toBe("FAIL");
        expect(finding?.message).toContain("oliphaunt-release-transport/*");
      }
    }

    for (const environmentName of ["release-pr", "release-dry-run"]) {
      const snapshot = fixture("desired-solo");
      snapshot.environments[environmentName].branchPolicies.push({
        name: "oliphaunt-release-transport/*",
        type: "tag",
      });
      const findings = auditGitHubReleaseControls(snapshot, {
        bootstrapState: "ready",
        governance: "solo",
      });
      expect(findings.find(
        ({ id }) => id === `environment.${environmentName}.branch-policy`,
      )?.status).toBe("FAIL");
    }
  });

  test("accepts only the lock-required revocable registry credentials while bootstrap is ready", () => {
    for (const token of ["CRATES_IO_BOOTSTRAP_TOKEN", "NPM_BOOTSTRAP_TOKEN"]) {
      const snapshot = fixture("desired-solo");
      snapshot.environments["release-bootstrap"].secretNames = [token];
      const findings = auditGitHubReleaseControls(snapshot, {
        bootstrapState: "ready",
        governance: "solo",
      });
      const finding = findings.find(({ id }) => id === "environment.release-bootstrap.secrets-present");
      expect(finding?.status).toBe("PASS");
      expect(finding?.message).toContain("at least one approved registry bootstrap token");
      expect(summarizeFindings(findings).FAIL).toBe(0);
    }
  });

  test("ready bootstrap mode rejects an empty credential set", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-bootstrap"].secretNames = [];
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    const finding = findings.find(({ id }) => id === "environment.release-bootstrap.secrets-present");
    expect(finding?.status).toBe("FAIL");
    expect(finding?.message).toContain("approved lock");
    expect(finding?.message).toContain("CRATES_IO_BOOTSTRAP_TOKEN");
    expect(finding?.message).toContain("NPM_BOOTSTRAP_TOKEN");
  });

  test("accepts an idle pre-bootstrap environment without long-lived tokens", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-bootstrap"].secretNames = [];
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "idle",
      governance: "solo",
    });
    expect(summarizeFindings(findings).FAIL).toBe(0);
  });

  test("idle bootstrap mode rejects prematurely installed bootstrap tokens", () => {
    const findings = auditGitHubReleaseControls(fixture("desired-solo"), {
      bootstrapState: "idle",
      governance: "solo",
    });
    const finding = findings.find(({ id }) => id === "environment.release-bootstrap.secrets-isolated");
    expect(finding?.status).toBe("FAIL");
    expect(finding?.message).toContain("CRATES_IO_BOOTSTRAP_TOKEN");
    expect(finding?.message).toContain("NPM_BOOTSTRAP_TOKEN");
  });

  test("rejects unverifiable crates.io capacity assertions as stale release secrets", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-publish"].secretNames.push("CRATES_IO_VERSION_RUN_CAPACITY");
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(findings.find(({ id }) => id === "environment.release-publish.secrets-present")?.status).toBe("PASS");
    const isolation = findings.find(({ id }) => id === "environment.release-publish.secrets-isolated");
    expect(isolation?.status).toBe("FAIL");
    expect(isolation?.message).toContain("CRATES_IO_VERSION_RUN_CAPACITY");
  });

  test("does not mistake absent branch protection for disabled mutations", () => {
    const snapshot = fixture("desired-solo");
    snapshot.branchProtection = null;
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(findings.find(({ id }) => id === "branch.protection")?.status).toBe("FAIL");
    expect(findings.find(({ id }) => id === "branch.force-push")?.status).toBe("FAIL");
    expect(findings.find(({ id }) => id === "branch.deletion")?.status).toBe("FAIL");
  });

  test("rejects an actor-specific force-push bypass hidden from the REST protection flag", () => {
    const snapshot = fixture("desired-solo");
    snapshot.branchProtectionGraphql.rule.bypassForcePushAllowances = {
      totalCount: 1,
      pageInfo: { endCursor: "cursor-1", hasNextPage: false },
      nodes: [{ id: "BPFA_test", actor: { __typename: "User", id: "U_test", login: "f0rr0" } }],
    };
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(findings.find(({ id }) => id === "branch.force-push")?.status).toBe("PASS");
    expect(findings.find(({ id }) => id === "branch.force-push-bypass")?.status).toBe("FAIL");
  });

  test("fails closed when the GraphQL force-push bypass inventory is absent", () => {
    const snapshot = fixture("desired-solo");
    delete snapshot.branchProtectionGraphql;
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(findings.find(({ id }) => id === "branch.force-push-bypass")?.status).toBe("FAIL");
  });

  test("retired bootstrap mode requires long-lived bootstrap tokens to be absent", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-bootstrap"].secretNames = [];
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "retired",
      governance: "solo",
    });
    expect(summarizeFindings(findings).FAIL).toBe(0);
  });

  test("retired bootstrap mode rejects lingering bootstrap tokens", () => {
    const findings = auditGitHubReleaseControls(fixture("desired-solo"), {
      bootstrapState: "retired",
      governance: "solo",
    });
    const finding = findings.find(({ id }) => id === "environment.release-bootstrap.secrets-isolated");
    expect(finding?.status).toBe("FAIL");
    expect(finding?.message).toContain("CRATES_IO_BOOTSTRAP_TOKEN");
    expect(finding?.message).toContain("NPM_BOOTSTRAP_TOKEN");
  });

  test("rejects an unknown bootstrap lifecycle state", () => {
    expect(() => auditGitHubReleaseControls(fixture("desired-solo"), {
      bootstrapState: "staged",
      governance: "solo",
    })).toThrow(/idle, ready, or retired/u);
  });

  test("formats findings deterministically", () => {
    const options = { bootstrapState: "ready", governance: "solo" };
    const findings = auditGitHubReleaseControls(fixture("desired-solo"), options);
    const first = formatAudit(findings, options);
    expect(formatAudit([...findings].reverse(), options)).toBe(first);
    expect(formatAudit(findings, options)).toBe(first);
    expect(first).toEndWith("Summary: 40 PASS, 0 WARN, 0 FAIL");
  });
});

describe("GitHub API snapshot collection", () => {
  test("constructs GET-only commands for the canonical repository", () => {
    expect(githubApiArguments("repos/f0rr0/oliphaunt").slice(0, 3)).toEqual([
      "api",
      "--header",
      "Accept: application/vnd.github+json",
    ]);
    expect(() => githubApiArguments("repos/another-owner/another-repo")).toThrow(
      /refusing non-canonical/u,
    );
    expect(() => githubApiArguments("repos/f0rr0/oliphaunt-typo")).toThrow(
      /refusing non-canonical/u,
    );
  });

  test("uses only the fixed canonical read endpoints", () => {
    const source = fixture("desired-solo");
    const endpoints = [];
    const graphReads = [];
    const apiGet = (endpoint) => {
      endpoints.push(endpoint);
      if (endpoint === "repos/f0rr0/oliphaunt") return source.repository;
      if (endpoint === "repos/f0rr0/oliphaunt/branches/main/protection") return source.branchProtection;
      if (endpoint === "repos/f0rr0/oliphaunt/actions/permissions/workflow") return source.actionsWorkflowPermissions;
      if (endpoint.startsWith("repos/f0rr0/oliphaunt/environments?")) {
        return {
          total_count: 4,
          environments: Object.values(source.environments).map(({ environment }) => environment),
        };
      }
      const environmentName = Object.keys(source.environments).find((name) => endpoint.includes(encodeURIComponent(name)));
      if (!environmentName) throw new Error(`unexpected endpoint ${endpoint}`);
      if (endpoint === `repos/f0rr0/oliphaunt/environments/${encodeURIComponent(environmentName)}`) {
        return source.environments[environmentName].environment;
      }
      if (endpoint.includes("deployment-branch-policies")) {
        return {
          total_count: 1,
          branch_policies: source.environments[environmentName].branchPolicies,
        };
      }
      if (endpoint.includes("/secrets?")) {
        const secrets = source.environments[environmentName].secretNames.map((name) => ({ name }));
        return { total_count: secrets.length, secrets };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    };
    const graphqlRead = (document, variables) => {
      graphReads.push({ document, variables });
      return JSON.stringify({
        data: {
          repository: {
            nameWithOwner: source.branchProtectionGraphql.nameWithOwner,
            ref: {
              name: source.branchProtectionGraphql.refName,
              branchProtectionRule: source.branchProtectionGraphql.rule,
            },
          },
        },
      });
    };

    expect(collectGitHubReleaseControls(apiGet, graphqlRead)).toEqual(source);
    expect(graphReads).toHaveLength(1);
    expect(graphReads[0].document).toMatch(/^\s*query OliphauntReleaseBranchProtection/u);
    expect(graphReads[0].variables).toEqual({
      name: "oliphaunt",
      owner: "f0rr0",
      qualifiedName: "refs/heads/main",
    });
    expect(endpoints.every((endpoint) => !/[\s]|(^|[?&])method=/u.test(endpoint))).toBe(true);
    expect(endpoints.every((endpoint) => endpoint === "repos/f0rr0/oliphaunt" || endpoint.startsWith("repos/f0rr0/oliphaunt/") || endpoint.startsWith("repos/f0rr0/oliphaunt?"))).toBe(true);
  });

  test("fails closed when GraphQL omits the response data", () => {
    expectGraphqlCollectionFailure({}, /exact canonical main ref/u);
  });

  test("fails closed when GraphQL omits the main branch-protection rule", () => {
    const source = fixture("desired-solo");
    const payload = graphqlPayload(source);
    payload.data.repository.ref.branchProtectionRule = null;
    expectGraphqlCollectionFailure(payload, /complete main branch-protection rule/u);
  });

  test("fails closed when the force-push bypass collection requires pagination", () => {
    const source = fixture("desired-solo");
    const payload = graphqlPayload(source);
    payload.data.repository.ref.branchProtectionRule
      .bypassForcePushAllowances.pageInfo.hasNextPage = true;
    expectGraphqlCollectionFailure(payload, /bypass inventory is incomplete or malformed/u);
  });

  test("fails closed when the force-push bypass total disagrees with its nodes", () => {
    const source = fixture("desired-solo");
    const payload = graphqlPayload(source);
    payload.data.repository.ref.branchProtectionRule
      .bypassForcePushAllowances.totalCount = 1;
    expectGraphqlCollectionFailure(payload, /bypass inventory is incomplete or malformed/u);
  });

  test("fails closed when GraphQL returns the wrong repository identity", () => {
    const source = fixture("desired-solo");
    const payload = graphqlPayload(source);
    payload.data.repository.nameWithOwner = "f0rr0/not-oliphaunt";
    expectGraphqlCollectionFailure(payload, /exact canonical main ref/u);
  });

  test("fails closed when GraphQL returns the wrong ref", () => {
    const source = fixture("desired-solo");
    const payload = graphqlPayload(source);
    payload.data.repository.ref.name = "release";
    expectGraphqlCollectionFailure(payload, /exact canonical main ref/u);
  });
});

describe("GitHub controls audit CLI", () => {
  test("defaults to the least-privilege idle bootstrap state", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-audit-"));
    try {
      const snapshot = fixture("desired-solo");
      snapshot.environments["release-bootstrap"].secretNames = [];
      const fixturePath = path.join(directory, "idle.json");
      writeFileSync(fixturePath, JSON.stringify(snapshot));
      const result = spawnSync(process.execPath, [
        TOOL,
        "--fixture",
        fixturePath,
        "--governance",
        "solo",
      ], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("(governance=solo, bootstrap=idle)");
      expect(result.stdout).toEndWith("Summary: 40 PASS, 0 WARN, 0 FAIL\n");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("warnings do not fail the audit process", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-github-audit-"));
    try {
      const snapshot = fixture("desired-solo");
      snapshot.repository.allow_merge_commit = true;
      const fixturePath = path.join(directory, "warning.json");
      writeFileSync(fixturePath, JSON.stringify(snapshot));
      const result = spawnSync(process.execPath, [
        TOOL,
        "--fixture",
        fixturePath,
        "--governance",
        "solo",
        "--bootstrap-state",
        "ready",
      ], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toEndWith("Summary: 39 PASS, 1 WARN, 0 FAIL\n");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("hard release-safety findings fail the audit process", () => {
    const result = spawnSync(process.execPath, [
      TOOL,
      "--fixture",
      path.join(FIXTURES, "current-bad.json"),
      "--governance",
      "solo",
      "--bootstrap-state",
      "ready",
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/Summary: \d+ PASS, \d+ WARN, [1-9]\d* FAIL/u);
  });
});
