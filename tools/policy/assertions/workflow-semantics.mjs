import { readFileSync } from "node:fs";
import path from "node:path";

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
  RELEASE_CURRENT_MAIN_STEP_TIMEOUT_MINUTES,
  RELEASE_JOB_CLEANUP_RESERVE_SECONDS,
  RELEASE_JOB_HARD_WINDOW_SECONDS,
  RELEASE_JOB_TIMEOUT_MINUTES,
  RELEASE_MINIMUM_FINALIZATION_SECONDS,
} from "../../release/release-finalization-budget.mjs";
import {
  NORMAL_PUBLICATION_RECOVERY_STEP_TIMEOUT_MS,
} from "../../release/normal-publication-recovery-contract.mjs";
import {
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
const HAS_RELEASE_CHANGES = "steps.release_plan.outputs.has_release_changes == 'true'";
const PUBLISH_OPERATION = "inputs.operation == 'publish'";
const BOOTSTRAP_REQUIRED = "steps.bootstrap_scope.outputs.required == 'true'";
const COMMAND_BOUNDARY = String.raw`(?:^|[\n;|&()])\s*`;

function commandPattern(command) {
  return new RegExp(`${COMMAND_BOUNDARY}${command}`, "mu");
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

export function assertCiWorkflow(workflow, { builderJobs = [] } = {}) {
  assertWorkflowFoundation(workflow, "CI");
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
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    invariant(
      job.permissions === undefined
        || (object(job.permissions)
          && Object.values(job.permissions).every((access) => access === "read" || access === "none")),
      `CI job ${jobId} must not grant write access`,
    );
  }
  assertAllCheckouts(workflow, CI_REF);

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
    ["always()", "github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/main'"],
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

export function assertReleaseDispatcherWorkflow(workflow) {
  assertWorkflowFoundation(workflow, "Release dispatcher");
  invariant(
    sameSet(Object.keys(workflow.on), ["workflow_dispatch"]),
    "Release dispatcher must be manual only",
  );
  const operations = workflow.on.workflow_dispatch?.inputs?.operation?.options ?? [];
  invariant(
    sameSet(operations, ["prepare-release-pr", "publish-dry-run", "publish", "publish-bootstrap"]),
    "Release dispatcher must expose only supported state transitions",
  );
  assertConcurrency(workflow, {
    group: "release-${{ inputs.operation == 'publish-dry-run' && github.sha || 'mutation' }}",
    cancel: false,
  }, "Release dispatcher");
  // GitHub concurrency retains at most one running and one pending run for a
  // group. The non-cancelling mutation group serializes those two runs, but it
  // cannot be treated as an unbounded release queue.
  assertPermissions(workflow.permissions, { contents: "read" }, "Release dispatcher workflow");
  const inputs = workflow.on.workflow_dispatch?.inputs ?? {};
  invariant(
    sameSet(Object.keys(inputs), ["operation", "release_commit", "continuation_pointer"])
      && inputs.operation?.required === true
      && inputs.release_commit?.required === false
      && inputs.release_commit?.type === "string"
      && inputs.continuation_pointer?.required === false
      && inputs.continuation_pointer?.type === "string",
    "Release dispatcher inputs must be operation plus optional exact commit and canonical continuation pointer",
  );

  const contracts = {
    "prepare-release-pr": {
      permissions: { contents: "write", issues: "write", "pull-requests": "write" },
    },
    "publish-dry-run": { permissions: { actions: "read", contents: "read" } },
    "publish-bootstrap": {
      permissions: { actions: "read", contents: "read", "id-token": "write" },
    },
    publish: {
      permissions: { actions: "read", attestations: "write", contents: "write", "id-token": "write" },
    },
  };
  const dispatchers = {
    "dispatch-bootstrap-continuation": "publish-bootstrap",
    "dispatch-publish-continuation": "publish",
  };
  invariant(
    sameSet(Object.keys(workflow.jobs), [...Object.keys(contracts), ...Object.keys(dispatchers)]),
    "Release dispatcher must have one least-privilege caller per operation and isolated continuation dispatchers",
  );
  for (const [jobId, contract] of Object.entries(contracts)) {
    const job = workflow.jobs[jobId];
    invariant(job.uses === "./.github/workflows/release-execute.yml", `${jobId} must call release execution`);
    assertConditionRequires(job.if, [`inputs.operation == '${jobId}'`], jobId);
    invariant(job.with?.operation === jobId, `${jobId} must pass its literal operation`);
    invariant(job.with?.release_commit === "${{ inputs.release_commit }}", `${jobId} must forward release_commit`);
    invariant(
      job.with?.continuation_pointer === "${{ inputs.continuation_pointer }}",
      `${jobId} must forward only the canonical continuation pointer`,
    );
    invariant(job.secrets === undefined, `${jobId} must not inherit caller secrets`);
    assertPermissions(job.permissions, contract.permissions, `Release dispatcher ${jobId}`);
  }
  for (const [jobId, parent] of Object.entries(dispatchers)) {
    const job = workflow.jobs[jobId];
    assertExactNeeds(workflow, jobId, [parent]);
    invariant(
      normalized(job.if) === `\${{ needs.${parent}.outputs.continuation_required == 'true' }}`,
      `${jobId} must run only for a verified deferred parent result`,
    );
    invariant(
      job.environment === undefined
        && job.secrets === undefined
        && !JSON.stringify(job).includes("secrets."),
      `${jobId} must not receive an environment or registry secrets`,
    );
    assertPermissions(job.permissions, { actions: "write", contents: "read" }, `Release dispatcher ${jobId}`);
    invariant(
      job["timeout-minutes"] === 55,
      `${jobId} must bound validation, delayed dispatch, authorization upload, and cleanup`,
    );
    const node = assertActionStep(
      workflow,
      jobId,
      "setup_dispatch_node",
      "./.github/actions/setup-node-runtime",
    );
    invariant(
      node.step["timeout-minutes"] === 3
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
      dispatch.step["timeout-minutes"] === 35
        && dispatch.step.env?.CONTINUATION_AUTHORIZATION_PATH
          === "${{ runner.temp }}/release-continuation-authorization.json",
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
        && authorization.step["timeout-minutes"] === 5
        && authorization.step.with?.["compression-level"] === 0
        && authorization.step.with?.["retention-days"] === 90,
      `${jobId} must upload the exact returned child-run authorization before it can succeed`,
    );
    invariant(
      job["timeout-minutes"] >= node.step["timeout-minutes"]
        + dispatch.step["timeout-minutes"] + authorization.step["timeout-minutes"] + 10,
      `${jobId} must retain at least ten minutes for checkout, scheduling, and job cleanup`,
    );
  }
  invariant(
    workflow.env?.NODE_VERSION === RELEASE_NODE_RUNTIME_VERSION,
    `release dispatcher must pin Node ${RELEASE_NODE_RUNTIME_VERSION}`,
  );
  assertPinnedNodeCommandRuntimes(workflow, "Release dispatcher");
}

const GITHUB_STAGE_PHASES = [
  "github_stage_job_deadline",
  "release_head",
  "setup_github_stage_node",
  "release_plan",
  "registry_needs",
  "verify_oidc_identity",
  "ci_qualification",
  "verify_qualification",
  "approved_publication_lock",
  "setup_github_stage_npm",
  "freeze_publication_lock",
  "github_request_budget",
  "audit_registry_input_transfer",
  "github_stage_phase_budget",
  "bootstrap_ledger_state",
  "freeze_bootstrap_capsule",
  "preserve_publication_lock",
  "preserve_bootstrap_capsule",
  "revalidate_release_mutation",
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
  "setup_registry_npm",
  "verify_registry_oidc_identity",
  "verify_registry_github_staging",
  "restore_normal_publication_checkpoint",
  "revalidate_registry_mutation",
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
  "revalidate_bootstrap_mutation",
  "bootstrap_mutation_deadline",
  "bootstrap_registry_identities",
  "require_bootstrap_execution_decision",
  "prepare_bootstrap_continuation",
  "remove_bootstrap_credentials",
  "preserve_deferred_bootstrap_ledger",
  "preserve_bootstrap_ledger",
];

function assertNormalStageConditions(workflow) {
  assertStepCondition(workflow, "publish", "github_stage_job_deadline", [PUBLISH_OPERATION]);
  for (const id of [
    "verify_oidc_identity",
    "approved_publication_lock",
    "github_request_budget",
    "revalidate_release_mutation",
    "stage_github_releases",
    "verify_product_tags",
    "verify_github_staging",
    "publish_github_assets",
    "freeze_github_evidence",
    "seal_github_stage_handoff",
    "preserve_github_stage_handoff",
  ]) assertStepCondition(workflow, "publish", id, [HAS_RELEASE_CHANGES, PUBLISH_OPERATION]);
  for (const id of [
    "attest_extensions_1",
    "attest_extensions_2",
    "attest_liboliphaunt_native",
    "attest_broker",
    "attest_node_direct",
    "attest_wasix",
    "publish_swift_source_tag",
  ]) assertStepCondition(workflow, "publish", id, [HAS_RELEASE_CHANGES, PUBLISH_OPERATION]);

  const dryRunRequired = [HAS_RELEASE_CHANGES, "inputs.operation == 'publish-dry-run'"];
  for (const id of [
    "freeze_bootstrap_capsule",
    "preserve_publication_lock",
    "preserve_bootstrap_capsule",
  ]) assertStepCondition(workflow, "publish", id, dryRunRequired);
}

function assertCriticalReleaseCommands(workflow) {
  const commands = [
    ["publish", "release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the exact release-head resolver"],
    ["publish", "verify_oidc_identity", "bun\\s+[.]github/scripts/verify-github-oidc-identity[.]mjs\\b", "the caller-bound OIDC verifier"],
    ["publish", "ci_qualification", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the exact-SHA CI selector"],
    ["publish", "verify_qualification", "node\\s+[.]github/scripts/verify-release-candidate[.]mjs\\b", "the candidate verifier"],
    ["publish", "approved_publication_lock", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the approved-lock selector"],
    ["publish", "freeze_bootstrap_capsule", "tools/dev/bun[.]sh\\s+tools/release/bootstrap-publication-capsule[.]mjs\\s+pack\\b", "the dry-run bootstrap capsule freezer"],
    ["publish", "github_request_budget", "tools/dev/bun[.]sh\\s+tools/release/github-release-request-budget[.]mjs\\b", "the request-budget admission"],
    ["publish", "github_stage_phase_budget", "tools/dev/bun[.]sh\\s+tools/release/release-phase-budget[.]mjs\\b", "the staging phase budget proof"],
    ["publish", "revalidate_release_mutation", "bash\\s+[.]github/scripts/require-current-main[.]sh\\b", "the pre-release current-main proof"],
    ["publish", "stage_github_releases", "bun\\s+[.]github/scripts/manage-release-drafts[.]mjs\\s+stage\\b", "draft staging"],
    ["publish", "verify_product_tags", "tools/dev/bun[.]sh\\s+tools/release/verify_product_tags[.]mjs\\b", "exact tag verification"],
    ["publish", "verify_github_staging", "bun\\s+[.]github/scripts/manage-release-drafts[.]mjs\\s+verify\\b", "draft verification"],
    ["publish", "publish_github_assets", "tools/dev/bun[.]sh\\s+tools/release/release-publish[.]mjs\\s+publish\\b", "GitHub asset publication"],
    ["publish", "publish_swift_source_tag", "tools/dev/bun[.]sh\\s+tools/release/release-publish[.]mjs\\s+publish\\b", "Swift source-tag publication"],
    ["publish", "freeze_github_evidence", "tools/dev/bun[.]sh\\s+tools/release/verify_github_release_attestations[.]mjs\\s+pre-mutation\\b", "attestation evidence freezing"],
    ["publish", "seal_github_stage_handoff", "tools/dev/bun[.]sh\\s+tools/release/release-phase-handoff[.]mjs\\s+seal\\b", "the immutable staging handoff sealer"],
    ["publish-registry", "registry_release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the registry release-head resolver"],
    ["publish-registry", "registry_phase_budget", "node\\s+tools/release/release-phase-budget[.]mjs\\b", "the registry phase budget proof"],
    ["publish-registry", "download_approved_publication_inputs", "node\\s+[.]github/scripts/download-build-artifacts[.]mjs\\b", "the approved dry-run input downloader"],
    ["publish-registry", "install_github_stage_handoff", "(?:bun|node)\\s+tools/release/release-phase-handoff[.]mjs\\s+install\\b", "the validated staging handoff installer"],
    ["publish-registry", "verify_registry_oidc_identity", "bun\\s+[.]github/scripts/verify-github-oidc-identity[.]mjs\\b", "the registry caller-bound OIDC verifier"],
    ["publish-registry", "verify_registry_github_staging", "tools/dev/bun[.]sh\\s+tools/release/verify_product_tags[.]mjs\\b", "registry pre-mutation staging verification"],
    ["publish-registry", "restore_normal_publication_checkpoint", "tools/dev/bun[.]sh\\s+[.]github/scripts/download-normal-publication-checkpoint[.]mjs\\b", "normal-publication recovery"],
    ["publish-registry", "revalidate_registry_mutation", "bash\\s+[.]github/scripts/require-current-main[.]sh\\b", "the pre-registry current-main proof"],
    ["publish-registry", "reprove_registry_capacity", "bun\\s+[.]github/scripts/check-crates-io-publish-capacity[.]mjs\\b", "registry capacity admission"],
    ["publish-registry", "exact_registry_publish", "tools/dev/bun[.]sh\\s+tools/release/release-publish[.]mjs\\s+publish\\b", "the exact-lock registry executor"],
    ["publish-registry", "seal_registry_handoff", "tools/dev/bun[.]sh\\s+tools/release/release-phase-handoff[.]mjs\\s+seal\\b", "the immutable registry handoff sealer"],
    ["publish-finalize", "finalize_release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the finalization release-head resolver"],
    ["publish-finalize", "finalize_phase_budget", "node\\s+tools/release/release-phase-budget[.]mjs\\b", "the finalization phase budget proof"],
    ["publish-finalize", "install_registry_handoff", "node\\s+tools/release/release-phase-handoff[.]mjs\\s+install\\b", "the validated registry handoff installer"],
    ["publish-finalize", "verify_final_github_staging", "tools/dev/bun[.]sh\\s+tools/release/verify_product_tags[.]mjs\\b", "final staging verification"],
    ["publish-finalize", "verify_published_release", "tools/dev/bun[.]sh\\s+tools/release/release-verify[.]mjs\\b", "published release verification"],
    ["publish-finalize", "public_consumer_smoke", "tools/dev/bun[.]sh\\s+tools/release/public-consumer-smoke[.]mjs\\b", "anonymous public consumers"],
    ["publish-finalize", "reverify_publication_lock", "bash\\s+[.]github/scripts/require-current-main[.]sh\\b", "the pre-promotion current-main proof"],
    ["publish-finalize", "reverify_publication_lock", "tools/dev/bun[.]sh\\s+tools/release/publication-lock[.]mjs\\s+verify\\b", "final lock verification"],
    ["publish-finalize", "promote_github_releases", "bun\\s+[.]github/scripts/manage-release-drafts[.]mjs\\s+promote\\b", "draft promotion"],
  ];
  for (const [jobId, id, command, description] of commands) {
    assertRunInvocation(workflow, jobId, id, commandPattern(command), description);
  }
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
  } of [
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
  ]) {
    const node = assertActionStep(workflow, jobId, nodeId, "./.github/actions/setup-node-runtime");
    const npm = assertActionStep(workflow, jobId, npmId, "./.github/actions/setup-npm-publisher");
    invariant(
      node.index < npm.index,
      `${jobId} must install its digest-verified pinned Node runtime before its npm publisher`,
    );
    invariant(
      node.step.with?.["node-version"] === "${{ env.NODE_VERSION }}"
        && npm.step.with?.["npm-version"] === "${{ env.NPM_VERSION }}"
        && normalized(node.step.if) === nodeCondition
        && normalized(npm.step.if) === npmCondition
        && node.step["timeout-minutes"] === nodeTimeout
        && npm.step["timeout-minutes"] === npmTimeout,
      `${jobId} must bind its exact Node/npm pins and their exact publication conditions`,
    );
    if (jobId === "publish") {
      const consumer = stepById(workflow, jobId, "validate_product_dry_runs");
      invariant(
        npm.index + 1 === consumer.index
          && consumer.step.env?.OLIPHAUNT_VERIFIED_NODE_EXECUTABLE
            === "${{ steps.setup_github_stage_npm.outputs.node-executable }}"
          && consumer.step.env?.OLIPHAUNT_VERIFIED_NPM_CLI
            === "${{ steps.setup_github_stage_npm.outputs.npm-cli }}",
        "publish product dry-runs must immediately consume the exact Node/npm paths exported by their pinned setup",
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
      .filter(({ step }) => step.uses === "./.github/actions/setup-node-runtime");
    invariant(
      setups.length === 1,
      `${context} ${jobId} must have exactly one digest-verified pinned Node setup before executable node commands`,
    );
    const [setup] = setups;
    invariant(
      setup.step.with?.["node-version"] === "${{ env.NODE_VERSION }}"
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

function assertReleaseTiming(workflow) {
  invariant(
    workflow.jobs.publish["timeout-minutes"] === GITHUB_STAGE_JOB_TIMEOUT_SECONDS / 60
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
    ["publish", "revalidate_release_mutation"],
    ["publish-registry", "revalidate_registry_mutation"],
    ["publish-finalize", "reverify_publication_lock"],
    ["publish-bootstrap", "revalidate_bootstrap_mutation"],
  ]) {
    const timeout = stepById(workflow, jobId, id).step["timeout-minutes"];
    invariant(
      id === "reverify_publication_lock"
        ? timeout === RELEASE_FINALIZATION_STEP_TIMEOUT_MINUTES.reverifyPublicationLock
        : timeout === RELEASE_CURRENT_MAIN_STEP_TIMEOUT_MINUTES,
      `${jobId}.${id} must retain its bounded current-main revalidation timeout`,
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
  const deferred = assertUploadById(
    workflow,
    "publish-registry",
    "preserve_deferred_registry_recovery",
    {
      name: "normal-publication-continuation-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}-${{ steps.prepare_registry_continuation.outputs.next_generation }}",
    },
  ).step;
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
      && !deferredPath.includes("normal-publication-plan.json")
      && !deferredPath.includes("registry-integrity-receipts.json")
      && !deferredPath.includes("normal-publication-admission.json"),
    "deferred normal publication must upload only its exact partial checkpoint/result/contract before dispatch",
  );
  invariant(
    sameSet(deferredFiles, [
      "target/release/normal-publication-checkpoint.json",
      "target/release/normal-publication-execution-result.json",
      "target/release/release-continuation-contract.json",
    ]),
    "deferred normal publication envelope must contain exactly checkpoint, typed result, and contract",
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
  assertActiveTokens(stageInstall, [
    "--phase github-staged",
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    '"$RUNNER_TEMP/github-stage-handoff"',
  ], "installed GitHub-stage handoff");

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
  invariant(
    registryDownload.index < registryInstall.index,
    "finalization handoff must be downloaded before validation",
  );
  assertActiveTokens(registryInstall, [
    "--phase registry-published",
    '"$PRODUCTS_JSON"',
    '"$RELEASE_HEAD_SHA"',
    '"$APPROVED_RUN_ID"',
    '"$APPROVED_ARTIFACT_METADATA_JSON"',
    '"$RUNNER_TEMP/registry-published-handoff"',
  ], "installed registry-published handoff");
}

function assertDryRunEvidence(workflow) {
  const capsule = stepById(workflow, "publish", "freeze_bootstrap_capsule");
  assertActiveTokens(capsule, [
    "--lock",
    '"$PUBLICATION_LOCK_PATH"',
    "--output target/release/oliphaunt-bootstrap-capsule.tar",
  ], "dry-run bootstrap capsule");
  const lock = assertUploadById(workflow, "publish", "preserve_publication_lock", {
    name: "oliphaunt-publication-lock",
    path: "target/release/publication-lock.json",
  });
  const capsuleUpload = assertUploadById(workflow, "publish", "preserve_bootstrap_capsule", {
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
      if (/verify-github-oidc-identity[.]mjs\b/u.test(executableShell(step.run))) {
        const location = `${jobId}.${step.id ?? "<missing-id>"}`;
        observed.push(location);
        invariant(
          expected.get(location) === step.env?.RELEASE_OPERATION,
          `${location} must verify the caller-bound OIDC identity for its exact operation`,
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
    "revalidate_bootstrap_mutation",
    "bootstrap_mutation_deadline",
    "bootstrap_registry_identities",
  ]) {
    assertStepCondition(workflow, "publish-bootstrap", id, [BOOTSTRAP_REQUIRED]);
  }
  for (const [id, command, description] of [
    ["release_head", "[.]github/scripts/resolve-release-head[.]sh\\b", "the release-head resolver"],
    ["verify_bootstrap_oidc_identity", "bun\\s+[.]github/scripts/verify-github-oidc-identity[.]mjs\\b", "the bootstrap caller-bound OIDC verifier"],
    ["ci_qualification", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the exact-SHA CI selector"],
    ["verify_bootstrap_qualification", "node\\s+[.]github/scripts/verify-release-candidate[.]mjs\\b", "the candidate verifier"],
    ["inspect_bootstrap_continuation", "node\\s+[.]github/scripts/inspect-release-continuation[.]mjs\\b", "the exact parent continuation inspector"],
    ["approved_bootstrap_capsule", "bash\\s+[.]github/scripts/require-workflow-success[.]sh\\b", "the approved capsule selector"],
    ["verify_bootstrap_capsule", "tools/dev/bun[.]sh\\s+tools/release/bootstrap-publication-capsule[.]mjs\\s+verify-extract\\b", "capsule verification"],
    ["restore_bootstrap_checkpoint", "bun\\s+[.]github/scripts/download-bootstrap-ledger[.]mjs\\b", "bootstrap checkpoint recovery"],
    ["revalidate_bootstrap_mutation", "bash\\s+[.]github/scripts/require-current-main[.]sh\\b", "current-main verification"],
    ["bootstrap_registry_identities", "bun\\s+[.]github/scripts/bootstrap-registry-identities[.]mjs\\b", "registry identity bootstrap"],
    ["prepare_bootstrap_continuation", "bun\\s+[.]github/scripts/prepare-release-continuation[.]mjs\\b", "the exact bootstrap continuation sealer"],
  ]) assertRunInvocation(workflow, "publish-bootstrap", id, commandPattern(command), description);

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

export function assertReleaseExecutionWorkflow(workflow) {
  assertWorkflowFoundation(workflow, "Release execution");
  invariant(
    sameSet(Object.keys(workflow.on), ["workflow_call"]),
    "Release execution must be callable only",
  );
  const inputs = workflow.on.workflow_call?.inputs ?? {};
  invariant(
    sameSet(Object.keys(inputs), ["operation", "release_commit", "continuation_pointer"])
      && inputs.operation?.required === true
      && inputs.operation?.type === "string"
      && inputs.release_commit?.required === false
      && inputs.release_commit?.type === "string"
      && inputs.continuation_pointer?.required === false
      && inputs.continuation_pointer?.type === "string",
    "Release execution inputs must be a required operation and optional release_commit/continuation_pointer",
  );
  invariant(workflow.on.workflow_call?.secrets === undefined, "Release execution must not accept caller secrets");
  invariant(workflow.concurrency === undefined, "Release execution must inherit dispatcher serialization");
  assertPermissions(workflow.permissions, { contents: "read" }, "Release execution workflow");
  invariant(
    sameSet(Object.keys(workflow.jobs), [
      "release-identity",
      "prepare-release-pr",
      "publish",
      "publish-registry",
      "publish-finalize",
      "publish-bootstrap",
    ]),
    "Release execution must keep the isolated staging, registry, finalization, and bootstrap jobs",
  );
  assertExactNeeds(workflow, "prepare-release-pr", ["release-identity"]);
  assertExactNeeds(workflow, "publish", ["release-identity"]);
  assertExactNeeds(workflow, "publish-registry", ["release-identity", "publish"]);
  assertExactNeeds(workflow, "publish-finalize", [
    "release-identity",
    "publish-registry",
  ]);
  assertExactNeeds(workflow, "publish-bootstrap", ["release-identity"]);
  assertPermissions(workflow.jobs["prepare-release-pr"].permissions, {
    contents: "write",
    issues: "write",
    "pull-requests": "write",
  }, "prepare release PR");
  assertPermissions(workflow.jobs.publish.permissions, {
    actions: "read",
    attestations: "write",
    contents: "write",
    "id-token": "write",
  }, "publish");
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
    contents: "read",
    "id-token": "write",
  }, "publish bootstrap");
  invariant(
    workflow.jobs["prepare-release-pr"].environment === "release-pr"
      && workflow.jobs.publish.environment
        === "${{ inputs.operation == 'publish' && 'release-publish' || 'release-dry-run' }}"
      && workflow.jobs["publish-registry"].environment === "release-publish"
      && workflow.jobs["publish-finalize"].environment === "release-publish"
      && workflow.jobs["publish-bootstrap"].environment === "release-bootstrap",
    "release jobs must use their isolated protected environments",
  );
  assertCondition(workflow, "prepare-release-pr", ["inputs.operation == 'prepare-release-pr'"]);
  assertConditionBranches(
    workflow.jobs.publish.if,
    [["inputs.operation == 'publish-dry-run'"], [PUBLISH_OPERATION, "inputs.continuation_pointer == ''"]],
    "publish",
  );
  invariant(
    normalized(workflow.jobs["publish-registry"].if)
      === "${{ always() && inputs.operation == 'publish' && ((inputs.continuation_pointer == '' && needs.publish.result == 'success' && needs.publish.outputs.has_release_changes == 'true') || (inputs.continuation_pointer != '' && needs.release-identity.result == 'success')) }}"
      && normalized(workflow.jobs["publish-finalize"].if)
        === "${{ always() && inputs.operation == 'publish' && needs.release-identity.result == 'success' && needs.publish-registry.result == 'success' && needs.publish-registry.outputs.publication_complete == 'true' }}",
    "registry and finalization jobs must run only for their exact root/continuation success state",
  );
  assertCondition(workflow, "publish-bootstrap", ["inputs.operation == 'publish-bootstrap'"]);
  invariant(
    workflow.env?.NODE_VERSION === RELEASE_NODE_RUNTIME_VERSION
      && workflow.env?.NPM_VERSION === RELEASE_NPM_PUBLISHER_VERSION,
    `release execution must pin Node ${RELEASE_NODE_RUNTIME_VERSION} and npm ${RELEASE_NPM_PUBLISHER_VERSION}`,
  );
  assertAllCheckouts(workflow, undefined);
  assertSingleCheckout(workflow, "prepare-release-pr", undefined);
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

  assertStepOrder(workflow, "publish", GITHUB_STAGE_PHASES, {
    final: "preserve_failed_github_stage_evidence",
  });
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
  assertPinnedNodeCommandRuntimes(workflow, "Release execution");
  assertCriticalReleaseCommands(workflow);
  assertReleaseTiming(workflow);
  assertAttestations(workflow);
  assertRegistryAdmission(workflow);
  assertNormalRecovery(workflow);
  assertReleaseHandoffs(workflow);
  assertDryRunEvidence(workflow);
  assertOidcBoundaries(workflow);
  assertBootstrapJob(workflow);
  assertMutationBoundary(workflow, {
    release_please: ["prepare-release-pr.release_please"],
    release_pr_push: ["prepare-release-pr.sync_release_pr"],
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

export function assertReleaseWorkflow(dispatcher, execution) {
  invariant(execution !== undefined, "release checks require dispatcher and execution workflows");
  assertReleaseDispatcherWorkflow(dispatcher);
  assertReleaseExecutionWorkflow(execution);
}

export function assertStableWorkflowInvariants(root, { builderJobs = [] } = {}) {
  const ci = parseWorkflow(root, ".github/workflows/ci.yml");
  const mobile = parseWorkflow(root, ".github/workflows/mobile-e2e.yml");
  const release = parseWorkflow(root, ".github/workflows/release.yml");
  const releaseExecution = parseWorkflow(root, ".github/workflows/release-execute.yml");
  assertCiWorkflow(ci, { builderJobs });
  assertMobileWorkflow(mobile);
  assertReleaseWorkflow(release, releaseExecution);
  return { ci, mobile, release, releaseExecution };
}
