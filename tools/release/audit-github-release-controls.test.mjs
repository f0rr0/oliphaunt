import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

describe("GitHub release controls", () => {
  test("accepts the desired solo-maintainer controls without team-only ceremony", () => {
    const findings = auditGitHubReleaseControls(fixture("desired-solo"), {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(summarizeFindings(findings)).toEqual({ PASS: 39, WARN: 0, FAIL: 0 });
  });

  test("accepts independent review when team governance is available", () => {
    const findings = auditGitHubReleaseControls(fixture("desired-team"), {
      bootstrapState: "ready",
      governance: "team",
    });
    expect(summarizeFindings(findings)).toEqual({ PASS: 41, WARN: 0, FAIL: 0 });
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

  test("requires the numeric crates.io run-capacity assertion while bootstrap is ready", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-bootstrap"].secretNames = [
      "CRATES_IO_BOOTSTRAP_TOKEN",
      "NPM_BOOTSTRAP_TOKEN",
    ];
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    const finding = findings.find(({ id }) => id === "environment.release-bootstrap.secrets-present");
    expect(finding?.status).toBe("FAIL");
    expect(finding?.message).toContain("CRATES_IO_NEW_CRATE_RUN_CAPACITY");
  });

  test("allows the normal version-capacity override to be absent for the official default burst", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-publish"].secretNames = snapshot.environments["release-publish"].secretNames
      .filter((name) => name !== "CRATES_IO_VERSION_RUN_CAPACITY");
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "ready",
      governance: "solo",
    });
    expect(findings.find(({ id }) => id === "environment.release-publish.secrets-present")?.status).toBe("PASS");
    expect(findings.find(({ id }) => id === "environment.release-publish.secrets-isolated")?.status).toBe("PASS");
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

  test("retired bootstrap mode requires long-lived bootstrap tokens to be absent", () => {
    const snapshot = fixture("desired-solo");
    snapshot.environments["release-bootstrap"].secretNames = [];
    const findings = auditGitHubReleaseControls(snapshot, {
      bootstrapState: "retired",
      governance: "solo",
    });
    expect(summarizeFindings(findings).FAIL).toBe(0);
  });

  test("formats findings deterministically", () => {
    const options = { bootstrapState: "ready", governance: "solo" };
    const findings = auditGitHubReleaseControls(fixture("desired-solo"), options);
    const first = formatAudit(findings, options);
    expect(formatAudit([...findings].reverse(), options)).toBe(first);
    expect(formatAudit(findings, options)).toBe(first);
    expect(first).toEndWith("Summary: 39 PASS, 0 WARN, 0 FAIL");
  });
});

describe("GitHub API snapshot collection", () => {
  test("constructs GET-only commands for the canonical repository", () => {
    expect(githubApiArguments("repos/f0rr0/oliphaunt").slice(0, 3)).toEqual([
      "api",
      "--method",
      "GET",
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

    expect(collectGitHubReleaseControls(apiGet)).toEqual(source);
    expect(endpoints.every((endpoint) => !/[\s]|(^|[?&])method=/u.test(endpoint))).toBe(true);
    expect(endpoints.every((endpoint) => endpoint === "repos/f0rr0/oliphaunt" || endpoint.startsWith("repos/f0rr0/oliphaunt/") || endpoint.startsWith("repos/f0rr0/oliphaunt?"))).toBe(true);
  });
});

describe("GitHub controls audit CLI", () => {
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
      expect(result.stdout).toEndWith("Summary: 38 PASS, 1 WARN, 0 FAIL\n");
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
