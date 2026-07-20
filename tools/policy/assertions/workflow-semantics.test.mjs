#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import { BUILDER_JOBS } from "../../graph/ci_plan.mjs";
import {
  assertCiWorkflow,
  assertReleaseDispatcherWorkflow,
  assertReleaseExecutionWorkflow,
  parseWorkflow,
} from "./workflow-semantics.mjs";

const CANONICAL = parseWorkflow(process.cwd(), ".github/workflows/release-execute.yml");
const DISPATCHER = parseWorkflow(process.cwd(), ".github/workflows/release.yml");
const CI = parseWorkflow(process.cwd(), ".github/workflows/ci.yml");

function candidate() {
  return structuredClone(CANONICAL);
}

function dispatcherCandidate() {
  return structuredClone(DISPATCHER);
}

function ciCandidate() {
  return structuredClone(CI);
}

function step(workflow, jobId, stepId) {
  const matches = workflow.jobs[jobId].steps.filter((entry) => entry.id === stepId);
  assert.equal(matches.length, 1, `${jobId}.${stepId} fixture identity`);
  return matches[0];
}

function namedStep(workflow, jobId, name) {
  const matches = workflow.jobs[jobId].steps.filter((entry) => entry.name === name);
  assert.equal(matches.length, 1, `${jobId} ${name} fixture identity`);
  return matches[0];
}

function downloadByArtifactId(workflow, jobId) {
  const matches = workflow.jobs[jobId].steps.filter((entry) =>
    String(entry.uses ?? "").startsWith("actions/download-artifact@")
      && entry.with?.["artifact-ids"] !== undefined);
  assert.equal(matches.length, 1, `${jobId} exact artifact-ID download fixture`);
  return matches[0];
}

test("the canonical release workflow satisfies the split publication contract", () => {
  assert.doesNotThrow(() => assertReleaseExecutionWorkflow(candidate()));
});

test("the exact TypeScript consumer preserves an upload-safe emergency timeout envelope", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const unbounded = ciCandidate();
  delete step(
    unbounded,
    "js-sdk-exact-candidate-consumer",
    "js_exact_candidate_consumer",
  )["timeout-minutes"];
  assert.throws(
    () => assertCiWorkflow(unbounded, { builderJobs: BUILDER_JOBS }),
    /70-minute step bound below its 90-minute job bound/u,
  );

  const exhaustedJob = ciCandidate();
  step(
    exhaustedJob,
    "js-sdk-exact-candidate-consumer",
    "js_exact_candidate_consumer",
  )["timeout-minutes"] = 90;
  assert.throws(
    () => assertCiWorkflow(exhaustedJob, { builderJobs: BUILDER_JOBS }),
    /70-minute step bound below its 90-minute job bound/u,
  );

  const evidenceBeforeProof = ciCandidate();
  const exactSteps = evidenceBeforeProof.jobs["js-sdk-exact-candidate-consumer"].steps;
  const evidenceIndex = exactSteps.findIndex(({ id }) => id === "js_exact_candidate_evidence");
  const [evidence] = exactSteps.splice(evidenceIndex, 1);
  const proofIndex = exactSteps.findIndex(({ id }) => id === "js_exact_candidate_consumer");
  exactSteps.splice(proofIndex, 0, evidence);
  assert.throws(
    () => assertCiWorkflow(evidenceBeforeProof, { builderJobs: BUILDER_JOBS }),
    /must precede js_exact_candidate_evidence/u,
  );
});

