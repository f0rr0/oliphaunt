import { readFileSync } from "node:fs";
import path from "node:path";

import { RELEASE_TRANSPORT_STEP_TIMEOUT_MINUTES } from "../../../.github/scripts/release-transport-ref.mjs";

import {
  GITHUB_RELEASE_ATTESTATION_EVIDENCE_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_ATTESTATION_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_DRAFT_STAGE_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_STAGING_VERIFY_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_SWIFTPM_STEP_TIMEOUT_MS,
  GITHUB_RELEASE_TAG_VERIFY_STEP_TIMEOUT_MS,
  MAX_GITHUB_RELEASE_ASSET_HANDOFF_WINDOW_MS,
} from "../../release/github-release-asset-upload-plan.mjs";
import {
  RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS,
  RELEASE_FINALIZATION_RESERVE_SECONDS,
  RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS,
  RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES,
  RELEASE_JOB_CLEANUP_RESERVE_SECONDS,
  RELEASE_JOB_HARD_WINDOW_SECONDS,
  RELEASE_JOB_TIMEOUT_MINUTES,
  RELEASE_MINIMUM_FINALIZATION_SECONDS,
} from "../../release/release-finalization-budget.mjs";
import {
  NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS,
} from "../../release/normal-publication-recovery-contract.mjs";
import {
  RELEASE_CONTINUATION_AUTHORIZATION_UPLOAD_TIMEOUT_MINUTES,
  RELEASE_CONTINUATION_DISPATCH_CHECKOUT_TIMEOUT_MINUTES,
  RELEASE_CONTINUATION_DISPATCH_JOB_MARGIN_MINUTES,
  RELEASE_CONTINUATION_DISPATCH_JOB_TIMEOUT_MINUTES,
  RELEASE_CONTINUATION_DISPATCH_NODE_TIMEOUT_MINUTES,
  RELEASE_CONTINUATION_DISPATCH_RETRY_ENVELOPE_MS,
  RELEASE_CONTINUATION_DISPATCH_STEP_TIMEOUT_MINUTES,
  RELEASE_CONTINUATION_INSPECTION_RETRY_ENVELOPE_MS,
  RELEASE_CONTINUATION_INSPECTION_STEP_TIMEOUT_MINUTES,
  RELEASE_CONTINUATION_PREPARATION_RETRY_ENVELOPE_MS,
  RELEASE_CONTINUATION_PREPARATION_STEP_TIMEOUT_MINUTES,
} from "../../release/release-continuation-read-budget.mjs";
import {
  FINALIZE_JOB_CLEANUP_SECONDS,
  FINALIZE_JOB_HARD_WINDOW_SECONDS,
  FINALIZE_JOB_TIMEOUT_SECONDS,
  FINALIZE_SETUP_HANDOFF_ALLOWANCE_SECONDS,
  GITHUB_STAGE_HANDOFF_ALLOWANCE_SECONDS,
  GITHUB_STAGE_JOB_CLEANUP_SECONDS,
  GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS,
  GITHUB_STAGE_JOB_TIMEOUT_SECONDS,
  REGISTRY_EVIDENCE_HANDOFF_ALLOWANCE_SECONDS,
  REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS,
  REGISTRY_INPUT_VALIDATION_ALLOWANCE_SECONDS,
  REGISTRY_JOB_CLEANUP_SECONDS,
  REGISTRY_JOB_HARD_WINDOW_SECONDS,
  REGISTRY_JOB_TIMEOUT_SECONDS,
  REGISTRY_MUTATION_ALLOWANCE_SECONDS,
  REGISTRY_SETUP_ALLOWANCE_SECONDS,
} from "../../release/release-phase-budget.mjs";
import {
  assertActionStep,
  assertAllCheckouts,
  assertCheckout,
  assertConditionBranches,
  assertConditionRequires,
  assertExactNeeds,
  assertGraph,
  assertMutationBoundary,
  assertNeedsInclude,
  assertPhaseChain,
  assertPermissions,
  assertPinnedActions,
  assertPinnedRunnerLabels,
  assertRunInvocation,
  assertStableIds,
  assertStepOrder,
  assertUploadById,
  executableShell,
  invariant,
  normalized,
  object,
  parseWorkflow,
  sameSet,
  stepById,
  strings,
  workflowNeeds,
  workflowSteps,
} from "./workflow-contract-core.mjs";

export {
  assertPinnedRunnerLabels,
  parseWorkflow,
  workflowNeeds,
  workflowSteps,
};

const CI_REF = "${{ github.event.pull_request.head.sha || github.sha }}";
const MOBILE_REF = "${{ needs.resolve.outputs.sha }}";
const RELEASE_NPM_PUBLISHER_VERSION = "11.18.0";
const RELEASE_NODE_RUNTIME_VERSION = "22.22.3";
const RELEASE_PNPM_VERSION = "11.5.0";
const HAS_RELEASE_CHANGES = "steps.release_plan.outputs.has_release_changes == 'true'";
const PUBLISH_OPERATION = "inputs.operation == 'publish'";
const BOOTSTRAP_REQUIRED = "steps.bootstrap_scope.outputs.required == 'true'";
const COMMAND_BOUNDARY = String.raw`(?:^|[\n;|&()])\s*`;

function commandPattern(command) {
  return new RegExp(`${COMMAND_BOUNDARY}${command}`, "mu");
}

function workflowSecretReferences(value, context) {
  const references = [];
  const visit = (entry) => {
    if (typeof entry === "string") {
      const tokens = [...entry.matchAll(/\bsecrets\b/giu)];
      const literals = [
        ...entry.matchAll(/\bsecrets\s*(?:[.]([A-Z0-9_]+)|\[\s*(["'])([A-Z0-9_]+)\2\s*\])/giu),
      ];
      invariant(
        tokens.length === literals.length,
        `${context} must use only literal dot or bracket secret references`,
      );
      for (const match of literals) references.push((match[1] ?? match[3]).toUpperCase());
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (object(entry)) {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  return references;
}

function activeRun(entry) {
  return executableShell(entry.step.run);
}

function assertActiveTokens(entry, tokens, context) {
  const source = activeRun(entry);
  for (const token of tokens) {
    invariant(source.includes(token), `${context} must actively bind ${token}`);
  }
}

function assertWorkflowFoundation(workflow, label) {
  assertGraph(workflow, label);
  assertPinnedRunnerLabels(workflow, label);
  assertPinnedActions(workflow, label);
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    const steps = job.steps ?? [];
    for (const [index, step] of steps.entries()) {
      invariant(
        (step.run === undefined) !== (step.uses === undefined),
        `${label} ${jobId}.steps[${index}] must declare exactly one of run or uses`,
      );
    }
  }
}

function assertAndroidE2eDiskSafety(workflow, jobId) {
  assertActionStep(
    workflow,
    jobId,
    "setup_android_e2e_node",
    "./.github/actions/setup-node-runtime",
  );
  const reclaim = assertRunInvocation(
    workflow,
    jobId,
    "reclaim_android_emulator_disk",
    commandPattern("node\\s+[.]github/scripts/reclaim-android-mobile-build-disk[.]mjs\\b"),
    "the bounded Android runner disk reclamation",
  );
  invariant(
    normalized(reclaim.step.if) === "",
    `${jobId} Android disk reclamation must run unconditionally`,
  );
  const setup = assertActionStep(
    workflow,
    jobId,
    "setup_android_e2e",
    "./.github/actions/setup-android",
  );
  invariant(
    setup.step.with?.["gradle-cache"] === "false",
    `${jobId} must not restore the build-only Gradle cache in an installed-app E2E job`,
  );
  const start = assertRunInvocation(
    workflow,
    jobId,
    "start_android_emulator",
    commandPattern("tools/dev/start-android-emulator-ci[.]sh\\b"),
    "the disk-bounded Android emulator launcher",
  );
  invariant(
    start.step.env?.OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB === "6144"
      && start.step.env?.OLIPHAUNT_ANDROID_EMULATOR_DISK_HEADROOM_MB === "2048",
    `${jobId} must bind the modern-image 6144 MB emulator floor and 2048 MB free-disk reserve`,
  );
  assertStepOrder(workflow, jobId, [
    "setup_android_e2e_node",
    "reclaim_android_emulator_disk",
    "setup_android_e2e",
    "start_android_emulator",
  ]);
}

function assertReleaseCheckToolchains(workflow) {
  const releaseCheckCallers = [];
  const metadataCheckCallers = [];
  for (const jobId of Object.keys(workflow.jobs)) {
    const steps = workflowSteps(workflow, jobId);
    const releaseChecks = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => commandPattern(
        "(?:tools/dev/bun[.]sh|bun)\\s+tools/release/release-check[.]mjs\\b",
      ).test(executableShell(step.run)));
    const metadataChecks = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => commandPattern(
        "(?:tools/dev/bun[.]sh|bun)\\s+tools/release/release-metadata-check[.]mjs\\b",
      ).test(executableShell(step.run)));
    if (releaseChecks.length > 0) {
      releaseCheckCallers.push(jobId);
      invariant(
        releaseChecks.length === 1,
        `${jobId} must invoke release-check exactly once`,
      );
    }
    if (metadataChecks.length > 0) {
      metadataCheckCallers.push(jobId);
      invariant(
        metadataChecks.length === 1,
        `${jobId} must invoke release-metadata-check exactly once`,
      );
    }
    const gates = [...releaseChecks, ...metadataChecks];
    if (gates.length === 0) continue;

    for (const [action, label] of [
      ["./.github/actions/setup-moon", "Moon"],
      ["./.github/actions/setup-rust", "Rust"],
    ]) {
      const setups = steps
        .map((step, index) => ({ index, step }))
        .filter(({ step }) => step.uses === action);
      invariant(
        setups.length === 1
          && setups[0].step.if === undefined
          && gates.every(({ index }) => setups[0].index < index),
        `${jobId} must set up the pinned ${label} toolchain exactly once and unconditionally before every release metadata gate`,
      );
      if (action === "./.github/actions/setup-moon" && releaseChecks.length > 0) {
        invariant(
          setups[0].step.with?.["install-workspace"] === "true",
          `${jobId} must install the frozen workspace before the full release check`,
        );
      }
    }
  }
  invariant(
    sameSet(releaseCheckCallers, ["prepare-release-pr", "publish-dry-run", "publish"]),
    "full release metadata validation must run in exactly the release PR, dry-run, and publish jobs",
  );
  invariant(
    sameSet(metadataCheckCallers, ["prepare-release-pr"]),
    "derived release metadata revalidation must run in exactly the release PR job",
  );
}

function assertConcurrency(workflow, expected, context) {
  invariant(object(workflow.concurrency), `${context} must declare concurrency`);
  invariant(
    sameSet(Object.keys(workflow.concurrency), ["group", "cancel-in-progress"]),
    `${context} concurrency may declare only GitHub's group and cancel-in-progress keys`,
  );
  invariant(
    workflow.concurrency.group === expected.group,
    `${context} concurrency group must be ${expected.group}`,
  );
  invariant(
    workflow.concurrency["cancel-in-progress"] === expected.cancel,
    `${context} cancel-in-progress must be ${String(expected.cancel)}`,
  );
}

function assertCondition(workflow, jobId, requiredAtoms) {
  assertConditionRequires(workflow.jobs[jobId]?.if, requiredAtoms, jobId);
}

function assertStepCondition(workflow, jobId, stepId, requiredAtoms) {
  const { step } = stepById(workflow, jobId, stepId);
  assertConditionRequires(step.if, requiredAtoms, `${jobId}.${stepId}`);
}

function assertGate(workflow, jobId, stepId, mode, selection) {
  const gate = assertRunInvocation(
    workflow,
    jobId,
    stepId,
    commandPattern(`bun\\s+[.]github/scripts/check-ci-gate[.]mjs\\s+${mode}\\b`),
    `the ${mode} CI gate`,
  );
  invariant(gate.step.env?.NEEDS_JSON === "${{ toJson(needs) }}", `${jobId} gate must bind needs`);
  const key = mode === "required" ? "REQUIRED_JOBS_JSON" : "SELECTED_JOBS_JSON";
  invariant(gate.step.env?.[key] === selection, `${jobId} gate must bind ${selection}`);
  assertCondition(workflow, jobId, ["always()"]);
}

function assertSameRunDownload(workflow, jobId, artifact) {
  const matches = workflowSteps(workflow, jobId).filter((step) =>
    String(step.uses ?? "").startsWith("actions/download-artifact@")
      && step.with?.name === artifact);
  invariant(matches.length === 1, `${jobId} must download exact same-run artifact ${artifact} once`);
  invariant(
    matches[0].with?.["run-id"] === undefined && matches[0].with?.pattern === undefined,
    `${jobId} ${artifact} download must not select another run or a wildcard`,
  );
}

function assertProofEvidence(workflow, {
  jobId,
  proofId,
  evidenceId,
  artifact,
  path: artifactPath,
}) {
  assertStepOrder(workflow, jobId, [proofId, evidenceId]);
  const proof = stepById(workflow, jobId, proofId);
  invariant(proof.step.env?.CI_HEAD_SHA === CI_REF, `${jobId}.${proofId} must bind the exact candidate SHA`);
  const evidence = assertUploadById(workflow, jobId, evidenceId, {
    name: artifact,
    path: artifactPath,
  });
  assertConditionRequires(
    evidence.step.if,
    ["always()", `steps.${proofId}.outcome != 'skipped'`],
    `${jobId}.${evidenceId}`,
  );
}

function assertPlannerConsumer(workflow, jobId, plannerJobId, producers) {
  assertNeedsInclude(workflow, jobId, ["affected", ...producers]);
  assertCondition(workflow, jobId, [
    "always()",
    "!cancelled()",
    "needs.affected.result == 'success'",
    ...producers.map((producer) => `needs.${producer}.result == 'success'`),
    `contains(fromJson(needs.affected.outputs.jobs), '${plannerJobId}')`,
  ]);
}

const HEAVY_CACHE_SAVE_EXPRESSION = "${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.save_heavy_caches) }}";
const PRIMARY_HEAVY_CACHE_WRITER = "liboliphaunt-wasix-runtime";
const PRIMARY_GRADLE_CACHE_WRITER = "kotlin-sdk-package:Set up Android";
const SETUP_ANDROID_GRADLE_CACHE_DEPENDENCY_PATH = `src/sdks/kotlin/**/*.gradle*
src/sdks/kotlin/**/gradle-wrapper.properties
src/sdks/kotlin/**/libs.versions.toml
src/sdks/react-native/examples/expo/package.json
src/sdks/react-native/package.json
pnpm-lock.yaml`;
const SETUP_ANDROID_GRADLE_CACHE_KEY = "setup-java-${{ runner.os }}-${{ runner.arch == 'X64' && 'x64' || runner.arch == 'ARM64' && 'arm64' || runner.arch }}-gradle-${{ hashFiles('src/sdks/kotlin/**/*.gradle*', 'src/sdks/kotlin/**/gradle-wrapper.properties', 'src/sdks/kotlin/**/libs.versions.toml', 'src/sdks/react-native/examples/expo/package.json', 'src/sdks/react-native/package.json', 'pnpm-lock.yaml') }}";

function enqueueLocalActions(queue, steps) {
  for (const step of steps ?? []) {
    const uses = String(step.uses ?? "");
    if (uses.startsWith("./.github/actions/")) queue.push(uses);
  }
}

export function parseReachableLocalActions(root, workflows) {
  const queue = [];
  for (const workflow of Object.values(workflows)) {
    for (const job of Object.values(workflow.jobs ?? {})) {
      enqueueLocalActions(queue, job.steps);
    }
  }
  const actions = {};
  while (queue.length > 0) {
    const uses = queue.shift();
    if (Object.hasOwn(actions, uses)) continue;
    const relative = `${uses.slice(2)}/action.yml`;
    let action;
    try {
      action = Bun.YAML.parse(readFileSync(path.join(root, relative), "utf8"));
    } catch (cause) {
      throw new Error(`workflow policy: cannot parse reachable local action ${relative}: ${cause.message}`);
    }
    invariant(
      object(action) && action.runs?.using === "composite" && Array.isArray(action.runs.steps),
      `${relative} must remain a composite action`,
    );
    actions[uses] = action;
    enqueueLocalActions(queue, action.runs.steps);
  }
  return actions;
}

function cacheInventoryEntries(workflows, actions) {
  const entries = [];
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        entries.push({
          location: `${workflowName}:${jobId}:${step.id ?? step.name ?? "unnamed"}`,
          step,
        });
      }
    }
  }
  for (const [uses, action] of Object.entries(actions)) {
    for (const step of action.runs.steps) {
      entries.push({
        location: `action:${uses}:${step.id ?? step.name ?? "unnamed"}`,
        step,
      });
    }
  }
  return entries;
}

function actionStepByName(actions, uses, name) {
  const matches = (actions[uses]?.runs?.steps ?? []).filter((step) => step.name === name);
  invariant(matches.length === 1, `${uses} must contain exactly one ${name} step`);
  return matches[0];
}

function assertVerifiedArchiveCache(actions, {
  uses,
  restoreName,
  restoreId,
  verifiedName,
  saveName,
  keyPrefix,
}) {
  const steps = actions[uses]?.runs?.steps ?? [];
  const restore = actionStepByName(actions, uses, restoreName);
  const verified = actionStepByName(actions, uses, verifiedName);
  const save = actionStepByName(actions, uses, saveName);
  invariant(
    restore.id === restoreId
      && String(restore.uses ?? "").startsWith("actions/cache/restore@")
      && restore.with?.["restore-keys"] === undefined,
    `${uses} must use one exact-key verified archive restore`,
  );
  invariant(
    String(save.uses ?? "").startsWith("actions/cache/save@")
      && save["continue-on-error"] === true
      && normalized(save.if) === normalized(
        `\${{ env.HEAVY_CACHE_SAVE_IF == 'true' && steps.${restoreId}.outputs.cache-hit != 'true' }}`,
      )
      && save.with?.path === restore.with?.path
      && save.with?.key === restore.with?.key,
    `${uses} verified archive save must be main-gated, miss-only, non-blocking, and match its restore`,
  );
  invariant(
    String(restore.with?.key ?? "").startsWith(`${keyPrefix}-\${{ runner.os }}-\${{ runner.arch }}-`),
    `${uses} verified archive cache must have one exact key per runner OS and architecture`,
  );
  invariant(
    steps.indexOf(restore) < steps.indexOf(verified) && steps.indexOf(verified) < steps.indexOf(save),
    `${uses} must verify its archive payload before cache save`,
  );
}

function assertNoWorkflowHeavyCacheOverride(workflow, label, { allowRoot = false } = {}) {
  invariant(
    allowRoot || !JSON.stringify(workflow).includes("HEAVY_CACHE_SAVE_IF"),
    `${label} must remain restore-only and must not define the CI heavy-cache writer gate`,
  );
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    invariant(
      !Object.hasOwn(job.env ?? {}, "HEAVY_CACHE_SAVE_IF"),
      `${label} job ${jobId} must not override the heavy-cache writer gate`,
    );
    for (const step of job.steps ?? []) {
      invariant(
        !Object.hasOwn(step.env ?? {}, "HEAVY_CACHE_SAVE_IF"),
        `${label} job ${jobId} must not override the heavy-cache writer gate in a step`,
      );
    }
  }
}

export function assertReachableCachePolicy(workflows, actions) {
  const { ci, mobile, release } = workflows;
  assertNoWorkflowHeavyCacheOverride(ci, "CI", { allowRoot: true });
  assertNoWorkflowHeavyCacheOverride(mobile, "Mobile E2E");
  assertNoWorkflowHeavyCacheOverride(release, "Release");

  const entries = cacheInventoryEntries(workflows, actions);
  const monolithic = entries.filter(({ step }) =>
    String(step.uses ?? "").startsWith("actions/cache@"));
  invariant(
    monolithic.length === 0,
    `reachable workflows and local composites must not hide monolithic cache writers; entries=${monolithic.map(({ location }) => location).join(",")}`,
  );

  const restores = entries.filter(({ step }) =>
    String(step.uses ?? "").startsWith("actions/cache/restore@"));
  const expectedRestores = [
    "action:./.github/actions/setup-android:Restore Gradle dependency cache",
    "action:./.github/actions/setup-moon:restore_verified_moon_toolchain",
    "action:./.github/actions/setup-node-pnpm:restore_verified_pnpm_runtime",
    "action:./.github/actions/setup-node-runtime:restore_verified_node_runtime",
    "action:./.github/actions/setup-npm-publisher:restore_verified_npm_publisher",
    "action:./.github/actions/setup-wasmer-llvm:cache",
    "ci:extension-artifacts-native:restore_ios_extension_ccache",
    "ci:liboliphaunt-wasix-runtime:wasix-build-cache",
  ];
  invariant(
    restores.length === expectedRestores.length
      && sameSet(restores.map(({ location }) => location), expectedRestores),
    `reachable explicit cache restore inventory changed; entries=${restores.map(({ location }) => location).join(",")}`,
  );

  const saves = entries.filter(({ step }) =>
    String(step.uses ?? "").startsWith("actions/cache/save@"));
  const expectedSaves = [
    "action:./.github/actions/setup-moon:Save verified tool archives",
    "action:./.github/actions/setup-node-pnpm:Save verified pnpm archive",
    "action:./.github/actions/setup-node-runtime:Save verified Node.js archive",
    "action:./.github/actions/setup-npm-publisher:Save verified npm publisher archive",
    "action:./.github/actions/setup-wasmer-llvm:Save Wasmer LLVM cache",
    "ci:extension-artifacts-native:save_ios_extension_ccache",
    "ci:liboliphaunt-wasix-runtime:save_wasix_build_cache",
  ];
  invariant(
    saves.length === expectedSaves.length
      && sameSet(saves.map(({ location }) => location), expectedSaves),
    `reachable explicit cache writer inventory changed; entries=${saves.map(({ location }) => location).join(",")}`,
  );

  const setupJavaWriters = entries.filter(({ step }) =>
    String(step.uses ?? "").startsWith("actions/setup-java@") && step.with?.cache !== undefined);
  invariant(
    setupJavaWriters.length === 1
      && setupJavaWriters[0].location
        === "action:./.github/actions/setup-android:Set up Java with Gradle cache",
    `reachable setup-java writer inventory changed; entries=${setupJavaWriters.map(({ location }) => location).join(",")}`,
  );

  const rustCacheWriters = entries.filter(({ step }) =>
    String(step.uses ?? "").startsWith("Swatinem/rust-cache@"));
  invariant(
    rustCacheWriters.length === 1
      && rustCacheWriters[0].location
        === "action:./.github/actions/setup-rust-tools:Cache Cargo output",
    `reachable Rust cache writer inventory changed; entries=${rustCacheWriters.map(({ location }) => location).join(",")}`,
  );

  const buildkitWriters = entries.filter(({ step }) =>
    String(step.with?.["cache-to"] ?? "").includes("type=gha"));
  invariant(
    buildkitWriters.length === 1
      && buildkitWriters[0].location
        === "ci:liboliphaunt-wasix-runtime:Build WASIX builder image and save cache",
    `reachable BuildKit cache writer inventory changed; entries=${buildkitWriters.map(({ location }) => location).join(",")}`,
  );

  for (const spec of [
    {
      uses: "./.github/actions/setup-node-runtime",
      restoreName: "Restore verified Node.js archive",
      restoreId: "restore_verified_node_runtime",
      verifiedName: "Install verified Node.js runtime",
      saveName: "Save verified Node.js archive",
      keyPrefix: "verified-node-runtime-v1",
    },
    {
      uses: "./.github/actions/setup-moon",
      restoreName: "Restore verified tool archives",
      restoreId: "restore_verified_moon_toolchain",
      verifiedName: "Verify toolchain",
      saveName: "Save verified tool archives",
      keyPrefix: "verified-moon-toolchain-v1",
    },
    {
      uses: "./.github/actions/setup-node-pnpm",
      restoreName: "Restore verified pnpm archive",
      restoreId: "restore_verified_pnpm_runtime",
      verifiedName: "Install verified pnpm",
      saveName: "Save verified pnpm archive",
      keyPrefix: "verified-pnpm-runtime-v1",
    },
    {
      uses: "./.github/actions/setup-npm-publisher",
      restoreName: "Restore verified npm publisher archive",
      restoreId: "restore_verified_npm_publisher",
      verifiedName: "Install exact npm publisher",
      saveName: "Save verified npm publisher archive",
      keyPrefix: "verified-npm-publisher-v1",
    },
  ]) {
    assertVerifiedArchiveCache(actions, spec);
  }
  invariant(
    !JSON.stringify(actions).includes("pnpm-store-"),
    "reachable composites must not restore or write a pnpm store with no post-install producer",
  );

  const setupRust = actions["./.github/actions/setup-rust"];
  const setupRustTools = actions["./.github/actions/setup-rust-tools"];
  const rustForwarder = actionStepByName(
    actions,
    "./.github/actions/setup-rust",
    "Set up Rust tooling",
  );
  invariant(
    setupRust?.inputs?.["cache-save-if"]?.default === "false"
      && setupRustTools?.inputs?.["cache-save-if"]?.default === "false"
      && rustForwarder.with?.["cache-save-if"] === "${{ inputs.cache-save-if }}"
      && rustCacheWriters[0].step.with?.["save-if"] === "${{ inputs.cache-save-if }}",
    "reachable Rust cache writes must remain false by default and explicitly forwarded",
  );
  invariant(
    actions["./.github/actions/setup-wasmer-llvm"]?.inputs?.["cache-save-if"]?.default
      === "false",
    "reachable Wasmer LLVM cache writes must remain false by default",
  );
}

export function assertSetupAndroidCachePolicy(action) {
  invariant(
    object(action) && action.runs?.using === "composite" && Array.isArray(action.runs.steps),
    "setup-android must remain a composite action",
  );
  const saveInput = action.inputs?.["gradle-cache-save-if"];
  invariant(
    saveInput?.required === false && saveInput.default === "false",
    "setup-android Gradle cache writes must be false by default",
  );
  invariant(
    !Object.hasOwn(action.inputs ?? {}, "gradle-cache-scope-file"),
    "setup-android must not expose an unwritable per-consumer Gradle cache scope",
  );

  const steps = action.runs.steps;
  const validation = steps.filter((step) => step.name === "Validate Android setup capabilities");
  invariant(
    validation.length === 1
      && validation[0].env?.GRADLE_CACHE_SAVE_IF_INPUT === "${{ inputs.gradle-cache-save-if }}"
      && String(validation[0].run ?? "").includes('case "$GRADLE_CACHE_SAVE_IF_INPUT" in true|false)'),
    "setup-android must validate gradle-cache-save-if as a boolean capability",
  );

  const javaSteps = steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/setup-java@"));
  const javaWriters = javaSteps.filter((step) => step.with?.cache !== undefined);
  invariant(
    javaSteps.length === 2
      && javaWriters.length === 1
      && javaWriters[0].name === "Set up Java with Gradle cache"
      && javaWriters[0].with.cache === "gradle"
      && normalized(javaWriters[0].if)
        === normalized("${{ inputs.gradle-cache == 'true' && inputs.gradle-cache-save-if == 'true' }}")
      && String(javaWriters[0].with["cache-dependency-path"] ?? "").trim()
        === SETUP_ANDROID_GRADLE_CACHE_DEPENDENCY_PATH,
    "setup-android must expose exactly one explicitly authorized setup-java Gradle cache writer",
  );
  const javaConsumers = javaSteps.filter((step) => step.with?.cache === undefined);
  invariant(
    javaConsumers.length === 1
      && javaConsumers[0].name === "Set up Java without Gradle cache"
      && normalized(javaConsumers[0].if)
        === normalized("${{ inputs.gradle-cache != 'true' || inputs.gradle-cache-save-if != 'true' }}"),
    "setup-android non-writers must install Java without enabling setup-java cache writes",
  );

  const monolithicCaches = steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/cache@"));
  const cacheSaves = steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/cache/save@"));
  const cacheRestores = steps.filter((step) =>
    String(step.uses ?? "").startsWith("actions/cache/restore@"));
  invariant(
    monolithicCaches.length === 0 && cacheSaves.length === 0,
    "setup-android must not hide implicit or direct cache writers",
  );
  invariant(
    cacheRestores.length === 1
      && cacheRestores[0].name === "Restore Gradle dependency cache"
      && normalized(cacheRestores[0].if)
        === normalized("${{ inputs.gradle-cache == 'true' && inputs.gradle-cache-save-if != 'true' }}")
      && String(cacheRestores[0].with?.path ?? "").trim()
        === "~/.gradle/caches\n~/.gradle/wrapper"
      && cacheRestores[0].with?.key === SETUP_ANDROID_GRADLE_CACHE_KEY,
    "setup-android consumers must use the setup-java-compatible Gradle restore without a native cache restore",
  );
}

function enabledCacheSaveInput(step) {
  const value = step.with?.["cache-save-if"];
  return value !== undefined && value !== false && value !== "false";
}

function assertCiHeavyCacheBudget(workflow) {
  const input = workflow.on.workflow_dispatch?.inputs?.save_heavy_caches;
  invariant(
    input?.type === "boolean" && input.required === true && input.default === false,
    "CI manual heavy-cache writes must be an explicit false-by-default boolean opt-in",
  );
  invariant(
    workflow.env?.HEAVY_CACHE_SAVE_IF === HEAVY_CACHE_SAVE_EXPRESSION,
    "CI heavy-cache writes must be automatic only on main pushes and explicit only on manual main runs",
  );
  invariant(
    !JSON.stringify(workflow).includes("RUST_CACHE_SAVE_IF"),
    "CI must not retain the former broad Rust cache-writer switch",
  );

  const rustWriters = [];
  const llvmWriters = [];
  const directCacheWriters = [];
  const implicitCacheWriters = [];
  const buildkitWriters = [];
  const gradleWriters = [];
  const gradleScopes = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses === "./.github/actions/setup-rust" && enabledCacheSaveInput(step)) {
        rustWriters.push(jobId);
        invariant(
          step.with["cache-save-if"] === "${{ env.HEAVY_CACHE_SAVE_IF }}",
          `${jobId} Rust cache writer must use the bounded heavy-cache policy`,
        );
      }
      if (step.uses === "./.github/actions/setup-wasmer-llvm" && enabledCacheSaveInput(step)) {
        llvmWriters.push(jobId);
        invariant(
          step.with["cache-save-if"] === "${{ env.HEAVY_CACHE_SAVE_IF }}",
          `${jobId} Wasmer LLVM cache writer must use the bounded heavy-cache policy`,
        );
      }
      if (String(step.uses ?? "").startsWith("actions/cache/save@")) {
        const location = `${jobId}:${step.id ?? step.name ?? "unnamed"}`;
        directCacheWriters.push(location);
        invariant(
          normalized(step.if).includes("env.HEAVY_CACHE_SAVE_IF == 'true'"),
          `${jobId} direct heavy-cache save must use the bounded heavy-cache policy`,
        );
        invariant(
          step["continue-on-error"] === true,
          `${jobId} direct heavy-cache save must not fail qualification`,
        );
      }
      if (String(step.uses ?? "").startsWith("actions/cache@")) {
        implicitCacheWriters.push(`${jobId}:${step.id ?? step.name ?? "unnamed"}`);
      }
      if (String(step.with?.["cache-to"] ?? "").includes("type=gha")) {
        buildkitWriters.push(jobId);
        invariant(
          normalized(step.if) === normalized("${{ env.HEAVY_CACHE_SAVE_IF == 'true' }}"),
          `${jobId} BuildKit cache writer must use the bounded heavy-cache policy`,
        );
      }
      if (
        step.uses === "./.github/actions/setup-android"
        && step.with?.["gradle-cache-save-if"] !== undefined
        && step.with["gradle-cache-save-if"] !== false
        && step.with["gradle-cache-save-if"] !== "false"
      ) {
        gradleWriters.push(`${jobId}:${step.name ?? "unnamed"}`);
        invariant(
          step.with["gradle-cache-save-if"] === "${{ env.HEAVY_CACHE_SAVE_IF }}",
          `${jobId} Gradle cache writer must use the bounded heavy-cache policy`,
        );
      }
      if (
        step.uses === "./.github/actions/setup-android"
        && Object.hasOwn(step.with ?? {}, "gradle-cache-scope-file")
      ) {
        gradleScopes.push(`${jobId}:${step.name ?? "unnamed"}`);
      }
    }
  }
  for (const [writers, label] of [
    [rustWriters, "Rust"],
    [llvmWriters, "Wasmer LLVM"],
    [buildkitWriters, "BuildKit"],
  ]) {
    invariant(
      writers.length === 1 && sameSet(writers, [PRIMARY_HEAVY_CACHE_WRITER]),
      `CI ${label} heavy-cache writer inventory must contain only ${PRIMARY_HEAVY_CACHE_WRITER}`,
    );
  }
  invariant(
    sameSet(directCacheWriters, [
      "extension-artifacts-native:save_ios_extension_ccache",
      "liboliphaunt-wasix-runtime:save_wasix_build_cache",
    ]) && directCacheWriters.length === 2,
    `CI direct heavy-cache writer inventory must contain only the WASIX primary and bounded exact-iOS producers; writers=${directCacheWriters.join(",")}`,
  );
  invariant(
    implicitCacheWriters.length === 0,
    `CI source/build caches must use explicit restore/save actions; implicit writers=${implicitCacheWriters.join(",")}`,
  );
  invariant(
    gradleWriters.length === 1 && sameSet(gradleWriters, [PRIMARY_GRADLE_CACHE_WRITER]),
    `CI Gradle heavy-cache writer inventory must contain only ${PRIMARY_GRADLE_CACHE_WRITER}; writers=${gradleWriters.join(",")}`,
  );
  invariant(
    gradleScopes.length === 0,
    `CI Gradle consumers must not select unwritable per-consumer cache scopes; callers=${gradleScopes.join(",")}`,
  );
  invariant(
    workflow.jobs["kotlin-sdk-package"]?.["runs-on"] === "ubuntu-24.04"
      && workflow.jobs["kotlin-sdk-package"]?.strategy?.matrix === undefined,
    "the sole Gradle cache writer must remain one fixed Linux x64 package job",
  );
  invariant(
    workflow.jobs[PRIMARY_HEAVY_CACHE_WRITER]?.["runs-on"] === "ubuntu-24.04",
    "the sole heavy-cache writer must remain the common Linux x64 primary builder",
  );
}

