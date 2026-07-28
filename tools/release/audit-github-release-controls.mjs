#!/usr/bin/env bun

import { readFileSync } from "node:fs";

import { RELEASE_TRANSPORT_TAG_PREFIX } from "../../.github/scripts/release-transport-ref.mjs";
import { runGitHubGraphqlReadSync, runGitHubReadSync } from "./github-read.mjs";

export const CANONICAL_REPOSITORY = "f0rr0/oliphaunt";
export const DEFAULT_BRANCH = "main";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const API_HEADERS = [
  "Accept: application/vnd.github+json",
  "X-GitHub-Api-Version: 2022-11-28",
];

const BRANCH_PROTECTION_QUERY = `
query OliphauntReleaseBranchProtection($owner: String!, $name: String!, $qualifiedName: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    ref(qualifiedName: $qualifiedName) {
      name
      branchProtectionRule {
        id
        pattern
        allowsForcePushes
        bypassForcePushAllowances(first: 100) {
          totalCount
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            actor {
              __typename
              ... on User {
                id
                login
              }
              ... on Team {
                id
                slug
                organization {
                  login
                }
              }
              ... on App {
                id
                slug
              }
            }
          }
        }
      }
    }
  }
}`;

const RELEASE_PUBLISH_SECRETS = [
  "MAVEN_CENTRAL_PASSWORD",
  "MAVEN_CENTRAL_USERNAME",
  "MAVEN_GPG_KEY_ID",
  "MAVEN_GPG_PASSPHRASE",
  "MAVEN_GPG_PRIVATE_KEY",
];

const BOOTSTRAP_SECRETS = [
  "CRATES_IO_BOOTSTRAP_TOKEN",
  "NPM_BOOTSTRAP_TOKEN",
];

const BOOTSTRAP_STATES = new Set(["idle", "ready", "retired"]);

function expectedBootstrapSecrets(bootstrapState) {
  if (!BOOTSTRAP_STATES.has(bootstrapState)) {
    throw new Error(`bootstrap state must be idle, ready, or retired, got ${bootstrapState}`);
  }
  return bootstrapState === "ready" ? BOOTSTRAP_SECRETS : [];
}