test("automatic continuations use GitHub serialization and an exact child authorization artifact", () => {
  assert.doesNotThrow(() => assertReleaseDispatcherWorkflow(dispatcherCandidate()));

  const unsupportedQueue = dispatcherCandidate();
  unsupportedQueue.concurrency.queue = "max";
  assert.throws(
    () => assertReleaseDispatcherWorkflow(unsupportedQueue),
    /may declare only GitHub's group and cancel-in-progress keys/u,
  );

  const cancellingMutations = dispatcherCandidate();
  cancellingMutations.concurrency["cancel-in-progress"] = true;
  assert.throws(
    () => assertReleaseDispatcherWorkflow(cancellingMutations),
    /cancel-in-progress must be false/u,
  );

  const splitMutationGroup = dispatcherCandidate();
  splitMutationGroup.concurrency.group = "release-${{ inputs.operation }}";
  assert.throws(
    () => assertReleaseDispatcherWorkflow(splitMutationGroup),
    /concurrency group must be/u,
  );

  const missingAuthorization = dispatcherCandidate();
  missingAuthorization.jobs["dispatch-publish-continuation"].steps =
    missingAuthorization.jobs["dispatch-publish-continuation"].steps.filter(
      (entry) => entry.id !== "preserve_continuation_authorization",
    );
  assert.throws(
    () => assertReleaseDispatcherWorkflow(missingAuthorization),
    /exactly one stable step id preserve_continuation_authorization/u,
  );

  const replayable = dispatcherCandidate();
  step(replayable, "dispatch-bootstrap-continuation", "preserve_continuation_authorization").if =
    "${{ false }}";
  assert.throws(
    () => assertReleaseDispatcherWorkflow(replayable),
    /upload the exact returned child-run authorization/u,
  );

  const secretBearing = dispatcherCandidate();
  step(secretBearing, "dispatch-publish-continuation", "dispatch_continuation").env.NPM_TOKEN =
    "${{ secrets.NPM_TOKEN }}";
  assert.throws(
    () => assertReleaseDispatcherWorkflow(secretBearing),
    /must not receive an environment or registry secrets/u,
  );
});

test("registry and finalization cannot bypass an upstream successful handoff", () => {
  for (const [jobId, needs] of [
    ["publish-registry", ["release-identity"]],
    ["publish-finalize", ["release-identity", "publish"]],
  ]) {
    const workflow = candidate();
    workflow.jobs[jobId].needs = needs;
    assert.throws(
      () => assertReleaseExecutionWorkflow(workflow),
      /needs must be/u,
      jobId,
    );
  }

  const widened = candidate();
  widened.jobs["publish-finalize"].if = "${{ inputs.operation == 'publish' || github.actor == 'maintainer' }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(widened),
    /registry and finalization jobs must run only/u,
  );
});

test("permission and caller-bound OIDC ceilings fail closed", () => {
  const elevatedFinalize = candidate();
  elevatedFinalize.jobs["publish-finalize"].permissions["id-token"] = "write";
  assert.throws(
    () => assertReleaseExecutionWorkflow(elevatedFinalize),
    /publish finalize permissions must be/u,
  );

  const weakenedRegistry = candidate();
  delete weakenedRegistry.jobs["publish-registry"].permissions["id-token"];
  assert.throws(
    () => assertReleaseExecutionWorkflow(weakenedRegistry),
    /publish registry permissions must be/u,
  );

  const spoofedVerifier = candidate();
  step(spoofedVerifier, "publish-registry", "verify_registry_oidc_identity").run =
    "# bun .github/scripts/verify-github-oidc-identity.mjs\necho skipped";
  assert.throws(
    () => assertReleaseExecutionWorkflow(spoofedVerifier),
    /must actively invoke the registry caller-bound OIDC verifier/u,
  );
});

test("registry capacity assertions cannot be injected through secrets", () => {
  const capacitySecret = candidate();
  step(capacitySecret, "publish-bootstrap", "bootstrap_registry_identities").env
    .CRATES_IO_NEW_CRATE_RUN_CAPACITY = "${{ secrets.CRATES_IO_NEW_CRATE_RUN_CAPACITY }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(capacitySecret),
    /capacity assertions must never be supplied by mutable workflow secrets/u,
  );
});