function assertNoNativeRuntimeCrossRunCaches(workflow) {
  for (const jobId of [
    "liboliphaunt-native-desktop",
    "liboliphaunt-native-android",
    "liboliphaunt-native-ios",
  ]) {
    const caches = workflowSteps(workflow, jobId).filter((step) =>
      /^actions\/cache(?:\/restore|\/save)?@/u.test(String(step.uses ?? "")));
    invariant(
      caches.length === 0,
      `${jobId} must not restore cross-run native runtime build trees or compiler caches`,
    );
  }
}

function assertReleaseDoesNotWriteRustCaches(workflow) {
  const writers = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses === "./.github/actions/setup-rust" && enabledCacheSaveInput(step)) {
        writers.push(jobId);
      }
    }
  }
  invariant(
    writers.length === 0,
    `release consumer/finalization jobs must restore but never write Rust caches; writers=${writers.join(",")}`,
  );
}

function assertNativeExtensionBuildBudget(workflow) {
  const job = workflow.jobs["extension-artifacts-native"];
  const builds = workflowSteps(workflow, "extension-artifacts-native")
    .filter((step) => step.name === "Build native exact-extension artifacts");
  invariant(
    job?.["timeout-minutes"] === 135
      && builds.length === 1
      && builds[0]["timeout-minutes"] === 120,
    "native exact-extension builds must retain a 120-minute step bound below a 135-minute job bound",
  );
  invariant(
    builds[0].env?.OLIPHAUNT_EXPECTED_QUALIFICATION_SQL_NAMES
      === "${{ matrix.qualification_sql_names_csv }}",
    "native exact-extension builds must verify the matrix-provided deferred qualification selection",
  );

  const restores = workflowSteps(workflow, "extension-artifacts-native")
    .filter((step) => step.name === "Restore native compiler cache");
  invariant(restores.length === 1, "native exact-extension CI must restore one compiler cache");
  invariant(
    restores[0].id === "restore_ios_extension_ccache"
      && String(restores[0].uses ?? "").startsWith("actions/cache/restore@"),
    "native exact-extension compiler cache must use the stable explicit restore action",
  );
  const key = String(restores[0].with?.key ?? "");
  for (const input of [
    ".github/actions/setup-apple/**",
    ".github/scripts/setup-native-build-tools.sh",
    "src/postgres/versions/18/**",
    "src/sources/third-party/shared/**",
    "src/sources/third-party/native/**",
    "src/shared/extension-runtime-contract/**",
    "src/extensions/catalog/extensions.source.json",
    "src/extensions/contrib/postgres18.toml",
    "src/extensions/external/*/source.toml",
    "src/extensions/external/*/recipe.toml",
    "src/extensions/external/*/deps.toml",
    "src/extensions/external/*/dependencies/**/source.toml",
    "src/extensions/external/*/patches/**",
    "src/extensions/external/*/dependencies/**/patches/**",
    "src/extensions/generated/extensions.catalog.json",
    "src/extensions/generated/extensions.build-plan.json",
    "src/extensions/generated/contrib-build.tsv",
    "src/extensions/generated/pgxs-build.tsv",
    "src/extensions/generated/mobile/static-extensions.tsv",
    "src/extensions/generated/mobile/qualification-static-extensions.tsv",
    "src/extensions/generated/mobile/static-registry.json",
    "src/runtimes/liboliphaunt/native/bin/build-*.sh",
    "!src/runtimes/liboliphaunt/native/bin/*.test.sh",
    "src/runtimes/liboliphaunt/native/patches/**",
    "src/runtimes/liboliphaunt/native/src/**",
  ]) {
    invariant(key.includes(`'${input}'`), `native extension compiler-cache key must hash ${input}`);
  }
  for (const excluded of [
    "'src/extensions/**'",
    "'src/runtimes/liboliphaunt/native/**'",
    ".release-semantic-inputs.json",
    "/CHANGELOG",
    "/VERSION",
    "/release.toml",
    "/targets/",
    "/evidence/",
    "/generated/docs/",
    "'tools/xtask/**'",
  ]) {
    invariant(
      !key.includes(excluded),
      `native extension compiler-cache key must exclude policy/release input ${excluded}`,
    );
  }
  invariant(
    String(restores[0].with?.["restore-keys"] ?? "").trim()
      === "liboliphaunt-native-extension-ccache-v2-${{ matrix.target }}-${{ runner.os }}-${{ runner.arch }}-",
    "native extension compiler cache must preserve its compatible restore prefix",
  );
  invariant(
    job?.env?.OLIPHAUNT_CCACHE_MAX_SIZE === "${{ matrix.target == 'ios-xcframework' && '512M' || '2G' }}",
    "native exact-extension iOS compiler cache must remain bounded to 512M",
  );

  const saves = workflowSteps(workflow, "extension-artifacts-native")
    .filter((step) => step.id === "save_ios_extension_ccache");
  invariant(saves.length === 1, "native exact-extension CI must declare one stable compiler-cache save");
  const save = saves[0];
  invariant(
    String(save.uses ?? "").startsWith("actions/cache/save@")
      && save["continue-on-error"] === true
      && save.with?.path === restores[0].with?.path
      && save.with?.key === restores[0].with?.key,
    "native exact-extension compiler cache save must be non-blocking and exactly match its restore",
  );
  for (const token of [
    "matrix.target == 'ios-xcframework'",
    "env.HEAVY_CACHE_SAVE_IF == 'true'",
    "steps.restore_ios_extension_ccache.outputs.cache-hit != 'true'",
  ]) {
    invariant(
      normalized(save.if).includes(token),
      `native exact-extension compiler cache save must require ${token}`,
    );
  }

  const diagnostics = workflowSteps(workflow, "extension-artifacts-native")
    .filter((step) => step.id === "upload_native_extension_logs");
  invariant(diagnostics.length === 1, "native exact-extension CI must declare one stable diagnostics upload");
  const diagnostic = diagnostics[0];
  invariant(
    normalized(diagnostic.if) === normalized("${{ failure() || cancelled() }}")
      && diagnostic["timeout-minutes"] === 5
      && diagnostic.with?.["if-no-files-found"] === "warn",
    "native exact-extension diagnostics must run after failure or cancellation within a five-minute warn-only envelope",
  );
  const diagnosticPaths = String(diagnostic.with?.path ?? "");
  for (const required of [
    "target/liboliphaunt-mobile-extension-ci/**/*.log",
    "target/liboliphaunt-mobile-extension-release/**/*.log",
    "/tmp/liboliphaunt-release-*-extensions.log",
    "/tmp/liboliphaunt-release-extension-assets-fetch.log",
  ]) {
    invariant(
      diagnosticPaths.includes(required),
      `native exact-extension diagnostics must retain ${required}`,
    );
  }
}

function assertWasixExtensionQualification(workflow) {
  const steps = workflowSteps(workflow, "extension-artifacts-wasix");
  const named = (name) => steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.name === name);
  const downloads = named("Download portable WASIX runtime outputs");
  const verifiers = named("Verify publication-deferred WASIX candidate build outputs");
  const packagers = named("Build WASIX exact-extension artifacts");
  invariant(
    downloads.length === 1 && verifiers.length === 1 && packagers.length === 1,
    "WASIX exact-extension CI must download, qualify deferred candidates, and package public artifacts exactly once",
  );
  invariant(
    downloads[0].index < verifiers[0].index && verifiers[0].index < packagers[0].index,
    "WASIX deferred-candidate qualification must run after the runtime download and before public packaging",
  );
  const command = normalized(verifiers[0].step.run);
  for (const token of [
    "tools/dev/bun.sh tools/release/verify-extension-qualification-build.mjs",
    "--family wasix",
    "--target '${{ matrix.target }}'",
    "--asset-root target/oliphaunt-wasix/assets",
  ]) {
    invariant(
      command.includes(token),
      `WASIX deferred-candidate qualification must invoke ${token}`,
    );
  }
}

