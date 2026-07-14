#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const CANONICAL_REPOSITORY = "f0rr0/oliphaunt";
export const DEFAULT_BRANCH = "main";

const API_HEADERS = [
  "Accept: application/vnd.github+json",
  "X-GitHub-Api-Version: 2022-11-28",
];

const RELEASE_PUBLISH_SECRETS = [
  "MAVEN_CENTRAL_PASSWORD",
  "MAVEN_CENTRAL_USERNAME",
  "MAVEN_GPG_KEY_ID",
  "MAVEN_GPG_PASSPHRASE",
  "MAVEN_GPG_PRIVATE_KEY",
];

const OPTIONAL_ENVIRONMENT_SECRETS = Object.freeze({
  // The official crates.io version bucket safely covers up to 30 pending
  // versions. Larger exact-lock releases may add this support-approved numeric
  // assertion without making it ceremony for every normal release.
  "release-publish": ["CRATES_IO_VERSION_RUN_CAPACITY"],
});

function expectedEnvironments(bootstrapState) {
  return {
    "release-bootstrap": bootstrapState === "ready"
      ? ["CRATES_IO_BOOTSTRAP_TOKEN", "CRATES_IO_NEW_CRATE_RUN_CAPACITY", "NPM_BOOTSTRAP_TOKEN"]
      : [],
    "release-dry-run": [],
    "release-pr": ["RELEASE_PR_TOKEN"],
    "release-publish": RELEASE_PUBLISH_SECRETS,
  };
}

function finding(status, id, message) {
  return { id, message, status };
}

function enabled(value) {
  return value?.enabled === true;
}

function requiredCheckNames(protection) {
  const checks = protection?.required_status_checks;
  return [...new Set([
    ...(Array.isArray(checks?.contexts) ? checks.contexts : []),
    ...(Array.isArray(checks?.checks)
      ? checks.checks.map((check) => check?.context).filter(Boolean)
      : []),
  ])].sort();
}

function reviewerRule(environment) {
  return (environment?.protection_rules ?? []).find(
    (rule) => rule?.type === "required_reviewers",
  );
}

function reviewerCount(rule) {
  return Array.isArray(rule?.reviewers) ? rule.reviewers.length : 0;
}

function bypassActorCount(reviews) {
  const bypass = reviews?.bypass_pull_request_allowances ?? {};
  return ["apps", "teams", "users"].reduce(
    (total, key) => total + (Array.isArray(bypass[key]) ? bypass[key].length : 0),
    0,
  );
}

function exactMainPolicy(entry) {
  const deployment = entry?.environment?.deployment_branch_policy;
  const policies = entry?.branchPolicies ?? [];
  return deployment?.protected_branches === false
    && deployment?.custom_branch_policies === true
    && policies.length === 1
    && policies[0]?.name === DEFAULT_BRANCH
    && policies[0]?.type === "branch";
}

function arrayDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function list(values) {
  return values.length === 0 ? "none" : values.join(", ");
}

/**
 * Evaluate a read-only snapshot of GitHub repository controls.
 *
 * FAIL findings are release-safety blockers. WARN findings are governance or
 * repository-hygiene recommendations and never change the process exit code.
 */