test("capacity admission cannot be ignored, replayed, or bypass the typed handoff", () => {
  const ignored = candidate();
  delete step(ignored, "publish-registry", "exact_registry_publish").if;
  assert.throws(
    () => assertReleaseExecutionWorkflow(ignored),
    /exact registry mutation must run only after and consume the immutable execute admission/u,
  );

  const capacityToStartBypass = candidate();
  step(capacityToStartBypass, "publish-registry", "exact_registry_publish").if =
    "${{ steps.reprove_registry_capacity.outputs.admission == 'execute' }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(capacityToStartBypass),
    /immutable execute admission file and digest/u,
  );

  const noAdmissionFile = candidate();
  step(noAdmissionFile, "publish-registry", "exact_registry_publish").run =
    step(noAdmissionFile, "publish-registry", "exact_registry_publish").run
      .replace('--registry-admission "$ADMISSION_FILE"', "");
  assert.throws(
    () => assertReleaseExecutionWorkflow(noAdmissionFile),
    /registry publication must actively bind --registry-admission/u,
  );

  const rawIds = candidate();
  step(rawIds, "publish-registry", "exact_registry_publish").env.ADMISSION_FILE =
    "${{ steps.reprove_registry_capacity.outputs.admitted_operation_ids_json }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(rawIds),
    /immutable execute admission file and digest/u,
  );

  const recursive = candidate();
  step(recursive, "publish-registry", "record_registry_capacity_deferral").if = "${{ always() }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(recursive),
    /defer admission must seal the exact zero-mutation checkpoint/u,
  );

  const untypedStartShrink = candidate();
  delete step(
    untypedStartShrink,
    "publish-registry",
    "record_registry_capacity_deferral",
  ).env.PRE_MUTATION_DEFERRAL_MODE;
  assert.throws(
    () => assertReleaseExecutionWorkflow(untypedStartShrink),
    /typed capacity[/]deadline proof/u,
  );

  const bypass = candidate();
  step(bypass, "publish-registry", "prepare_registry_continuation").if =
    "${{ steps.exact_registry_publish.outputs.deferred == 'true' }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(bypass),
    /only a normalized typed deferred result may seal/u,
  );

  const resetLineage = candidate();
  delete step(
    resetLineage,
    "publish-registry",
    "prepare_registry_continuation",
  ).env.RELEASE_CONTINUATION_POINTER;
  assert.throws(
    () => assertReleaseExecutionWorkflow(resetLineage),
    /exact parent and stage-handoff bindings/u,
  );

  const substitutedStageHandoff = candidate();
  step(
    substitutedStageHandoff,
    "publish-registry",
    "prepare_registry_continuation",
  ).env.STAGE_HANDOFF_ARTIFACT_DIGEST = "${{ steps.registry_inputs.outputs.approved_artifact_digest }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(substitutedStageHandoff),
    /exact parent and stage-handoff bindings/u,
  );

  const earlyClock = candidate();
  step(earlyClock, "publish-registry", "registry_mutation_deadline").if = "${{ always() }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(earlyClock),
    /authoritative mutation clock must start only after exact execute admission/u,
  );
});

test("bootstrap typed decisions cannot be bypassed by raw publisher outputs", () => {
  const rawPrepare = candidate();
  step(rawPrepare, "publish-bootstrap", "prepare_bootstrap_continuation").if =
    "${{ steps.bootstrap_registry_identities.outputs.deferred == 'true' }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(rawPrepare),
    /deferred bootstrap must seal its exact result/u,
  );

  const rawDispatch = candidate();
  rawDispatch.jobs["publish-bootstrap"].outputs.continuation_required =
    "${{ steps.bootstrap_registry_identities.outputs.deferred }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(rawDispatch),
    /continuation dispatch must consume only the normalized typed decision/u,
  );

  const untyped = candidate();
  step(untyped, "publish-bootstrap", "require_bootstrap_execution_decision").run =
    step(untyped, "publish-bootstrap", "require_bootstrap_execution_decision").run
      .replace('elif [[ "$DEFERRAL_MODE" == rate-limit ]]; then', 'elif [[ "$DEFERRAL_MODE" == anything ]]; then');
  assert.throws(
    () => assertReleaseExecutionWorkflow(untyped),
    /typed bootstrap execution decision/u,
  );
});