export function assertCiWorkflow(workflow, { builderJobs = [] } = {}) {
  assertWorkflowFoundation(workflow, "CI");
  assertCiHeavyCacheBudget(workflow);
  assertNoNativeRuntimeCrossRunCaches(workflow);
  assertNativeExtensionBuildBudget(workflow);
  assertWasixExtensionQualification(workflow);
  invariant(
    workflow.env?.NPM_VERSION === RELEASE_NPM_PUBLISHER_VERSION,
    `CI must pin npm ${RELEASE_NPM_PUBLISHER_VERSION}`,
  );
  invariant(
    sameSet(Object.keys(workflow.on), ["pull_request", "merge_group", "push", "workflow_dispatch"]),
    "CI triggers must cover pull requests, merge queue, main pushes, and manual qualification",
  );
  invariant(
    sameSet(workflow.on.pull_request?.types ?? [], ["opened", "synchronize", "reopened", "closed"]),
    "CI pull_request trigger must cover lifecycle cancellation events",
  );
  invariant(
    sameSet(workflow.on.push?.branches ?? [], ["main"]),
    "CI push qualification must run on main only",
  );
  invariant(!Object.hasOwn(workflow.on.pull_request ?? {}, "paths"), "CI must not path-filter PRs");
  assertConcurrency(workflow, {
    group: "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.number) || format('sha-{0}', github.sha) }}",
    cancel: "${{ github.event_name == 'pull_request' }}",
  }, "CI");
  assertPermissions(workflow.permissions, { contents: "read" }, "CI workflow");
  assertPermissions(
    workflow.jobs["release-intent"].permissions,
    { actions: "read", contents: "read" },
    "CI history-repair intent gate",
  );
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    invariant(
      job.permissions === undefined
        || (object(job.permissions)
          && Object.values(job.permissions).every((access) => access === "read" || access === "none")),
      `CI job ${jobId} must not grant write access`,
    );
  }
  assertAllCheckouts(workflow, CI_REF);
  assertAndroidE2eDiskSafety(workflow, "mobile-e2e-android");

  assertExactNeeds(workflow, "affected", ["release-intent"]);
  assertExactNeeds(workflow, "required", ["affected", "release-intent", "checks", "tests", "builds", "e2e"]);
  assertExactNeeds(workflow, "qualified", ["affected", "required"]);
  assertExactNeeds(workflow, "checks", ["affected", "check-targets", "policy-targets"]);
  assertExactNeeds(workflow, "tests", ["affected", "test-targets"]);
  assertExactNeeds(workflow, "e2e", [
    "affected",
    "mobile-e2e-android",
    "mobile-e2e-ios",
    "native-extension-lifecycle-aggregate",
    "rust-sdk-exact-candidate-consumer",
    "wasix-rust-exact-candidate-consumer",
  ]);
  const buildNeeds = workflowNeeds(workflow, "builds");
  for (const builder of builderJobs) {
    invariant(buildNeeds.has(builder), `builds.needs must include modeled builder ${builder}`);
  }

  const targetMatrices = assertRunInvocation(
    workflow,
    "affected",
    "target-matrices",
    commandPattern("node\\s+[.]github/scripts/write-affected-moon-target-matrices[.]mjs\\s+check\\s+test\\b"),
    "the Node-owned affected Moon target inventory",
  );
  invariant(
    normalized(targetMatrices.step.run)
      === "node .github/scripts/write-affected-moon-target-matrices.mjs check test",
    "affected Moon target inventory must run exactly once under the pinned Node runtime",
  );

  assertGate(
    workflow,
    "checks",
    "selected_checks_gate",
    "selected",
    "${{ needs.affected.outputs.check_jobs }}",
  );
  assertGate(
    workflow,
    "tests",
    "selected_tests_gate",
    "selected",
    "${{ needs.affected.outputs.test_jobs }}",
  );
  assertGate(
    workflow,
    "builds",
    "selected_builds_gate",
    "selected",
    "${{ needs.affected.outputs.builder_jobs }}",
  );
  assertGate(
    workflow,
    "e2e",
    "selected_e2e_gate",
    "selected",
    "${{ needs.affected.outputs.e2e_jobs }}",
  );
  assertGate(
    workflow,
    "required",
    "required_gate",
    "required",
    '["affected","release-intent","checks","tests","builds","e2e"]',
  );
  assertRunInvocation(
    workflow,
    "builds",
    "wasix_regression_gate",
    commandPattern("bun\\s+[.]github/scripts/check-ci-gate[.]mjs\\s+selected\\b"),
    "the selected WASIX regression gate",
  );

  const releaseIntent = assertRunInvocation(
    workflow,
    "release-intent",
    "release_intent",
    commandPattern("[.]github/scripts/check-release-intent[.]sh\\b"),
    "the release-intent behavior contract",
  );
  invariant(
    releaseIntent.step.env?.CI_EVENT_NAME === "${{ github.event_name }}"
      && releaseIntent.step.env?.CI_FULL_REF === "${{ github.ref }}",
    "release intent must receive immutable event and full-ref context",
  );
  const historyRepairNode = assertActionStep(
    workflow,
    "release-intent",
    "setup_history_repair_node",
    "./.github/actions/setup-node-runtime",
  );
  assertConditionRequires(
    historyRepairNode.step.if,
    ["steps.release_intent.outputs.history_repair == 'true'"],
    "release-intent.setup_history_repair_node",
  );
  invariant(
    historyRepairNode.step.with?.["node-version"] === "${{ env.NODE_VERSION }}",
    "history-repair proof must use the pinned CI Node version",
  );
  const historyRepairQualification = assertRunInvocation(
    workflow,
    "release-intent",
    "history_repair_qualification",
    commandPattern("bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b"),
    "the exact history-repair transport qualification selector",
  );
  assertConditionRequires(
    historyRepairQualification.step.if,
    ["steps.release_intent.outputs.history_repair == 'true'"],
    "release-intent.history_repair_qualification",
  );
  invariant(
    historyRepairQualification.step.env?.HISTORY_REPAIR_CANDIDATE_SHA
      === "${{ steps.release_intent.outputs.history_repair_candidate_sha }}"
      && historyRepairQualification.step.env?.GH_REPO === "${{ github.repository }}"
      && historyRepairQualification.step.env?.GH_TOKEN === "${{ github.token }}",
    "history-repair qualification must bind the trailer SHA and read-only repository identity",
  );
  assertActiveTokens(historyRepairQualification, [
    "CI \"$HISTORY_REPAIR_CANDIDATE_SHA\" 0",
    "--event workflow_dispatch",
    "--job Builds",
    "--job Required",
    "--job Qualified",
    "--artifact artifact-build-plan",
    "--artifact oliphaunt-release-candidate",
  ], "history-repair qualification selector");
  const historyRepairDownload = assertRunInvocation(
    workflow,
    "release-intent",
    "history_repair_candidate_download",
    commandPattern("node\\s+[.]github/scripts/download-build-artifacts[.]mjs\\b"),
    "the exact history-repair artifact downloader",
  );
  assertConditionRequires(
    historyRepairDownload.step.if,
    ["steps.release_intent.outputs.history_repair == 'true'"],
    "release-intent.history_repair_candidate_download",
  );
  invariant(
    historyRepairDownload.step.env?.HISTORY_REPAIR_RUN_ID
      === "${{ steps.history_repair_qualification.outputs.run_id }}"
      && historyRepairDownload.step.env?.HISTORY_REPAIR_ARTIFACT_METADATA
        === "${{ steps.history_repair_qualification.outputs.artifact_metadata_json }}",
    "history-repair artifact download must bind the selected run and immutable artifact metadata",
  );
  assertActiveTokens(historyRepairDownload, [
    "--run-id",
    "--artifact-metadata-json",
    "--artifact artifact-build-plan",
    "--artifact oliphaunt-release-candidate",
  ], "history-repair artifact downloader");
  const historyRepairBinding = assertRunInvocation(
    workflow,
    "release-intent",
    "history_repair_candidate_binding",
    commandPattern("node\\s+[.]github/scripts/verify-history-repair-candidate[.]mjs\\b"),
    "the history-repair candidate tree verifier",
  );
  assertConditionRequires(
    historyRepairBinding.step.if,
    ["steps.release_intent.outputs.history_repair == 'true'"],
    "release-intent.history_repair_candidate_binding",
  );
  invariant(
    historyRepairBinding.step.env?.CI_RUN_ID
      === "${{ steps.history_repair_qualification.outputs.run_id }}"
      && historyRepairBinding.step.env?.HISTORY_REPAIR_CANDIDATE_SHA
        === "${{ steps.release_intent.outputs.history_repair_candidate_sha }}"
      && historyRepairBinding.step.env?.HISTORY_REPAIR_HEAD_SHA === "${{ github.sha }}",
    "history-repair tree verification must bind the selected run, trailer SHA, and introduction SHA",
  );
  assertActiveTokens(historyRepairBinding, [
    "target/history-repair-candidate/oliphaunt-release-candidate.json",
    "--plan target/history-repair-candidate/ci-plan.json",
  ], "history-repair candidate tree verifier");
  const generatedReleaseReadiness = assertRunInvocation(
    workflow,
    "release-intent",
    "generated_release_readiness",
    commandPattern("tools/dev/bun[.]sh\\s+tools/release/sync-release-pr[.]mjs\\s+--check-generated-release\\b"),
    "the generated release fixed-point readiness barrier",
  );
  invariant(
    normalized(generatedReleaseReadiness.step.if) === normalized(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.head.ref == 'release-please--branches--main' && github.event.pull_request.head.repo.full_name == github.repository }}",
    ),
    "generated release readiness must run only for the canonical same-repository release PR branch",
  );
  invariant(
    normalized(generatedReleaseReadiness.step.run)
      === "tools/dev/bun.sh tools/release/sync-release-pr.mjs --check-generated-release",
    "generated release readiness must contain only the cheap fixed-point check after the existing structural verifier",
  );
  assertStepOrder(workflow, "release-intent", [
    "release_intent",
    "setup_history_repair_node",
    "history_repair_qualification",
    "history_repair_candidate_download",
    "history_repair_candidate_binding",
    "generated_release_readiness",
  ]);

  for (const [jobId, plannerJobId, producers] of [
    ["mobile-extension-packages", "mobile-extension-packages", ["extension-artifacts-native"]],
    [
      "js-sdk-exact-candidate-consumer",
      "js-sdk-exact-candidate-consumer",
      ["extension-artifacts-native", "js-sdk-package", "liboliphaunt-native-desktop", "liboliphaunt-native-ios", "broker-runtime", "node-direct"],
    ],
    [
      "native-extension-lifecycle",
      "native-extension-lifecycle",
      ["extension-artifacts-native", "liboliphaunt-native-desktop", "broker-runtime", "rust-sdk-package"],
    ],
    ["native-extension-lifecycle-aggregate", "native-extension-lifecycle", ["native-extension-lifecycle"]],
    [
      "rust-sdk-exact-candidate-consumer",
      "rust-sdk-exact-candidate-consumer",
      ["extension-artifacts-native", "liboliphaunt-native-desktop", "broker-runtime", "rust-sdk-package"],
    ],
    [
      "wasix-rust-exact-candidate-consumer",
      "wasix-rust-exact-candidate-consumer",
      ["wasix-rust-package", "liboliphaunt-wasix-release-assets"],
    ],
    [
      "mobile-build-android",
      "mobile-build-android",
      ["mobile-extension-packages", "liboliphaunt-native-android", "kotlin-sdk-package", "react-native-sdk-package"],
    ],
    ["mobile-e2e-android", "mobile-build-android", ["mobile-build-android"]],
  ]) {
    assertPlannerConsumer(workflow, jobId, plannerJobId, producers);
  }

  invariant(
    workflow.jobs.affected.outputs?.extension_package_sql_names
      === "${{ steps.plan.outputs.extension_package_sql_names }}"
      && workflow.jobs.affected.outputs?.native_extension_lifecycle_matrix
        === "${{ steps.plan.outputs.native_extension_lifecycle_matrix }}"
      && workflow.jobs.affected.outputs?.js_exact_candidate_consumer_matrix
        === "${{ steps.plan.outputs.js_exact_candidate_consumer_matrix }}",
    "CI must expose planner-owned extension and exact-candidate matrices",
  );

  for (const artifact of [
    "${{ matrix.native_artifact }}",
    "liboliphaunt-native-icu-data",
    "liboliphaunt-native-release-assets-ios-xcframework",
    "liboliphaunt-native-extension-artifacts-ios-xcframework",
    "${{ matrix.broker_artifact }}",
    "${{ matrix.node_artifact }}",
    "${{ matrix.extension_artifact }}",
    "oliphaunt-js-sdk-package-artifacts",
  ]) assertSameRunDownload(workflow, "js-sdk-exact-candidate-consumer", artifact);
  const iosBaseDownload = workflowSteps(workflow, "js-sdk-exact-candidate-consumer")
    .find((step) => step.with?.name === "liboliphaunt-native-release-assets-ios-xcframework");
  invariant(
    iosBaseDownload?.with?.path === "target/js-exact-candidate-input/ios",
    "JavaScript exact-candidate Apple carrier must use its own immutable input root",
  );
  const jsExactCandidate = assertRunInvocation(
    workflow,
    "js-sdk-exact-candidate-consumer",
    "js_exact_candidate_consumer",
    commandPattern("bun\\s+tools/release/js-exact-candidate-consumer[.]mjs\\b"),
    "the exact TypeScript candidate consumer",
  );
  const jsExactCandidateJob = workflow.jobs["js-sdk-exact-candidate-consumer"];
  invariant(
    jsExactCandidateJob["timeout-minutes"] === 90
      && jsExactCandidate.step["timeout-minutes"] === 70
      && jsExactCandidate.step["timeout-minutes"] < jsExactCandidateJob["timeout-minutes"],
    "the exact TypeScript candidate consumer must have a 70-minute step bound below its 90-minute job bound",
  );
  invariant(
    String(jsExactCandidate.step.run).includes(
      "--artifact-root target/js-exact-candidate-input/ios",
    ),
    "JavaScript exact-candidate consumer must hash the Apple carrier as an explicit input root",
  );
  assertProofEvidence(workflow, {
    jobId: "js-sdk-exact-candidate-consumer",
    proofId: "js_exact_candidate_consumer",
    evidenceId: "js_exact_candidate_evidence",
    artifact: "oliphaunt-js-exact-candidate-consumer-${{ matrix.target }}",
    path: "target/js-exact-candidate-consumer/${{ matrix.target }}/evidence",
  });
  assertProofEvidence(workflow, {
    jobId: "swift-sdk-package",
    proofId: "swift_exact_candidate_consumer",
    evidenceId: "swift_exact_candidate_evidence",
    artifact: "oliphaunt-swift-exact-candidate-consumer-evidence",
    path: "target/exact-candidate-consumer/swift",
  });
  assertProofEvidence(workflow, {
    jobId: "rust-sdk-exact-candidate-consumer",
    proofId: "rust_exact_candidate_consumer",
    evidenceId: "rust_exact_candidate_evidence",
    artifact: "oliphaunt-rust-exact-candidate-consumer-evidence",
    path: "target/exact-candidate-consumer/rust/evidence",
  });
  for (const artifact of [
    "oliphaunt-wasix-rust-package-artifacts",
    "liboliphaunt-wasix-release-assets",
  ]) assertSameRunDownload(workflow, "wasix-rust-exact-candidate-consumer", artifact);
  assertRunInvocation(
    workflow,
    "wasix-rust-exact-candidate-consumer",
    "wasix_rust_exact_candidate_consumer",
    commandPattern("tools/dev/bun[.]sh\\s+tools/release/wasix-rust-exact-candidate-consumer[.]mjs\\b"),
    "the exact WASIX Rust candidate consumer",
  );
  const wasixRustReceipt = assertRunInvocation(
    workflow,
    "wasix-rust-exact-candidate-consumer",
    "wasix_rust_exact_candidate_receipt",
    commandPattern("tools/dev/bun[.]sh\\s+tools/release/write-sdk-exact-candidate-receipt[.]mjs\\b"),
    "the exact WASIX Rust candidate receipt writer",
  );
  assertActiveTokens(
    wasixRustReceipt,
    ["--sdk wasix-rust", "--proof-outcome", "--workflow-sha"],
    "WASIX Rust exact-candidate receipt",
  );
  assertConditionRequires(
    wasixRustReceipt.step.if,
    ["always()", "steps.wasix_rust_exact_candidate_consumer.outcome != 'skipped'"],
    "wasix-rust-exact-candidate-consumer.wasix_rust_exact_candidate_receipt",
  );
  assertStepOrder(workflow, "wasix-rust-exact-candidate-consumer", [
    "wasix_rust_exact_candidate_consumer",
    "wasix_rust_exact_candidate_receipt",
    "wasix_rust_exact_candidate_evidence",
  ]);
  assertProofEvidence(workflow, {
    jobId: "wasix-rust-exact-candidate-consumer",
    proofId: "wasix_rust_exact_candidate_consumer",
    evidenceId: "wasix_rust_exact_candidate_evidence",
    artifact: "oliphaunt-wasix-rust-exact-candidate-consumer-evidence",
    path: "target/exact-candidate-consumer/wasix-rust/evidence",
  });
  assertProofEvidence(workflow, {
    jobId: "native-extension-lifecycle",
    proofId: "native_extension_lifecycle",
    evidenceId: "native_extension_lifecycle_evidence",
    artifact: "native-extension-lifecycle-evidence-${{ matrix.shard }}",
    path: "target/native-extension-lifecycle/evidence",
  });
  assertProofEvidence(workflow, {
    jobId: "native-extension-lifecycle-aggregate",
    proofId: "native_extension_lifecycle_aggregate",
    evidenceId: "native_extension_lifecycle_aggregate_evidence",
    artifact: "native-extension-lifecycle-evidence",
    path: "target/native-extension-lifecycle/aggregate",
  });

  assertStepOrder(workflow, "qualified", ["require_full_ci", "qualification_record", "qualification_evidence"]);
  assertConditionBranches(workflow.jobs.qualified.if, [
    ["always()", "github.event_name == 'push'", "github.ref == 'refs/heads/main'"],
    ["always()", "github.event_name == 'workflow_dispatch'"],
  ], "qualified");
  const candidate = assertRunInvocation(
    workflow,
    "qualified",
    "qualification_record",
    commandPattern("node\\s+[.]github/scripts/write-release-candidate[.]mjs\\b"),
    "the exact-SHA qualification record writer",
  );
  invariant(
    candidate.step.env?.CI_HEAD_SHA === CI_REF
      && candidate.step.env?.CI_PLAN_PATH === "target/qualification/affected-plan/ci-plan.json"
      && candidate.step.env?.WASIX_RELEASE_REGRESSION_REQUIRED
        === "${{ needs.affected.outputs.wasix_release_regression_required }}",
    "qualification record must bind the candidate SHA, plan, and selected WASIX requirement",
  );
  assertUploadById(workflow, "qualified", "qualification_evidence", {
    name: "oliphaunt-release-candidate",
    path: "target/qualification/oliphaunt-release-candidate.json",
  });
}