export function auditGitHubReleaseControls(
  snapshot,
  { bootstrapState = "ready", governance = "solo" } = {},
) {
  if (!new Set(["solo", "team"]).has(governance)) {
    throw new Error(`governance must be solo or team, got ${governance}`);
  }
  if (!new Set(["ready", "retired"]).has(bootstrapState)) {
    throw new Error(`bootstrap state must be ready or retired, got ${bootstrapState}`);
  }

  const findings = [];
  const repository = snapshot?.repository ?? {};
  const protection = snapshot?.branchProtection ?? {};
  const actions = snapshot?.actionsWorkflowPermissions ?? {};
  const reviews = protection?.required_pull_request_reviews;
  const hasProtection = snapshot?.branchProtection != null
    && Object.keys(snapshot.branchProtection).length > 0;

  findings.push(repository.full_name === CANONICAL_REPOSITORY
    ? finding("PASS", "repository.identity", `repository is ${CANONICAL_REPOSITORY}`)
    : finding("FAIL", "repository.identity", `expected ${CANONICAL_REPOSITORY}, got ${repository.full_name ?? "missing"}`));
  findings.push(repository.default_branch === DEFAULT_BRANCH
    ? finding("PASS", "repository.default-branch", `default branch is ${DEFAULT_BRANCH}`)
    : finding("FAIL", "repository.default-branch", `default branch must be ${DEFAULT_BRANCH}`));
  findings.push(repository.allow_squash_merge === true
    ? finding("PASS", "repository.squash-merge", "squash merging is enabled")
    : finding("FAIL", "repository.squash-merge", "squash merging must be enabled"));
  findings.push(repository.allow_merge_commit === false
    ? finding("PASS", "repository.merge-commit", "merge commits are disabled")
    : finding("WARN", "repository.merge-commit", "disable merge commits to keep squash-only history"));
  findings.push(repository.allow_rebase_merge === false
    ? finding("PASS", "repository.rebase-merge", "rebase merging is disabled")
    : finding("WARN", "repository.rebase-merge", "disable rebase merging to keep squash-only history"));
  findings.push(repository.delete_branch_on_merge === true
    ? finding("PASS", "repository.delete-branch", "merged branches are deleted automatically")
    : finding("WARN", "repository.delete-branch", "enable automatic deletion of merged branches"));

  findings.push(hasProtection
    ? finding("PASS", "branch.protection", `${DEFAULT_BRANCH} has branch protection`)
    : finding("FAIL", "branch.protection", `${DEFAULT_BRANCH} must have branch protection`));
  findings.push(protection?.allow_force_pushes?.enabled === false
    ? finding("PASS", "branch.force-push", `${DEFAULT_BRANCH} blocks force-pushes`)
    : finding("FAIL", "branch.force-push", `${DEFAULT_BRANCH} must block force-pushes`));
  findings.push(protection?.allow_deletions?.enabled === false
    ? finding("PASS", "branch.deletion", `${DEFAULT_BRANCH} blocks deletion`)
    : finding("FAIL", "branch.deletion", `${DEFAULT_BRANCH} must block deletion`));
  findings.push(enabled(protection.required_linear_history)
    ? finding("PASS", "branch.linear-history", `${DEFAULT_BRANCH} requires linear history`)
    : finding("FAIL", "branch.linear-history", `${DEFAULT_BRANCH} must require linear history`));
  findings.push(enabled(protection.required_conversation_resolution)
    ? finding("PASS", "branch.conversation-resolution", "review conversations must be resolved")
    : finding("FAIL", "branch.conversation-resolution", "review conversations must be resolved before merge"));
  findings.push(enabled(protection.enforce_admins)
    ? finding("PASS", "branch.admin-enforcement", "branch protection applies to administrators")
    : finding("FAIL", "branch.admin-enforcement", "branch protection must apply to administrators"));

  const checkNames = requiredCheckNames(protection);
  findings.push(protection?.required_status_checks?.strict === true
    ? finding("PASS", "branch.strict-checks", "required checks must pass on an up-to-date branch")
    : finding("FAIL", "branch.strict-checks", "required status checks must use strict mode"));
  findings.push(checkNames.includes("Required")
    ? finding("PASS", "branch.required-check", "aggregate Required check is a merge gate")
    : finding("FAIL", "branch.required-check", "aggregate Required check must be required"));
  const extraChecks = checkNames.filter((name) => name !== "Required");
  findings.push(extraChecks.length === 0
    ? finding("PASS", "branch.aggregate-only", "Required is the only branch-protection check")
    : finding("WARN", "branch.aggregate-only", `remove redundant required checks: ${list(extraChecks)}`));

  findings.push(reviews && Number(reviews.required_approving_review_count) >= 1
    ? finding("PASS", "branch.pr-review", "pull requests require at least one approval")
    : finding("FAIL", "branch.pr-review", "pull requests must require at least one approval"));
  findings.push(reviews?.dismiss_stale_reviews === true
    ? finding("PASS", "branch.stale-review", "new commits dismiss stale approvals")
    : finding("FAIL", "branch.stale-review", "new commits must dismiss stale approvals"));
  const bypassCount = bypassActorCount(reviews);
  findings.push(bypassCount === 0
    ? finding("PASS", "branch.review-bypass", "no actor bypasses pull-request review")
    : finding("WARN", "branch.review-bypass", `${bypassCount} actor(s) can bypass pull-request review`));
  if (governance === "team") {
    findings.push(reviews?.require_last_push_approval === true
      ? finding("PASS", "branch.last-push-review", "a different maintainer must approve the last push")
      : finding("WARN", "branch.last-push-review", "with a second maintainer, require approval of the last push by someone else"));
  } else {
    findings.push(reviews?.require_last_push_approval !== true
      ? finding("PASS", "branch.last-push-review", "solo governance does not require an unavailable second approver")
      : finding("WARN", "branch.last-push-review", "last-push approval can make a solo-maintained repository unmergeable"));
  }

  findings.push(actions.default_workflow_permissions === "read"
    ? finding("PASS", "actions.default-token", "default workflow token permission is read")
    : finding("FAIL", "actions.default-token", "default workflow token permission must be read"));
  findings.push(actions.can_approve_pull_request_reviews === false
    ? finding("PASS", "actions.pr-approval", "workflow tokens cannot approve pull requests")
    : finding("FAIL", "actions.pr-approval", "workflow tokens must not approve pull requests"));

  const expected = expectedEnvironments(bootstrapState);
  for (const environmentName of Object.keys(expected).sort()) {
    const entry = snapshot?.environments?.[environmentName];
    if (!entry) {
      findings.push(finding("FAIL", `environment.${environmentName}.exists`, `${environmentName} must exist`));
      continue;
    }

    findings.push(finding("PASS", `environment.${environmentName}.exists`, `${environmentName} exists`));
    findings.push(exactMainPolicy(entry)
      ? finding("PASS", `environment.${environmentName}.branch-policy`, `${environmentName} accepts only branch main`)
      : finding("FAIL", `environment.${environmentName}.branch-policy`, `${environmentName} must use one exact custom branch policy for main and no tag policy`));

    const actualSecrets = [...new Set(entry.secretNames ?? [])].sort();
    const expectedSecrets = [...expected[environmentName]].sort();
    const allowedSecrets = [
      ...expectedSecrets,
      ...(OPTIONAL_ENVIRONMENT_SECRETS[environmentName] ?? []),
    ].sort();
    const missingSecrets = arrayDifference(expectedSecrets, actualSecrets);
    const unexpectedSecrets = arrayDifference(actualSecrets, allowedSecrets);
    findings.push(missingSecrets.length === 0
      ? finding("PASS", `environment.${environmentName}.secrets-present`, `${environmentName} has all expected secret names`)
      : finding("FAIL", `environment.${environmentName}.secrets-present`, `${environmentName} is missing secret names: ${list(missingSecrets)}`));
    findings.push(unexpectedSecrets.length === 0
      ? finding("PASS", `environment.${environmentName}.secrets-isolated`, `${environmentName} has no unexpected secret names`)
      : finding("FAIL", `environment.${environmentName}.secrets-isolated`, `${environmentName} has unexpected secret names: ${list(unexpectedSecrets)}`));

    if (!new Set(["release-bootstrap", "release-publish"]).has(environmentName)) continue;
    const rule = reviewerRule(entry.environment);
    if (governance === "team") {
      findings.push(reviewerCount(rule) > 0
        ? finding("PASS", `environment.${environmentName}.reviewer`, `${environmentName} requires an environment reviewer`)
        : finding("WARN", `environment.${environmentName}.reviewer`, `configure an independent reviewer for ${environmentName} when a second maintainer is available`));
      findings.push(rule?.prevent_self_review === true
        ? finding("PASS", `environment.${environmentName}.self-review`, `${environmentName} prevents self-review`)
        : finding("WARN", `environment.${environmentName}.self-review`, `enable prevent-self-review for ${environmentName} with team governance`));
    } else {
      findings.push(rule?.prevent_self_review !== true
        ? finding("PASS", `environment.${environmentName}.self-review`, `${environmentName} remains operable by a solo maintainer`)
        : finding("WARN", `environment.${environmentName}.self-review`, `disable prevent-self-review for ${environmentName} while the repository has one maintainer`));
    }
  }

  return findings.sort((left, right) => left.id.localeCompare(right.id));
}