function expectedEnvironments(bootstrapState) {
  return {
    "release-bootstrap": expectedBootstrapSecrets(bootstrapState),
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

function exactDeploymentPolicy(entry, environmentName) {
  const deployment = entry?.environment?.deployment_branch_policy;
  const policies = entry?.branchPolicies ?? [];
  const expected = [
    { name: DEFAULT_BRANCH, type: "branch" },
    ...(new Set(["release-bootstrap", "release-publish"]).has(environmentName)
      ? [{ name: `${RELEASE_TRANSPORT_TAG_PREFIX}*`, type: "tag" }]
      : []),
  ];
  const identity = (policy) => `${policy?.type ?? ""}\0${policy?.name ?? ""}`;
  return deployment?.protected_branches === false
    && deployment?.custom_branch_policies === true
    && policies.length === expected.length
    && JSON.stringify(policies.map(identity).sort()) === JSON.stringify(expected.map(identity).sort());
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
  { bootstrapState = "idle", governance = "solo" } = {},
) {
  if (!new Set(["solo", "team"]).has(governance)) {
    throw new Error(`governance must be solo or team, got ${governance}`);
  }
  expectedBootstrapSecrets(bootstrapState);

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
  const graphProtection = snapshot?.branchProtectionGraphql;
  const graphRule = graphProtection?.rule;
  const forcePushAllowances = graphRule?.bypassForcePushAllowances;
  const forcePushBypassCount = forcePushAllowances?.totalCount;
  const forcePushBypassNodes = forcePushAllowances?.nodes;
  const graphIdentityIsExact = graphProtection?.nameWithOwner === CANONICAL_REPOSITORY
    && graphProtection?.refName === DEFAULT_BRANCH
    && graphRule?.pattern === DEFAULT_BRANCH;
  const graphForcePushesBlocked = graphRule?.allowsForcePushes === false;
  const forcePushBypassInventoryIsComplete = Number.isSafeInteger(forcePushBypassCount)
    && forcePushBypassCount >= 0
    && Array.isArray(forcePushBypassNodes)
    && forcePushBypassNodes.length === forcePushBypassCount
    && forcePushAllowances?.pageInfo?.hasNextPage === false;
  const forcePushBypassesBlocked = forcePushBypassInventoryIsComplete
    && forcePushBypassCount === 0;
  findings.push(graphIdentityIsExact && graphForcePushesBlocked && forcePushBypassesBlocked
    ? finding("PASS", "branch.force-push-bypass", `${DEFAULT_BRANCH} has no actor-specific force-push bypass`)
    : finding(
      "FAIL",
      "branch.force-push-bypass",
      !graphIdentityIsExact
        ? `GraphQL must expose the exact ${CANONICAL_REPOSITORY} ${DEFAULT_BRANCH} branch-protection rule`
        : !graphForcePushesBlocked
          ? `${DEFAULT_BRANCH} must block force-pushes in its GraphQL branch-protection rule`
          : !forcePushBypassInventoryIsComplete
            ? `${DEFAULT_BRANCH} force-push bypass inventory is incomplete or malformed`
            : Number.isSafeInteger(forcePushBypassCount)
            ? `${forcePushBypassCount} actor(s) can bypass ${DEFAULT_BRANCH} force-push protection`
            : `${DEFAULT_BRANCH} force-push bypass inventory is malformed`,
    ));
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

  const approvalCount = Number(reviews?.required_approving_review_count);
  if (governance === "team") {
    findings.push(reviews && Number.isSafeInteger(approvalCount) && approvalCount >= 1
      ? finding("PASS", "branch.pr-review", "pull requests require independent approval")
      : finding("FAIL", "branch.pr-review", "team-governed pull requests must require at least one approval"));
  } else {
    findings.push(reviews && approvalCount === 0
      ? finding("PASS", "branch.pr-review", "solo pull requests do not require an unavailable self-approval")
      : finding(
        "FAIL",
        "branch.pr-review",
        `solo governance requires zero approvals; ${Number.isSafeInteger(approvalCount) ? approvalCount : "an invalid count"} makes self-authored pull requests unmergeable`,
      ));
  }
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
    const continuationEnvironment = new Set(["release-bootstrap", "release-publish"])
      .has(environmentName);
    findings.push(exactDeploymentPolicy(entry, environmentName)
      ? finding(
        "PASS",
        `environment.${environmentName}.branch-policy`,
        continuationEnvironment
          ? `${environmentName} accepts only branch main and exact release transport tags`
          : `${environmentName} accepts only branch main`,
      )
      : finding(
        "FAIL",
        `environment.${environmentName}.branch-policy`,
        continuationEnvironment
          ? `${environmentName} must allow exactly branch main and tag ${RELEASE_TRANSPORT_TAG_PREFIX}*`
          : `${environmentName} must use one exact custom branch policy for main and no tag policy`,
      ));

    const actualSecrets = [...new Set(entry.secretNames ?? [])].sort();
    const expectedSecrets = [...expected[environmentName]].sort();
    const allowedSecrets = expectedSecrets;
    const readyBootstrap = environmentName === "release-bootstrap" && bootstrapState === "ready";
    const missingSecrets = readyBootstrap
      ? actualSecrets.some((secret) => allowedSecrets.includes(secret)) ? [] : expectedSecrets
      : arrayDifference(expectedSecrets, actualSecrets);
    const unexpectedSecrets = arrayDifference(actualSecrets, allowedSecrets);
    findings.push(missingSecrets.length === 0
      ? finding(
        "PASS",
        `environment.${environmentName}.secrets-present`,
        readyBootstrap
          ? `${environmentName} has at least one approved registry bootstrap token name`
          : `${environmentName} has all expected secret names`,
      )
      : finding(
        "FAIL",
        `environment.${environmentName}.secrets-present`,
        readyBootstrap
          ? `${environmentName} must contain at least one token required by the approved lock: ${list(missingSecrets)}`
          : `${environmentName} is missing secret names: ${list(missingSecrets)}`,
      ));
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

  return findings.sort((left, right) => compareText(left.id, right.id));
}

export function summarizeFindings(findings) {
  const summary = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const item of findings) summary[item.status] += 1;
  return summary;
}

export function formatAudit(findings, options) {
  const summary = summarizeFindings(findings);
  const ordered = [...findings].sort((left, right) => compareText(left.id, right.id));
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
  const args = ["api"];
  for (const header of API_HEADERS) args.push("--header", header);
  args.push(endpoint);
  return args;
}

export function ghApiGet(endpoint) {
  const args = githubApiArguments(endpoint);
  const output = runGitHubReadSync(args, {
    label: `release-controls GET ${endpoint}`,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`GET ${endpoint} returned invalid JSON: ${error.message}`);
  }
}

function collectBranchProtectionGraphql(graphqlRead) {
  const [owner, name] = CANONICAL_REPOSITORY.split("/");
  const output = graphqlRead(BRANCH_PROTECTION_QUERY, {
    name,
    owner,
    qualifiedName: `refs/heads/${DEFAULT_BRANCH}`,
  }, {
    label: "release-controls GraphQL main branch-protection rule",
    maxBuffer: 16 * 1024 * 1024,
  });
  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(`GraphQL branch-protection query returned invalid JSON: ${error.message}`);
  }
  if (response?.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) {
    throw new Error("GraphQL branch-protection query returned errors");
  }
  const repository = response?.data?.repository;
  const ref = repository?.ref;
  const rule = ref?.branchProtectionRule;
  const allowances = rule?.bypassForcePushAllowances;
  if (repository?.nameWithOwner !== CANONICAL_REPOSITORY || ref?.name !== DEFAULT_BRANCH) {
    throw new Error("GraphQL did not return the exact canonical main ref");
  }
  if (
    !rule
    || typeof rule.id !== "string"
    || rule.id === ""
    || typeof rule.pattern !== "string"
    || typeof rule.allowsForcePushes !== "boolean"
  ) {
    throw new Error("GraphQL did not return a complete main branch-protection rule");
  }
  if (
    !Number.isSafeInteger(allowances?.totalCount)
    || allowances.totalCount < 0
    || !Array.isArray(allowances?.nodes)
    || allowances.nodes.length !== allowances.totalCount
    || allowances?.pageInfo?.hasNextPage !== false
  ) {
    throw new Error("GraphQL main force-push bypass inventory is incomplete or malformed");
  }
  for (const node of allowances.nodes) {
    if (
      typeof node?.id !== "string"
      || node.id === ""
      || !new Set(["App", "Team", "User"]).has(node?.actor?.__typename)
    ) {
      throw new Error("GraphQL main force-push bypass actor is malformed");
    }
  }
  return {
    nameWithOwner: repository.nameWithOwner,
    refName: ref.name,
    rule,
  };
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

export function collectGitHubReleaseControls(
  apiGet = ghApiGet,
  graphqlRead = runGitHubGraphqlReadSync,
) {
  const repository = apiGet(`repos/${CANONICAL_REPOSITORY}`);
  const branchProtection = apiGet(`repos/${CANONICAL_REPOSITORY}/branches/${DEFAULT_BRANCH}/protection`);
  const branchProtectionGraphql = collectBranchProtectionGraphql(graphqlRead);
  const actionsWorkflowPermissions = apiGet(`repos/${CANONICAL_REPOSITORY}/actions/permissions/workflow`);
  const environmentList = paged(
    apiGet,
    `repos/${CANONICAL_REPOSITORY}/environments`,
    "environments",
  );
  const environmentByName = new Map(environmentList.map((environment) => [environment.name, environment]));
  const environments = {};

  for (const environmentName of Object.keys(expectedEnvironments("idle")).sort()) {
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
    branchProtectionGraphql,
    environments,
    repository,
  };
}

function parseArgs(argv) {
  const options = {
    bootstrapState: "idle",
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
  --bootstrap-state idle|ready|retired
                               Require bootstrap tokens absent before bootstrap, one or both
                               approved registry tokens for an imminent lock-derived bootstrap,
                               or no tokens after revocation (default: idle)
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