export function assertMobileWorkflow(workflow) {
  assertWorkflowFoundation(workflow, "mobile E2E");
  invariant(
    sameSet(Object.keys(workflow.on), ["workflow_call", "workflow_dispatch"]),
    "mobile E2E must be reusable or manually dispatched only",
  );
  assertConcurrency(workflow, {
    group: "mobile-e2e-${{ inputs.sha || github.sha }}-${{ inputs.platform || 'all' }}",
    cancel: false,
  }, "mobile E2E");
  assertPermissions(workflow.permissions, { actions: "read", contents: "read" }, "mobile E2E");
  assertAndroidE2eDiskSafety(workflow, "android");
  assertExactNeeds(workflow, "android", ["resolve"]);
  assertExactNeeds(workflow, "ios", ["resolve"]);
  assertExactNeeds(workflow, "required", ["resolve", "android", "ios"]);

  const resolveCheckout = workflowSteps(workflow, "resolve")
    .find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
  assertCheckout(resolveCheckout, "${{ inputs.sha || github.sha }}", "mobile resolve");
  for (const jobId of ["android", "ios"]) {
    const checkout = workflowSteps(workflow, jobId)
      .find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    assertCheckout(checkout, MOBILE_REF, `mobile ${jobId}`);
  }

  assertStepOrder(workflow, "android", ["download_android_app", "android_app_e2e"]);
  assertStepOrder(workflow, "ios", ["download_ios_app", "verify_ios_app_transport", "ios_app_e2e"]);
  assertStepOrder(workflow, "required", ["resolver_gate", "selected_platforms_gate"]);
  const androidDownload = assertRunInvocation(
    workflow,
    "android",
    "download_android_app",
    commandPattern("node\\s+[.]github/scripts/download-build-artifacts[.]mjs\\b"),
    "the exact-run artifact downloader",
  );
  const iosDownload = assertRunInvocation(
    workflow,
    "ios",
    "download_ios_app",
    commandPattern("node\\s+[.]github/scripts/download-build-artifacts[.]mjs\\b"),
    "the exact-run artifact downloader",
  );
  for (const [entry, artifact] of [
    [androidDownload, "react-native-mobile-android-app-android-x86_64"],
    [iosDownload, "react-native-mobile-ios-app"],
  ]) {
    invariant(
      entry.step.env?.CI_HEAD_SHA === MOBILE_REF
        && entry.step.env?.CI_RUN_ID === "${{ needs.resolve.outputs.run_id }}",
      "mobile artifact downloads must bind the resolved exact SHA and run",
    );
    assertActiveTokens(entry, ["--run-id", "--job Builds", `--artifact ${artifact}`], "mobile download");
  }
  assertRunInvocation(
    workflow,
    "ios",
    "verify_ios_app_transport",
    commandPattern("node\\s+src/sdks/react-native/tools/ios-app-transport[.]mjs\\s+verify-extract\\b"),
    "the iOS fidelity transport verifier",
  );
  assertRunInvocation(
    workflow,
    "android",
    "android_app_e2e",
    commandPattern("bash\\s+src/sdks/react-native/tools/mobile-e2e[.]sh\\s+android\\b"),
    "the Android installed-app proof",
  );
  assertRunInvocation(
    workflow,
    "ios",
    "ios_app_e2e",
    commandPattern("bash\\s+src/sdks/react-native/tools/mobile-e2e[.]sh\\s+ios\\b"),
    "the iOS installed-app proof",
  );
  assertGate(workflow, "required", "resolver_gate", "required", '["resolve"]');
  assertGate(
    workflow,
    "required",
    "selected_platforms_gate",
    "selected",
    "${{ needs.resolve.outputs.platform_jobs }}",
  );
  invariant(
    workflow.jobs.resolve.outputs?.platform_jobs === "${{ steps.plan.outputs.platform_jobs }}",
    "mobile resolver must expose its exact selected platform jobs",
  );
}

export function assertReleaseEntryWorkflow(workflow) {
  assertWorkflowFoundation(workflow, "Release entry");
  assertReleaseDoesNotWriteRustCaches(workflow);
  invariant(
    sameSet(Object.keys(workflow.on), ["workflow_dispatch"]),
    "Release entry must be manual only",
  );
  const operations = workflow.on.workflow_dispatch?.inputs?.operation?.options ?? [];
  invariant(
    sameSet(operations, ["prepare-release-pr", "publish-dry-run", "publish", "publish-bootstrap"]),
    "Release entry must expose only supported state transitions",
  );
  assertConcurrency(workflow, {
    group: "release-${{ inputs.operation == 'publish-dry-run' && github.sha || 'mutation' }}",
    cancel: false,
  }, "Release entry");
  // GitHub concurrency retains at most one running and one pending run for a
  // group. The non-cancelling mutation group serializes those two runs, but it
  // cannot be treated as an unbounded release queue.
  assertPermissions(workflow.permissions, { contents: "read" }, "Release entry workflow");
  const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
  invariant(
    sameSet(Object.keys(inputs), ["operation", "release_commit", "continuation_pointer"])
      && inputs.operation?.required === true
      && inputs.release_commit?.required === false
      && inputs.release_commit?.type === "string"
      && inputs.continuation_pointer?.required === false
      && inputs.continuation_pointer?.type === "string",
    "Release entry inputs must be operation plus optional exact commit and canonical continuation pointer",
  );

  const operationJobIds = [
    "prepare-release-pr",
    "publish-dry-run",
    "publish",
    "publish-registry",
    "publish-finalize",
    "publish-bootstrap",
  ];
  const dispatchers = {
    "dispatch-bootstrap-continuation": {
      operation: "publish-bootstrap",
      parent: "publish-bootstrap",
    },
    "dispatch-publish-continuation": {
      operation: "publish",
      parent: "publish-registry",
    },
  };
  invariant(
    sameSet(Object.keys(workflow.jobs), ["validate-inputs", ...operationJobIds, ...Object.keys(dispatchers)]),
    "Release workflow must have one unconditional input validator, direct operation jobs, and isolated continuation dispatchers",
  );
  const inputValidation = assertRunInvocation(
    workflow,
    "validate-inputs",
    "validate_release_inputs",
    commandPattern("bash\\s+[.]github/scripts/validate-release-workflow-inputs[.]sh\\b"),
    "the unconditional release-input validator",
  );
  invariant(
    workflow.jobs["validate-inputs"]["runs-on"] === "ubuntu-24.04"
      && workflow.jobs["validate-inputs"]["timeout-minutes"] === 5
      && inputValidation.step.env?.RELEASE_OPERATION === "${{ inputs.operation }}"
      && inputValidation.step.env?.RELEASE_COMMIT === "${{ inputs.release_commit }}"
      && inputValidation.step.env?.RELEASE_CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && normalized(inputValidation.step.if) === "",
    "the release workflow must validate every caller-controlled input unconditionally and inside a bounded read-only job",
  );
  assertPermissions(
    workflow.jobs["validate-inputs"].permissions,
    { contents: "read" },
    "Release input validation",
  );
  assertSingleCheckout(workflow, "validate-inputs", "${{ github.sha }}");
  invariant(
    workflow.jobs["validate-inputs"].environment === undefined
      && workflow.jobs["validate-inputs"].secrets === undefined
      && workflowSecretReferences(workflow.jobs["validate-inputs"], "validate-inputs").length === 0,
    "release input validation must not receive an environment or secrets",
  );
  for (const jobId of operationJobIds) {
    const job = workflow.jobs[jobId];
    invariant(
      job.uses === undefined && Array.isArray(job.steps) && job.steps.length > 0,
      `${jobId} must be implemented directly in the protected release workflow`,
    );
  }
  for (const [jobId, { operation, parent }] of Object.entries(dispatchers)) {
    const job = workflow.jobs[jobId];
    assertExactNeeds(workflow, jobId, [parent]);
    invariant(
      normalized(job.if) === `\${{ needs.${parent}.outputs.continuation_required == 'true' }}`,
      `${jobId} must run only for a verified deferred parent result`,
    );
    invariant(
      job.environment === undefined
        && job.secrets === undefined
        && workflowSecretReferences(job, jobId).length === 0,
      `${jobId} must not receive an environment or registry secrets`,
    );
    assertPermissions(job.permissions, { actions: "write", contents: "read" }, `Release entry ${jobId}`);
    invariant(
      job["timeout-minutes"] === RELEASE_CONTINUATION_DISPATCH_JOB_TIMEOUT_MINUTES,
      `${jobId} must bound validation, delayed dispatch, authorization upload, and cleanup`,
    );
    const checkout = workflowSteps(workflow, jobId)
      .find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    invariant(
      checkout?.["timeout-minutes"] === RELEASE_CONTINUATION_DISPATCH_CHECKOUT_TIMEOUT_MINUTES,
      `${jobId} must bound its exact release-transport checkout`,
    );
    const node = assertActionStep(
      workflow,
      jobId,
      "setup_dispatch_node",
      "./.github/actions/setup-node-runtime",
    );
    invariant(
      node.step["timeout-minutes"] === RELEASE_CONTINUATION_DISPATCH_NODE_TIMEOUT_MINUTES
        && node.step.with?.["node-version"] === "${{ env.NODE_VERSION }}"
        && normalized(node.step.if) === "",
      `${jobId} must install its unconditional digest-verified pinned Node runtime inside three minutes`,
    );
    const dispatch = assertRunInvocation(
      workflow,
      jobId,
      "dispatch_continuation",
      commandPattern("node\\s+[.]github/scripts/dispatch-release-continuation[.]mjs\\b"),
      "the exact continuation dispatcher",
    );
    invariant(
      dispatch.step["timeout-minutes"] === RELEASE_CONTINUATION_DISPATCH_STEP_TIMEOUT_MINUTES
        && dispatch.step["timeout-minutes"] * 60_000
          >= RELEASE_CONTINUATION_DISPATCH_RETRY_ENVELOPE_MS
        && sameSet(Object.keys(dispatch.step.env ?? {}), [
          "CONTINUATION_ARTIFACT_DIGEST",
          "CONTINUATION_ARTIFACT_ID",
          "CONTINUATION_AUTHORIZATION_PATH",
          "CONTINUATION_CONTRACT_DIGEST",
          "GH_REPO",
          "GH_TOKEN",
          "RELEASE_HEAD_SHA",
          "RELEASE_OPERATION",
        ])
        && dispatch.step.env?.CONTINUATION_AUTHORIZATION_PATH
          === "${{ runner.temp }}/release-continuation-authorization.json"
        && dispatch.step.env?.CONTINUATION_ARTIFACT_ID
          === `\${{ needs.${parent}.outputs.continuation_artifact_id }}`
        && dispatch.step.env?.CONTINUATION_ARTIFACT_DIGEST
          === `\${{ needs.${parent}.outputs.continuation_artifact_digest }}`
        && dispatch.step.env?.CONTINUATION_CONTRACT_DIGEST
          === `\${{ needs.${parent}.outputs.continuation_contract_digest }}`
        && dispatch.step.env?.GH_REPO === "${{ github.repository }}"
        && dispatch.step.env?.GH_TOKEN === "${{ github.token }}"
        && dispatch.step.env?.RELEASE_HEAD_SHA === "${{ github.sha }}"
        && dispatch.step.env?.RELEASE_OPERATION === operation,
      `${jobId} must reserve a bounded exact dispatched-child authorization receipt`,
    );
    const authorization = assertUploadById(
      workflow,
      jobId,
      "preserve_continuation_authorization",
      {
        name: "${{ steps.dispatch_continuation.outputs.authorization_artifact_name }}",
        path: "${{ runner.temp }}/release-continuation-authorization.json",
      },
    );
    invariant(
      dispatch.index < authorization.index
        && authorization.step.if === undefined
        && authorization.step["timeout-minutes"]
          === RELEASE_CONTINUATION_AUTHORIZATION_UPLOAD_TIMEOUT_MINUTES
        && authorization.step.with?.["compression-level"] === 0
        && authorization.step.with?.["retention-days"] === 90,
      `${jobId} must upload the exact returned child-run authorization before it can succeed`,
    );
    invariant(
      job["timeout-minutes"] >= checkout["timeout-minutes"]
        + node.step["timeout-minutes"]
        + dispatch.step["timeout-minutes"]
        + authorization.step["timeout-minutes"]
        + RELEASE_CONTINUATION_DISPATCH_JOB_MARGIN_MINUTES,
      `${jobId} must retain its exact checkout, setup, dispatch, upload, and cleanup margin`,
    );
  }
  invariant(
    workflow.env?.NODE_VERSION === RELEASE_NODE_RUNTIME_VERSION,
    `release entry must pin Node ${RELEASE_NODE_RUNTIME_VERSION}`,
  );
  assertPinnedNodeCommandRuntimes(workflow, "Release entry");
}

const GITHUB_STAGE_PHASES = [
  "github_stage_job_deadline",
  "release_head",
  "setup_github_stage_node",
  "release_plan",
  "registry_needs",
  "verify_oidc_identity",
  "verify_maven_signing",
  "ci_qualification",
  "verify_qualification",
  "approved_publication_lock",
  "setup_github_stage_npm",
  "freeze_publication_lock",
  "preflight_maven_bundle",
  "preflight_swift_source_tag",
  "github_request_budget",
  "audit_registry_input_transfer",
  "github_stage_phase_budget",
  "bootstrap_ledger_state",
  "freeze_bootstrap_capsule",
  "preserve_publication_lock",
  "preserve_bootstrap_capsule",
  "ensure_release_transport_ref",
  "stage_github_releases",
  "verify_product_tags",
  "verify_github_staging",
  "publish_github_assets",
  "extension_attestation_subjects",
  "attest_extensions_1",
  "attest_extensions_2",
  "attest_liboliphaunt_native",
  "publish_swift_source_tag",
  "attest_broker",
  "attest_node_direct",
  "attest_wasix",
  "freeze_github_evidence",
  "seal_github_stage_handoff",
  "preserve_github_stage_handoff",
  "preserve_failed_github_stage_evidence",
];

const REGISTRY_PHASES = [
  "registry_job_deadline",
  "registry_release_head",
  "setup_registry_node",
  "registry_phase_budget",
  "download_approved_publication_inputs",
  "download_github_stage_handoff",
  "install_github_stage_handoff",
  "registry_publish_needs",
  "install_registry_jsr_tooling",
  "setup_registry_npm",
  "verify_registry_oidc_identity",
  "verify_registry_maven_signing",
  "verify_registry_github_staging",
  "restore_normal_publication_checkpoint",
  "registry_capacity_deadline",
  "reprove_registry_capacity",
  "registry_mutation_deadline",
  "record_registry_capacity_deferral",
  "exact_registry_publish",
  "require_registry_execution_decision",
  "preserve_failed_registry_recovery",
  "preserve_complete_registry_recovery",
  "seal_registry_handoff",
  "preserve_publication_receipts",
];

const FINALIZE_PHASES = [
  "finalize_job_deadline",
  "finalize_release_head",
  "setup_finalize_node",
  "finalize_phase_budget",
  "download_registry_handoff",
  "install_registry_handoff",
  "setup_finalize_npm",
  "verify_final_github_staging",
  "enter_finalization",
  "verify_published_release",
  "public_consumer_smoke",
  "preserve_consumer_evidence",
  "reverify_publication_lock",
  "preserve_pre_promotion_evidence",
  "promote_github_releases",
];

const BOOTSTRAP_PHASES = [
  "bootstrap_job_deadline",
  "release_head",
  "setup_bootstrap_node",
  "release_plan",
  "registry_needs",
  "bootstrap_scope",
  "verify_bootstrap_oidc_identity",
  "ci_qualification",
  "verify_bootstrap_qualification",
  "inspect_bootstrap_continuation",
  "approved_bootstrap_capsule",
  "verify_bootstrap_capsule",
  "verify_bootstrap_lock",
  "restore_bootstrap_checkpoint",
  "ensure_bootstrap_transport_ref",
  "bootstrap_mutation_deadline",
  "bootstrap_registry_identities",
  "require_bootstrap_execution_decision",
  "prepare_bootstrap_continuation",
  "remove_bootstrap_credentials",
  "preserve_deferred_bootstrap_ledger",
  "preserve_bootstrap_ledger",
];

function assertNormalStageConditions(workflow) {
  for (const jobId of ["publish-dry-run", "publish"]) {
    assertStepCondition(workflow, jobId, "github_stage_job_deadline", [PUBLISH_OPERATION]);
    for (const id of [
      "verify_oidc_identity",
      "verify_maven_signing",
      "approved_publication_lock",
      "preflight_maven_bundle",
      "preflight_swift_source_tag",
      "github_request_budget",
      "ensure_release_transport_ref",
      "stage_github_releases",
      "verify_product_tags",
      "verify_github_staging",
      "publish_github_assets",
      "freeze_github_evidence",
      "seal_github_stage_handoff",
      "preserve_github_stage_handoff",
    ]) assertStepCondition(workflow, jobId, id, [HAS_RELEASE_CHANGES, PUBLISH_OPERATION]);
    for (const id of [
      "attest_extensions_1",
      "attest_extensions_2",
      "attest_liboliphaunt_native",
      "attest_broker",
      "attest_node_direct",
      "attest_wasix",
      "publish_swift_source_tag",
    ]) assertStepCondition(workflow, jobId, id, [HAS_RELEASE_CHANGES, PUBLISH_OPERATION]);
  }

  const dryRunRequired = [HAS_RELEASE_CHANGES, "inputs.operation == 'publish-dry-run'"];
  for (const jobId of ["publish-dry-run", "publish"]) {
    for (const id of [
      "freeze_bootstrap_capsule",
      "preserve_publication_lock",
      "preserve_bootstrap_capsule",
    ]) assertStepCondition(workflow, jobId, id, dryRunRequired);
  }
}