export function summarizeFindings(findings) {
  const summary = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const item of findings) summary[item.status] += 1;
  return summary;
}

export function formatAudit(findings, options) {
  const summary = summarizeFindings(findings);
  const ordered = [...findings].sort((left, right) => left.id.localeCompare(right.id));
  const lines = [
    `GitHub release-controls audit: ${CANONICAL_REPOSITORY} (governance=${options.governance}, bootstrap=${options.bootstrapState})`,
    ...ordered.map((item) => `${item.status.padEnd(4)} ${item.id}: ${item.message}`),
    `Summary: ${summary.PASS} PASS, ${summary.WARN} WARN, ${summary.FAIL} FAIL`,
  ];
  return lines.join("\n");
}

/** Run exactly one read-only GitHub REST request. */
export function githubApiArguments(endpoint) {
  const repositoryRoot = `repos/${CANONICAL_REPOSITORY}`;
  const canonicalRepositoryEndpoint = endpoint === repositoryRoot
    || endpoint.startsWith(`${repositoryRoot}/`)
    || endpoint.startsWith(`${repositoryRoot}?`);
  if (!canonicalRepositoryEndpoint) {
    throw new Error(`refusing non-canonical GitHub API endpoint: ${endpoint}`);
  }
  const args = ["api", "--method", "GET"];
  for (const header of API_HEADERS) args.push("--header", header);
  args.push(endpoint);
  return args;
}