test("normal registry and finalization npm always use the pinned Node runtime first", () => {
  for (const [jobId, nodeId, npmId] of [
    ["publish", "setup_github_stage_node", "setup_github_stage_npm"],
    ["publish-registry", "setup_registry_node", "setup_registry_npm"],
    ["publish-finalize", "setup_finalize_node", "setup_finalize_npm"],
  ]) {
    const reordered = candidate();
    const steps = reordered.jobs[jobId].steps;
    const nodeIndex = steps.findIndex(({ id }) => id === nodeId);
    const [node] = steps.splice(nodeIndex, 1);
    const npmIndex = steps.findIndex(({ id }) => id === npmId);
    steps.splice(npmIndex + 1, 0, node);
    assert.throws(
      () => assertReleaseExecutionWorkflow(reordered),
      /(?:phase setup_.+ must precede|must install its digest-verified pinned Node runtime before (?:its npm publisher|every executable node command))/u,
    );

    const ambient = candidate();
    step(ambient, jobId, nodeId).uses = "./.github/actions/setup-bun";
    assert.throws(
      () => assertReleaseExecutionWorkflow(ambient),
      /must use [.][/][.]github[/]actions[/]setup-node-runtime/u,
    );
  }
});

test("external-extension dry-runs consume only the exact npm setup outputs", () => {
  for (const name of ["OLIPHAUNT_VERIFIED_NODE_EXECUTABLE", "OLIPHAUNT_VERIFIED_NPM_CLI"]) {
    const ambient = candidate();
    step(ambient, "publish", "validate_product_dry_runs").env[name] = name.endsWith("NPM_CLI") ? "npm" : "node";
    assert.throws(
      () => assertReleaseExecutionWorkflow(ambient),
      /product dry-runs must immediately consume the exact Node[/]npm paths exported by their pinned setup/u,
    );
  }
});

test("external-extension npm setup remains immediately adjacent to its dry-run consumer", () => {
  const separated = candidate();
  const steps = separated.jobs.publish.steps;
  const consumerIndex = steps.findIndex(({ id }) => id === "validate_product_dry_runs");
  steps.splice(consumerIndex, 0, { name: "Unrelated work", run: "true" });
  assert.throws(
    () => assertReleaseExecutionWorkflow(separated),
    /product dry-runs must immediately consume the exact Node[/]npm paths exported by their pinned setup/u,
  );
});

test("caller and reusable workflows pin Node before every executable node command", () => {
  for (const [jobId, nodeId] of [
    ["publish", "setup_github_stage_node"],
    ["publish-bootstrap", "setup_bootstrap_node"],
  ]) {
    const ambient = candidate();
    step(ambient, jobId, nodeId).uses = "./.github/actions/setup-bun";
    assert.throws(
      () => assertReleaseExecutionWorkflow(ambient),
      /(?:must use [.][/][.]github[/]actions[/]setup-node-runtime|must have exactly one digest-verified pinned Node setup before executable node commands)/u,
    );
  }

  for (const jobId of ["dispatch-bootstrap-continuation", "dispatch-publish-continuation"]) {
    const ambient = dispatcherCandidate();
    step(ambient, jobId, "setup_dispatch_node").uses = "./.github/actions/setup-bun";
    assert.throws(
      () => assertReleaseDispatcherWorkflow(ambient),
      /must use [.][/][.]github[/]actions[/]setup-node-runtime/u,
    );

    const reordered = dispatcherCandidate();
    const steps = reordered.jobs[jobId].steps;
    const nodeIndex = steps.findIndex(({ id }) => id === "setup_dispatch_node");
    const [node] = steps.splice(nodeIndex, 1);
    const dispatchIndex = steps.findIndex(({ id }) => id === "dispatch_continuation");
    steps.splice(dispatchIndex + 1, 0, node);
    assert.throws(
      () => assertReleaseDispatcherWorkflow(reordered),
      /must install its digest-verified pinned Node runtime before every executable node command/u,
    );
  }
});