function assertCriticalReleaseCommands(workflow) {
  const commands = [
    ["publish", "release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the exact release-head resolver"],
    ["publish", "verify_oidc_identity", "bun\\s+[.]github/scripts/verify-github-oidc-identity[.]mjs\\b", "the direct-workflow OIDC verifier"],
    ["publish", "verify_maven_signing", "tools/dev/bun[.]sh\\s+tools/release/verify-maven-signing-readiness[.]mjs\\b", "the pre-mutation Maven signing verifier"],
    ["publish", "ci_qualification", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the exact-SHA CI selector"],
    ["publish", "verify_qualification", "node\\s+[.]github/scripts/verify-release-candidate[.]mjs\\b", "the candidate verifier"],
    ["publish", "approved_publication_lock", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the approved-lock selector"],
    ["publish", "preflight_maven_bundle", "tools/dev/bun[.]sh\\s+tools/release/preflight-maven-central-bundle[.]mjs\\b", "the exact pre-mutation Maven Central bundle preflight"],
    ["publish", "preflight_swift_source_tag", "tools/dev/bun[.]sh\\s+tools/release/preflight-swiftpm-source-tag[.]mjs\\b", "the exact pre-mutation SwiftPM source-tag preflight"],
    ["publish-dry-run", "freeze_bootstrap_capsule", "tools/dev/bun[.]sh\\s+tools/release/bootstrap-publication-capsule[.]mjs\\s+pack\\b", "the dry-run bootstrap capsule freezer"],
    ["publish", "github_request_budget", "tools/dev/bun[.]sh\\s+tools/release/github-release-request-budget[.]mjs\\b", "the request-budget admission"],
    ["publish", "github_stage_phase_budget", "tools/dev/bun[.]sh\\s+tools/release/release-phase-budget[.]mjs\\b", "the staging phase budget proof"],
    ["publish", "ensure_release_transport_ref", "node\\s+[.]github/scripts/release-transport-ref[.]mjs\\s+ensure\\b", "the immutable exact-SHA continuation transport"],
    ["publish", "stage_github_releases", "bun\\s+[.]github/scripts/manage-release-drafts[.]mjs\\s+stage\\b", "draft staging"],
    ["publish", "verify_product_tags", "tools/dev/bun[.]sh\\s+tools/release/verify_product_tags[.]mjs\\b", "exact tag verification"],
    ["publish", "verify_github_staging", "bun\\s+[.]github/scripts/manage-release-drafts[.]mjs\\s+verify\\b", "draft verification"],
    ["publish", "publish_github_assets", "tools/dev/bun[.]sh\\s+tools/release/release-publish[.]mjs\\s+publish\\b", "GitHub asset publication"],
    ["publish", "publish_swift_source_tag", "tools/dev/bun[.]sh\\s+tools/release/release-publish[.]mjs\\s+publish\\b", "Swift source-tag publication"],
    ["publish", "freeze_github_evidence", "tools/dev/bun[.]sh\\s+tools/release/verify_github_release_attestations[.]mjs\\s+pre-mutation\\b", "attestation evidence freezing"],
    ["publish", "seal_github_stage_handoff", "tools/dev/bun[.]sh\\s+tools/release/release-phase-handoff[.]mjs\\s+seal\\b", "the immutable staging handoff sealer"],
    ["publish-registry", "registry_release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the registry release-head resolver"],
    ["publish-registry", "inspect_registry_continuation", "node\\s+[.]github/scripts/inspect-release-continuation[.]mjs\\b", "the exact normal-publication parent continuation inspector"],
    ["publish-registry", "registry_phase_budget", "node\\s+tools/release/release-phase-budget[.]mjs\\b", "the registry phase budget proof"],
    ["publish-registry", "download_approved_publication_inputs", "node\\s+[.]github/scripts/download-build-artifacts[.]mjs\\b", "the approved dry-run input downloader"],
    ["publish-registry", "install_github_stage_handoff", "tools/dev/bun[.]sh\\s+tools/release/release-phase-handoff[.]mjs\\s+install\\b", "the validated staging handoff installer"],
    ["publish-registry", "install_github_stage_handoff", "node\\s+[.]github/scripts/install-release-continuation-github-state[.]mjs\\b", "the continuation-safe GitHub state installer"],
    ["publish-registry", "verify_registry_oidc_identity", "bun\\s+[.]github/scripts/verify-github-oidc-identity[.]mjs\\b", "the registry direct-workflow OIDC verifier"],
    ["publish-registry", "verify_registry_maven_signing", "tools/dev/bun[.]sh\\s+tools/release/verify-maven-signing-readiness[.]mjs\\b", "the registry Maven signing verifier"],
    ["publish-registry", "verify_registry_github_staging", "tools/dev/bun[.]sh\\s+tools/release/verify_product_tags[.]mjs\\b", "registry pre-mutation staging verification"],
    ["publish-registry", "restore_normal_publication_checkpoint", "tools/dev/bun[.]sh\\s+[.]github/scripts/download-normal-publication-checkpoint[.]mjs\\b", "normal-publication recovery"],
    ["publish-registry", "reprove_registry_capacity", "bun\\s+[.]github/scripts/check-crates-io-publish-capacity[.]mjs\\b", "registry capacity admission"],
    ["publish-registry", "exact_registry_publish", "tools/dev/bun[.]sh\\s+tools/release/release-publish[.]mjs\\s+publish\\b", "the exact-lock registry executor"],
    ["publish-registry", "prepare_registry_continuation", "bun\\s+[.]github/scripts/prepare-release-continuation[.]mjs\\b", "the exact normal-publication continuation sealer"],
    ["publish-registry", "seal_registry_handoff", "tools/dev/bun[.]sh\\s+tools/release/release-phase-handoff[.]mjs\\s+seal\\b", "the immutable registry handoff sealer"],
    ["publish-finalize", "finalize_release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the finalization release-head resolver"],
    ["publish-finalize", "finalize_phase_budget", "node\\s+tools/release/release-phase-budget[.]mjs\\b", "the finalization phase budget proof"],
    ["publish-finalize", "install_registry_handoff", "tools/dev/bun[.]sh\\s+tools/release/release-phase-handoff[.]mjs\\s+install\\b", "the validated registry handoff installer"],
    ["publish-finalize", "verify_final_github_staging", "tools/dev/bun[.]sh\\s+tools/release/verify_product_tags[.]mjs\\b", "final staging verification"],
    ["publish-finalize", "verify_published_release", "tools/dev/bun[.]sh\\s+tools/release/release-verify[.]mjs\\b", "published release verification"],
    ["publish-finalize", "public_consumer_smoke", "tools/dev/bun[.]sh\\s+tools/release/public-consumer-smoke[.]mjs\\b", "anonymous public consumers"],
    ["publish-finalize", "reverify_publication_lock", "tools/dev/bun[.]sh\\s+tools/release/publication-lock[.]mjs\\s+verify\\b", "final lock verification"],
    ["publish-finalize", "promote_github_releases", "bun\\s+[.]github/scripts/manage-release-drafts[.]mjs\\s+promote\\b", "draft promotion"],
  ];
  for (const [jobId, id, command, description] of commands) {
    assertRunInvocation(workflow, jobId, id, commandPattern(command), description);
  }
  const releaseTransport = stepById(workflow, "publish", "ensure_release_transport_ref");
  const releaseReservation = workflowSteps(workflow, "publish")[releaseTransport.index - 1];
  invariant(
    commandPattern(
        "tools/dev/bun[.]sh\\s+tools/release/github-content-write-pacer[.]mjs\\s+reserve\\b",
      ).test(executableShell(releaseReservation?.run))
      && releaseTransport.step.env?.GH_TOKEN === "${{ github.token }}"
      && releaseTransport.step.env?.GH_REPO === "${{ github.repository }}"
      && releaseTransport.step.env?.RELEASE_OPERATION === "publish"
      && releaseTransport.step.env?.RELEASE_CONTINUATION_POINTER
        === "${{ inputs.continuation_pointer }}"
      && releaseTransport.step.env?.RELEASE_TRANSPORT_CONTENT_WRITE_ADMISSION
        === "pre-reserved",
    "normal publication must reserve immediately before its root-admitted, rerun-safe exact transport",
  );
  for (const jobId of ["publish", "publish-registry", "publish-finalize", "publish-bootstrap"]) {
    invariant(
      workflowSteps(workflow, jobId).every((step) =>
        !/[.]github\/scripts\/require-current-main[.]sh\b/u.test(executableShell(step.run))),
      `${jobId} must keep current-main proof inside the idempotent transport boundary or remain bound to the exact release SHA`,
    );
  }
  for (const [jobId, stepId, condition] of [
    [
      "publish",
      "verify_maven_signing",
      "${{ steps.release_plan.outputs.has_release_changes == 'true' && inputs.operation == 'publish' && steps.registry_needs.outputs.needs_maven == 'true' }}",
    ],
    [
      "publish-registry",
      "verify_registry_maven_signing",
      "${{ steps.registry_publish_needs.outputs.needs_maven == 'true' }}",
    ],
  ]) {
    const signing = stepById(workflow, jobId, stepId).step;
    invariant(
      normalized(signing.if) === condition
        && signing["timeout-minutes"] === 2
        && signing.env?.ORG_GRADLE_PROJECT_signingInMemoryKey
          === "${{ secrets.MAVEN_GPG_PRIVATE_KEY }}"
        && signing.env?.ORG_GRADLE_PROJECT_signingInMemoryKeyId
          === "${{ secrets.MAVEN_GPG_KEY_ID }}"
        && signing.env?.ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
          === "${{ secrets.MAVEN_GPG_PASSPHRASE }}",
      `${jobId}.${stepId} must bind the exact Maven selection and signing secrets inside two minutes`,
    );
  }
  const mavenBundle = stepById(workflow, "publish", "preflight_maven_bundle");
  invariant(
    normalized(mavenBundle.step.if)
      === "${{ steps.release_plan.outputs.has_release_changes == 'true' && inputs.operation == 'publish' && steps.registry_needs.outputs.needs_maven == 'true' }}"
      && mavenBundle.step["timeout-minutes"] === 15
      && mavenBundle.step.env?.PRODUCTS_JSON === "${{ steps.release_plan.outputs.products_json }}"
      && mavenBundle.step.env?.ORG_GRADLE_PROJECT_signingInMemoryKey
        === "${{ secrets.MAVEN_GPG_PRIVATE_KEY }}"
      && mavenBundle.step.env?.ORG_GRADLE_PROJECT_signingInMemoryKeyId
        === "${{ secrets.MAVEN_GPG_KEY_ID }}"
      && mavenBundle.step.env?.ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
        === "${{ secrets.MAVEN_GPG_PASSPHRASE }}",
    "the Maven bundle preflight must bind the exact selection, frozen lock, release SHA, and signing credentials before mutation",
  );
  assertActiveTokens(mavenBundle, [
    '"$PUBLICATION_LOCK_PATH"',
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
  ], "pre-mutation Maven Central bundle preflight");
  const swiftPreflight = stepById(workflow, "publish", "preflight_swift_source_tag");
  invariant(
    normalized(swiftPreflight.step.if)
      === "${{ steps.release_plan.outputs.has_release_changes == 'true' && inputs.operation == 'publish' && steps.release_plan.outputs.product_oliphaunt_swift == 'true' }}"
      && swiftPreflight.step["timeout-minutes"] === 2,
    "the SwiftPM source-tag preflight must run only for an exact selected Swift publish",
  );
  assertActiveTokens(swiftPreflight, [
    '"$PUBLICATION_LOCK_PATH"',
    '"$RELEASE_HEAD_SHA"',
  ], "pre-mutation SwiftPM source-tag preflight");
  const jsrTooling = stepById(workflow, "publish-registry", "install_registry_jsr_tooling");
  invariant(
    normalized(jsrTooling.step.if)
      === "${{ steps.registry_publish_needs.outputs.needs_jsr == 'true' }}"
      && normalized(executableShell(jsrTooling.step.run))
        === "pnpm install --frozen-lockfile --ignore-scripts --filter @oliphaunt/ts"
      && jsrTooling.step["timeout-minutes"] === 2
      && jsrTooling.index < stepById(workflow, "publish-registry", "verify_registry_github_staging").index
      && jsrTooling.index < stepById(workflow, "publish-registry", "exact_registry_publish").index,
    "JSR publication must install the exact lockfile dependencies before every registry mutation gate",
  );
  const registry = stepById(workflow, "publish-registry", "exact_registry_publish");
  assertActiveTokens(registry, [
    "--registry-plan",
    "--registry-admission",
    '"$ADMISSION_FILE"',
    '"$PUBLICATION_LOCK_PATH"',
    '"$RELEASE_HEAD_SHA"',
  ], "registry publication");
  const assets = stepById(workflow, "publish", "publish_github_assets");
  assertActiveTokens(assets, ["--step github-release-assets", '"$PUBLICATION_LOCK_PATH"'], "GitHub asset publication");
}

function assertPinnedNpmPublisherRuntimes(workflow) {
  for (const {
    jobId,
    nodeId,
    npmId,
    nodeCondition,
    npmCondition,
    nodeTimeout,
    npmTimeout,
    nodeAction = "./.github/actions/setup-node-runtime",
    pnpmVersion = undefined,
  } of [
    {
      jobId: "publish-dry-run",
      nodeId: "setup_github_stage_node",
      npmId: "setup_github_stage_npm",
      nodeCondition: "",
      npmCondition: "${{ steps.release_plan.outputs.has_release_changes == 'true' && steps.registry_needs.outputs.needs_npm == 'true' }}",
      nodeTimeout: 3,
      npmTimeout: 3,
    },
    {
      jobId: "publish",
      nodeId: "setup_github_stage_node",
      npmId: "setup_github_stage_npm",
      nodeCondition: "",
      npmCondition: "${{ steps.release_plan.outputs.has_release_changes == 'true' && steps.registry_needs.outputs.needs_npm == 'true' }}",
      nodeTimeout: 3,
      npmTimeout: 3,
    },
    {
      jobId: "publish-registry",
      nodeId: "setup_registry_node",
      npmId: "setup_registry_npm",
      nodeCondition: "",
      npmCondition: "${{ steps.registry_publish_needs.outputs.needs_npm == 'true' }}",
      nodeTimeout: 3,
      npmTimeout: 3,
      nodeAction: "./.github/actions/setup-node-pnpm",
      pnpmVersion: "${{ env.PNPM_VERSION }}",
    },
    {
      jobId: "publish-finalize",
      nodeId: "setup_finalize_node",
      npmId: "setup_finalize_npm",
      nodeCondition: "",
      npmCondition: "",
      nodeTimeout: 5,
      npmTimeout: 5,
    },
    {
      jobId: "publish-bootstrap",
      nodeId: "setup_bootstrap_node",
      npmId: "setup_bootstrap_npm",
      nodeCondition: "",
      npmCondition: "${{ steps.bootstrap_scope.outputs.required == 'true' && steps.registry_needs.outputs.needs_npm == 'true' }}",
      nodeTimeout: 3,
      npmTimeout: 3,
    },
  ]) {
    const node = assertActionStep(workflow, jobId, nodeId, nodeAction);
    const npm = assertActionStep(workflow, jobId, npmId, "./.github/actions/setup-npm-publisher");
    invariant(
      node.index < npm.index,
      `${jobId} must install its digest-verified pinned Node runtime before its npm publisher`,
    );
    invariant(
      node.step.with?.["node-version"] === "${{ env.NODE_VERSION }}"
        && (pnpmVersion === undefined
          ? node.step.with?.["pnpm-version"] === undefined
          : node.step.with?.["pnpm-version"] === pnpmVersion)
        && npm.step.with?.["npm-version"] === "${{ env.NPM_VERSION }}"
        && normalized(node.step.if) === nodeCondition
        && normalized(npm.step.if) === npmCondition
        && node.step["timeout-minutes"] === nodeTimeout
        && npm.step["timeout-minutes"] === npmTimeout,
      `${jobId} must bind its exact Node/npm pins and their exact publication conditions`,
    );
    if (jobId === "publish" || jobId === "publish-dry-run") {
      const consumer = stepById(workflow, jobId, "validate_product_dry_runs");
      invariant(
        npm.index + 1 === consumer.index
          && consumer.step.env?.OLIPHAUNT_VERIFIED_NODE_EXECUTABLE
            === "${{ steps.setup_github_stage_npm.outputs.node-executable }}"
          && consumer.step.env?.OLIPHAUNT_VERIFIED_NPM_CLI
            === "${{ steps.setup_github_stage_npm.outputs.npm-cli }}",
        `${jobId} product dry-runs must immediately consume the exact Node/npm paths exported by their pinned setup`,
      );
    }
    for (const [index, step] of workflowSteps(workflow, jobId).entries()) {
      if (/(?:^|[\n;|&()])\s*node\s+/mu.test(executableShell(step.run))) {
        invariant(
          index > node.index,
          `${jobId} must install its digest-verified pinned Node runtime before every executable node command`,
        );
      }
    }
  }
}

function assertPinnedNodeCommandRuntimes(workflow, context) {
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!Array.isArray(job.steps)) continue;
    const steps = workflowSteps(workflow, jobId);
    const commands = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => /(?:^|[\n;|&()])\s*node\s+/mu.test(executableShell(step.run)));
    if (commands.length === 0) continue;
    const setups = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => new Set([
        "./.github/actions/setup-node-runtime",
        "./.github/actions/setup-node-pnpm",
      ]).has(step.uses));
    invariant(
      setups.length === 1,
      `${context} ${jobId} must have exactly one digest-verified pinned Node setup before executable node commands`,
    );
    const [setup] = setups;
    invariant(
      setup.step.with?.["node-version"] === "${{ env.NODE_VERSION }}"
        && (setup.step.uses !== "./.github/actions/setup-node-pnpm"
          || setup.step.with?.["pnpm-version"] === "${{ env.PNPM_VERSION }}")
        && normalized(setup.step.if) === ""
        && Number.isSafeInteger(setup.step["timeout-minutes"])
        && setup.step["timeout-minutes"] > 0,
      `${context} ${jobId} pinned Node setup must be unconditional, version-bound, and bounded`,
    );
    for (const command of commands) {
      invariant(
        command.index > setup.index,
        `${context} ${jobId} must install its digest-verified pinned Node runtime before every executable node command`,
      );
    }
  }
}

function assertArtifactCaptureSafeRuntimes(workflow) {
  for (const { entrypoint, runtimePattern, runtimeName } of [
    {
      entrypoint: "download-build-artifacts.mjs",
      runtimePattern: "node\\s+",
      runtimeName: "the pinned Node runtime",
    },
    {
      entrypoint: "download-bootstrap-ledger.mjs",
      runtimePattern: "node\\s+",
      runtimeName: "the pinned Node runtime",
    },
    {
      entrypoint: "download-normal-publication-checkpoint.mjs",
      runtimePattern: "tools/dev/bun[.]sh\\s+",
      runtimeName: "the pinned Bun launcher",
    },
  ]) {
    let occurrences = 0;
    let safeInvocations = 0;
    const escaped = entrypoint.replaceAll(".", "[.]");
    const referencePattern = new RegExp(`[.]github/scripts/${escaped}\\b`, "gu");
    const safePattern = new RegExp(
      `${COMMAND_BOUNDARY}${runtimePattern}[.]github/scripts/${escaped}\\b`,
      "gmu",
    );
    for (const job of Object.values(workflow.jobs)) {
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        const source = executableShell(step.run);
        occurrences += [...source.matchAll(referencePattern)].length;
        safeInvocations += [...source.matchAll(safePattern)].length;
      }
    }
    invariant(occurrences > 0, `release workflow must invoke ${entrypoint}`);
    invariant(
      safeInvocations === occurrences,
      `every ${entrypoint} invocation must use ${runtimeName}`,
    );
  }
}

function assertReleaseTiming(workflow) {
  invariant(
    workflow.jobs["publish-dry-run"]["timeout-minutes"] === GITHUB_STAGE_JOB_TIMEOUT_SECONDS / 60
      && workflow.jobs.publish["timeout-minutes"] === GITHUB_STAGE_JOB_TIMEOUT_SECONDS / 60
      && workflow.jobs["publish-registry"]["timeout-minutes"]
        === REGISTRY_JOB_TIMEOUT_SECONDS / 60
      && workflow.jobs["publish-finalize"]["timeout-minutes"]
        === FINALIZE_JOB_TIMEOUT_SECONDS / 60
      && workflow.jobs["publish-bootstrap"]["timeout-minutes"] === RELEASE_JOB_TIMEOUT_MINUTES,
    "each mutating release phase must retain its independently derived job timeout",
  );
  invariant(
    workflow.env?.RELEASE_JOB_HARD_WINDOW_SECONDS === RELEASE_JOB_HARD_WINDOW_SECONDS
      && workflow.env?.GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS
        === GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS
      && workflow.env?.REGISTRY_JOB_HARD_WINDOW_SECONDS === REGISTRY_JOB_HARD_WINDOW_SECONDS
      && workflow.env?.FINALIZE_JOB_HARD_WINDOW_SECONDS === FINALIZE_JOB_HARD_WINDOW_SECONDS
      && workflow.env?.NORMAL_REGISTRY_MUTATION_WINDOW_SECONDS
        === REGISTRY_MUTATION_ALLOWANCE_SECONDS
      && workflow.env?.REGISTRY_EVIDENCE_HANDOFF_RESERVE_SECONDS
        === REGISTRY_EVIDENCE_HANDOFF_ALLOWANCE_SECONDS
      && workflow.env?.RELEASE_FINALIZATION_RESERVE_SECONDS === RELEASE_FINALIZATION_RESERVE_SECONDS
      && workflow.env?.RELEASE_MINIMUM_FINALIZATION_SECONDS === RELEASE_MINIMUM_FINALIZATION_SECONDS
      && workflow.env?.RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS
        === RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS
      && workflow.jobs["publish-bootstrap"]["timeout-minutes"] * 60
        - workflow.env.RELEASE_JOB_HARD_WINDOW_SECONDS === RELEASE_JOB_CLEANUP_RESERVE_SECONDS
      && GITHUB_STAGE_JOB_TIMEOUT_SECONDS - GITHUB_STAGE_JOB_HARD_WINDOW_SECONDS
        === GITHUB_STAGE_JOB_CLEANUP_SECONDS
      && REGISTRY_JOB_TIMEOUT_SECONDS - REGISTRY_JOB_HARD_WINDOW_SECONDS
        === REGISTRY_JOB_CLEANUP_SECONDS
      && FINALIZE_JOB_TIMEOUT_SECONDS - FINALIZE_JOB_HARD_WINDOW_SECONDS
        === FINALIZE_JOB_CLEANUP_SECONDS,
    "release timing must come from the independent executable phase budgets",
  );
  const timeoutMinutes = (jobId, id) =>
    stepById(workflow, jobId, id).step["timeout-minutes"];
  const stageHandoffSeconds = 60 * (
    timeoutMinutes("publish", "seal_github_stage_handoff")
      + timeoutMinutes("publish", "preserve_github_stage_handoff")
  );
  const registryTransferSeconds = 60 * (
    timeoutMinutes("publish-registry", "download_approved_publication_inputs")
      + timeoutMinutes("publish-registry", "download_github_stage_handoff")
  );
  const registryEvidenceSeconds = 60 * (
    timeoutMinutes("publish-registry", "preserve_complete_registry_recovery")
      + timeoutMinutes("publish-registry", "seal_registry_handoff")
      + timeoutMinutes("publish-registry", "preserve_publication_receipts")
  );
  invariant(
    stageHandoffSeconds === GITHUB_STAGE_HANDOFF_ALLOWANCE_SECONDS
      && registryTransferSeconds === REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS
      && REGISTRY_MUTATION_ALLOWANCE_SECONDS
        === timeoutMinutes("publish-registry", "exact_registry_publish") * 60
      && registryEvidenceSeconds === REGISTRY_EVIDENCE_HANDOFF_ALLOWANCE_SECONDS,
    "handoff, exact-input transfer, registry mutation, and recovery timeouts must exactly match their phase allowances",
  );

  const registrySteps = workflowSteps(workflow, "publish-registry");
  const registryBounded = registrySteps.slice(
    stepById(workflow, "publish-registry", "registry_job_deadline").index + 1,
  ).filter((step) => !new Set([
    "continued_release_plan",
    "inspect_registry_continuation",
    "download_continued_github_stage_handoff",
    "record_registry_capacity_deferral",
    "prepare_registry_continuation",
    "preserve_deferred_registry_recovery",
    "preserve_failed_registry_recovery",
  ]).has(step.id));
  invariant(
    registryBounded.every((step) => Number.isSafeInteger(step["timeout-minutes"])
      && step["timeout-minutes"] > 0),
    "every registry success-path operation after deadline admission must have a positive timeout",
  );
  const registrySuccessPathSeconds = 60 * registryBounded.reduce(
    (total, step) => total + step["timeout-minutes"],
    0,
  );
  const registryAccountedSeconds = REGISTRY_SETUP_ALLOWANCE_SECONDS
    + REGISTRY_EXACT_INPUT_TRANSFER_ALLOWANCE_SECONDS
    + REGISTRY_INPUT_VALIDATION_ALLOWANCE_SECONDS
    + REGISTRY_MUTATION_ALLOWANCE_SECONDS
    + REGISTRY_EVIDENCE_HANDOFF_ALLOWANCE_SECONDS;
  invariant(
    registrySuccessPathSeconds <= registryAccountedSeconds
      && registryAccountedSeconds < REGISTRY_JOB_HARD_WINDOW_SECONDS,
    "the fully bounded registry success path must fit its accounted phase envelope and hard window",
  );

  const finalSteps = workflowSteps(workflow, "publish-finalize");
  const finalSetup = finalSteps.slice(
    stepById(workflow, "publish-finalize", "finalize_job_deadline").index + 1,
    stepById(workflow, "publish-finalize", "enter_finalization").index,
  );
  invariant(
    finalSetup.every((step) => Number.isSafeInteger(step["timeout-minutes"])
      && step["timeout-minutes"] > 0)
      && finalSetup.reduce((total, step) => total + step["timeout-minutes"], 0) * 60
        <= FINALIZE_SETUP_HANDOFF_ALLOWANCE_SECONDS,
    "every pre-finalization setup/handoff operation must be bounded inside its setup allowance",
  );
  const timeoutContracts = [
    ["publish-finalize", "enter_finalization", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.enterFinalization],
    ["publish-registry", "preserve_complete_registry_recovery", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.preservePublicationReceipts],
    ["publish-finalize", "verify_published_release", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.verifyPublishedRelease],
    ["publish-finalize", "public_consumer_smoke", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.publicConsumerSmoke],
    ["publish-finalize", "preserve_consumer_evidence", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.preserveConsumerEvidence],
    ["publish-finalize", "reverify_publication_lock", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.reverifyPublicationLock],
    ["publish-finalize", "preserve_pre_promotion_evidence", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.preservePacingEvidence],
    ["publish-finalize", "promote_github_releases", RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.promoteDrafts],
  ];
  let seconds = 0;
  for (const [jobId, id, minutes] of timeoutContracts) {
    const step = stepById(workflow, jobId, id).step;
    invariant(step["timeout-minutes"] === minutes, `${jobId}.${id} timeout must be ${minutes} minutes`);
    seconds += minutes * 60;
  }
  invariant(
    seconds === RELEASE_FINALIZATION_STEP_TIMEOUT_SECONDS
      && seconds + RELEASE_FINALIZATION_CLEANUP_MARGIN_SECONDS === RELEASE_MINIMUM_FINALIZATION_SECONDS
      && RELEASE_MINIMUM_FINALIZATION_SECONDS < RELEASE_FINALIZATION_RESERVE_SECONDS,
    "mandatory finalization must leave its derived cleanup margin inside the protected reserve",
  );
  for (const [id, milliseconds] of [
    ["stage_github_releases", GITHUB_RELEASE_DRAFT_STAGE_STEP_TIMEOUT_MS],
    ["verify_product_tags", GITHUB_RELEASE_TAG_VERIFY_STEP_TIMEOUT_MS],
    ["verify_github_staging", GITHUB_RELEASE_STAGING_VERIFY_STEP_TIMEOUT_MS],
    ["publish_github_assets", MAX_GITHUB_RELEASE_ASSET_HANDOFF_WINDOW_MS],
    ["publish_swift_source_tag", GITHUB_RELEASE_SWIFTPM_STEP_TIMEOUT_MS],
    ["freeze_github_evidence", GITHUB_RELEASE_ATTESTATION_EVIDENCE_STEP_TIMEOUT_MS],
  ]) {
    invariant(
      stepById(workflow, "publish", id).step["timeout-minutes"] * 60_000 === milliseconds,
      `publish.${id} timeout must match its executable budget`,
    );
  }
  invariant(
    stepById(workflow, "publish-registry", "restore_normal_publication_checkpoint")
      .step["timeout-minutes"] * 60_000 === NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS,
    "publish-registry.restore_normal_publication_checkpoint timeout must match recovery contract",
  );
  for (const [jobId, id] of [
    ["publish-registry", "inspect_registry_continuation"],
    ["publish-bootstrap", "inspect_bootstrap_continuation"],
  ]) {
    const timeoutMinutes = stepById(workflow, jobId, id).step["timeout-minutes"];
    invariant(
      Number.isSafeInteger(timeoutMinutes)
        && timeoutMinutes * 60_000 >= RELEASE_CONTINUATION_INSPECTION_RETRY_ENVELOPE_MS,
      `${jobId}.${id} timeout must cover the bounded sequential continuation-read retry envelope`,
    );
    invariant(
      timeoutMinutes === RELEASE_CONTINUATION_INSPECTION_STEP_TIMEOUT_MINUTES,
      `${jobId}.${id} timeout must retain its derived local-verification margin`,
    );
  }
  const preparationTimeoutMinutes = stepById(
    workflow,
    "publish-registry",
    "prepare_registry_continuation",
  ).step["timeout-minutes"];
  invariant(
    Number.isSafeInteger(preparationTimeoutMinutes)
      && preparationTimeoutMinutes * 60_000
        >= RELEASE_CONTINUATION_PREPARATION_RETRY_ENVELOPE_MS,
    "publish-registry.prepare_registry_continuation timeout must cover both exact stage-handoff metadata reads",
  );
  invariant(
    preparationTimeoutMinutes === RELEASE_CONTINUATION_PREPARATION_STEP_TIMEOUT_MINUTES,
    "publish-registry.prepare_registry_continuation timeout must retain its local sealing margin",
  );
  for (const [jobId, id] of [
    ["publish", "ensure_release_transport_ref"],
    ["publish-bootstrap", "ensure_bootstrap_transport_ref"],
  ]) {
    invariant(
      stepById(workflow, jobId, id).step["timeout-minutes"]
        === RELEASE_TRANSPORT_STEP_TIMEOUT_MINUTES,
      `${jobId}.${id} must retain its bounded immutable-transport timeout`,
    );
  }
}