export function ghApiGet(endpoint) {
  const args = githubApiArguments(endpoint);
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(`gh api failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${result.status ?? "unknown"}`;
    throw new Error(`GET ${endpoint} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`GET ${endpoint} returned invalid JSON: ${error.message}`);
  }
}

function paged(apiGet, endpoint, collectionKey) {
  const values = [];
  let page = 1;
  while (true) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = apiGet(`${endpoint}${separator}per_page=100&page=${page}`);
    const batch = response?.[collectionKey];
    if (!Array.isArray(batch)) {
      throw new Error(`GET ${endpoint} did not return ${collectionKey}`);
    }
    values.push(...batch);
    const total = Number(response.total_count ?? values.length);
    if (values.length >= total || batch.length === 0) return values;
    page += 1;
  }
}

export function collectGitHubReleaseControls(apiGet = ghApiGet) {
  const repository = apiGet(`repos/${CANONICAL_REPOSITORY}`);
  const branchProtection = apiGet(`repos/${CANONICAL_REPOSITORY}/branches/${DEFAULT_BRANCH}/protection`);
  const actionsWorkflowPermissions = apiGet(`repos/${CANONICAL_REPOSITORY}/actions/permissions/workflow`);
  const environmentList = paged(
    apiGet,
    `repos/${CANONICAL_REPOSITORY}/environments`,
    "environments",
  );
  const environmentByName = new Map(environmentList.map((environment) => [environment.name, environment]));
  const environments = {};

  for (const environmentName of Object.keys(expectedEnvironments("ready")).sort()) {
    if (!environmentByName.has(environmentName)) continue;
    const encodedName = encodeURIComponent(environmentName);
    const root = `repos/${CANONICAL_REPOSITORY}/environments/${encodedName}`;
    const environment = apiGet(root);
    const branchPolicies = environment.deployment_branch_policy?.custom_branch_policies === true
      ? paged(apiGet, `${root}/deployment-branch-policies`, "branch_policies")
      : [];
    const secrets = paged(apiGet, `${root}/secrets`, "secrets");
    environments[environmentName] = {
      branchPolicies,
      environment,
      secretNames: secrets.map((secret) => secret.name).sort(),
    };
  }

  return {
    actionsWorkflowPermissions,
    branchProtection,
    environments,
    repository,
  };
}

function parseArgs(argv) {
  const options = {
    bootstrapState: "ready",
    fixture: null,
    governance: "solo",
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") return { ...options, help: true };
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--governance" || arg === "--bootstrap-state" || arg === "--fixture") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--governance") options.governance = value;
      else if (arg === "--bootstrap-state") options.bootstrapState = value;
      else options.fixture = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `usage: tools/dev/bun.sh tools/release/audit-github-release-controls.mjs [options]

Read-only audit of ${CANONICAL_REPOSITORY}'s release safety controls.

Options:
  --governance solo|team       Calibrate independent-review recommendations (default: solo)
  --bootstrap-state ready|retired
                               Require bootstrap token names, or require them revoked (default: ready)
  --fixture PATH               Audit a saved API snapshot without accessing GitHub
  --json                       Emit deterministic JSON
  -h, --help                   Show this help
`;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return;
    }
    const snapshot = options.fixture
      ? JSON.parse(readFileSync(options.fixture, "utf8"))
      : collectGitHubReleaseControls();
    const findings = auditGitHubReleaseControls(snapshot, options);
    const summary = summarizeFindings(findings);
    if (options.json) {
      console.log(JSON.stringify({
        bootstrapState: options.bootstrapState,
        findings,
        governance: options.governance,
        repository: CANONICAL_REPOSITORY,
        summary,
      }, null, 2));
    } else {
      console.log(formatAudit(findings, options));
    }
    if (summary.FAIL > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`audit-github-release-controls.mjs: ${error.message}`);
    process.exitCode = 2;
  }
}

if (import.meta.main) main(Bun.argv.slice(2));