test("cross-job handoffs require immutable current-run artifact IDs and active validation", () => {
  const byName = candidate();
  const registryDownload = downloadByArtifactId(byName, "publish-registry");
  delete registryDownload.with["artifact-ids"];
  registryDownload.with.name = "github-stage-handoff-attacker-controlled";
  assert.throws(
    () => assertReleaseExecutionWorkflow(byName),
    /must download exact current-run artifact id/u,
  );

  const crossRun = candidate();
  downloadByArtifactId(crossRun, "publish-finalize").with["run-id"] = "${{ github.event.inputs.run_id }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(crossRun),
    /handoff download must use only its exact current-run artifact id/u,
  );

  const deadInstaller = candidate();
  step(deadInstaller, "publish-finalize", "install_registry_handoff").run = [
    "# node tools/release/release-phase-handoff.mjs install --phase registry-published",
    "echo not-validated",
  ].join("\n");
  assert.throws(
    () => assertReleaseExecutionWorkflow(deadInstaller),
    /must actively invoke the validated registry handoff installer/u,
  );

  const unboundApproval = candidate();
  step(unboundApproval, "publish-registry", "download_approved_publication_inputs").run =
    step(unboundApproval, "publish-registry", "download_approved_publication_inputs").run
      .replace('--artifact-metadata-json "$APPROVED_ARTIFACT_METADATA_JSON"', "");
  assert.throws(
    () => assertReleaseExecutionWorkflow(unboundApproval),
    /approved registry input transfer must actively bind/u,
  );
});

test("dry-run evidence cannot be relabeled as publish evidence or omit the capsule", () => {
  const widenedMutation = candidate();
  step(widenedMutation, "publish", "stage_github_releases").if =
    "${{ steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(widenedMutation),
    /condition does not guarantee/u,
  );

  const missingCapsule = candidate();
  step(missingCapsule, "publish", "approved_publication_lock").run =
    step(missingCapsule, "publish", "approved_publication_lock").run
      .replace("--artifact oliphaunt-bootstrap-capsule", "");
  assert.throws(
    () => assertReleaseExecutionWorkflow(missingCapsule),
    /approved dry-run selection must actively bind --artifact oliphaunt-bootstrap-capsule/u,
  );

  const mislabeledLock = candidate();
  step(mislabeledLock, "publish", "preserve_publication_lock").if =
    "${{ inputs.operation == 'publish' && steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(mislabeledLock),
    /condition does not guarantee/u,
  );
});

test("exact-main revalidation and recovery failure blocking cannot be skipped", () => {
  const skippedMain = candidate();
  step(skippedMain, "publish-registry", "revalidate_registry_mutation").run = "echo assumed-current";
  assert.throws(
    () => assertReleaseExecutionWorkflow(skippedMain),
    /must actively invoke the pre-registry current-main proof/u,
  );

  const skippedFinalMain = candidate();
  step(skippedFinalMain, "publish-finalize", "reverify_publication_lock").run =
    step(skippedFinalMain, "publish-finalize", "reverify_publication_lock").run
      .replace('bash .github/scripts/require-current-main.sh "$RELEASE_HEAD_SHA"', "echo assumed-current");
  assert.throws(
    () => assertReleaseExecutionWorkflow(skippedFinalMain),
    /must actively invoke the pre-promotion current-main proof/u,
  );

  const swallowedFailure = candidate();
  step(swallowedFailure, "publish-registry", "preserve_failed_registry_recovery").if = "${{ always() }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(swallowedFailure),
    /failed recovery evidence must run only after/u,
  );

  const unconditionalComplete = candidate();
  step(unconditionalComplete, "publish-registry", "preserve_complete_registry_recovery").if =
    "${{ always() }}";
  assert.throws(
    () => assertReleaseExecutionWorkflow(unconditionalComplete),
    /complete evidence must stay on the success path/u,
  );
});

