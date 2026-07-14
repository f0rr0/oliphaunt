import { readFileSync } from "node:fs";
import path from "node:path";

const CI_REF = "${{ github.event.pull_request.head.sha || github.sha }}";
const MOBILE_REF = "${{ needs.resolve.outputs.sha }}";

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`workflow policy: ${message}`);
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function sameSet(actual, expected) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalized(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function parseWorkflow(root, repoPath) {
  const file = path.join(root, repoPath);
  let workflow;
  try {
    workflow = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new Error(`workflow policy: cannot parse ${repoPath}: ${cause.message}`);
  }
  invariant(object(workflow), `${repoPath} must contain a YAML object`);
  invariant(object(workflow.on), `${repoPath} must declare workflow triggers`);
  invariant(object(workflow.jobs) && Object.keys(workflow.jobs).length > 0, `${repoPath} must declare jobs`);
  return workflow;
}

export function workflowNeeds(workflow, jobId) {
  const job = workflow.jobs[jobId];
  invariant(object(job), `missing job ${jobId}`);
  return new Set(strings(job.needs));
}

export function workflowSteps(workflow, jobId) {
  const job = workflow.jobs[jobId];
  invariant(object(job), `missing job ${jobId}`);
  invariant(Array.isArray(job.steps), `${jobId} must declare steps`);
  return job.steps;
}

export function stepCommands(workflow, jobId) {
  return workflowSteps(workflow, jobId)
    .map((step, index) => ({ index, step, run: normalized(step.run), uses: String(step.uses ?? "") }));
}

function commandStep(workflow, jobId, needle) {
  const matches = stepCommands(workflow, jobId).filter(({ run }) => run.includes(needle));
  invariant(matches.length === 1, `${jobId} must contain exactly one command step matching ${needle}; found ${matches.length}`);
  return matches[0];
}

function actionStep(workflow, jobId, prefix) {
  const matches = stepCommands(workflow, jobId).filter(({ uses }) => uses.startsWith(prefix));
  invariant(matches.length === 1, `${jobId} must contain exactly one action matching ${prefix}; found ${matches.length}`);
  return matches[0];
}

function assertNeeds(workflow, jobId, expected) {
  const actual = [...workflowNeeds(workflow, jobId)];
  invariant(sameSet(actual, expected), `${jobId}.needs must be ${JSON.stringify([...expected].sort())}; got ${JSON.stringify(actual.sort())}`);
}

function assertGraph(workflow, repoPath) {
  const jobs = new Set(Object.keys(workflow.jobs));
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const dependency of strings(job.needs)) {
      invariant(jobs.has(dependency), `${repoPath} ${jobId}.needs references missing job ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (jobId) => {
    if (visited.has(jobId)) return;
    invariant(!visiting.has(jobId), `${repoPath} job dependency graph contains a cycle through ${jobId}`);
    visiting.add(jobId);
    for (const dependency of strings(workflow.jobs[jobId].needs)) visit(dependency);
    visiting.delete(jobId);
    visited.add(jobId);
  };
  for (const jobId of jobs) visit(jobId);
}

function assertPermissions(actual, expected, context) {
  invariant(object(actual), `${context} must declare permissions explicitly`);
  invariant(
    sameSet(Object.keys(actual), Object.keys(expected))
      && Object.entries(expected).every(([scope, access]) => actual[scope] === access),
    `${context} permissions must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
  );
}

function assertCheckout(step, ref, context) {
  invariant(String(step.uses ?? "").startsWith("actions/checkout@"), `${context} must use actions/checkout`);
  invariant(step.with?.ref === ref, `${context} checkout ref must be ${ref}; got ${String(step.with?.ref)}`);
  invariant(step.with?.["persist-credentials"] === false, `${context} checkout must disable persisted credentials`);
}

function assertAllCheckouts(workflow, ref) {
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const checkouts = (job.steps ?? []).filter((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    for (const checkout of checkouts) assertCheckout(checkout, ref, `${jobId}`);
  }
}

function assertUpload(workflow, jobId, artifact, { required = true } = {}) {
  const matches = stepCommands(workflow, jobId).filter(({ step, uses }) =>
    uses.startsWith("actions/upload-artifact@") && step.with?.name === artifact);
  invariant(matches.length === 1, `${jobId} must upload ${artifact} exactly once`);
  if (required) {
    invariant(matches[0].step.with?.["if-no-files-found"] === "error", `${artifact} upload must fail when files are absent`);
  }
  return matches[0];
}

function assertConcurrency(workflow, { tokens, cancel }, context) {
  invariant(object(workflow.concurrency), `${context} must declare concurrency`);
  const group = String(workflow.concurrency.group ?? "");
  for (const token of tokens) invariant(group.includes(token), `${context} concurrency group must bind ${token}`);
  invariant(workflow.concurrency["cancel-in-progress"] === cancel, `${context} cancel-in-progress must be ${String(cancel)}`);
}

export function assertReleaseIntentScript(source) {
  invariant(
    source.includes('[[ "${head_branch}" == "release-please--branches--main" ]]')
      && !source.includes("release/*"),
    "release-intent generated-release exemption must be limited to the canonical Release Please branch",
  );
  const marker = 'if [[ "${is_release_pr}" == true ]]; then';
  const start = source.indexOf(marker);
  const end = source.indexOf('release_plan="$(tools/dev/bun.sh tools/release/release_plan.mjs', start);
  invariant(start !== -1 && end > start, "release-intent must validate generated release commits before release planning");
  const validation = source.slice(start, end);
  for (const token of [
    'base_commit="$(git rev-parse "${base_ref}^{commit}")"',
    'head_parent="$(git rev-parse "${head_ref}^{commit}^")"',
    '"${head_parent}" != "${base_commit}"',
    "tools/release/verify-release-commit.mjs",
    "--derive-products",
    '--products-json "${release_products_json}"',
    '--head-ref "${head_ref}"',
  ]) {
    invariant(validation.includes(token), `generated release PR validation must enforce ${token}`);
  }
  invariant(
    validation.split("tools/release/verify-release-commit.mjs").length - 1 === 2,
    "generated release PR validation must derive the exact manifest product set and verify the commit with it",
  );
}

export function assertCiWorkflow(workflow, { builderJobs = [] } = {}) {
  assertGraph(workflow, "CI");
  invariant(sameSet(Object.keys(workflow.on), ["pull_request", "merge_group", "push", "workflow_dispatch"]), "CI triggers must be pull_request, merge_group, push, and workflow_dispatch");
  invariant(sameSet(workflow.on.pull_request?.types ?? [], ["opened", "synchronize", "reopened", "closed"]), "CI pull_request trigger must cover lifecycle cancellation events");
  invariant(sameSet(workflow.on.push?.branches ?? [], ["main"]), "CI push qualification must run on main only");
  invariant(!Object.hasOwn(workflow.on.pull_request ?? {}, "paths"), "CI pull_request trigger must not use path filters");
  assertConcurrency(workflow, {
    tokens: ["github.event.number", "github.sha"],
    cancel: "${{ github.event_name == 'pull_request' }}",
  }, "CI");
  assertPermissions(workflow.permissions, { contents: "read" }, "CI workflow");
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    invariant(
      job.permissions === undefined
        || (object(job.permissions) && Object.values(job.permissions).every((access) => access === "read" || access === "none")),
      `CI job ${jobId} must not grant write access to the GITHUB_TOKEN`,
    );
  }
  assertAllCheckouts(workflow, CI_REF);

  assertNeeds(workflow, "required", ["affected", "release-intent", "checks", "tests", "builds", "e2e"]);
  assertNeeds(workflow, "qualified", ["affected", "required"]);
  const buildNeeds = workflowNeeds(workflow, "builds");
  for (const builder of builderJobs) invariant(buildNeeds.has(builder), `builds.needs must include selected builder ${builder}`);
  for (const [jobId, expected] of Object.entries({
    checks: ["affected", "check-targets", "policy-targets"],
    tests: ["affected", "test-targets"],
    e2e: ["affected", "mobile-e2e-android", "mobile-e2e-ios"],
  })) assertNeeds(workflow, jobId, expected);

  for (const [jobId, mode] of [["checks", "allow-skipped"], ["tests", "allow-skipped"], ["builds", "selected"], ["e2e", "allow-skipped"], ["required", "required"]]) {
    const gates = stepCommands(workflow, jobId).filter(({ run }) => run.includes(`check-ci-gate.mjs ${mode}`));
    invariant(gates.length > 0, `${jobId} must contain a ${mode} fail-closed gate`);
    invariant(String(workflow.jobs[jobId].if ?? "").includes("always()"), `${jobId} must run under always() and fail closed from dependency results`);
  }

  assertNeeds(workflow, "wasix-release-regression", [
    "affected",
    "extension-artifacts-wasix",
    "liboliphaunt-wasix-aot",
    "liboliphaunt-wasix-runtime",
  ]);
  const regressionDownloads = stepCommands(workflow, "wasix-release-regression")
    .filter(({ uses }) => uses.startsWith("actions/download-artifact@"));
  const regressionDownload = (key, value) => regressionDownloads.find(({ step }) => step.with?.[key] === value)?.step;
  const portableDownload = regressionDownload("name", "liboliphaunt-wasix-runtime-portable");
  invariant(portableDownload?.with?.path === ".", "WASIX regression must restore the exact portable runtime artifact at the repository root");
  const extensionDownload = regressionDownload("pattern", "liboliphaunt-wasix-extension-artifacts-*");
  invariant(
    extensionDownload?.with?.path === "target/extensions/wasix/release-assets"
      && extensionDownload.with?.["merge-multiple"] === true,
    "WASIX regression must merge same-run portable extension carriers into the canonical staging input",
  );
  const runtimeAotDownload = regressionDownload("name", "liboliphaunt-wasix-runtime-aot-linux-x64-gnu");
  invariant(runtimeAotDownload !== undefined, "WASIX regression must download the same-run Linux host runtime AOT carrier");
  const extensionAotDownload = regressionDownload("name", "liboliphaunt-wasix-extension-aot-linux-x64-gnu");
  invariant(
    extensionAotDownload?.with?.path === "target/extensions/wasix/aot-artifacts",
    "WASIX regression must download the same-run Linux host extension AOT carrier into the canonical staging input",
  );
  const extensionStage = commandStep(workflow, "wasix-release-regression", "build-extension-ci-artifacts.mjs");
  invariant(
    extensionStage.run.includes("--all") && extensionStage.run.includes("--require-wasix"),
    "WASIX regression must normalize every exact extension and fail closed on absent WASIX inputs",
  );
  const evidence = commandStep(workflow, "wasix-release-regression", "collect-wasix-evidence.sh");
  invariant(evidence.step.env?.CI_HEAD_SHA === CI_REF, "WASIX evidence must bind to the exact checked-out candidate SHA");
  invariant(
    evidence.step.env?.OLIPHAUNT_WASIX_EXTENSION_ARTIFACT_ROOT === "${{ github.workspace }}/target/extension-artifacts",
    "WASIX evidence must resolve extension archives and host AOT only from the normalized same-run artifact root",
  );
  invariant(evidence.run.includes("git rev-parse HEAD") && evidence.run.includes("CI_HEAD_SHA"), "WASIX evidence must verify checkout SHA before collection");
  assertUpload(workflow, "wasix-release-regression", "wasix-release-regression-evidence");
  invariant(
    String(workflow.jobs["wasix-release-regression"].if ?? "").includes("needs.affected.outputs.wasix_release_regression_required == 'true'"),
    "WASIX release regression must be selected only by the canonical planner output",
  );
  const wasixCache = stepCommands(workflow, "liboliphaunt-wasix-runtime").find(({ step, uses }) =>
    uses.startsWith("actions/cache/restore@") && step.id === "wasix-build-cache");
  invariant(wasixCache !== undefined, "WASIX runtime must restore its semantic compilation cache once");
  const wasixCacheKey = String(wasixCache.step.with?.key ?? "");
  for (const token of [
    "${{ runner.os }}",
    "${{ env.ASSET_PROFILE }}",
    "${{ env.WASMER_LLVM_VERSION }}",
    "hashFiles('src/runtimes/liboliphaunt/wasix/assets/generated/asset-inputs.sha256')",
  ]) invariant(wasixCacheKey.includes(token), `WASIX compilation cache key must bind ${token}`);
  invariant(!Object.hasOwn(wasixCache.step.with ?? {}, "restore-keys"), "WASIX compilation cache must not use broad restore fallbacks");
  invariant(buildNeeds.has("wasix-release-regression"), "Builds must depend on the conditional WASIX regression job");
  const wasixBuildGate = stepCommands(workflow, "builds").find(({ step }) => step.name === "Check exact-candidate WASIX regression");
  invariant(
    wasixBuildGate?.run.includes("check-ci-gate.mjs selected")
      && String(wasixBuildGate.step.env?.SELECTED_JOBS_JSON).includes("needs.affected.outputs.wasix_release_regression_required")
      && String(wasixBuildGate.step.env?.SELECTED_JOBS_JSON).includes("wasix-release-regression"),
    "Builds must fail closed on the WASIX regression exactly when the planner selects it",
  );

  const candidate = commandStep(workflow, "qualified", "write-release-candidate.mjs");
  invariant(candidate.step.env?.CI_HEAD_SHA === CI_REF, "release candidate record must bind to the exact CI candidate SHA");
  invariant(candidate.step.env?.CI_PLAN_PATH === "target/qualification/affected-plan/ci-plan.json", "release candidate must consume the same-run affected plan");
  invariant(
    candidate.step.env?.WASIX_RELEASE_REGRESSION_REQUIRED === "${{ needs.affected.outputs.wasix_release_regression_required }}",
    "release candidate must consume the canonical affected-plan WASIX requirement",
  );
  const qualifiedDownloads = stepCommands(workflow, "qualified").filter(({ uses }) => uses.startsWith("actions/download-artifact@"));
  const planDownload = qualifiedDownloads.find(({ step }) => step.with?.name === "artifact-build-plan");
  invariant(planDownload?.step.with?.path === "target/qualification/affected-plan", "Qualified must download the same-run affected plan");
  const evidenceDownload = qualifiedDownloads.find(({ step }) => step.with?.name === "wasix-release-regression-evidence");
  invariant(
    String(evidenceDownload?.step.if ?? "").includes("needs.affected.outputs.wasix_release_regression_required == 'true'"),
    "Qualified must download WASIX evidence exactly when the affected plan requires it",
  );
  const qualification = stepCommands(workflow, "qualified").find(({ run }) => run.includes("needs.required.result"));
  invariant(qualification?.run.includes("needs.affected.result"), "qualified must fail unless planning and the Required gate succeeded");
  assertUpload(workflow, "qualified", "oliphaunt-release-candidate");
}

export function assertMobileWorkflow(workflow) {
  assertGraph(workflow, "mobile E2E");
  invariant(sameSet(Object.keys(workflow.on), ["workflow_call", "workflow_dispatch"]), "mobile E2E must be reusable/manual only");
  assertConcurrency(workflow, { tokens: ["inputs.sha", "inputs.platform"], cancel: false }, "mobile E2E");
  assertPermissions(workflow.permissions, { actions: "read", contents: "read" }, "mobile E2E workflow");
  assertNeeds(workflow, "android", ["resolve"]);
  assertNeeds(workflow, "ios", ["resolve"]);
  assertNeeds(workflow, "required", ["resolve", "android", "ios"]);
  const resolveCheckout = actionStep(workflow, "resolve", "actions/checkout@").step;
  assertCheckout(resolveCheckout, "${{ inputs.sha || github.sha }}", "mobile resolve");
  for (const jobId of ["android", "ios"]) {
    const checkout = actionStep(workflow, jobId, "actions/checkout@").step;
    assertCheckout(checkout, MOBILE_REF, `mobile ${jobId}`);
    const downloads = stepCommands(workflow, jobId).filter(({ run }) => run.includes("gh run download"));
    invariant(downloads.length === 1 && downloads[0].run.includes("CI_RUN_ID"), `mobile ${jobId} must download the resolved exact-run app artifact`);
  }
  const resolver = commandStep(workflow, "resolve", "resolve-mobile-e2e.mjs");
  invariant(resolver.run.length > 0, "mobile resolver must be present");
  invariant(String(workflow.jobs.required.if ?? "").includes("always()"), "mobile required gate must run under always()");
  commandStep(workflow, "required", "check-ci-gate.mjs allow-skipped");
}

function assertPublishGuard(step, mode) {
  const condition = String(step.if ?? "");
  invariant(condition.includes(`inputs.operation == '${mode}'`), `${step.name ?? step.run ?? step.uses} must be guarded by ${mode}`);
}

function assertCargoCandidateGuard(step) {
  const condition = String(step.if ?? "");
  invariant(
    condition.includes("steps.release_plan.outputs.has_release_changes == 'true'")
      && condition.includes("steps.registry_needs.outputs.needs_cargo == 'true'"),
    `${step.name ?? step.run ?? step.uses} must run only for a selected release with Cargo carriers`,
  );
}

export function assertReleaseDispatcherWorkflow(workflow) {
  assertGraph(workflow, "Release dispatcher");
  invariant(sameSet(Object.keys(workflow.on), ["workflow_dispatch"]), "Release dispatcher must be manually dispatched only");
  const operations = workflow.on.workflow_dispatch?.inputs?.operation?.options ?? [];
  invariant(sameSet(operations, ["prepare-release-pr", "publish-dry-run", "publish", "publish-bootstrap"]), "Release operation input must expose only the supported state transitions");
  assertConcurrency(
    workflow,
    { tokens: ["inputs.operation == 'publish-dry-run'", "github.sha", "'mutation'"], cancel: false },
    "Release",
  );
  invariant(
    !String(workflow.concurrency.group).includes("inputs.release_commit"),
    "Release registry mutations must not be serialized by candidate SHA",
  );
  assertPermissions(workflow.permissions, { contents: "read" }, "Release workflow");

  const expected = {
    "prepare-release-pr": {
      mode: "prepare-release-pr",
      permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    },
    "publish-dry-run": {
      mode: "publish-dry-run",
      permissions: { actions: "read", contents: "read" },
    },
    "publish-bootstrap": {
      mode: "publish-bootstrap",
      permissions: { actions: "read", contents: "read", "id-token": "write" },
    },
    publish: {
      mode: "publish",
      permissions: { actions: "read", attestations: "write", contents: "write", "id-token": "write" },
    },
  };
  invariant(sameSet(Object.keys(workflow.jobs), Object.keys(expected)), "Release dispatcher must expose exactly one least-privilege caller per operation");
  for (const [jobId, contract] of Object.entries(expected)) {
    const job = workflow.jobs[jobId];
    invariant(job.uses === "./.github/workflows/release-execute.yml", `${jobId} must call the shared release execution workflow`);
    invariant(String(job.if ?? "").includes(`inputs.operation == '${contract.mode}'`), `${jobId} must be selected only by ${contract.mode}`);
    invariant(job.with?.operation === contract.mode, `${jobId} must pass the literal operation ${contract.mode}`);
    invariant(job.with?.release_commit === "${{ inputs.release_commit }}", `${jobId} must forward the release commit assertion`);
    invariant(job.secrets === undefined, `${jobId} must not inherit repository or organization secrets; execution uses only its protected environment`);
    assertPermissions(job.permissions, contract.permissions, `Release dispatcher ${jobId} job`);
  }
}

export function assertReleaseExecutionWorkflow(workflow) {
  assertGraph(workflow, "Release execution");
  invariant(sameSet(Object.keys(workflow.on), ["workflow_call"]), "Release execution must be callable only");
  const callInputs = workflow.on.workflow_call?.inputs ?? {};
  invariant(sameSet(Object.keys(callInputs), ["operation", "release_commit"]), "Release execution must accept only operation and release_commit inputs");
  invariant(callInputs.operation?.required === true && callInputs.operation?.type === "string", "Release execution operation must be a required string");
  invariant(callInputs.release_commit?.required === false && callInputs.release_commit?.type === "string", "Release execution release_commit must be an optional string");
  invariant(
    workflow.on.workflow_call?.secrets === undefined,
    "Release execution must read only its selected environment secrets and the automatic GITHUB_TOKEN; callers must not pass repository or organization secrets",
  );
  invariant(workflow.concurrency === undefined, "Release execution must inherit serialization from its dispatcher without a nested concurrency lock");
  assertPermissions(workflow.permissions, { contents: "read" }, "Release execution workflow");
  invariant(sameSet(Object.keys(workflow.jobs), ["release-identity", "prepare-release-pr", "publish"]), "Release execution must contain only identity, preparation, and shared publish jobs");
  assertNeeds(workflow, "prepare-release-pr", ["release-identity"]);
  assertNeeds(workflow, "publish", ["release-identity"]);
  invariant(workflow.jobs.publish["timeout-minutes"] === 360, "shared publish job must retain its bounded six-hour timeout");
  invariant(workflow.env?.REGISTRY_MUTATION_WINDOW_SECONDS === 19800, "registry mutation must stop 30 minutes before the shared publish timeout");
  assertPermissions(workflow.jobs.publish.permissions, {
    actions: "read",
    attestations: "write",
    contents: "write",
    "id-token": "write",
  }, "Release execution publish job");
  assertPermissions(workflow.jobs["prepare-release-pr"].permissions, {
    contents: "write",
    issues: "write",
    "pull-requests": "write",
  }, "Release execution prepare job");
  invariant(workflow.jobs["prepare-release-pr"].environment === "release-pr", "release preparation must use the release-pr environment");
  invariant(
    workflow.jobs.publish.environment === "${{ inputs.operation == 'publish-bootstrap' && 'release-bootstrap' || inputs.operation == 'publish' && 'release-publish' || 'release-dry-run' }}",
    "shared release execution must map each operation to its protected environment",
  );

  const operationGuard = commandStep(workflow, "release-identity", "Unsupported release operation");
  for (const operation of ["prepare-release-pr", "publish-dry-run", "publish-bootstrap", "publish"]) {
    invariant(operationGuard.run.includes(operation), `release execution must explicitly allow ${operation}`);
  }

  for (const jobId of ["prepare-release-pr", "publish"]) {
    const checkout = actionStep(workflow, jobId, "actions/checkout@").step;
    invariant(checkout.with?.["persist-credentials"] === false, `${jobId} checkout must disable persisted credentials`);
  }
  const releasePrSync = commandStep(workflow, "prepare-release-pr", "sync-release-pr.mjs");
  for (const token of [
    'expected_release_pr_head="release-please--branches--main"',
    '"${release_pr_head_repository}" != "${CANONICAL_RELEASE_REPOSITORY}"',
    '"${release_pr_is_cross_repository}" != "false"',
    'git rev-list --count "${main_sha}..HEAD"',
    "git rev-parse 'HEAD^'",
    "git commit --amend --no-edit",
    '--force-with-lease="refs/heads/${release_pr_head}:${release_pr_old_sha}"',
    '"HEAD:refs/heads/${release_pr_head}"',
  ]) invariant(releasePrSync.run.includes(token), `release PR normalization must enforce ${token}`);
  invariant(!releasePrSync.run.includes("chore(release): sync derived release files"), "derived release files must not create a second release commit");
  invariant(!releasePrSync.run.includes("HEAD:main"), "release PR normalization must never update main");
  const steps = stepCommands(workflow, "publish");
  const npmRuntime = commandStep(workflow, "publish", "npm-trusted-publishing.mjs check-runtime");
  for (const token of ['node_version="$(node --version)"', 'npm_version="$(npm --version)"', '--node "$node_version"', '--npm "$npm_version"']) {
    invariant(npmRuntime.run.includes(token), `npm trusted publishing must verify the observed runtime with ${token}`);
  }
  const mutationDeadline = commandStep(workflow, "publish", "REGISTRY_MUTATION_DEADLINE_EPOCH");
  invariant(
    String(mutationDeadline.step.if ?? "").includes("inputs.operation == 'publish-bootstrap'")
      && String(mutationDeadline.step.if ?? "").includes("inputs.operation == 'publish'")
      && mutationDeadline.run.includes("REGISTRY_MUTATION_WINDOW_SECONDS")
      && mutationDeadline.run.includes("$GITHUB_ENV"),
    "bootstrap and normal publication must receive one bounded registry mutation deadline",
  );
  const releaseHead = commandStep(workflow, "publish", "resolve-release-head.sh");
  invariant(releaseHead.step.id === "release_head", "release commit resolver must expose the release_head output identity");
  const registryNeeds = commandStep(workflow, "publish", "selected-registry-needs.mjs");
  const oidcIdentity = commandStep(workflow, "publish", "verify-github-oidc-identity.mjs");
  const oidcCondition = String(oidcIdentity.step.if ?? "");
  invariant(
    oidcCondition.includes("steps.release_plan.outputs.has_release_changes == 'true'")
      && oidcCondition.includes("inputs.operation == 'publish-bootstrap'")
      && oidcCondition.includes("inputs.operation == 'publish'")
      && oidcIdentity.step.env?.RELEASE_OPERATION === "${{ inputs.operation }}"
      && oidcIdentity.index > registryNeeds.index,
    "mutating operations must verify the live caller/reusable-workflow OIDC identity before publication",
  );
  const preflight = commandStep(workflow, "publish", "manage-release-drafts.mjs preflight");
  invariant(oidcIdentity.index < preflight.index, "OIDC identity verification must precede release collision and mutation preflight");
  invariant(preflight.run.includes("verify_product_tags.mjs") && preflight.run.includes("--allow-missing") && preflight.run.includes("$RELEASE_HEAD_SHA"), "tag/release collision preflight must bind the selected products to RELEASE_HEAD_SHA");
  const externalReadiness = commandStep(workflow, "publish", "verify-external-publish-readiness.mjs");
  assertPublishGuard(externalReadiness.step, "publish");
  invariant(workflow.env?.MAVEN_CENTRAL_NAMESPACE === "dev.oliphaunt", "release workflow must pin the verified Maven Central namespace");

  const qualificationMatches = steps.filter(({ run }) =>
    run.includes("require-workflow-success.sh")
    && run.includes("--job Qualified")
    && run.includes("--artifact oliphaunt-release-candidate"));
  invariant(qualificationMatches.length === 1, "publish must select exactly one qualified CI run and candidate record");
  const qualification = qualificationMatches[0];
  for (const token of ["CI", "$RELEASE_HEAD_SHA", "--job Builds", "--job Required", "--job Qualified", "--artifact artifact-build-plan", "--artifact oliphaunt-release-candidate"]) {
    invariant(qualification.run.includes(token), `release qualification must require ${token}`);
  }
  invariant(
    qualification.step.env?.REQUIRES_WASIX_EVIDENCE === "${{ steps.release_plan.outputs.requires_wasix_release_regression_evidence }}"
      && qualification.run.includes('if [[ "$REQUIRES_WASIX_EVIDENCE" == true ]]')
      && qualification.run.includes("--artifact wasix-release-regression-evidence"),
    "release qualification must require WASIX evidence only for release selections that need it",
  );
  invariant(qualification.step.id === "ci_qualification", "release qualification must export a pinned CI run id");
  const candidateDownloads = steps.filter(({ run }) => run.includes("download-build-artifacts.mjs") && run.includes("target/release-candidate"));
  const candidateDownloadMatches = candidateDownloads.filter(({ run }) => run.includes("--artifact oliphaunt-release-candidate"));
  invariant(candidateDownloadMatches.length === 1, "publish must download the exact-SHA candidate record exactly once");
  const candidateDownload = candidateDownloadMatches[0];
  for (const token of ["$RELEASE_HEAD_SHA", "--run-id", "CI_RUN_ID", "--job Qualified", "--artifact oliphaunt-release-candidate"]) {
    invariant(candidateDownload.run.includes(token), `release candidate download must bind ${token}`);
  }
  const planDownloads = candidateDownloads.filter(({ run }) => run.includes("--artifact artifact-build-plan"));
  invariant(
    planDownloads.length === 1 && planDownloads[0].run.includes("--job Plan") && planDownloads[0].run.includes("--run-id"),
    "publish must download the same-run affected plan for candidate digest verification",
  );
  const evidenceDownloads = candidateDownloads.filter(({ run }) => run.includes("--artifact wasix-release-regression-evidence"));
  invariant(
    evidenceDownloads.length === 1
      && String(evidenceDownloads[0].step.if ?? "").includes("requires_wasix_release_regression_evidence == 'true'")
      && evidenceDownloads[0].run.includes('--job "E2E / WASIX release regression"'),
    "publish must download same-run WASIX evidence exactly when the release plan requires it",
  );
  const candidateVerify = commandStep(workflow, "publish", "verify-release-candidate.mjs");
  invariant(candidateVerify.step.env?.CI_RUN_ID === "${{ steps.ci_qualification.outputs.run_id }}", "release candidate verifier must bind the selected CI run id");
  invariant(
    candidateVerify.step.env?.WASIX_EVIDENCE_REQUIRED === "${{ steps.release_plan.outputs.requires_wasix_release_regression_evidence }}"
      && candidateVerify.run.includes("--plan target/release-candidate/affected-plan/ci-plan.json")
      && candidateVerify.run.includes('--wasix-evidence-required "$WASIX_EVIDENCE_REQUIRED"')
      && candidateVerify.run.includes("--wasix-evidence-root target/release-candidate/wasix-evidence"),
    "release candidate verifier must recompute the plan binding and conditionally validate WASIX evidence bytes",
  );

  const lockGate = steps.find(({ run }) => run.includes("require-workflow-success.sh") && run.includes("oliphaunt-publication-lock"));
  invariant(lockGate?.run.includes("$RELEASE_HEAD_SHA"), "approved publication lock must come from the exact release SHA");
  invariant(!lockGate?.run.includes("--job"), "approved publication lock selection must not depend on reusable-workflow display names");
  const lockDownloads = steps.filter(({ run }) => run.includes("download-build-artifacts.mjs") && run.includes("target/approved-publication-lock"));
  invariant(lockDownloads.length === 1, "publish must download the approved publication lock exactly once");
  const lockDownload = lockDownloads[0];
  invariant(lockDownload.run.includes("--run-id") && lockDownload.run.includes("RELEASE_LOCK_RUN_ID"), "approved publication lock download must bind the selected Release run id");
  invariant(!lockDownload.run.includes("--job"), "approved publication lock download must not depend on reusable-workflow display names");
  const bootstrapLedgerDownload = commandStep(workflow, "publish", "--artifact oliphaunt-bootstrap-ledger");
  invariant(!bootstrapLedgerDownload.run.includes("--job"), "bootstrap ledger lookup must not depend on reusable-workflow display names");
  const freezeMatches = steps.filter(({ run }) => run.includes("publication-lock.mjs") && run.includes("create") && run.includes("target/release/publication-lock.json"));
  invariant(freezeMatches.length === 1, "publish must create and verify one exhaustive publication lock");
  const freeze = freezeMatches[0];
  for (const token of ["create", "verify", "--head-ref \"$RELEASE_HEAD_SHA\"", "target/release/publication-lock.json"]) {
    invariant(freeze.run.includes(token), `publication lock freeze must include ${token}`);
  }
  const releaseDryRun = commandStep(workflow, "publish", "release-publish.mjs publish-dry-run");
  const candidateCargoRegistry = commandStep(workflow, "publish", "local-registry-publish.mjs");
  const candidateCargoExamples = commandStep(workflow, "publish", "validate-example-cargo-candidates.mjs");
  assertCargoCandidateGuard(candidateCargoRegistry.step);
  assertCargoCandidateGuard(candidateCargoExamples.step);
  for (const token of [
    "candidate_registry_args=( publish",
    "--surface cargo",
    "--strict",
    "--exact-artifacts",
    '--products-json "$PRODUCTS_JSON"',
    "--registry-root target/release-work/candidate-registries",
    "target/release",
    "target/sdk-artifacts",
    "target/extension-artifacts",
    "target/liboliphaunt/release-assets",
    "target/liboliphaunt/cargo-artifacts",
    "target/oliphaunt-wasix/release-assets",
    "target/oliphaunt-wasix/cargo-artifacts",
    "target/oliphaunt-broker/release-assets",
    "target/oliphaunt-broker/cargo-artifacts",
    "target/oliphaunt-node-direct/release-assets",
    "target/oliphaunt-node-direct/npm-packages",
  ]) {
    invariant(candidateCargoRegistry.run.includes(token), `candidate Cargo registry must consume ${token}`);
  }
  invariant(
    candidateCargoRegistry.step.env?.PRODUCTS_JSON === "${{ steps.release_plan.outputs.products_json }}",
    "candidate Cargo registry must bind exact release-plan products",
  );
  invariant(
    candidateCargoExamples.run.includes("--index target/release-work/candidate-registries/cargo/index")
      && candidateCargoExamples.run.includes("--output-root target/release-work/example-cargo-candidates"),
    "candidate Cargo example validation must consume the exact local index and keep evidence outside the frozen artifact roots",
  );
  invariant(
    !freeze.run.includes("target/release-work"),
    "publication lock artifact roots must exclude candidate Cargo registry and consumer scratch state",
  );
  invariant(
    releaseDryRun.index < candidateCargoRegistry.index
      && candidateCargoRegistry.index < candidateCargoExamples.index
      && candidateCargoExamples.index < freeze.index,
    "candidate Cargo consumers must resolve after all selected dry-runs and before the publication lock is frozen",
  );
  const lockMatch = commandStep(workflow, "publish", "cmp --silent");
  invariant(lockMatch.run.includes("approved-publication-lock") && lockMatch.run.includes("PUBLICATION_LOCK_PATH"), "publish must byte-compare the rebuilt lock with the approved lock");
  const cratesIoVersionCapacity = commandStep(workflow, "publish", "check-crates-io-publish-capacity.mjs");
  assertPublishGuard(cratesIoVersionCapacity.step, "publish");
  invariant(
    cratesIoVersionCapacity.index > lockMatch.index
      && String(cratesIoVersionCapacity.step.if ?? "").includes("needs_cargo == 'true'")
      && cratesIoVersionCapacity.step.env?.CRATES_IO_VERSION_RUN_CAPACITY === "${{ secrets.CRATES_IO_VERSION_RUN_CAPACITY }}"
      && cratesIoVersionCapacity.step.env?.PRODUCTS_JSON === "${{ steps.release_plan.outputs.products_json }}",
    "normal Cargo publication must inventory exact locked versions and consume the protected environment's optional numeric capacity override",
  );
  const versionCapacityConsumers = steps.filter(({ step }) =>
    object(step.env) && Object.hasOwn(step.env, "CRATES_IO_VERSION_RUN_CAPACITY"));
  invariant(
    versionCapacityConsumers.length === 1
      && versionCapacityConsumers[0].index === cratesIoVersionCapacity.index,
    "the optional crates.io version-capacity override must be scoped only to its pre-mutation gate; the official default burst needs no secret",
  );
  const normalTopology = commandStep(workflow, "publish", "normal-publication-plan.mjs");
  assertPublishGuard(normalTopology.step, "publish");
  invariant(
    normalTopology.index > cratesIoVersionCapacity.index
      && normalTopology.run.includes('--lock "$PUBLICATION_LOCK_PATH"')
      && normalTopology.run.includes('--products-json "$PRODUCTS_JSON"')
      && normalTopology.run.includes("target/release/normal-publication-plan.json")
      && normalTopology.step.env?.PRODUCTS_JSON === "${{ steps.release_plan.outputs.products_json }}",
    "normal publication topology evidence must derive from the exact frozen lock and complete selected product closure before mutation",
  );
  assertUpload(workflow, "publish", "oliphaunt-publication-lock");
  const approvedLockUploads = stepCommands(workflow, "publish").filter(({ step, uses }) =>
    uses.startsWith("actions/upload-artifact@") && step.with?.name === "oliphaunt-publication-lock");
  invariant(
    approvedLockUploads.length === 1
      && String(approvedLockUploads[0].step.if ?? "").includes("inputs.operation == 'publish-dry-run'"),
    "the canonical approved publication-lock artifact must be emitted only by publish-dry-run",
  );
  const auditLockUploads = stepCommands(workflow, "publish").filter(({ step, uses }) =>
    uses.startsWith("actions/upload-artifact@") && step.with?.name === "oliphaunt-publication-lock-${{ inputs.operation }}");
  invariant(
    auditLockUploads.length === 1
      && String(auditLockUploads[0].step.if ?? "").includes("inputs.operation != 'publish-dry-run'"),
    "bootstrap and publish must preserve their locks under non-approving audit artifact names",
  );

  invariant(releaseHead.index < preflight.index, "release commit must be resolved before collision preflight");
  const revalidateMain = steps.filter(({ run }) => run.includes("require-current-main.sh") && run.includes("$RELEASE_HEAD_SHA"));
  const publicationRevalidation = revalidateMain.find(({ step }) => step.name === "Revalidate current main before publication");
  const releaseMutationRevalidation = revalidateMain.find(({ step }) => step.name === "Revalidate current main immediately before release mutation");
  invariant(
    revalidateMain.length === 2
      && publicationRevalidation?.index > freeze.index
      && String(publicationRevalidation.step.if ?? "").includes("inputs.operation != 'publish-dry-run'"),
    "bootstrap and publish must revalidate current main after lock freeze",
  );
  invariant(
    releaseMutationRevalidation?.index > publicationRevalidation.index,
    "publish must revalidate current main again immediately before tag and release mutation",
  );
  invariant(
    cratesIoVersionCapacity.index < publicationRevalidation.index
      && cratesIoVersionCapacity.index < releaseMutationRevalidation.index,
    "normal crates.io capacity must fail before current-main mutation revalidation and every release mutation",
  );
  invariant(
    normalTopology.index < publicationRevalidation.index
      && normalTopology.index < releaseMutationRevalidation.index,
    "exact-lock registry topology must fail before current-main mutation revalidation and every release mutation",
  );
  assertPublishGuard(releaseMutationRevalidation.step, "publish");

  const bootstrap = commandStep(workflow, "publish", "bootstrap-registry-identities.mjs");
  assertPublishGuard(bootstrap.step, "publish-bootstrap");
  invariant(
    bootstrap.index > publicationRevalidation.index
      && mutationDeadline.index < bootstrap.index
      && bootstrap.step.env?.CRATES_IO_NEW_CRATE_RUN_CAPACITY === "${{ secrets.CRATES_IO_NEW_CRATE_RUN_CAPACITY }}",
    "bootstrap publication must follow current-main revalidation and consume only the protected environment's numeric crates.io capacity assertion",
  );
  const stage = commandStep(workflow, "publish", "manage-release-drafts.mjs stage");
  assertPublishGuard(stage.step, "publish");
  invariant(
    stage.index === releaseMutationRevalidation.index + 1
      && stage.run.includes('--head-ref "$RELEASE_HEAD_SHA"')
      && stage.run.includes("--state staged"),
    "exact-SHA tag and draft staging must immediately follow final current-main revalidation",
  );
  invariant(
    !steps.some(({ uses }) => uses.startsWith("googleapis/release-please-action@")),
    "publish execution must stage exact-SHA tags and drafts directly, never target moving main through release-please",
  );
  const mutating = steps.filter(({ step, run, uses }) =>
    run.includes("bootstrap-registry-identities.mjs")
    || run.includes("manage-release-drafts.mjs stage")
    || run.includes("release-publish.mjs publish ")
    || run.includes("manage-release-drafts.mjs promote")
    || uses.startsWith("actions/attest-build-provenance@"));
  invariant(
    mutating.length > 0
      && mutating.every(({ index }) =>
        index > preflight.index
        && index > freeze.index
        && index > lockMatch.index),
    "all registry, tag, release, and attestation mutations must follow collision preflight, frozen-lock approval, and current-main revalidation",
  );
  for (const mutation of mutating) {
    if (mutation.run.includes("bootstrap-registry-identities.mjs")) {
      invariant(mutation.index > publicationRevalidation.index, "bootstrap mutation must follow current-main revalidation");
      continue;
    }
    assertPublishGuard(mutation.step, "publish");
    invariant(mutation.index > releaseMutationRevalidation.index, "publish mutation must follow immediate current-main revalidation");
    if (mutation.run.includes("release-publish.mjs publish ")) {
      invariant(mutation.run.includes("--head-ref \"$RELEASE_HEAD_SHA\"") && mutation.run.includes("--publication-lock \"$PUBLICATION_LOCK_PATH\""), "every package publication must consume the exact SHA and frozen lock");
    }
  }

  const staged = commandStep(workflow, "publish", "manage-release-drafts.mjs verify");
  invariant(staged.run.includes("--state staged") && staged.index > stage.index, "exact-SHA tags and releases must verify staged before publication");
  const registryPlan = commandStep(workflow, "publish", "--registry-plan");
  assertPublishGuard(registryPlan.step, "publish");
  invariant(
    registryPlan.run.includes('release-publish.mjs publish')
      && registryPlan.run.includes('--products-json "$PRODUCTS_JSON"')
      && registryPlan.run.includes('--head-ref "$RELEASE_HEAD_SHA"')
      && registryPlan.run.includes('--publication-lock "$PUBLICATION_LOCK_PATH"')
      && registryPlan.step.env?.PRODUCTS_JSON === "${{ steps.release_plan.outputs.products_json }}"
      && registryPlan.step.env?.CARGO_REGISTRY_TOKEN === undefined,
    "normal registry mutation must use one lock-derived executor with in-memory refreshed Cargo credentials",
  );
  invariant(
    !steps.some(({ uses }) => uses.startsWith("rust-lang/crates-io-auth-action@")),
    "normal publication must not rely on one short-lived crates.io token for the full carrier topology",
  );
  const legacyRegistrySteps = steps.filter(({ run }) =>
    run.includes("release-publish.mjs publish")
    && ["--step crates-io", "--step npm", "--step maven-central", "--step jsr"].some((token) => run.includes(token)));
  invariant(legacyRegistrySteps.length === 0, "normal workflow must not retain manually ordered product/ecosystem registry mutations");
  const attestations = steps.filter(({ uses }) => uses.startsWith("actions/attest-build-provenance@"));
  invariant(
    attestations.length > 0 && attestations.every(({ index }) => index < registryPlan.index),
    "all selected GitHub release assets must be attested before the registry topology executes",
  );
  const swiftSourceTag = commandStep(workflow, "publish", "--product oliphaunt-swift --step github-release");
  invariant(swiftSourceTag.index < registryPlan.index, "Swift source-tag publication must remain outside and before the registry executor");
  const releaseVerify = commandStep(workflow, "publish", "release-verify.mjs");
  const registryIntegrity = commandStep(workflow, "publish", "registry-integrity.mjs");
  const consumerVerify = commandStep(workflow, "publish", "release-consumer-shape.mjs --require-ready");
  const lockReverify = steps.find(({ index, run }) => index > releaseVerify.index && run.includes("publication-lock.mjs verify"));
  const promote = commandStep(workflow, "publish", "manage-release-drafts.mjs promote");
  invariant(
    staged.index < registryPlan.index
      && registryPlan.index < releaseVerify.index
      && releaseVerify.index < registryIntegrity.index
      && registryIntegrity.index < consumerVerify.index
      && consumerVerify.index < lockReverify?.index
      && lockReverify.index < promote.index,
    "draft promotion must follow topology publication, version/attestation checks, immutable registry proof, one consumer gate, and final lock verification",
  );
  assertPublishGuard(promote.step, "publish");
  const receiptUpload = stepCommands(workflow, "publish").find(({ step, uses }) =>
    uses.startsWith("actions/upload-artifact@") && String(step.with?.name ?? "").startsWith("registry-integrity-"));
  invariant(
    String(receiptUpload?.step.with?.path ?? "").includes("normal-publication-plan.json")
      && String(receiptUpload?.step.with?.path ?? "").includes("registry-integrity-receipts.json"),
    "registry audit artifact must preserve both the executed topology and immutable byte receipts",
  );
}

export function assertReleaseWorkflow(dispatcher, execution) {
  invariant(execution !== undefined, "release workflow checks require both the dispatcher and shared execution workflow");
  assertReleaseDispatcherWorkflow(dispatcher);
  assertReleaseExecutionWorkflow(execution);
}

export function assertStableWorkflowInvariants(root, { builderJobs = [] } = {}) {
  const ci = parseWorkflow(root, ".github/workflows/ci.yml");
  const mobile = parseWorkflow(root, ".github/workflows/mobile-e2e.yml");
  const release = parseWorkflow(root, ".github/workflows/release.yml");
  const releaseExecution = parseWorkflow(root, ".github/workflows/release-execute.yml");
  assertCiWorkflow(ci, { builderJobs });
  assertReleaseIntentScript(readFileSync(path.join(root, ".github/scripts/check-release-intent.sh"), "utf8"));
  assertMobileWorkflow(mobile);
  assertReleaseWorkflow(release, releaseExecution);
  return { ci, mobile, release, releaseExecution };
}