function assertAttestations(workflow) {
  const ids = [
    "attest_extensions_1",
    "attest_extensions_2",
    "attest_liboliphaunt_native",
    "attest_broker",
    "attest_node_direct",
    "attest_wasix",
  ];
  for (const id of ids) {
    const entry = assertActionStep(workflow, "publish", id, "actions/attest-build-provenance@");
    invariant(
      entry.step["timeout-minutes"] * 60_000 === GITHUB_RELEASE_ATTESTATION_STEP_TIMEOUT_MS,
      `publish.${id} must use the bounded attestation timeout`,
    );
    const reservation = workflowSteps(workflow, "publish")[entry.index - 1];
    invariant(reservation !== undefined, `publish.${id} must have a preceding pacer reservation`);
    invariant(
      commandPattern("tools/dev/bun[.]sh\\s+tools/release/github-content-write-pacer[.]mjs\\s+reserve\\b")
        .test(executableShell(reservation.run)),
      `publish.${id} must immediately follow a durable content-write reservation`,
    );
    invariant(
      normalized(reservation.if) === normalized(entry.step.if),
      `publish.${id} reservation and attestation guards must be identical`,
    );
  }
  invariant(
    stepById(workflow, "publish", "attest_extensions_1").step.with?.["subject-path"]
      === "${{ steps.extension_attestation_subjects.outputs.paths_1 }}"
      && stepById(workflow, "publish", "attest_extensions_2").step.with?.["subject-path"]
        === "${{ steps.extension_attestation_subjects.outputs.paths_2 }}",
    "extension attestations must consume byte-verified balanced lock shards",
  );
  const evidence = stepById(workflow, "publish", "freeze_github_evidence").step;
  const expectedBundles = {
    EXTENSIONS_ATTESTATION_BUNDLE_1: "attest_extensions_1",
    EXTENSIONS_ATTESTATION_BUNDLE_2: "attest_extensions_2",
    LIBOLIPHAUNT_NATIVE_ATTESTATION_BUNDLE: "attest_liboliphaunt_native",
    BROKER_ATTESTATION_BUNDLE: "attest_broker",
    NODE_DIRECT_ATTESTATION_BUNDLE: "attest_node_direct",
    WASIX_ATTESTATION_BUNDLE: "attest_wasix",
  };
  for (const [environment, id] of Object.entries(expectedBundles)) {
    invariant(
      evidence.env?.[environment] === `\${{ steps.${id}.outputs.bundle-path }}`,
      `attestation evidence must bind ${id}'s whole bundle`,
    );
  }
}

function assertNormalRecovery(workflow) {
  const restore = stepById(
    workflow,
    "publish-registry",
    "restore_normal_publication_checkpoint",
  ).step;
  invariant(
    normalized(executableShell(restore.run))
      === "tools/dev/bun.sh .github/scripts/download-normal-publication-checkpoint.mjs"
      && restore.env?.GH_TOKEN === "${{ secrets.GITHUB_TOKEN }}"
      && restore.env?.GH_REPO === "${{ github.repository }}"
      && restore.env?.PUBLICATION_LOCK_PATH === "target/release/publication-lock.json"
      && restore.env?.NORMAL_PUBLICATION_CHECKPOINT_PATH
        === "target/release/normal-publication-checkpoint.json"
      && restore.env?.PRODUCTS_JSON === "${{ steps.registry_inputs.outputs.products_json }}"
      && restore.env?.RELEASE_CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && restore.env?.RELEASE_CONTINUATION_ARCHIVE
        === "${{ runner.temp }}/release-continuation.zip",
    "normal recovery must restore only the exact-SHA canonical checkpoint",
  );

  const failed = assertUploadById(workflow, "publish-registry", "preserve_failed_registry_recovery", {
    name: "normal-publication-recovery-${{ github.sha }}",
    ifNoFiles: "warn",
  }).step;
  const complete = assertUploadById(workflow, "publish-registry", "preserve_complete_registry_recovery", {
    name: "normal-publication-recovery-${{ github.sha }}",
  }).step;
  invariant(
    failed["continue-on-error"] === true
      && failed["timeout-minutes"] === 3
      && complete["timeout-minutes"]
        === RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.preservePublicationReceipts,
    "failure checkpoint preservation must not mask the cause and complete recovery must be bounded",
  );
  invariant(
    normalized(failed.if)
      === "${{ always() && ((steps.exact_registry_publish.outcome != 'skipped' && steps.exact_registry_publish.outcome != 'success') || (steps.record_registry_capacity_deferral.outcome != 'skipped' && steps.record_registry_capacity_deferral.outcome != 'success') || ((steps.exact_registry_publish.outcome == 'success' || steps.record_registry_capacity_deferral.outcome == 'success') && steps.require_registry_execution_decision.outcome != 'success') || (steps.require_registry_execution_decision.outputs.deferred == 'true' && (steps.prepare_registry_continuation.outcome != 'success' || steps.preserve_deferred_registry_recovery.outcome != 'success'))) }}"
      && normalized(complete.if)
        === "${{ steps.require_registry_execution_decision.outputs.complete == 'true' }}",
    "failed recovery evidence must run only after an attempted-mutation transport failure; complete evidence must stay on the success path with exhaustive completion",
  );
  for (const step of [failed, complete]) {
    const artifactPath = String(step.with?.path ?? "");
    invariant(
      artifactPath.includes("normal-publication-plan.json")
        && artifactPath.includes("normal-publication-checkpoint.json")
        && artifactPath.includes("registry-integrity-receipts.json"),
      "normal recovery evidence must preserve its plan, checkpoint, and receipts",
    );
    invariant(
      !artifactPath.includes("normal-publication-admission.json"),
      "the ephemeral normal-publication admission must never cross a job or continuation boundary",
    );
  }
  const deferredUpload = assertUploadById(
    workflow,
    "publish-registry",
    "preserve_deferred_registry_recovery",
    {
      name: "normal-publication-continuation-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}-${{ steps.prepare_registry_continuation.outputs.next_generation }}",
    },
  );
  const deferred = deferredUpload.step;
  const deferredPath = String(deferred.with?.path ?? "");
  const deferredFiles = deferredPath.split(/\s+/u).filter(Boolean);
  invariant(
    normalized(deferred.if)
      === "${{ steps.require_registry_execution_decision.outputs.deferred == 'true' }}"
      && deferred.with?.["if-no-files-found"] === "error"
      && deferred.with?.["compression-level"] === 0
      && deferredPath.includes("normal-publication-checkpoint.json")
      && deferredPath.includes("normal-publication-execution-result.json")
      && deferredPath.includes("release-continuation-contract.json")
      && deferredPath.includes("oliphaunt-github-content-write-pacer.json")
      && deferredPath.includes("oliphaunt-github-core-request-journal.json")
      && !deferredPath.includes("normal-publication-plan.json")
      && !deferredPath.includes("registry-integrity-receipts.json")
      && !deferredPath.includes("normal-publication-admission.json"),
    "deferred normal publication must upload only its exact partial checkpoint/result/contract and GitHub state before dispatch",
  );
  invariant(
    stepById(workflow, "publish-registry", "prepare_registry_continuation").index
      < deferredUpload.index,
    "normal continuation state must be sealed before its exact envelope is uploaded",
  );
  invariant(
    sameSet(deferredFiles, [
      "target/release/normal-publication-checkpoint.json",
      "target/release/normal-publication-execution-result.json",
      "target/release/release-continuation-contract.json",
      "target/release/oliphaunt-github-content-write-pacer.json",
      "target/release/oliphaunt-github-core-request-journal.json",
    ]),
    "deferred normal publication envelope must contain exactly checkpoint, typed result, contract, pacer, and core-request journal",
  );
}

function assertRegistryAdmission(workflow) {
  const capacityDeadline = stepById(
    workflow,
    "publish-registry",
    "registry_capacity_deadline",
  );
  const capacity = stepById(workflow, "publish-registry", "reprove_registry_capacity");
  const mutationDeadline = assertRunInvocation(
    workflow,
    "publish-registry",
    "registry_mutation_deadline",
    commandPattern("node\\s+tools/release/normal-registry-mutation-start[.]mjs\\b"),
    "the fail-closed authoritative registry mutation-start decision",
  );
  const capacityDeferral = assertRunInvocation(
    workflow,
    "publish-registry",
    "record_registry_capacity_deferral",
    commandPattern(
      "tools/dev/bun[.]sh\\s+tools/release/record-normal-publication-capacity-deferral[.]mjs\\b",
    ),
    "the typed zero-mutation capacity/deadline deferral sealer",
  );
  const publish = stepById(workflow, "publish-registry", "exact_registry_publish");
  const decision = stepById(
    workflow,
    "publish-registry",
    "require_registry_execution_decision",
  );
  invariant(
    capacityDeadline.index < capacity.index
      && capacity.index < mutationDeadline.index
      && capacity.index < capacityDeferral.index
      && mutationDeadline.index < publish.index
      && capacityDeferral.index < publish.index,
    "registry admission must inspect against a provisional deadline before either bounded branch",
  );
  assertActiveTokens(capacityDeadline, [
    "REGISTRY_JOB_HARD_DEADLINE_EPOCH",
    "REGISTRY_EVIDENCE_HANDOFF_RESERVE_SECONDS",
    "REGISTRY_MUTATION_DEADLINE_EPOCH=$handoff_deadline",
  ], "registry capacity-inspection deadline");
  invariant(
    normalized(mutationDeadline.step.if)
      === "${{ steps.reprove_registry_capacity.outputs.admission == 'execute' }}"
      && mutationDeadline.step.env?.REQUIRED_WINDOW_SECONDS
        === "${{ steps.reprove_registry_capacity.outputs.required_window_seconds }}",
    "authoritative mutation clock must start only after exact execute admission",
  );
  invariant(
    normalized(publish.step.if)
      === "${{ steps.reprove_registry_capacity.outputs.admission == 'execute' && steps.registry_mutation_deadline.outputs.admission == 'execute' }}"
      && publish.step.env?.ADMISSION_FILE
        === "${{ steps.reprove_registry_capacity.outputs.admission_file }}"
      && publish.step.env?.NORMAL_PUBLICATION_ADMISSION_DIGEST
        === "${{ steps.reprove_registry_capacity.outputs.admission_digest }}",
    "exact registry mutation must run only after and consume the immutable execute admission file and digest",
  );
  const publishSource = activeRun(publish);
  invariant(
    publishSource.includes('--registry-admission "$ADMISSION_FILE"')
      && !publishSource.includes("admitted_operation_ids_json")
      && !publishSource.includes("unadmitted_operation_ids_json")
      && !Object.values(publish.step.env ?? {}).some((value) =>
        String(value).includes("admitted_operation_ids_json")
          || String(value).includes("unadmitted_operation_ids_json")),
    "registry mutation authority must be the immutable admission file, never raw operation-ID outputs",
  );
  invariant(
    normalized(capacityDeferral.step.if)
      === "${{ steps.reprove_registry_capacity.outputs.admission == 'defer' || steps.registry_mutation_deadline.outputs.admission == 'defer' }}"
      && capacityDeferral.step.env?.RELEASE_CONTINUATION_POINTER
        === "${{ inputs.continuation_pointer }}"
      && capacityDeferral.step.env?.CAPACITY_NAMES_SATISFIED
        === "${{ steps.reprove_registry_capacity.outputs.names_satisfied }}"
      && capacityDeferral.step.env?.CAPACITY_NOT_BEFORE_EPOCH
        === "${{ steps.registry_mutation_deadline.outputs.not_before_epoch || steps.reprove_registry_capacity.outputs.not_before_epoch }}"
      && capacityDeferral.step.env?.CAPACITY_REQUIRED_WINDOW_SECONDS
        === "${{ steps.reprove_registry_capacity.outputs.required_window_seconds }}"
      && capacityDeferral.step.env?.PRE_MUTATION_DEFERRAL_MODE
        === "${{ steps.registry_mutation_deadline.outputs.admission == 'defer' && 'pre-mutation-deadline' || '' }}",
    "defer admission must seal the exact zero-mutation checkpoint and typed capacity/deadline proof",
  );
  invariant(
    normalized(decision.step.if)
      === "${{ steps.exact_registry_publish.outcome == 'success' || steps.record_registry_capacity_deferral.outcome == 'success' }}"
      && decision.step.env?.ADMISSION
        === "${{ steps.reprove_registry_capacity.outputs.admission }}"
      && decision.step.env?.CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && decision.step.env?.DEFERRAL_MODE
        === "${{ steps.exact_registry_publish.outputs.deferral_mode || steps.record_registry_capacity_deferral.outputs.deferral_mode }}",
    "registry decision must normalize exactly one admitted executor or root capacity result",
  );
  assertActiveTokens(decision, [
    '[[ "$DEFERRAL_MODE" == pre-mutation-capacity ]]',
    '[[ "$DEFERRAL_MODE" == pre-mutation-deadline ]]',
    '[[ "$DEFERRAL_MODE" == rate-limit ]]',
    '[[ "$DEFERRAL_MODE" == progress ]]',
    'echo "complete=$COMPLETE"',
    'echo "deferred=$DEFERRED"',
  ], "typed registry execution decision");
  const prepare = stepById(workflow, "publish-registry", "prepare_registry_continuation").step;
  const prepareEnv = prepare.env ?? {};
  invariant(
    normalized(prepare.if)
      === "${{ steps.require_registry_execution_decision.outputs.deferred == 'true' }}"
      && sameSet(Object.keys(prepareEnv), [
        "APPROVED_ARTIFACT_METADATA_JSON",
        "APPROVED_RUN_ID",
        "GH_REPO",
        "GH_TOKEN",
        "PRODUCTS_JSON",
        "RELEASE_CONTINUATION_CONTRACT_PATH",
        "RELEASE_CONTINUATION_POINTER",
        "RELEASE_CONTINUATION_STATE_PATH",
        "RELEASE_EXECUTION_RESULT_PATH",
        "RELEASE_OPERATION",
        "STAGE_HANDOFF_ARTIFACT_DIGEST",
        "STAGE_HANDOFF_ARTIFACT_ID",
        "STAGE_HANDOFF_ARTIFACT_NAME",
        "STAGE_HANDOFF_RUN_ID",
      ])
      && prepareEnv.GH_TOKEN === "${{ secrets.GITHUB_TOKEN }}"
      && prepareEnv.GH_REPO === "${{ github.repository }}"
      && prepareEnv.PRODUCTS_JSON === "${{ steps.registry_inputs.outputs.products_json }}"
      && prepareEnv.APPROVED_RUN_ID === "${{ steps.registry_inputs.outputs.approved_run_id }}"
      && prepareEnv.APPROVED_ARTIFACT_METADATA_JSON
        === "${{ steps.registry_inputs.outputs.approved_artifact_metadata_json }}"
      && prepareEnv.RELEASE_OPERATION === "publish"
      && prepareEnv.RELEASE_CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && prepareEnv.RELEASE_EXECUTION_RESULT_PATH
        === "target/release/normal-publication-execution-result.json"
      && prepareEnv.RELEASE_CONTINUATION_STATE_PATH
        === "target/release/normal-publication-checkpoint.json"
      && prepareEnv.RELEASE_CONTINUATION_CONTRACT_PATH
        === "target/release/release-continuation-contract.json"
      && prepareEnv.STAGE_HANDOFF_RUN_ID
        === "${{ steps.registry_inputs.outputs.stage_handoff_run_id }}"
      && prepareEnv.STAGE_HANDOFF_ARTIFACT_ID
        === "${{ steps.registry_inputs.outputs.stage_handoff_artifact_id }}"
      && prepareEnv.STAGE_HANDOFF_ARTIFACT_NAME
        === "${{ steps.registry_inputs.outputs.stage_handoff_artifact_name }}"
      && prepareEnv.STAGE_HANDOFF_ARTIFACT_DIGEST
        === "${{ steps.registry_inputs.outputs.stage_handoff_artifact_digest }}",
    "only a normalized typed deferred result may seal a normal continuation; it must carry the exact parent and stage-handoff bindings",
  );
}