test("fresh phase budgets remain attached to their bounded workflow operations", () => {
  const oversizedTransfer = candidate();
  step(
    oversizedTransfer,
    "publish-registry",
    "download_approved_publication_inputs",
  )["timeout-minutes"] += 1;
  assert.throws(
    () => assertReleaseExecutionWorkflow(oversizedTransfer),
    /timeouts must exactly match their phase allowances/u,
  );

  const oversizedFinalizeSetup = candidate();
  namedStep(oversizedFinalizeSetup, "publish-finalize", "Set up Rust")["timeout-minutes"] += 2;
  assert.throws(
    () => assertReleaseExecutionWorkflow(oversizedFinalizeSetup),
    /pre-finalization setup\/handoff operation must be bounded/u,
  );

  const unboundedRegistryStep = candidate();
  delete step(unboundedRegistryStep, "publish-registry", "verify_registry_github_staging")["timeout-minutes"];
  assert.throws(
    () => assertReleaseExecutionWorkflow(unboundedRegistryStep),
    /every registry success-path operation after deadline admission must have a positive timeout/u,
  );

  for (const [jobId, stepId] of [
    ["publish-registry", "inspect_registry_continuation"],
    ["publish-bootstrap", "inspect_bootstrap_continuation"],
  ]) {
    const undersizedContinuationInspection = candidate();
    step(undersizedContinuationInspection, jobId, stepId)["timeout-minutes"] = 52;
    assert.throws(
      () => assertReleaseExecutionWorkflow(undersizedContinuationInspection),
      /timeout must cover the bounded sequential continuation-read retry envelope/u,
    );
  }

  const undersizedContinuationPreparation = candidate();
  step(
    undersizedContinuationPreparation,
    "publish-registry",
    "prepare_registry_continuation",
  )["timeout-minutes"] = 1;
  assert.throws(
    () => assertReleaseExecutionWorkflow(undersizedContinuationPreparation),
    /timeout must cover both exact stage-handoff metadata reads/u,
  );
});

test("direct registry mutation and post-promotion mutation bypasses are rejected", () => {
  const directPublish = candidate();
  const promotionIndex = directPublish.jobs["publish-finalize"].steps.findIndex(
    (entry) => entry.id === "promote_github_releases",
  );
  directPublish.jobs["publish-finalize"].steps.splice(promotionIndex, 0, {
    id: "innocent_cleanup",
    run: "npm publish attacker-controlled.tgz",
  });
  assert.throws(
    () => assertReleaseExecutionWorkflow(directPublish),
    /performs unapproved unmediated_package_publish mutation/u,
  );

  const afterPromotion = candidate();
  afterPromotion.jobs["publish-finalize"].steps.push({
    id: "after_promotion",
    run: "echo too-late",
  });
  assert.throws(
    () => assertReleaseExecutionWorkflow(afterPromotion),
    /promote_github_releases must be the literal final step/u,
  );

  const promotedEarly = candidate();
  const steps = promotedEarly.jobs["publish-finalize"].steps;
  const promotion = steps.pop();
  const evidenceIndex = steps.findIndex((entry) => entry.id === "preserve_pre_promotion_evidence");
  steps.splice(evidenceIndex, 0, promotion);
  assert.throws(
    () => assertReleaseExecutionWorkflow(promotedEarly),
    /preserve_pre_promotion_evidence must precede promote_github_releases/u,
  );
});