function assertExactDownloadByArtifactId(workflow, jobId, stepId, artifactId, artifactPath) {
  const matches = workflowSteps(workflow, jobId)
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => String(step.uses ?? "").startsWith("actions/download-artifact@")
      && step.with?.["artifact-ids"] === artifactId);
  invariant(
    matches.length === 1,
    `${jobId} must download exact current-run artifact id ${artifactId} once`,
  );
  const [{ step }] = matches;
  invariant(
    step.with?.path === artifactPath
      && step.id === stepId
      && step.with?.name === undefined
      && step.with?.pattern === undefined
      && step.with?.["run-id"] === undefined
      && step.with?.["github-token"] === undefined,
    `${jobId} handoff download must use only its exact current-run artifact id and path`,
  );
  return matches[0];
}

function assertSingleCheckout(workflow, jobId, ref) {
  const matches = workflowSteps(workflow, jobId).filter((step) =>
    String(step.uses ?? "").startsWith("actions/checkout@"));
  invariant(matches.length === 1, `${jobId} must contain exactly one checkout`);
  assertCheckout(matches[0], undefined, jobId);
  invariant(matches[0].with?.ref === ref, `${jobId} checkout ref must be ${String(ref)}`);
}

function assertReleaseHandoffs(workflow) {
  const stageDeadline = stepById(workflow, "publish", "github_stage_job_deadline");
  assertActiveTokens(stageDeadline, [
    "OLIPHAUNT_GITHUB_CONTENT_WRITE_COLD_START_EPOCH=$(date +%s)",
    "OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH=$RUNNER_TEMP/oliphaunt-github-content-write-pacer.json",
    "OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH=$RUNNER_TEMP/oliphaunt-github-core-request-journal.json",
    "OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL=true",
    "OLIPHAUNT_RELEASE_ROOT_RUN_ID=$GITHUB_RUN_ID",
  ], "root release pacing lineage initialization");
  const registryDeadline = stepById(workflow, "publish-registry", "registry_job_deadline");
  assertActiveTokens(registryDeadline, [
    "OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH=$RUNNER_TEMP/registry-input-download-core-journal.json",
    "OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL=true",
  ], "pre-install registry GitHub read journal");
  const finalDeadline = stepById(workflow, "publish-finalize", "finalize_job_deadline");
  assertActiveTokens(finalDeadline, [
    "FINALIZE_JOB_HARD_DEADLINE_EPOCH=$hard_deadline",
    "REGISTRY_JOB_HARD_DEADLINE_EPOCH=$hard_deadline",
  ], "finalization pacing deadline bridge");
  const stageOutputs = workflow.jobs.publish.outputs ?? {};
  invariant(
    sameSet(Object.keys(stageOutputs), [
      "approved_artifact_metadata_json",
      "approved_run_id",
      "has_release_changes",
      "products_json",
      "release_head_sha",
      "stage_handoff_artifact_digest",
      "stage_handoff_artifact_id",
    ])
      && stageOutputs.has_release_changes
        === "${{ steps.release_plan.outputs.has_release_changes }}"
      && stageOutputs.products_json === "${{ steps.release_plan.outputs.products_json }}"
      && stageOutputs.release_head_sha === "${{ steps.release_head.outputs.sha }}"
      && stageOutputs.approved_run_id
        === "${{ steps.approved_publication_lock.outputs.run_id }}"
      && stageOutputs.approved_artifact_metadata_json
        === "${{ steps.approved_publication_lock.outputs.artifact_metadata_json }}"
      && stageOutputs.stage_handoff_artifact_id
        === "${{ steps.preserve_github_stage_handoff.outputs.artifact-id }}"
      && stageOutputs.stage_handoff_artifact_digest
        === "${{ steps.preserve_github_stage_handoff.outputs.artifact-digest }}",
    "publish outputs must expose only exact plan, head, approved dry-run, and immutable handoff identities",
  );
  const registryOutputs = workflow.jobs["publish-registry"].outputs ?? {};
  invariant(
    sameSet(Object.keys(registryOutputs), [
      "approved_artifact_metadata_json",
      "approved_run_id",
      "continuation_artifact_digest",
      "continuation_artifact_id",
      "continuation_contract_digest",
      "continuation_required",
      "products_json",
      "publication_complete",
      "release_head_sha",
      "root_run_id",
      "registry_handoff_artifact_digest",
      "registry_handoff_artifact_id",
    ])
      && registryOutputs.publication_complete
        === "${{ steps.require_registry_execution_decision.outputs.complete }}"
      && registryOutputs.release_head_sha === "${{ steps.registry_release_head.outputs.sha }}"
      && registryOutputs.products_json === "${{ steps.registry_inputs.outputs.products_json }}"
      && registryOutputs.approved_run_id === "${{ steps.registry_inputs.outputs.approved_run_id }}"
      && registryOutputs.approved_artifact_metadata_json
        === "${{ steps.registry_inputs.outputs.approved_artifact_metadata_json }}"
      && registryOutputs.root_run_id === "${{ steps.registry_inputs.outputs.root_run_id }}"
      && registryOutputs.registry_handoff_artifact_id
        === "${{ steps.preserve_publication_receipts.outputs.artifact-id }}"
      && registryOutputs.registry_handoff_artifact_digest
        === "${{ steps.preserve_publication_receipts.outputs.artifact-digest }}"
      && registryOutputs.continuation_required
        === "${{ steps.require_registry_execution_decision.outputs.deferred }}"
      && registryOutputs.continuation_artifact_id
        === "${{ steps.preserve_deferred_registry_recovery.outputs.artifact-id }}"
      && registryOutputs.continuation_artifact_digest
        === "${{ steps.preserve_deferred_registry_recovery.outputs.artifact-digest }}"
      && registryOutputs.continuation_contract_digest
        === "${{ steps.prepare_registry_continuation.outputs.contract_digest }}",
    "registry outputs must expose the exact receipt handoff or verified continuation identity",
  );

  const stageSeal = stepById(workflow, "publish", "seal_github_stage_handoff");
  assertActiveTokens(stageSeal, [
    "--phase github-staged",
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    '"$RUNNER_TEMP/github-stage-handoff"',
  ], "GitHub-stage handoff");
  const stageUpload = assertUploadById(workflow, "publish", "preserve_github_stage_handoff", {
    name: "github-stage-handoff-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/github-stage-handoff",
  });
  invariant(
    stageUpload.step.with?.["compression-level"] === 0
      && stageUpload.step.with?.["include-hidden-files"] === true,
    "GitHub-stage handoff must preserve its byte-exact hidden manifest without recompression",
  );
  const failedStage = assertUploadById(
    workflow,
    "publish",
    "preserve_failed_github_stage_evidence",
    {
      name: "github-staging-recovery-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      ifNoFiles: "warn",
    },
  ).step;
  invariant(
    failedStage["continue-on-error"] === true
      && normalized(failedStage.if)
        === "${{ failure() && inputs.operation == 'publish' && steps.release_plan.outputs.has_release_changes == 'true' }}",
    "failed GitHub staging evidence must run only after a normal-publish failure and must not mask it",
  );

  const approvedInputs = stepById(
    workflow,
    "publish-registry",
    "download_approved_publication_inputs",
  );
  assertActiveTokens(approvedInputs, [
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    "--artifact oliphaunt-publication-lock",
    "--artifact oliphaunt-bootstrap-capsule",
  ], "approved registry input transfer");
  invariant(
    approvedInputs.step.env?.APPROVED_RUN_ID === "${{ steps.registry_inputs.outputs.approved_run_id }}"
      && approvedInputs.step.env?.APPROVED_ARTIFACT_METADATA_JSON
        === "${{ steps.registry_inputs.outputs.approved_artifact_metadata_json }}",
    "approved registry input transfer must consume the exact selected run and immutable artifact metadata",
  );

  const stageDownload = assertExactDownloadByArtifactId(
    workflow,
    "publish-registry",
    "download_github_stage_handoff",
    "${{ needs.publish.outputs.stage_handoff_artifact_id }}",
    "${{ runner.temp }}/github-stage-handoff",
  );
  const stageInstall = stepById(workflow, "publish-registry", "install_github_stage_handoff");
  invariant(stageDownload.index < stageInstall.index, "registry handoff must be downloaded before validation");
  const continuationInspect = stepById(
    workflow,
    "publish-registry",
    "inspect_registry_continuation",
  );
  invariant(
    continuationInspect.index < stageInstall.index
      && normalized(continuationInspect.step.if) === "${{ inputs.continuation_pointer != '' }}"
      && continuationInspect.step.env?.RELEASE_CONTINUATION_GITHUB_PACER_PATH
        === "${{ runner.temp }}/continued-oliphaunt-github-content-write-pacer.json"
      && continuationInspect.step.env?.RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_PATH
        === "${{ runner.temp }}/continued-oliphaunt-github-core-request-journal.json",
    "normal continuation inspection must extract the contract-bound GitHub state before stage installation",
  );
  assertActiveTokens(stageInstall, [
    "--phase github-staged",
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    '"$RUNNER_TEMP/github-stage-handoff"',
    "node .github/scripts/install-release-continuation-github-state.mjs",
    "OLIPHAUNT_RELEASE_ROOT_RUN_ID=${{ steps.registry_inputs.outputs.root_run_id }}",
  ], "installed GitHub-stage handoff");
  const stageInstallShell = normalized(executableShell(stageInstall.step.run));
  const registryBunSetups = workflowSteps(workflow, "publish-registry")
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.uses === "./.github/actions/setup-bun");
  invariant(
    registryBunSetups.length === 1
      && registryBunSetups[0].index < stageInstall.index
      && stageInstallShell.indexOf("tools/dev/bun.sh tools/release/release-phase-handoff.mjs install")
        < stageInstallShell.indexOf("node .github/scripts/install-release-continuation-github-state.mjs")
      && stageInstall.index
        < stepById(workflow, "publish-registry", "verify_registry_github_staging").index
      && stageInstall.step.env?.ORIGINAL_GITHUB_PACER_PATH
        === "${{ runner.temp }}/oliphaunt-github-content-write-pacer.json"
      && stageInstall.step.env?.ORIGINAL_GITHUB_CORE_JOURNAL_PATH
        === "${{ runner.temp }}/oliphaunt-github-core-request-journal.json"
      && stageInstall.step.env?.PREINSTALL_GITHUB_CORE_JOURNAL_PATH
        === "${{ runner.temp }}/registry-input-download-core-journal.json"
      && stageInstall.step.env?.OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH
        === "${{ runner.temp }}/oliphaunt-github-content-write-pacer.json"
      && stageInstall.step.env?.OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH
        === "${{ runner.temp }}/oliphaunt-github-core-request-journal.json"
      && stageInstall.step.env?.OLIPHAUNT_RELEASE_ROOT_RUN_ID
        === "${{ steps.registry_inputs.outputs.root_run_id }}"
      && stageInstall.step.env?.RELEASE_CONTINUATION_GITHUB_PACER_PATH
        === "${{ steps.inspect_registry_continuation.outputs.continued_github_pacer_path }}"
      && stageInstall.step.env?.RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_PATH
        === "${{ steps.inspect_registry_continuation.outputs.continued_github_core_journal_path }}"
      && stageInstall.step.env?.RELEASE_CONTINUATION_GITHUB_STATE_JSON
        === "${{ steps.inspect_registry_continuation.outputs.continued_github_state_json }}",
    "registry setup must install and merge the latest exact continuation GitHub state with pinned Bun for its Bun-only handoff graph before any downstream GitHub read or mutation",
  );

  const registrySeal = stepById(workflow, "publish-registry", "seal_registry_handoff");
  assertActiveTokens(registrySeal, [
    "--phase registry-published",
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    '"$RUNNER_TEMP/registry-published-handoff"',
  ], "registry-published handoff");
  const registryUpload = assertUploadById(
    workflow,
    "publish-registry",
    "preserve_publication_receipts",
    {
      name: "registry-published-handoff-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
      path: "${{ runner.temp }}/registry-published-handoff",
    },
  );
  invariant(
    registryUpload.step.with?.["compression-level"] === 0
      && registryUpload.step.with?.["include-hidden-files"] === true,
    "registry handoff must preserve its byte-exact hidden manifest without recompression",
  );

  const registryDownload = assertExactDownloadByArtifactId(
    workflow,
    "publish-finalize",
    "download_registry_handoff",
    "${{ needs.publish-registry.outputs.registry_handoff_artifact_id }}",
    "${{ runner.temp }}/registry-published-handoff",
  );
  const registryInstall = stepById(workflow, "publish-finalize", "install_registry_handoff");
  const finalizeBunSetups = workflowSteps(workflow, "publish-finalize")
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => step.uses === "./.github/actions/setup-bun");
  invariant(
    registryDownload.index < registryInstall.index
      && finalizeBunSetups.length === 1
      && finalizeBunSetups[0].index < registryInstall.index,
    "finalization handoff must be downloaded and pinned Bun installed before validation",
  );
  assertActiveTokens(registryInstall, [
    "--phase registry-published",
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    '"$RUNNER_TEMP/registry-published-handoff"',
    "OLIPHAUNT_GITHUB_CONTENT_WRITE_PACER_PATH=$RUNNER_TEMP/oliphaunt-github-content-write-pacer.json",
    "OLIPHAUNT_GITHUB_CORE_REQUEST_JOURNAL_PATH=$RUNNER_TEMP/oliphaunt-github-core-request-journal.json",
    "OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL=true",
    "OLIPHAUNT_RELEASE_ROOT_RUN_ID=$RELEASE_ROOT_RUN_ID",
  ], "installed registry-published handoff");
  invariant(
    registryInstall.step.env?.RELEASE_ROOT_RUN_ID
      === "${{ needs.publish-registry.outputs.root_run_id }}",
    "finalization must restore the exact verified root release lineage before any GitHub operation",
  );
}

function assertDryRunEvidence(workflow) {
  const capsule = stepById(workflow, "publish-dry-run", "freeze_bootstrap_capsule");
  assertActiveTokens(capsule, [
    "--lock",
    '"$PUBLICATION_LOCK_PATH"',
    "--output target/release/oliphaunt-bootstrap-capsule.tar",
  ], "dry-run bootstrap capsule");
  const lock = assertUploadById(workflow, "publish-dry-run", "preserve_publication_lock", {
    name: "oliphaunt-publication-lock",
    path: "target/release/publication-lock.json",
  });
  const capsuleUpload = assertUploadById(workflow, "publish-dry-run", "preserve_bootstrap_capsule", {
    name: "oliphaunt-bootstrap-capsule",
    path: "target/release/oliphaunt-bootstrap-capsule.tar",
  });
  invariant(
    lock.index < capsuleUpload.index
      && capsule.index < lock.index,
    "dry-run must freeze one capsule before preserving its exact lock and transport",
  );
  const approval = stepById(workflow, "publish", "approved_publication_lock");
  assertActiveTokens(approval, [
    "--event workflow_dispatch",
    "--artifact oliphaunt-publication-lock",
    "--artifact oliphaunt-bootstrap-capsule",
  ], "approved dry-run selection");
}

function assertOidcBoundaries(workflow) {
  const expected = new Map([
    ["publish.verify_oidc_identity", "${{ inputs.operation }}"],
    ["publish-registry.verify_registry_oidc_identity", "publish"],
    ["publish-bootstrap.verify_bootstrap_oidc_identity", "publish-bootstrap"],
  ]);
  const observed = [];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (
        job.permissions?.["id-token"] === "write"
        && /verify-github-oidc-identity[.]mjs\b/u.test(executableShell(step.run))
      ) {
        const location = `${jobId}.${step.id ?? "<missing-id>"}`;
        observed.push(location);
        invariant(
          expected.get(location) === step.env?.RELEASE_OPERATION
            && step.env?.RELEASE_CONTINUATION_POINTER
              === "${{ inputs.continuation_pointer }}",
          `${location} must verify the direct-workflow OIDC identity for its exact operation and root/transport ref`,
        );
      }
    }
  }
  invariant(
    sameSet(observed, [...expected.keys()]),
    `OIDC verification locations must be ${JSON.stringify([...expected.keys()])}; got ${JSON.stringify(observed)}`,
  );
  const oidcJobs = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.["id-token"] === "write")
    .map(([jobId]) => jobId);
  invariant(
    sameSet(oidcJobs, ["publish", "publish-registry", "publish-bootstrap"]),
    "only staging, registry publication, and bootstrap may request an OIDC token",
  );
}

function assertBootstrapJob(workflow) {
  assertStepOrder(workflow, "publish-bootstrap", BOOTSTRAP_PHASES);
  for (const id of [
    "verify_bootstrap_oidc_identity",
    "ci_qualification",
    "verify_bootstrap_qualification",
    "verify_bootstrap_capsule",
    "verify_bootstrap_lock",
    "restore_bootstrap_checkpoint",
    "bootstrap_mutation_deadline",
    "bootstrap_registry_identities",
  ]) {
    assertStepCondition(workflow, "publish-bootstrap", id, [BOOTSTRAP_REQUIRED]);
  }
  assertStepCondition(workflow, "publish-bootstrap", "ensure_bootstrap_transport_ref", [
    BOOTSTRAP_REQUIRED,
    "inputs.continuation_pointer == ''",
  ]);
  for (const [id, command, description] of [
    ["release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the release-head resolver"],
    ["verify_bootstrap_oidc_identity", "bun\\s+[.]github/scripts/verify-github-oidc-identity[.]mjs\\b", "the bootstrap direct-workflow OIDC verifier"],
    ["ci_qualification", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the exact-SHA CI selector"],
    ["verify_bootstrap_qualification", "node\\s+[.]github/scripts/verify-release-candidate[.]mjs\\b", "the candidate verifier"],
    ["inspect_bootstrap_continuation", "node\\s+[.]github/scripts/inspect-release-continuation[.]mjs\\b", "the exact parent continuation inspector"],
    ["approved_bootstrap_capsule", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the approved capsule selector"],
    ["verify_bootstrap_capsule", "tools/dev/bun[.]sh\\s+tools/release/bootstrap-publication-capsule[.]mjs\\s+verify-extract\\b", "capsule verification"],
    ["restore_bootstrap_checkpoint", "node\\s+[.]github/scripts/download-bootstrap-ledger[.]mjs\\b", "bootstrap checkpoint recovery"],
    ["ensure_bootstrap_transport_ref", "node\\s+[.]github/scripts/release-transport-ref[.]mjs\\s+ensure\\b", "the immutable exact-SHA bootstrap continuation transport"],
    ["bootstrap_registry_identities", "bun\\s+[.]github/scripts/bootstrap-registry-identities[.]mjs\\b", "registry identity bootstrap"],
    ["prepare_bootstrap_continuation", "bun\\s+[.]github/scripts/prepare-release-continuation[.]mjs\\b", "the exact bootstrap continuation sealer"],
  ]) assertRunInvocation(workflow, "publish-bootstrap", id, commandPattern(command), description);

  const bootstrapTransport = stepById(workflow, "publish-bootstrap", "ensure_bootstrap_transport_ref");
  invariant(
    bootstrapTransport.step.env?.GH_TOKEN === "${{ github.token }}"
      && bootstrapTransport.step.env?.GH_REPO === "${{ github.repository }}"
      && bootstrapTransport.step.env?.RELEASE_OPERATION === "publish-bootstrap"
      && bootstrapTransport.step.env?.RELEASE_CONTINUATION_POINTER
        === "${{ inputs.continuation_pointer }}"
      && bootstrapTransport.step.env?.RELEASE_TRANSPORT_CONTENT_WRITE_ADMISSION
        === "isolated-bootstrap",
    "bootstrap root must use its rerun-safe immutable transport with isolated admission",
  );

  const capsule = stepById(workflow, "publish-bootstrap", "verify_bootstrap_capsule");
  const lock = stepById(workflow, "publish-bootstrap", "verify_bootstrap_lock");
  const approval = stepById(workflow, "publish-bootstrap", "approved_bootstrap_capsule");
  const inspection = stepById(workflow, "publish-bootstrap", "inspect_bootstrap_continuation");
  invariant(
    normalized(inspection.step.if)
      === "${{ steps.bootstrap_scope.outputs.required == 'true' && inputs.continuation_pointer != '' }}"
      && inspection.step.env?.GH_REPO === "${{ github.repository }}"
      && inspection.step.env?.PRODUCTS_JSON === "${{ steps.release_plan.outputs.products_json }}"
      && inspection.step.env?.RELEASE_CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && inspection.step.env?.RELEASE_CONTINUATION_ARCHIVE
        === "${{ runner.temp }}/release-continuation.zip"
      && inspection.step.env?.RELEASE_OPERATION === "publish-bootstrap",
    "bootstrap continuation branch must inspect the exact parent artifact and dispatched-child authorization",
  );
  invariant(
    normalized(approval.step.if)
      === "${{ steps.bootstrap_scope.outputs.required == 'true' && inputs.continuation_pointer == '' }}",
    "bootstrap root branch alone may select an approved dry-run",
  );
  assertActiveTokens(approval, [
    "--event workflow_dispatch",
    "--artifact oliphaunt-publication-lock",
    "--artifact oliphaunt-bootstrap-capsule",
  ], "approved bootstrap dry-run selection");
  const approvedDownloads = workflowSteps(workflow, "publish-bootstrap")
    .map((step, index) => ({ index, step }))
    .filter((entry) => activeRun(entry).includes(".github/scripts/download-build-artifacts.mjs")
      && activeRun(entry).includes("$RUNNER_TEMP/approved-bootstrap"));
  invariant(
    approvedDownloads.length === 1,
    "bootstrap must have one exact root/continuation-aware approved-input download",
  );
  const [approvedDownload] = approvedDownloads;
  assertActiveTokens(approvedDownload, [
    '"$RELEASE_HEAD_SHA"',
    '"$DRY_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    "--artifact-metadata-json",
    "--artifact oliphaunt-publication-lock",
    "--artifact oliphaunt-bootstrap-capsule",
  ], "bootstrap approved-input transfer");
  invariant(
    approvedDownload.step.env?.DRY_RUN_ID
      === "${{ steps.inspect_bootstrap_continuation.outputs.approved_run_id || steps.approved_bootstrap_capsule.outputs.run_id }}"
      && approvedDownload.step.env?.APPROVED_ARTIFACT_METADATA_JSON
        === "${{ steps.inspect_bootstrap_continuation.outputs.approved_artifact_metadata_json || steps.approved_bootstrap_capsule.outputs.artifact_metadata_json }}",
    "bootstrap approved-input transfer must bind continuation provenance or the one root selector",
  );
  assertActiveTokens(capsule, [
    "$RUNNER_TEMP/approved-bootstrap/oliphaunt-bootstrap-capsule.tar",
    "$RUNNER_TEMP/approved-bootstrap/publication-lock.json",
  ], "bootstrap capsule");
  assertActiveTokens(lock, ["cmp -s", "publication-lock.mjs verify", '"$RELEASE_HEAD_SHA"'], "bootstrap lock");
  const restore = stepById(workflow, "publish-bootstrap", "restore_bootstrap_checkpoint").step;
  invariant(
    restore.env?.RELEASE_CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && restore.env?.RELEASE_CONTINUATION_ARCHIVE
        === "${{ runner.temp }}/release-continuation.zip",
    "bootstrap recovery must consume only the exact inspected continuation archive",
  );

  const decision = stepById(
    workflow,
    "publish-bootstrap",
    "require_bootstrap_execution_decision",
  );
  invariant(
    normalized(decision.step.if)
      === "${{ steps.bootstrap_registry_identities.outcome == 'success' }}"
      && decision.step.env?.COMPLETE === "${{ steps.bootstrap_registry_identities.outputs.complete }}"
      && decision.step.env?.DEFERRED === "${{ steps.bootstrap_registry_identities.outputs.deferred }}"
      && decision.step.env?.DEFERRAL_MODE
        === "${{ steps.bootstrap_registry_identities.outputs.deferral_mode }}"
      && decision.step.env?.PROGRESS_COUNT
        === "${{ steps.bootstrap_registry_identities.outputs.progress_count }}"
      && decision.step.env?.REMAINING_COUNT
        === "${{ steps.bootstrap_registry_identities.outputs.remaining_count }}"
      && decision.step.env?.NOT_BEFORE_EPOCH
        === "${{ steps.bootstrap_registry_identities.outputs.not_before_epoch }}",
    "bootstrap decision must normalize the exact successful publisher outputs",
  );
  assertActiveTokens(decision, [
    '[[ "$DEFERRAL_MODE" == pre-mutation-deadline ]]',
    '[[ "$DEFERRAL_MODE" == rate-limit ]]',
    '[[ "$DEFERRAL_MODE" == progress ]]',
    'echo "complete=$COMPLETE"',
    'echo "deferred=$DEFERRED"',
  ], "typed bootstrap execution decision");
  invariant(
    workflow.jobs["publish-bootstrap"].outputs?.continuation_required
      === "${{ steps.require_bootstrap_execution_decision.outputs.deferred }}",
    "bootstrap continuation dispatch must consume only the normalized typed decision",
  );

  const prepare = stepById(workflow, "publish-bootstrap", "prepare_bootstrap_continuation").step;
  invariant(
    normalized(prepare.if)
      === "${{ steps.require_bootstrap_execution_decision.outputs.deferred == 'true' }}"
      && prepare.env?.RELEASE_CONTINUATION_POINTER === "${{ inputs.continuation_pointer }}"
      && prepare.env?.RELEASE_EXECUTION_RESULT_PATH
        === "target/release/bootstrap-execution-result.json"
      && prepare.env?.RELEASE_CONTINUATION_STATE_PATH === "target/release/bootstrap-ledger"
      && prepare.env?.RELEASE_CONTINUATION_CONTRACT_PATH
        === "target/release/release-continuation-contract.json",
    "deferred bootstrap must seal its exact result, state, parent pointer, and next contract",
  );
  const deferred = assertUploadById(
    workflow,
    "publish-bootstrap",
    "preserve_deferred_bootstrap_ledger",
    {
      name: "bootstrap-continuation-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}-${{ steps.prepare_bootstrap_continuation.outputs.next_generation }}",
    },
  ).step;
  const deferredPath = String(deferred.with?.path ?? "");
  invariant(
    normalized(deferred.if)
      === "${{ steps.require_bootstrap_execution_decision.outputs.deferred == 'true' }}"
      && deferred.with?.["compression-level"] === 0
      && deferred.with?.["include-hidden-files"] === true
      && deferredPath.includes("bootstrap-ledger")
      && deferredPath.includes("bootstrap-execution-result.json")
      && deferredPath.includes("release-continuation-contract.json"),
    "deferred bootstrap must upload its exact partial state, typed result, and contract before dispatch",
  );

  const forbiddenActions = [
    "./.github/actions/setup-moon",
    "./.github/actions/setup-rust",
    "./.github/actions/setup-apple",
    "actions/setup-java@",
    "android-actions/setup-android@",
  ];
  invariant(
    workflowSteps(workflow, "publish-bootstrap").every((step) =>
      !forbiddenActions.some((action) => String(step.uses ?? "").startsWith(action))),
    "bootstrap must not install build, Rust, Java, Android, or Apple toolchains",
  );
  const serializedWorkflow = JSON.stringify(workflow);
  invariant(
    !serializedWorkflow.includes("secrets.CRATES_IO_NEW_CRATE_RUN_CAPACITY")
      && !serializedWorkflow.includes("secrets.CRATES_IO_VERSION_RUN_CAPACITY"),
    "registry capacity assertions must never be supplied by mutable workflow secrets",
  );
  const verifyLockIndex = lock.index;
  for (const [index, step] of workflowSteps(workflow, "publish-bootstrap").entries()) {
    const environment = JSON.stringify(step.env ?? {});
    if (
      environment.includes("secrets.CRATES_IO_BOOTSTRAP_TOKEN")
      || environment.includes("secrets.NPM_BOOTSTRAP_TOKEN")
    ) {
      invariant(index > verifyLockIndex, "bootstrap credentials must not be read before lock verification");
    }
  }
  const cleanup = stepById(workflow, "publish-bootstrap", "remove_bootstrap_credentials").step;
  const ledger = assertUploadById(workflow, "publish-bootstrap", "preserve_bootstrap_ledger", {
    name: "oliphaunt-bootstrap-ledger",
    path: "target/release/bootstrap-ledger",
    ifNoFiles: "warn",
  }).step;
  assertConditionRequires(cleanup.if, ["always()"], "publish-bootstrap.remove_bootstrap_credentials");
  assertConditionRequires(ledger.if, ["always()"], "publish-bootstrap.preserve_bootstrap_ledger");
}

export function assertReleaseOperationWorkflow(workflow) {
  assertWorkflowFoundation(workflow, "Release");
  assertReleaseDoesNotWriteRustCaches(workflow);
  invariant(
    sameSet(Object.keys(workflow.on), ["workflow_dispatch"]),
    "Release jobs must execute directly from the manual release workflow",
  );
  assertPermissions(workflow.permissions, { contents: "read" }, "Release workflow");
  invariant(
    sameSet(Object.keys(workflow.jobs), [
      "validate-inputs",
      "prepare-release-pr",
      "publish-dry-run",
      "publish",
      "publish-registry",
      "publish-finalize",
      "publish-bootstrap",
      "dispatch-bootstrap-continuation",
      "dispatch-publish-continuation",
    ]),
    "Release workflow must keep validation, isolated operation jobs, and continuation dispatchers",
  );
  const releaseInputValidation = assertRunInvocation(
    workflow,
    "validate-inputs",
    "validate_release_inputs",
    commandPattern("bash\\s+[.]github/scripts/validate-release-workflow-inputs[.]sh\\b"),
    "the global release workflow input validator",
  );
  const identityCheckouts = workflowSteps(workflow, "validate-inputs")
    .map((step, index) => ({ index, step }))
    .filter(({ step }) => String(step.uses ?? "").startsWith("actions/checkout@"));
  invariant(
    identityCheckouts.length === 1,
    `release input validation must contain exactly one checkout; found ${identityCheckouts.length}`,
  );
  assertCheckout(identityCheckouts[0].step, "${{ github.sha }}", "release input validation");
  invariant(
    identityCheckouts[0].index < releaseInputValidation.index,
    "release input validation must checkout the exact workflow commit before invoking its input validator",
  );
  invariant(
    releaseInputValidation.step.env?.RELEASE_OPERATION === "${{ inputs.operation }}"
      && releaseInputValidation.step.env?.RELEASE_COMMIT === "${{ inputs.release_commit }}"
      && releaseInputValidation.step.env?.RELEASE_CONTINUATION_POINTER
        === "${{ inputs.continuation_pointer }}",
    "release input validation must bind every caller-controlled release input to the global validator",
  );
  assertExactNeeds(workflow, "prepare-release-pr", ["validate-inputs"]);
  assertExactNeeds(workflow, "publish-dry-run", ["validate-inputs"]);
  assertExactNeeds(workflow, "publish", ["validate-inputs"]);
  assertExactNeeds(workflow, "publish-registry", ["validate-inputs", "publish"]);
  assertExactNeeds(workflow, "publish-finalize", [
    "validate-inputs",
    "publish-registry",
  ]);
  assertExactNeeds(workflow, "publish-bootstrap", ["validate-inputs"]);
  assertPermissions(workflow.jobs["prepare-release-pr"].permissions, {
    contents: "write",
    issues: "write",
    "pull-requests": "write",
  }, "prepare release PR");
  assertPermissions(workflow.jobs["publish-dry-run"].permissions, {
    actions: "read",
    contents: "read",
  }, "publish dry run");
  assertPermissions(workflow.jobs.publish.permissions, {
    actions: "read",
    attestations: "write",
    contents: "write",
    "id-token": "write",
  }, "publish");
  invariant(
    workflow.jobs["publish-dry-run"].outputs === undefined
      && workflow.jobs["publish-dry-run"].steps === workflow.jobs.publish.steps,
    "dry-run and publish must share one canonical release-candidate step list while only publish exposes handoff outputs",
  );
  invariant(
    workflow.jobs["publish-dry-run"]["runs-on"] === "macos-26"
      && workflow.jobs.publish["runs-on"] === "macos-26",
    "dry-run and publish must run their shared Apple-capable candidate path on macos-26",
  );
  assertPermissions(workflow.jobs["publish-registry"].permissions, {
    actions: "read",
    contents: "read",
    "id-token": "write",
  }, "publish registry");
  assertPermissions(workflow.jobs["publish-finalize"].permissions, {
    actions: "read",
    contents: "write",
  }, "publish finalize");
  assertPermissions(workflow.jobs["publish-bootstrap"].permissions, {
    actions: "read",
    contents: "write",
    "id-token": "write",
  }, "publish bootstrap");
  invariant(
    workflow.jobs["prepare-release-pr"].environment === "release-pr"
      && workflow.jobs["publish-dry-run"].environment === "release-dry-run"
      && workflow.jobs.publish.environment === "release-publish"
      && workflow.jobs["publish-registry"].environment === "release-publish"
      && workflow.jobs["publish-finalize"].environment === "release-publish"
      && workflow.jobs["publish-bootstrap"].environment === "release-bootstrap",
    "release jobs must use their isolated protected environments",
  );
  const expectedSecretReferences = {
    "validate-inputs": [],
    "prepare-release-pr": ["RELEASE_PR_TOKEN"],
    "publish-dry-run": [
      "GITHUB_TOKEN",
      "MAVEN_CENTRAL_PASSWORD",
      "MAVEN_CENTRAL_USERNAME",
      "MAVEN_GPG_KEY_ID",
      "MAVEN_GPG_PASSPHRASE",
      "MAVEN_GPG_PRIVATE_KEY",
    ],
    publish: [
      "GITHUB_TOKEN",
      "MAVEN_CENTRAL_PASSWORD",
      "MAVEN_CENTRAL_USERNAME",
      "MAVEN_GPG_KEY_ID",
      "MAVEN_GPG_PASSPHRASE",
      "MAVEN_GPG_PRIVATE_KEY",
    ],
    "publish-registry": [
      "GITHUB_TOKEN",
      "MAVEN_CENTRAL_PASSWORD",
      "MAVEN_CENTRAL_USERNAME",
      "MAVEN_GPG_KEY_ID",
      "MAVEN_GPG_PASSPHRASE",
      "MAVEN_GPG_PRIVATE_KEY",
    ],
    "publish-finalize": ["GITHUB_TOKEN"],
    "publish-bootstrap": ["CRATES_IO_BOOTSTRAP_TOKEN", "GITHUB_TOKEN", "NPM_BOOTSTRAP_TOKEN"],
    "dispatch-bootstrap-continuation": [],
    "dispatch-publish-continuation": [],
  };
  for (const [jobId, expected] of Object.entries(expectedSecretReferences)) {
    const job = workflow.jobs[jobId];
    const referenced = workflowSecretReferences(job, jobId);
    invariant(job.secrets === undefined, `${jobId} must not forward or inherit secrets`);
    invariant(
      sameSet(referenced, expected),
      `${jobId} must reference exactly its protected-environment secret contract`,
    );
  }
  for (const step of workflowSteps(workflow, "publish-dry-run")) {
    if (workflowSecretReferences(step, `publish-dry-run.${step.id ?? step.name ?? "unnamed-step"}`)
      .some((name) => name.startsWith("MAVEN_"))) {
      assertConditionRequires(
        step.if,
        ["inputs.operation == 'publish'"],
        `publish-dry-run.${step.id ?? step.name ?? "unnamed-maven-step"}`,
      );
    }
  }
  assertCondition(workflow, "prepare-release-pr", ["inputs.operation == 'prepare-release-pr'"]);
  invariant(
    normalized(workflow.jobs["publish-dry-run"].if)
      === "${{ inputs.operation == 'publish-dry-run' }}"
      && normalized(workflow.jobs.publish.if)
      === "${{ inputs.operation == 'publish' && inputs.continuation_pointer == '' }}",
    "dry-run and publish jobs must use their exact disjoint root-operation conditions",
  );
  invariant(
    normalized(workflow.jobs["publish-registry"].if)
      === "${{ always() && inputs.operation == 'publish' && ((inputs.continuation_pointer == '' && needs.publish.result == 'success' && needs.publish.outputs.has_release_changes == 'true') || (inputs.continuation_pointer != '' && needs.validate-inputs.result == 'success')) }}"
      && normalized(workflow.jobs["publish-finalize"].if)
        === "${{ always() && inputs.operation == 'publish' && needs.validate-inputs.result == 'success' && needs.publish-registry.result == 'success' && needs.publish-registry.outputs.publication_complete == 'true' }}",
    "registry and finalization jobs must run only for their exact root/continuation success state",
  );
  assertCondition(workflow, "publish-bootstrap", ["inputs.operation == 'publish-bootstrap'"]);
  invariant(
    workflow.env?.NODE_VERSION === RELEASE_NODE_RUNTIME_VERSION
      && workflow.env?.NPM_VERSION === RELEASE_NPM_PUBLISHER_VERSION
      && workflow.env?.PNPM_VERSION === RELEASE_PNPM_VERSION,
    `release workflow must pin Node ${RELEASE_NODE_RUNTIME_VERSION}, npm ${RELEASE_NPM_PUBLISHER_VERSION}, and pnpm ${RELEASE_PNPM_VERSION}`,
  );
  assertAllCheckouts(workflow, undefined);
  assertSingleCheckout(workflow, "prepare-release-pr", undefined);
  assertSingleCheckout(workflow, "publish-dry-run", undefined);
  assertSingleCheckout(workflow, "publish", undefined);
  assertSingleCheckout(
    workflow,
    "publish-registry",
    "${{ inputs.release_commit || needs.publish.outputs.release_head_sha }}",
  );
  assertSingleCheckout(
    workflow,
    "publish-finalize",
    "${{ needs.publish-registry.outputs.release_head_sha }}",
  );
  assertSingleCheckout(workflow, "publish-bootstrap", undefined);
  assertReleaseCheckToolchains(workflow);

  assertStepOrder(workflow, "prepare-release-pr", ["require_current_main", "release_please", "sync_release_pr"]);
  assertRunInvocation(
    workflow,
    "prepare-release-pr",
    "require_current_main",
    commandPattern("bash\\s+[.]github/scripts/require-current-main[.]sh\\b"),
    "current-main verification",
  );
  assertActionStep(workflow, "prepare-release-pr", "release_please", "googleapis/release-please-action@");
  assertRunInvocation(
    workflow,
    "prepare-release-pr",
    "sync_release_pr",
    commandPattern("(?:tools/dev/bun[.]sh|bun|node)\\s+[.]github/scripts/normalize-release-please-pr[.]mjs\\s+push\\b"),
    "the exact-lease release PR synchronizer",
  );

  for (const jobId of ["publish-dry-run", "publish"]) {
    assertStepOrder(workflow, jobId, GITHUB_STAGE_PHASES, {
      final: "preserve_failed_github_stage_evidence",
    });
  }
  assertStepOrder(workflow, "publish-registry", REGISTRY_PHASES, {
    final: "preserve_publication_receipts",
  });
  assertStepOrder(workflow, "publish-finalize", FINALIZE_PHASES, {
    final: "promote_github_releases",
  });
  assertPhaseChain(workflow, [
    "publish.stage_github_releases",
    "publish.seal_github_stage_handoff",
    "publish.preserve_github_stage_handoff",
    "publish-registry.install_github_stage_handoff",
    "publish-registry.exact_registry_publish",
    "publish-registry.seal_registry_handoff",
    "publish-registry.preserve_publication_receipts",
    "publish-finalize.install_registry_handoff",
    "publish-finalize.verify_published_release",
    "publish-finalize.promote_github_releases",
  ]);
  assertNormalStageConditions(workflow);
  assertPinnedNpmPublisherRuntimes(workflow);
  assertPinnedNodeCommandRuntimes(workflow, "Release");
  assertArtifactCaptureSafeRuntimes(workflow);
  assertCriticalReleaseCommands(workflow);
  assertReleaseTiming(workflow);
  assertAttestations(workflow);
  assertRegistryAdmission(workflow);
  assertNormalRecovery(workflow);
  assertReleaseHandoffs(workflow);
  assertDryRunEvidence(workflow);
  assertOidcBoundaries(workflow);
  assertBootstrapJob(workflow);
  const mutationWorkflow = {
    ...workflow,
    jobs: Object.fromEntries(
      Object.entries(workflow.jobs).filter(([jobId]) => jobId !== "publish-dry-run"),
    ),
  };
  assertMutationBoundary(mutationWorkflow, {
    release_please: ["prepare-release-pr.release_please"],
    release_pr_push: ["prepare-release-pr.sync_release_pr"],
    release_transport: [
      "publish.ensure_release_transport_ref",
      "publish-bootstrap.ensure_bootstrap_transport_ref",
    ],
    github_stage: ["publish.stage_github_releases"],
    release_publish: [
      "publish.publish_github_assets",
      "publish.publish_swift_source_tag",
      "publish-registry.exact_registry_publish",
    ],
    attestation: [
      "publish.attest_extensions_1",
      "publish.attest_extensions_2",
      "publish.attest_liboliphaunt_native",
      "publish.attest_broker",
      "publish.attest_node_direct",
      "publish.attest_wasix",
    ],
    registry_bootstrap: ["publish-bootstrap.bootstrap_registry_identities"],
    github_promote: ["publish-finalize.promote_github_releases"],
  });
}

export function assertReleaseWorkflow(workflow) {
  invariant(workflow !== undefined, "release checks require the direct release workflow");
  assertReleaseEntryWorkflow(workflow);
  assertReleaseOperationWorkflow(workflow);
}

export function assertStableWorkflowInvariants(root, { builderJobs = [] } = {}) {
  const ci = parseWorkflow(root, ".github/workflows/ci.yml");
  const mobile = parseWorkflow(root, ".github/workflows/mobile-e2e.yml");
  const release = parseWorkflow(root, ".github/workflows/release.yml");
  const localActions = parseReachableLocalActions(root, { ci, mobile, release });
  assertCiWorkflow(ci, { builderJobs });
  assertSetupAndroidCachePolicy(localActions["./.github/actions/setup-android"]);
  assertReachableCachePolicy({ ci, mobile, release }, localActions);
  assertMobileWorkflow(mobile);
  assertReleaseWorkflow(release);
  return { ci, localActions, mobile, release };
}
