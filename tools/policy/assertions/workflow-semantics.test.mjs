#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import { BUILDER_JOBS } from "../../graph/ci_plan.mjs";
import {
  assertCiWorkflow,
  assertMobileWorkflow,
  assertReleaseEntryWorkflow,
  assertReleaseOperationWorkflow,
  assertReleaseWorkflow,
  assertReachableCachePolicy,
  assertSetupAndroidCachePolicy,
  parseReachableLocalActions,
  parseWorkflow,
} from "./workflow-semantics.mjs";

const CANONICAL = parseWorkflow(process.cwd(), ".github/workflows/release.yml");
const CI = parseWorkflow(process.cwd(), ".github/workflows/ci.yml");
const MOBILE = parseWorkflow(process.cwd(), ".github/workflows/mobile-e2e.yml");
const LOCAL_ACTIONS = parseReachableLocalActions(process.cwd(), {
  ci: CI,
  mobile: MOBILE,
  release: CANONICAL,
});
const SETUP_ANDROID = LOCAL_ACTIONS["./.github/actions/setup-android"];

function candidate() {
  return structuredClone(CANONICAL);
}

function entryCandidate() {
  return structuredClone(CANONICAL);
}

function ciCandidate() {
  return structuredClone(CI);
}

function mobileCandidate() {
  return structuredClone(MOBILE);
}

function setupAndroidCandidate() {
  return structuredClone(SETUP_ANDROID);
}

function localActionsCandidate() {
  return structuredClone(LOCAL_ACTIONS);
}

function workflowSetCandidate() {
  return {
    ci: ciCandidate(),
    mobile: mobileCandidate(),
    release: candidate(),
  };
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

function namedActionStep(action, name) {
  const matches = action.runs.steps.filter((entry) => entry.name === name);
  assert.equal(matches.length, 1, `composite action ${name} fixture identity`);
  return matches[0];
}

function downloadByArtifactId(workflow, jobId) {
  const matches = workflow.jobs[jobId].steps.filter((entry) =>
    String(entry.uses ?? "").startsWith("actions/download-artifact@")
      && entry.with?.["artifact-ids"] !== undefined);
  assert.equal(matches.length, 1, `${jobId} exact artifact-ID download fixture`);
  return matches[0];
}

test("the canonical direct release workflow satisfies the split publication contract", () => {
  assert.doesNotThrow(() => assertReleaseOperationWorkflow(candidate()));
  assert.doesNotThrow(() => assertReleaseWorkflow(candidate()));
});

test("release input validation binds every caller-controlled input before operation jobs", () => {
  const noCheckout = candidate();
  noCheckout.jobs["validate-inputs"].steps = noCheckout.jobs["validate-inputs"].steps
    .filter((entry) => !String(entry.uses ?? "").startsWith("actions/checkout@"));
  assert.throws(
    () => assertReleaseOperationWorkflow(noCheckout),
    /release input validation must contain exactly one checkout/u,
  );

  const movingCheckout = candidate();
  namedStep(movingCheckout, "validate-inputs", "Checkout exact workflow commit").with.ref =
    "${{ github.ref }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(movingCheckout),
    /release input validation checkout ref must be/u,
  );

  const reordered = candidate();
  const identitySteps = reordered.jobs["validate-inputs"].steps;
  const checkoutIndex = identitySteps.findIndex((entry) =>
    String(entry.uses ?? "").startsWith("actions/checkout@"));
  const validatorIndex = identitySteps.findIndex((entry) => entry.id === "validate_release_inputs");
  [identitySteps[checkoutIndex], identitySteps[validatorIndex]] =
    [identitySteps[validatorIndex], identitySteps[checkoutIndex]];
  assert.throws(
    () => assertReleaseOperationWorkflow(reordered),
    /must checkout the exact workflow commit before invoking its input validator/u,
  );

  const bypassed = candidate();
  step(bypassed, "validate-inputs", "validate_release_inputs").run = "echo validation skipped";
  assert.throws(
    () => assertReleaseOperationWorkflow(bypassed),
    /must actively invoke the global release workflow input validator/u,
  );

  const unboundCommit = candidate();
  step(unboundCommit, "validate-inputs", "validate_release_inputs").env.RELEASE_COMMIT =
    "${{ github.sha }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(unboundCommit),
    /must bind every caller-controlled release input/u,
  );
});

test("every release metadata gate sets up pinned Moon and Rust unconditionally first", () => {
  const unhydratedWorkspace = candidate();
  delete unhydratedWorkspace.jobs["prepare-release-pr"].steps.find(
    (entry) => entry.uses === "./.github/actions/setup-moon",
  ).with;
  assert.throws(
    () => assertReleaseOperationWorkflow(unhydratedWorkspace),
    /must install the frozen workspace before the full release check/u,
  );

  const explicitlyUnhydratedWorkspace = candidate();
  explicitlyUnhydratedWorkspace.jobs["publish-dry-run"].steps.find(
    (entry) => entry.uses === "./.github/actions/setup-moon",
  ).with["install-workspace"] = "false";
  assert.throws(
    () => assertReleaseOperationWorkflow(explicitlyUnhydratedWorkspace),
    /must install the frozen workspace before the full release check/u,
  );

  const ambientMoon = candidate();
  ambientMoon.jobs["prepare-release-pr"].steps.find(
    (entry) => entry.uses === "./.github/actions/setup-moon",
  ).uses = "./.github/actions/setup-bun";
  assert.throws(
    () => assertReleaseOperationWorkflow(ambientMoon),
    /must set up the pinned Moon toolchain exactly once and unconditionally/u,
  );

  const missingMoon = candidate();
  missingMoon.jobs["prepare-release-pr"].steps = missingMoon.jobs["prepare-release-pr"].steps
    .filter((entry) => entry.uses !== "./.github/actions/setup-moon");
  assert.throws(
    () => assertReleaseOperationWorkflow(missingMoon),
    /must set up the pinned Moon toolchain exactly once and unconditionally/u,
  );

  const lateMoon = candidate();
  const releaseSteps = lateMoon.jobs["prepare-release-pr"].steps;
  const moonIndex = releaseSteps.findIndex(
    (entry) => entry.uses === "./.github/actions/setup-moon",
  );
  const [moonSetup] = releaseSteps.splice(moonIndex, 1);
  const releaseCheckIndex = releaseSteps.findIndex((entry) =>
    String(entry.run ?? "").includes("tools/release/release-check.mjs"));
  releaseSteps.splice(releaseCheckIndex + 1, 0, moonSetup);
  assert.throws(
    () => assertReleaseOperationWorkflow(lateMoon),
    /must set up the pinned Moon toolchain exactly once and unconditionally/u,
  );

  const conditionalMoon = candidate();
  conditionalMoon.jobs["prepare-release-pr"].steps.find(
    (entry) => entry.uses === "./.github/actions/setup-moon",
  ).if = "${{ false }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(conditionalMoon),
    /must set up the pinned Moon toolchain exactly once and unconditionally/u,
  );

  const missingRust = candidate();
  missingRust.jobs["prepare-release-pr"].steps = missingRust.jobs["prepare-release-pr"].steps
    .filter((entry) => entry.uses !== "./.github/actions/setup-rust");
  assert.throws(
    () => assertReleaseOperationWorkflow(missingRust),
    /must set up the pinned Rust toolchain exactly once and unconditionally/u,
  );

  const lateRust = candidate();
  const lateRustSteps = lateRust.jobs["prepare-release-pr"].steps;
  const rustIndex = lateRustSteps.findIndex(
    (entry) => entry.uses === "./.github/actions/setup-rust",
  );
  const [rustSetup] = lateRustSteps.splice(rustIndex, 1);
  const lateRustCheckIndex = lateRustSteps.findIndex((entry) =>
    String(entry.run ?? "").includes("tools/release/release-check.mjs"));
  lateRustSteps.splice(lateRustCheckIndex + 1, 0, rustSetup);
  assert.throws(
    () => assertReleaseOperationWorkflow(lateRust),
    /must set up the pinned Rust toolchain exactly once and unconditionally/u,
  );

  const conditionalRust = candidate();
  conditionalRust.jobs["prepare-release-pr"].steps.find(
    (entry) => entry.uses === "./.github/actions/setup-rust",
  ).if = "${{ false }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(conditionalRust),
    /must set up the pinned Rust toolchain exactly once and unconditionally/u,
  );

  const unpreparedMetadataCaller = candidate();
  unpreparedMetadataCaller.jobs["validate-inputs"].steps.push({
    name: "Unprepared release metadata gate",
    run: "tools/dev/bun.sh tools/release/release-metadata-check.mjs",
  });
  assert.throws(
    () => assertReleaseOperationWorkflow(unpreparedMetadataCaller),
    /validate-inputs must set up the pinned Moon toolchain exactly once and unconditionally/u,
  );

  const omittedGate = candidate();
  namedStep(omittedGate, "prepare-release-pr", "Validate release metadata").run =
    "echo release metadata assumed";
  assert.throws(
    () => assertReleaseOperationWorkflow(omittedGate),
    /full release metadata validation must run in exactly/u,
  );

  const omittedRevalidation = candidate();
  const syncReleasePr = namedStep(
    omittedRevalidation,
    "prepare-release-pr",
    "Sync derived release PR files",
  );
  syncReleasePr.run = syncReleasePr.run.replace(
    "tools/dev/bun.sh tools/release/release-metadata-check.mjs",
    "echo release metadata assumed",
  );
  assert.throws(
    () => assertReleaseOperationWorkflow(omittedRevalidation),
    /derived release metadata revalidation must run in exactly/u,
  );
});

test("the direct release workflow validates malformed inputs before operation jobs", () => {
  const skipped = entryCandidate();
  step(skipped, "validate-inputs", "validate_release_inputs").run = "echo assumed-valid";
  assert.throws(
    () => assertReleaseEntryWorkflow(skipped),
    /must actively invoke the unconditional release-input validator/u,
  );

  const conditional = entryCandidate();
  step(conditional, "validate-inputs", "validate_release_inputs").if =
    "${{ inputs.operation == 'publish' }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(conditional),
    /validate every caller-controlled input unconditionally/u,
  );

  const bypassed = entryCandidate();
  bypassed.jobs["publish-dry-run"].needs = [];
  assert.throws(
    () => assertReleaseWorkflow(bypassed),
    /publish-dry-run[.]needs must be/u,
  );

  for (const jobId of ["dispatch-bootstrap-continuation", "dispatch-publish-continuation"]) {
    const undersizedStep = entryCandidate();
    step(undersizedStep, jobId, "dispatch_continuation")["timeout-minutes"] -= 1;
    assert.throws(
      () => assertReleaseEntryWorkflow(undersizedStep),
      /bounded exact dispatched-child authorization receipt/u,
    );

    const undersizedJob = entryCandidate();
    undersizedJob.jobs[jobId]["timeout-minutes"] -= 1;
    assert.throws(
      () => assertReleaseEntryWorkflow(undersizedJob),
      /bound validation, delayed dispatch, authorization upload, and cleanup/u,
    );
  }
});

test("every direct release job retains its exact least-privilege permissions", () => {
  const widened = candidate();
  widened.jobs.publish.permissions.packages = "write";
  assert.throws(
    () => assertReleaseWorkflow(widened),
    /publish permissions must be/u,
  );
});

test("dry-run is a read-only job over the one anchored release-candidate step list", () => {
  const writeCapableDryRun = candidate();
  writeCapableDryRun.jobs["publish-dry-run"].permissions.contents = "write";
  assert.throws(
    () => assertReleaseOperationWorkflow(writeCapableDryRun),
    /publish dry run permissions must be/u,
  );

  const detachedSteps = candidate();
  detachedSteps.jobs["publish-dry-run"].steps = structuredClone(detachedSteps.jobs.publish.steps);
  assert.throws(
    () => assertReleaseOperationWorkflow(detachedSteps),
    /share one canonical release-candidate step list/u,
  );

  const unavailableDryRun = candidate();
  unavailableDryRun.jobs["publish-dry-run"].if =
    "${{ inputs.operation == 'publish-dry-run' && false }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(unavailableDryRun),
    /exact disjoint root-operation conditions/u,
  );

  const nonAppleDryRun = candidate();
  nonAppleDryRun.jobs["publish-dry-run"]["runs-on"] = "ubuntu-24.04";
  assert.throws(
    () => assertReleaseOperationWorkflow(nonAppleDryRun),
    /shared Apple-capable candidate path on macos-26/u,
  );
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

test("Kotlin Maven staging validation stays exact, product-owned, and same-run", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const bypassed = ciCandidate();
  step(bypassed, "kotlin-maven-staging", "kotlin_maven_staging").run = "echo assumed-valid";
  assert.throws(
    () => assertCiWorkflow(bypassed, { builderJobs: BUILDER_JOBS }),
    /must run only the product-owned exact Kotlin Maven staging validator/u,
  );

  const crossRun = ciCandidate();
  namedStep(
    crossRun,
    "kotlin-maven-staging",
    "Download exact same-run Kotlin SDK package artifacts",
  ).with["run-id"] = "123";
  assert.throws(
    () => assertCiWorkflow(crossRun, { builderJobs: BUILDER_JOBS }),
    /must not select another run or a wildcard/u,
  );

  const moved = ciCandidate();
  namedStep(
    moved,
    "kotlin-maven-staging",
    "Download exact same-run Kotlin SDK package artifacts",
  ).with.path = "target/elsewhere";
  assert.throws(
    () => assertCiWorkflow(moved, { builderJobs: BUILDER_JOBS }),
    /must install the exact SDK artifact at its canonical release path/u,
  );
});

test("aggregate jobs run credential-free registry-carrier qualification before handoff", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const missingNativeAggregate = ciCandidate();
  missingNativeAggregate.jobs["extension-packages"].steps =
    missingNativeAggregate.jobs["extension-packages"].steps.filter(
      (step) => step.with?.name !== "liboliphaunt-native-release-assets",
    );
  assert.throws(
    () => assertCiWorkflow(missingNativeAggregate, { builderJobs: BUILDER_JOBS }),
    /must download exact same-run artifact liboliphaunt-native-release-assets once/u,
  );

  const unboundProducts = ciCandidate();
  delete namedStep(
    unboundProducts,
    "extension-packages",
    "Qualify exact-extension registry carriers",
  ).env.OLIPHAUNT_REGISTRY_CARRIER_PRODUCTS_JSON;
  assert.throws(
    () => assertCiWorkflow(unboundProducts, { builderJobs: BUILDER_JOBS }),
    /bind planner-owned exact product selections separately/u,
  );

  const bypassed = ciCandidate();
  namedStep(
    bypassed,
    "liboliphaunt-native-release-assets",
    "Package aggregate liboliphaunt release assets",
  ).run = "true";
  assert.throws(
    () => assertCiWorkflow(bypassed, { builderJobs: BUILDER_JOBS }),
    /aggregate assembly target before local qualification/u,
  );

  const concurrent = ciCandidate();
  const concurrentSteps = concurrent.jobs["extension-packages"].steps;
  const assembly = concurrentSteps.findIndex(
    (entry) => entry.name === "Assemble exact-extension product packages",
  );
  const qualification = concurrentSteps.findIndex(
    (entry) => entry.name === "Qualify exact-extension registry carriers",
  );
  [concurrentSteps[assembly], concurrentSteps[qualification]] = [
    concurrentSteps[qualification],
    concurrentSteps[assembly],
  ];
  assert.throws(
    () => assertCiWorkflow(concurrent, { builderJobs: BUILDER_JOBS }),
    /sequence aggregate assembly, local carrier qualification, then artifact upload/u,
  );

  const gradleCoupled = ciCandidate();
  gradleCoupled.jobs["extension-packages"].steps.splice(2, 0, {
    name: "Set up Android unnecessarily",
    uses: "./.github/actions/setup-android",
  });
  assert.throws(
    () => assertCiWorkflow(gradleCoupled, { builderJobs: BUILDER_JOBS }),
    /must not require Java, Android, or Gradle/u,
  );

  const prematureUpload = ciCandidate();
  const steps = prematureUpload.jobs["extension-packages"].steps;
  const qualificationIndex = steps.findIndex(
    (entry) => entry.name === "Qualify exact-extension registry carriers",
  );
  const upload = steps.findIndex((entry) => String(entry.uses ?? "").startsWith("actions/upload-artifact@"));
  [steps[qualificationIndex], steps[upload]] = [steps[upload], steps[qualificationIndex]];
  assert.throws(
    () => assertCiWorkflow(prematureUpload, { builderJobs: BUILDER_JOBS }),
    /sequence aggregate assembly, local carrier qualification, then artifact upload/u,
  );
});

test("heavy cache writers stay within the primary-builder budget", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const defaultOn = ciCandidate();
  defaultOn.on.workflow_dispatch.inputs.save_heavy_caches.default = true;
  assert.throws(
    () => assertCiWorkflow(defaultOn, { builderJobs: BUILDER_JOBS }),
    /false-by-default boolean opt-in/u,
  );

  const branchWritable = ciCandidate();
  branchWritable.env.HEAVY_CACHE_SAVE_IF =
    "${{ github.event_name == 'workflow_dispatch' && inputs.save_heavy_caches }}";
  assert.throws(
    () => assertCiWorkflow(branchWritable, { builderJobs: BUILDER_JOBS }),
    /manual main runs/u,
  );

  const downstreamRustWriter = ciCandidate();
  namedStep(downstreamRustWriter, "wasix-release-regression", "Set up Rust").with = {
    "cache-save-if": "${{ env.HEAVY_CACHE_SAVE_IF }}",
  };
  assert.throws(
    () => assertCiWorkflow(downstreamRustWriter, { builderJobs: BUILDER_JOBS }),
    /Rust heavy-cache writer inventory/u,
  );

  const crossPlatformLlvmWriters = ciCandidate();
  namedStep(
    crossPlatformLlvmWriters,
    "liboliphaunt-wasix-aot",
    "Install Wasmer LLVM 22.1 for AOT generation",
  ).with["cache-save-if"] = "${{ env.HEAVY_CACHE_SAVE_IF }}";
  assert.throws(
    () => assertCiWorkflow(crossPlatformLlvmWriters, { builderJobs: BUILDER_JOBS }),
    /Wasmer LLVM heavy-cache writer inventory/u,
  );

  const secondGradleWriter = ciCandidate();
  namedStep(secondGradleWriter, "policy-targets", "Set up Android").with = {
    "gradle-cache-save-if": "${{ env.HEAVY_CACHE_SAVE_IF }}",
  };
  assert.throws(
    () => assertCiWorkflow(secondGradleWriter, { builderJobs: BUILDER_JOBS }),
    /Gradle heavy-cache writer inventory/u,
  );

  const deadConsumerScope = ciCandidate();
  namedStep(deadConsumerScope, "test-targets", "Set up Android").with = {
    "gradle-cache-scope-file": "dead-scope.txt",
  };
  assert.throws(
    () => assertCiWorkflow(deadConsumerScope, { builderJobs: BUILDER_JOBS }),
    /must not select unwritable per-consumer cache scopes/u,
  );

  const matrixGradleWriter = ciCandidate();
  matrixGradleWriter.jobs["kotlin-sdk-package"].strategy = {
    matrix: { shard: ["one", "two"] },
  };
  assert.throws(
    () => assertCiWorkflow(matrixGradleWriter, { builderJobs: BUILDER_JOBS }),
    /one fixed Linux x64 package job/u,
  );

  const implicitDownstreamWriter = ciCandidate();
  implicitDownstreamWriter.jobs["kotlin-sdk-package"].steps.push({
    name: "Implicit downstream cache writer",
    uses: "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    with: { key: "forbidden", path: "target" },
  });
  assert.throws(
    () => assertCiWorkflow(implicitDownstreamWriter, { builderJobs: BUILDER_JOBS }),
    /implicit writers/u,
  );

  const releaseWriter = candidate();
  namedStep(releaseWriter, "publish-finalize", "Set up Rust").with = {
    "cache-save-if": "true",
  };
  assert.throws(
    () => assertReleaseOperationWorkflow(releaseWriter),
    /restore but never write Rust caches/u,
  );
});

test("setup-android exposes one false-by-default Gradle writer and no native cache writer", () => {
  assert.doesNotThrow(() => assertSetupAndroidCachePolicy(setupAndroidCandidate()));

  const writableByDefault = setupAndroidCandidate();
  writableByDefault.inputs["gradle-cache-save-if"].default = "true";
  assert.throws(
    () => assertSetupAndroidCachePolicy(writableByDefault),
    /false by default/u,
  );

  const deadScopeInput = setupAndroidCandidate();
  deadScopeInput.inputs["gradle-cache-scope-file"] = {
    required: false,
    default: "",
  };
  assert.throws(
    () => assertSetupAndroidCachePolicy(deadScopeInput),
    /must not expose an unwritable per-consumer Gradle cache scope/u,
  );

  const unguardedWriter = setupAndroidCandidate();
  namedActionStep(unguardedWriter, "Set up Java with Gradle cache").if =
    "${{ inputs.gradle-cache == 'true' }}";
  assert.throws(
    () => assertSetupAndroidCachePolicy(unguardedWriter),
    /explicitly authorized setup-java Gradle cache writer/u,
  );

  const implicitGradleWriter = setupAndroidCandidate();
  const gradleRestore = implicitGradleWriter.runs.steps.find(
    ({ name }) => name === "Restore Gradle dependency cache",
  );
  gradleRestore.uses = gradleRestore.uses.replace("actions/cache/restore@", "actions/cache@");
  assert.throws(
    () => assertSetupAndroidCachePolicy(implicitGradleWriter),
    /must not hide implicit or direct cache writers/u,
  );

  const nativeWriter = setupAndroidCandidate();
  nativeWriter.runs.steps.push({
    name: "Restore native Android ccache",
    uses: "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    with: { key: "forbidden", path: "~/.cache/oliphaunt-ccache/android" },
  });
  assert.throws(
    () => assertSetupAndroidCachePolicy(nativeWriter),
    /must not hide implicit or direct cache writers/u,
  );
});

test("reachable composite caches expose only bounded main writers and writable exact keys", () => {
  assert.doesNotThrow(() =>
    assertReachableCachePolicy(workflowSetCandidate(), localActionsCandidate()));

  const hiddenMonolithicWriter = localActionsCandidate();
  namedActionStep(
    hiddenMonolithicWriter["./.github/actions/setup-node-runtime"],
    "Restore verified Node.js archive",
  ).uses = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), hiddenMonolithicWriter),
    /must not hide monolithic cache writers/u,
  );

  const unguardedArchiveWriter = localActionsCandidate();
  namedActionStep(
    unguardedArchiveWriter["./.github/actions/setup-moon"],
    "Save verified tool archives",
  ).if = "${{ steps.restore_verified_moon_toolchain.outputs.cache-hit != 'true' }}";
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), unguardedArchiveWriter),
    /verified archive save must be main-gated/u,
  );

  const blockingArchiveWriter = localActionsCandidate();
  namedActionStep(
    blockingArchiveWriter["./.github/actions/setup-node-pnpm"],
    "Save verified pnpm archive",
  )["continue-on-error"] = false;
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), blockingArchiveWriter),
    /verified archive save must be main-gated/u,
  );

  const mismatchedArchiveWriter = localActionsCandidate();
  namedActionStep(
    mismatchedArchiveWriter["./.github/actions/setup-npm-publisher"],
    "Save verified npm publisher archive",
  ).with.key += "-mismatch";
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), mismatchedArchiveWriter),
    /non-blocking, and match its restore/u,
  );

  const releaseWriter = workflowSetCandidate();
  releaseWriter.release.env.HEAVY_CACHE_SAVE_IF = "true";
  assert.throws(
    () => assertReachableCachePolicy(releaseWriter, localActionsCandidate()),
    /Release must remain restore-only/u,
  );

  const deadPnpmStore = localActionsCandidate();
  deadPnpmStore["./.github/actions/setup-node-pnpm"].runs.steps.push({
    name: "Restore pnpm store",
    uses: "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    with: { key: "pnpm-store-dead", path: "~/.pnpm-store" },
  });
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), deadPnpmStore),
    /explicit cache restore inventory changed/u,
  );

  const hiddenSetupJavaWriter = localActionsCandidate();
  hiddenSetupJavaWriter["./.github/actions/setup-moon"].runs.steps.push({
    name: "Hidden setup-java writer",
    uses: "actions/setup-java@0f481fcb613427c0f801b606911222b5b6f3083a",
    with: { cache: "gradle", distribution: "temurin", "java-version": "17" },
  });
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), hiddenSetupJavaWriter),
    /setup-java writer inventory changed/u,
  );

  const hiddenRustWriter = localActionsCandidate();
  hiddenRustWriter["./.github/actions/setup-moon"].runs.steps.push({
    name: "Hidden Rust writer",
    uses: "Swatinem/rust-cache@e18b497796c12c097a38f9edb9d0641fb99eee32",
    with: { "save-if": "true" },
  });
  assert.throws(
    () => assertReachableCachePolicy(workflowSetCandidate(), hiddenRustWriter),
    /Rust cache writer inventory changed/u,
  );

  const hiddenBuildkitWriter = workflowSetCandidate();
  hiddenBuildkitWriter.ci.jobs.affected.steps.push({
    name: "Hidden BuildKit writer",
    uses: "docker/build-push-action@bcafcacb16a39f128d818304e6c9c0c18556b85f",
    with: { "cache-to": "type=gha,mode=max" },
  });
  assert.throws(
    () => assertReachableCachePolicy(hiddenBuildkitWriter, localActionsCandidate()),
    /BuildKit cache writer inventory changed/u,
  );
});

test("native exact-extension builds are bounded and hash compiler inputs only", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const unbounded = ciCandidate();
  delete namedStep(
    unbounded,
    "extension-artifacts-native",
    "Build native exact-extension artifacts",
  )["timeout-minutes"];
  assert.throws(
    () => assertCiWorkflow(unbounded, { builderJobs: BUILDER_JOBS }),
    /120-minute step bound below a 135-minute job bound/u,
  );

  const broadExtensionHash = ciCandidate();
  namedStep(
    broadExtensionHash,
    "extension-artifacts-native",
    "Restore native compiler cache",
  ).with.key += ", 'src/extensions/**'";
  assert.throws(
    () => assertCiWorkflow(broadExtensionHash, { builderJobs: BUILDER_JOBS }),
    /exclude policy\/release input 'src\/extensions\/[*][*]'/u,
  );

  const missingSourcePin = ciCandidate();
  const restore = namedStep(
    missingSourcePin,
    "extension-artifacts-native",
    "Restore native compiler cache",
  );
  restore.with.key = restore.with.key.replace("'src/extensions/external/*/source.toml', ", "");
  assert.throws(
    () => assertCiWorkflow(missingSourcePin, { builderJobs: BUILDER_JOBS }),
    /must hash src\/extensions\/external\/[*]\/source[.]toml/u,
  );

  const missingQualificationSpec = ciCandidate();
  const qualificationRestore = namedStep(
    missingQualificationSpec,
    "extension-artifacts-native",
    "Restore native compiler cache",
  );
  qualificationRestore.with.key = qualificationRestore.with.key.replace(
    "'src/extensions/generated/mobile/qualification-static-extensions.tsv', ",
    "",
  );
  assert.throws(
    () => assertCiWorkflow(missingQualificationSpec, { builderJobs: BUILDER_JOBS }),
    /must hash src\/extensions\/generated\/mobile\/qualification-static-extensions[.]tsv/u,
  );

  const uncheckedQualificationSelection = ciCandidate();
  delete namedStep(
    uncheckedQualificationSelection,
    "extension-artifacts-native",
    "Build native exact-extension artifacts",
  ).env.OLIPHAUNT_EXPECTED_QUALIFICATION_SQL_NAMES;
  assert.throws(
    () => assertCiWorkflow(uncheckedQualificationSelection, { builderJobs: BUILDER_JOBS }),
    /matrix-provided deferred qualification selection/u,
  );

  const implicitCompilerWriter = ciCandidate();
  namedStep(
    implicitCompilerWriter,
    "extension-artifacts-native",
    "Restore native compiler cache",
  ).uses = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
  assert.throws(
    () => assertCiWorkflow(implicitCompilerWriter, { builderJobs: BUILDER_JOBS }),
    /implicit writers/u,
  );

  const unguardedSave = ciCandidate();
  step(unguardedSave, "extension-artifacts-native", "save_ios_extension_ccache").if =
    "${{ matrix.target == 'ios-xcframework' }}";
  assert.throws(
    () => assertCiWorkflow(unguardedSave, { builderJobs: BUILDER_JOBS }),
    /direct heavy-cache save must use the bounded heavy-cache policy/u,
  );

  const blockingSave = ciCandidate();
  step(
    blockingSave,
    "extension-artifacts-native",
    "save_ios_extension_ccache",
  )["continue-on-error"] = false;
  assert.throws(
    () => assertCiWorkflow(blockingSave, { builderJobs: BUILDER_JOBS }),
    /direct heavy-cache save must not fail qualification/u,
  );

  const cancellationBlind = ciCandidate();
  step(
    cancellationBlind,
    "extension-artifacts-native",
    "upload_native_extension_logs",
  ).if = "${{ failure() }}";
  assert.throws(
    () => assertCiWorkflow(cancellationBlind, { builderJobs: BUILDER_JOBS }),
    /after failure or cancellation/u,
  );

  const unboundedDiagnostics = ciCandidate();
  step(
    unboundedDiagnostics,
    "extension-artifacts-native",
    "upload_native_extension_logs",
  )["timeout-minutes"] = 10;
  assert.throws(
    () => assertCiWorkflow(unboundedDiagnostics, { builderJobs: BUILDER_JOBS }),
    /five-minute warn-only envelope/u,
  );

  const strictDiagnostics = ciCandidate();
  step(
    strictDiagnostics,
    "extension-artifacts-native",
    "upload_native_extension_logs",
  ).with["if-no-files-found"] = "error";
  assert.throws(
    () => assertCiWorkflow(strictDiagnostics, { builderJobs: BUILDER_JOBS }),
    /five-minute warn-only envelope/u,
  );

  const missingCancellationLog = ciCandidate();
  const upload = step(
    missingCancellationLog,
    "extension-artifacts-native",
    "upload_native_extension_logs",
  );
  upload.with.path = upload.with.path.replace(
    "target/liboliphaunt-mobile-extension-ci/**/*.log\n",
    "",
  );
  assert.throws(
    () => assertCiWorkflow(missingCancellationLog, { builderJobs: BUILDER_JOBS }),
    /must retain target\/liboliphaunt-mobile-extension-ci/u,
  );
});

test("native helper aggregate gates require their same-run matrix producers", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  for (const [aggregate, producer] of [
    ["broker-release-assets", "broker-runtime"],
    ["node-direct-release-assets", "node-direct"],
  ]) {
    const detached = ciCandidate();
    detached.jobs[aggregate].needs = detached.jobs[aggregate].needs
      .filter((job) => job !== producer);
    assert.throws(
      () => assertCiWorkflow(detached, { builderJobs: BUILDER_JOBS }),
      new RegExp(`${aggregate}[.]needs is missing.*${producer}`, "u"),
    );

    const cancellationBlind = ciCandidate();
    cancellationBlind.jobs[aggregate].if =
      `\${{ contains(fromJson(needs.affected.outputs.jobs), '${aggregate}') }}`;
    assert.throws(
      () => assertCiWorkflow(cancellationBlind, { builderJobs: BUILDER_JOBS }),
      new RegExp(`${aggregate} condition does not guarantee`, "u"),
    );

    const bypassed = ciCandidate();
    const verifierId = aggregate === "broker-release-assets"
      ? "verify_aggregate_broker_release_assets"
      : "verify_aggregate_node_direct_release_assets";
    step(bypassed, aggregate, verifierId).run = "true";
    assert.throws(
      () => assertCiWorkflow(bypassed, { builderJobs: BUILDER_JOBS }),
      /must run only its planner-selected aggregate verifier without rebuilding producers/u,
    );
  }
});

test("WASIX deferred candidates are qualified before public extension packaging", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const bypassed = ciCandidate();
  namedStep(
    bypassed,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).run = "true";
  assert.throws(
    () => assertCiWorkflow(bypassed, { builderJobs: BUILDER_JOBS }),
    /exact quoted OLIPHAUNT_EXTENSION_TARGET shell handoff/u,
  );

  const missingBinding = ciCandidate();
  delete namedStep(
    missingBinding,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).env.OLIPHAUNT_EXTENSION_TARGET;
  assert.throws(
    () => assertCiWorkflow(missingBinding, { builderJobs: BUILDER_JOBS }),
    /bind matrix[.]target to step env OLIPHAUNT_EXTENSION_TARGET/u,
  );

  const hardCodedBinding = ciCandidate();
  namedStep(
    hardCodedBinding,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).env.OLIPHAUNT_EXTENSION_TARGET = "wasm32-wasmer-wasi";
  assert.throws(
    () => assertCiWorkflow(hardCodedBinding, { builderJobs: BUILDER_JOBS }),
    /bind matrix[.]target to step env OLIPHAUNT_EXTENSION_TARGET/u,
  );

  const unquotedTarget = ciCandidate();
  namedStep(
    unquotedTarget,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).run = namedStep(
    unquotedTarget,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).run.replace('"$OLIPHAUNT_EXTENSION_TARGET"', "$OLIPHAUNT_EXTENSION_TARGET");
  assert.throws(
    () => assertCiWorkflow(unquotedTarget, { builderJobs: BUILDER_JOBS }),
    /exact quoted OLIPHAUNT_EXTENSION_TARGET shell handoff/u,
  );

  const directExpression = ciCandidate();
  namedStep(
    directExpression,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).run = namedStep(
    directExpression,
    "extension-artifacts-wasix",
    "Verify publication-deferred WASIX candidate build outputs",
  ).run.replace('"$OLIPHAUNT_EXTENSION_TARGET"', "'${{ matrix.target }}'");
  assert.throws(
    () => assertCiWorkflow(directExpression, { builderJobs: BUILDER_JOBS }),
    /exact quoted OLIPHAUNT_EXTENSION_TARGET shell handoff/u,
  );

  const reordered = ciCandidate();
  const wasixSteps = reordered.jobs["extension-artifacts-wasix"].steps;
  const verifierIndex = wasixSteps.findIndex(
    ({ name }) => name === "Verify publication-deferred WASIX candidate build outputs",
  );
  const [verifier] = wasixSteps.splice(verifierIndex, 1);
  const packagerIndex = wasixSteps.findIndex(
    ({ name }) => name === "Build WASIX exact-extension artifacts",
  );
  wasixSteps.splice(packagerIndex + 1, 0, verifier);
  assert.throws(
    () => assertCiWorkflow(reordered, { builderJobs: BUILDER_JOBS }),
    /after the runtime download and before public packaging/u,
  );
});

test("native runtime jobs do not restore stale cross-run build state", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const staleBuildTree = ciCandidate();
  staleBuildTree.jobs["liboliphaunt-native-ios"].steps.push({
    name: "Restore stale native iOS build tree",
    uses: "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    with: { key: "forbidden", path: "target/liboliphaunt-native-ios" },
  });
  assert.throws(
    () => assertCiWorkflow(staleBuildTree, { builderJobs: BUILDER_JOBS }),
    /must not restore cross-run native runtime build trees or compiler caches/u,
  );
});

test("affected target-matrix inventory runs under pinned Node", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const bunOwned = ciCandidate();
  step(bunOwned, "affected", "target-matrices").run =
    "bun .github/scripts/write-affected-moon-target-matrices.mjs check test";
  assert.throws(
    () => assertCiWorkflow(bunOwned, { builderJobs: BUILDER_JOBS }),
    /Node-owned affected Moon target inventory|pinned Node runtime/u,
  );
});

test("generated release readiness blocks CI fanout until normalization", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const missing = ciCandidate();
  missing.jobs["release-intent"].steps = missing.jobs["release-intent"].steps
    .filter((entry) => entry.id !== "generated_release_readiness");
  assert.throws(
    () => assertCiWorkflow(missing, { builderJobs: BUILDER_JOBS }),
    /generated_release_readiness/u,
  );

  const bypassed = ciCandidate();
  step(bypassed, "release-intent", "generated_release_readiness").run = "echo assumed normalized";
  assert.throws(
    () => assertCiWorkflow(bypassed, { builderJobs: BUILDER_JOBS }),
    /generated release fixed-point readiness barrier/u,
  );

  const mutating = ciCandidate();
  step(mutating, "release-intent", "generated_release_readiness").run +=
    "\ntools/dev/bun.sh tools/release/sync-release-pr.mjs";
  assert.throws(
    () => assertCiWorkflow(mutating, { builderJobs: BUILDER_JOBS }),
    /must contain only the cheap fixed-point check/u,
  );

  const widened = ciCandidate();
  step(widened, "release-intent", "generated_release_readiness").if =
    "${{ github.event_name == 'pull_request' }}";
  assert.throws(
    () => assertCiWorkflow(widened, { builderJobs: BUILDER_JOBS }),
    /canonical same-repository release PR branch/u,
  );

  const reordered = ciCandidate();
  const releaseIntentSteps = reordered.jobs["release-intent"].steps;
  const verifierIndex = releaseIntentSteps.findIndex((entry) => entry.id === "release_intent");
  const readinessIndex = releaseIntentSteps.findIndex((entry) => entry.id === "generated_release_readiness");
  [releaseIntentSteps[verifierIndex], releaseIntentSteps[readinessIndex]] =
    [releaseIntentSteps[readinessIndex], releaseIntentSteps[verifierIndex]];
  assert.throws(
    () => assertCiWorkflow(reordered, { builderJobs: BUILDER_JOBS }),
    /release_intent must precede setup_history_repair_node/u,
  );

  const detached = ciCandidate();
  detached.jobs.affected.needs = [];
  assert.throws(
    () => assertCiWorkflow(detached, { builderJobs: BUILDER_JOBS }),
    /affected[.]needs must be/u,
  );
});

test("history repair is bound to one exact qualified transport tree before CI fanout", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));

  const missingGate = ciCandidate();
  missingGate.jobs["release-intent"].steps = missingGate.jobs["release-intent"].steps
    .filter((entry) => entry.id !== "history_repair_qualification");
  assert.throws(
    () => assertCiWorkflow(missingGate, { builderJobs: BUILDER_JOBS }),
    /history_repair_qualification|history-repair transport qualification/u,
  );

  const broadenedEvent = ciCandidate();
  step(broadenedEvent, "release-intent", "history_repair_qualification").run =
    step(broadenedEvent, "release-intent", "history_repair_qualification").run
      .replace("--event workflow_dispatch", "--event push");
  assert.throws(
    () => assertCiWorkflow(broadenedEvent, { builderJobs: BUILDER_JOBS }),
    /must actively bind --event workflow_dispatch/u,
  );

  const driftingDownload = ciCandidate();
  step(driftingDownload, "release-intent", "history_repair_candidate_download").run =
    step(driftingDownload, "release-intent", "history_repair_candidate_download").run
      .replace(/\s+--artifact-metadata-json "\$HISTORY_REPAIR_ARTIFACT_METADATA"/u, "");
  assert.throws(
    () => assertCiWorkflow(driftingDownload, { builderJobs: BUILDER_JOBS }),
    /must actively bind --artifact-metadata-json/u,
  );

  const missingTreeProof = ciCandidate();
  missingTreeProof.jobs["release-intent"].steps = missingTreeProof.jobs["release-intent"].steps
    .filter((entry) => entry.id !== "history_repair_candidate_binding");
  assert.throws(
    () => assertCiWorkflow(missingTreeProof, { builderJobs: BUILDER_JOBS }),
    /history_repair_candidate_binding|candidate tree verifier/u,
  );

  const reordered = ciCandidate();
  const steps = reordered.jobs["release-intent"].steps;
  const downloadIndex = steps.findIndex((entry) => entry.id === "history_repair_candidate_download");
  const verifyIndex = steps.findIndex((entry) => entry.id === "history_repair_candidate_binding");
  [steps[downloadIndex], steps[verifyIndex]] = [steps[verifyIndex], steps[downloadIndex]];
  assert.throws(
    () => assertCiWorkflow(reordered, { builderJobs: BUILDER_JOBS }),
    /history_repair_candidate_download must precede history_repair_candidate_binding/u,
  );

  const branchQualificationDisabled = ciCandidate();
  branchQualificationDisabled.jobs.qualified.if =
    "${{ always() && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' }}";
  assert.throws(
    () => assertCiWorkflow(branchQualificationDisabled, { builderJobs: BUILDER_JOBS }),
    /qualified condition/u,
  );
});

test("Android installed-app E2E jobs reclaim disk and bound emulator storage", () => {
  assert.doesNotThrow(() => assertCiWorkflow(ciCandidate(), { builderJobs: BUILDER_JOBS }));
  assert.doesNotThrow(() => assertMobileWorkflow(mobileCandidate()));

  const unnecessaryPnpmCache = ciCandidate();
  step(unnecessaryPnpmCache, "mobile-e2e-android", "setup_android_e2e_node")
    .uses = "./.github/actions/setup-node-pnpm";
  assert.throws(
    () => assertCiWorkflow(unnecessaryPnpmCache, { builderJobs: BUILDER_JOBS }),
    /must use [.][/][.]github[/]actions[/]setup-node-runtime/u,
  );

  const cachedBuildDependencies = ciCandidate();
  step(cachedBuildDependencies, "mobile-e2e-android", "setup_android_e2e")
    .with["gradle-cache"] = "true";
  assert.throws(
    () => assertCiWorkflow(cachedBuildDependencies, { builderJobs: BUILDER_JOBS }),
    /must not restore the build-only Gradle cache/u,
  );

  const missingReclamation = mobileCandidate();
  missingReclamation.jobs.android.steps = missingReclamation.jobs.android.steps
    .filter((entry) => entry.id !== "reclaim_android_emulator_disk");
  assert.throws(
    () => assertMobileWorkflow(missingReclamation),
    /must contain exactly one stable step id reclaim_android_emulator_disk/u,
  );

  const unboundedPartition = mobileCandidate();
  delete step(unboundedPartition, "android", "start_android_emulator")
    .env.OLIPHAUNT_ANDROID_EMULATOR_PARTITION_SIZE_MB;
  assert.throws(
    () => assertMobileWorkflow(unboundedPartition),
    /must bind the modern-image 6144 MB emulator floor/u,
  );
});

test("automatic continuations use GitHub serialization and an exact child authorization artifact", () => {
  assert.doesNotThrow(() => assertReleaseEntryWorkflow(entryCandidate()));

  const delegatedOperation = entryCandidate();
  delegatedOperation.jobs["prepare-release-pr"] = {
    uses: "./.github/workflows/ci.yml",
  };
  assert.throws(
    () => assertReleaseEntryWorkflow(delegatedOperation),
    /must be implemented directly in the protected release workflow/u,
  );

  const unsupportedQueue = entryCandidate();
  unsupportedQueue.concurrency.queue = "max";
  assert.throws(
    () => assertReleaseEntryWorkflow(unsupportedQueue),
    /may declare only GitHub's group and cancel-in-progress keys/u,
  );

  const cancellingMutations = entryCandidate();
  cancellingMutations.concurrency["cancel-in-progress"] = true;
  assert.throws(
    () => assertReleaseEntryWorkflow(cancellingMutations),
    /cancel-in-progress must be false/u,
  );

  const splitMutationGroup = entryCandidate();
  splitMutationGroup.concurrency.group = "release-${{ inputs.operation }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(splitMutationGroup),
    /concurrency group must be/u,
  );

  const wrongRegistryParent = entryCandidate();
  wrongRegistryParent.jobs["dispatch-publish-continuation"].needs = "publish";
  assert.throws(
    () => assertReleaseEntryWorkflow(wrongRegistryParent),
    /dispatch-publish-continuation[.]needs must be/u,
  );

  for (const [jobId, expectedOperation] of [
    ["dispatch-bootstrap-continuation", "publish-bootstrap"],
    ["dispatch-publish-continuation", "publish"],
  ]) {
    for (const [name, value] of [
      ["EXTRA", "unexpected"],
      ["GH_REPO", "attacker/repository"],
      ["GH_TOKEN", "untrusted-token"],
      ["RELEASE_HEAD_SHA", "0000000000000000000000000000000000000000"],
      ["RELEASE_OPERATION", `${expectedOperation}-wrong`],
    ]) {
      const widened = entryCandidate();
      step(widened, jobId, "dispatch_continuation").env[name] = value;
      assert.throws(
        () => assertReleaseEntryWorkflow(widened),
        new RegExp(`${jobId} must reserve a bounded exact dispatched-child authorization receipt`, "u"),
      );
    }
  }

  const missingAuthorization = entryCandidate();
  missingAuthorization.jobs["dispatch-publish-continuation"].steps =
    missingAuthorization.jobs["dispatch-publish-continuation"].steps.filter(
      (entry) => entry.id !== "preserve_continuation_authorization",
    );
  assert.throws(
    () => assertReleaseEntryWorkflow(missingAuthorization),
    /exactly one stable step id preserve_continuation_authorization/u,
  );

  const replayable = entryCandidate();
  step(replayable, "dispatch-bootstrap-continuation", "preserve_continuation_authorization").if =
    "${{ false }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(replayable),
    /upload the exact returned child-run authorization/u,
  );

  const secretBearing = entryCandidate();
  step(secretBearing, "dispatch-publish-continuation", "dispatch_continuation").env.NPM_TOKEN =
    "${{ secrets.NPM_TOKEN }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(secretBearing),
    /must not receive an environment or registry secrets/u,
  );
});

test("protected release environments expose only their exact secret contracts", () => {
  const wrongEnvironment = candidate();
  wrongEnvironment.jobs["prepare-release-pr"].environment = "release-publish";
  assert.throws(
    () => assertReleaseOperationWorkflow(wrongEnvironment),
    /release jobs must use their isolated protected environments/u,
  );

  const unexpectedSecret = candidate();
  step(unexpectedSecret, "publish-finalize", "promote_github_releases").env.NPM_TOKEN =
    "${{ secrets.NPM_TOKEN }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(unexpectedSecret),
    /publish-finalize must reference exactly its protected-environment secret contract/u,
  );

  const dryRunCredentialExposure = candidate();
  namedStep(dryRunCredentialExposure, "publish-dry-run", "Check publish environment").if =
    "${{ steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(dryRunCredentialExposure),
    /publish-dry-run[.]Check publish environment condition does not guarantee/u,
  );

  const secretBearingValidator = candidate();
  step(secretBearingValidator, "validate-inputs", "validate_release_inputs").env.RELEASE_PR_TOKEN =
    "${{ secrets.RELEASE_PR_TOKEN }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(secretBearingValidator),
    /release input validation must not receive an environment or secrets/u,
  );

  const bracketSecretValidator = candidate();
  step(bracketSecretValidator, "validate-inputs", "validate_release_inputs").env.EXTRA =
    "${{ secrets[\"EXTRA\"] }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(bracketSecretValidator),
    /release input validation must not receive an environment or secrets/u,
  );

  const bracketSecretDispatcher = candidate();
  step(bracketSecretDispatcher, "dispatch-bootstrap-continuation", "dispatch_continuation").env.EXTRA =
    "${{ secrets['EXTRA'] }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(bracketSecretDispatcher),
    /dispatch-bootstrap-continuation must not receive an environment or registry secrets/u,
  );

  const dynamicSecret = candidate();
  step(dynamicSecret, "publish-finalize", "promote_github_releases").env.EXTRA =
    "${{ secrets[inputs.secret_name] }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(dynamicSecret),
    /must use only literal dot or bracket secret references/u,
  );

  const wholeSecretContext = candidate();
  step(wholeSecretContext, "dispatch-publish-continuation", "dispatch_continuation").env.EXTRA =
    "${{ toJSON(SeCrEtS) }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(wholeSecretContext),
    /must use only literal dot or bracket secret references/u,
  );

  const quotedExpressionDelimiter = candidate();
  step(quotedExpressionDelimiter, "dispatch-publish-continuation", "dispatch_continuation").env.EXTRA =
    "${{ format('}}{0}', secrets.EXTRA) }}";
  assert.throws(
    () => assertReleaseEntryWorkflow(quotedExpressionDelimiter),
    /dispatch-publish-continuation must not receive an environment or registry secrets/u,
  );

  const mixedCaseSecret = candidate();
  step(mixedCaseSecret, "publish-finalize", "promote_github_releases").env.EXTRA =
    "${{ SeCrEtS.EXTRA }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(mixedCaseSecret),
    /publish-finalize must reference exactly its protected-environment secret contract/u,
  );

  const reusableTrigger = candidate();
  reusableTrigger.on = { workflow_call: {} };
  assert.throws(
    () => assertReleaseWorkflow(reusableTrigger),
    /Release entry must be manual only/u,
  );
});

test("registry and finalization cannot bypass an upstream successful handoff", () => {
  for (const [jobId, needs] of [
    ["publish-registry", ["validate-inputs"]],
    ["publish-finalize", ["validate-inputs", "publish"]],
  ]) {
    const workflow = candidate();
    workflow.jobs[jobId].needs = needs;
    assert.throws(
      () => assertReleaseOperationWorkflow(workflow),
      /needs must be/u,
      jobId,
    );
  }

  const widened = candidate();
  widened.jobs["publish-finalize"].if = "${{ inputs.operation == 'publish' || github.actor == 'maintainer' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(widened),
    /registry and finalization jobs must run only/u,
  );
});

test("permission and direct-workflow OIDC ceilings fail closed", () => {
  const elevatedFinalize = candidate();
  elevatedFinalize.jobs["publish-finalize"].permissions["id-token"] = "write";
  assert.throws(
    () => assertReleaseOperationWorkflow(elevatedFinalize),
    /publish finalize permissions must be/u,
  );

  const weakenedRegistry = candidate();
  delete weakenedRegistry.jobs["publish-registry"].permissions["id-token"];
  assert.throws(
    () => assertReleaseOperationWorkflow(weakenedRegistry),
    /publish registry permissions must be/u,
  );

  const spoofedVerifier = candidate();
  step(spoofedVerifier, "publish-registry", "verify_registry_oidc_identity").run =
    "# bun .github/scripts/verify-github-oidc-identity.mjs\necho skipped";
  assert.throws(
    () => assertReleaseOperationWorkflow(spoofedVerifier),
    /must actively invoke the registry direct-workflow OIDC verifier/u,
  );
});

test("Maven signing credentials are exercised before either mutation boundary", () => {
  const skipped = candidate();
  step(skipped, "publish", "verify_maven_signing").run = "echo signing assumed";
  assert.throws(
    () => assertReleaseOperationWorkflow(skipped),
    /must actively invoke the pre-mutation Maven signing verifier/u,
  );

  const unbound = candidate();
  step(unbound, "publish-registry", "verify_registry_maven_signing").env
    .ORG_GRADLE_PROJECT_signingInMemoryKeyId = "placeholder";
  assert.throws(
    () => assertReleaseOperationWorkflow(unbound),
    /must bind the exact Maven selection and signing secrets/u,
  );
});

test("Maven, SwiftPM, and JSR pre-mutation tooling cannot be omitted or widened", () => {
  const deadMaven = candidate();
  step(deadMaven, "publish", "preflight_maven_bundle").run = "echo bundle-assumed";
  assert.throws(
    () => assertReleaseOperationWorkflow(deadMaven),
    /must actively invoke the exact pre-mutation Maven Central bundle preflight/u,
  );

  const widenedSwift = candidate();
  step(widenedSwift, "publish", "preflight_swift_source_tag").if =
    "${{ inputs.operation == 'publish' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(widenedSwift),
    /(?:SwiftPM source-tag preflight must run only for an exact selected Swift publish|preflight_swift_source_tag condition does not guarantee)/u,
  );

  const ambientJsr = candidate();
  step(ambientJsr, "publish-registry", "install_registry_jsr_tooling").run =
    "npm install --global jsr";
  assert.throws(
    () => assertReleaseOperationWorkflow(ambientJsr),
    /JSR publication must install the exact lockfile dependencies/u,
  );

  const exhaustedRegistryWindow = candidate();
  step(exhaustedRegistryWindow, "publish-registry", "install_registry_jsr_tooling")["timeout-minutes"] = 10;
  assert.throws(
    () => assertReleaseOperationWorkflow(exhaustedRegistryWindow),
    /(?:JSR publication must install the exact lockfile dependencies|fully bounded registry success path)/u,
  );
});

test("registry capacity assertions cannot be injected through secrets", () => {
  const capacitySecret = candidate();
  step(capacitySecret, "publish-bootstrap", "bootstrap_registry_identities").env
    .CRATES_IO_NEW_CRATE_RUN_CAPACITY = "${{ secrets.CRATES_IO_NEW_CRATE_RUN_CAPACITY }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(capacitySecret),
    /(?:protected-environment secret contract|capacity assertions must never be supplied by mutable workflow secrets)/u,
  );
});

test("capacity admission cannot be ignored, replayed, or bypass the typed handoff", () => {
  const ignored = candidate();
  delete step(ignored, "publish-registry", "exact_registry_publish").if;
  assert.throws(
    () => assertReleaseOperationWorkflow(ignored),
    /exact registry mutation must run only after and consume the immutable execute admission/u,
  );

  const capacityToStartBypass = candidate();
  step(capacityToStartBypass, "publish-registry", "exact_registry_publish").if =
    "${{ steps.reprove_registry_capacity.outputs.admission == 'execute' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(capacityToStartBypass),
    /immutable execute admission file and digest/u,
  );

  const noAdmissionFile = candidate();
  step(noAdmissionFile, "publish-registry", "exact_registry_publish").run =
    step(noAdmissionFile, "publish-registry", "exact_registry_publish").run
      .replace('--registry-admission "$ADMISSION_FILE"', "");
  assert.throws(
    () => assertReleaseOperationWorkflow(noAdmissionFile),
    /registry publication must actively bind --registry-admission/u,
  );

  const rawIds = candidate();
  step(rawIds, "publish-registry", "exact_registry_publish").env.ADMISSION_FILE =
    "${{ steps.reprove_registry_capacity.outputs.admitted_operation_ids_json }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(rawIds),
    /immutable execute admission file and digest/u,
  );

  const recursive = candidate();
  step(recursive, "publish-registry", "record_registry_capacity_deferral").if = "${{ always() }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(recursive),
    /defer admission must seal the exact zero-mutation checkpoint/u,
  );

  const untypedStartShrink = candidate();
  delete step(
    untypedStartShrink,
    "publish-registry",
    "record_registry_capacity_deferral",
  ).env.PRE_MUTATION_DEFERRAL_MODE;
  assert.throws(
    () => assertReleaseOperationWorkflow(untypedStartShrink),
    /typed capacity[/]deadline proof/u,
  );

  const bypass = candidate();
  step(bypass, "publish-registry", "prepare_registry_continuation").if =
    "${{ steps.exact_registry_publish.outputs.deferred == 'true' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(bypass),
    /only a normalized typed deferred result may seal/u,
  );

  const resetLineage = candidate();
  delete step(
    resetLineage,
    "publish-registry",
    "prepare_registry_continuation",
  ).env.RELEASE_CONTINUATION_POINTER;
  assert.throws(
    () => assertReleaseOperationWorkflow(resetLineage),
    /exact parent and stage-handoff bindings/u,
  );

  const substitutedStageHandoff = candidate();
  step(
    substitutedStageHandoff,
    "publish-registry",
    "prepare_registry_continuation",
  ).env.STAGE_HANDOFF_ARTIFACT_DIGEST = "${{ steps.registry_inputs.outputs.approved_artifact_digest }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(substitutedStageHandoff),
    /exact parent and stage-handoff bindings/u,
  );

  const earlyClock = candidate();
  step(earlyClock, "publish-registry", "registry_mutation_deadline").if = "${{ always() }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(earlyClock),
    /authoritative mutation clock must start only after exact execute admission/u,
  );
});

test("bootstrap typed decisions cannot be bypassed by raw publisher outputs", () => {
  const rawPrepare = candidate();
  step(rawPrepare, "publish-bootstrap", "prepare_bootstrap_continuation").if =
    "${{ steps.bootstrap_registry_identities.outputs.deferred == 'true' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(rawPrepare),
    /deferred bootstrap must seal its exact result/u,
  );

  const rawDispatch = candidate();
  rawDispatch.jobs["publish-bootstrap"].outputs.continuation_required =
    "${{ steps.bootstrap_registry_identities.outputs.deferred }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(rawDispatch),
    /continuation dispatch must consume only the normalized typed decision/u,
  );

  const untyped = candidate();
  step(untyped, "publish-bootstrap", "require_bootstrap_execution_decision").run =
    step(untyped, "publish-bootstrap", "require_bootstrap_execution_decision").run
      .replace('elif [[ "$DEFERRAL_MODE" == rate-limit ]]; then', 'elif [[ "$DEFERRAL_MODE" == anything ]]; then');
  assert.throws(
    () => assertReleaseOperationWorkflow(untyped),
    /typed bootstrap execution decision/u,
  );
});

test("every npm publisher installs its pinned Node runtime first", () => {
  for (const [jobId, nodeId, npmId, expectedAction] of [
    ["publish-dry-run", "setup_github_stage_node", "setup_github_stage_npm", "./.github/actions/setup-node-runtime"],
    ["publish", "setup_github_stage_node", "setup_github_stage_npm", "./.github/actions/setup-node-runtime"],
    ["publish-registry", "setup_registry_node", "setup_registry_npm", "./.github/actions/setup-node-pnpm"],
    ["publish-finalize", "setup_finalize_node", "setup_finalize_npm", "./.github/actions/setup-node-runtime"],
    ["publish-bootstrap", "setup_bootstrap_node", "setup_bootstrap_npm", "./.github/actions/setup-node-runtime"],
  ]) {
    const reordered = candidate();
    const steps = reordered.jobs[jobId].steps;
    const nodeIndex = steps.findIndex(({ id }) => id === nodeId);
    const [node] = steps.splice(nodeIndex, 1);
    const npmIndex = steps.findIndex(({ id }) => id === npmId);
    steps.splice(npmIndex + 1, 0, node);
    assert.throws(
      () => assertReleaseOperationWorkflow(reordered),
      /(?:phase setup_.+ must precede|must install its digest-verified pinned Node runtime before (?:its npm publisher|every executable node command))/u,
    );

    const ambient = candidate();
    step(ambient, jobId, nodeId).uses = "./.github/actions/setup-bun";
    assert.throws(
      () => assertReleaseOperationWorkflow(ambient),
      new RegExp(`must use ${expectedAction.replaceAll(".", "[.]").replaceAll("/", "[/]")}`, "u"),
    );

  }
});

test("external-extension dry-runs consume only the exact npm setup outputs", () => {
  for (const name of ["OLIPHAUNT_VERIFIED_NODE_EXECUTABLE", "OLIPHAUNT_VERIFIED_NPM_CLI"]) {
    const ambient = candidate();
    step(ambient, "publish", "validate_product_dry_runs").env[name] = name.endsWith("NPM_CLI") ? "npm" : "node";
    assert.throws(
      () => assertReleaseOperationWorkflow(ambient),
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
    () => assertReleaseOperationWorkflow(separated),
    /product dry-runs must immediately consume the exact Node[/]npm paths exported by their pinned setup/u,
  );
});

test("direct release jobs pin Node before every executable node command", () => {
  for (const [jobId, nodeId] of [
    ["publish", "setup_github_stage_node"],
    ["publish-bootstrap", "setup_bootstrap_node"],
  ]) {
    const ambient = candidate();
    step(ambient, jobId, nodeId).uses = "./.github/actions/setup-bun";
    assert.throws(
      () => assertReleaseOperationWorkflow(ambient),
      /(?:must use [.][/][.]github[/]actions[/]setup-node-runtime|must have exactly one digest-verified pinned Node setup before executable node commands)/u,
    );
  }

  for (const jobId of ["dispatch-bootstrap-continuation", "dispatch-publish-continuation"]) {
    const ambient = entryCandidate();
    step(ambient, jobId, "setup_dispatch_node").uses = "./.github/actions/setup-bun";
    assert.throws(
      () => assertReleaseEntryWorkflow(ambient),
      /must use [.][/][.]github[/]actions[/]setup-node-runtime/u,
    );

    const reordered = entryCandidate();
    const steps = reordered.jobs[jobId].steps;
    const nodeIndex = steps.findIndex(({ id }) => id === "setup_dispatch_node");
    const [node] = steps.splice(nodeIndex, 1);
    const dispatchIndex = steps.findIndex(({ id }) => id === "dispatch_continuation");
    steps.splice(dispatchIndex + 1, 0, node);
    assert.throws(
      () => assertReleaseEntryWorkflow(reordered),
      /must install its digest-verified pinned Node runtime before every executable node command/u,
    );
  }
});

test("release artifact capture and recovery entrypoints use only their audited runtimes", () => {
  const buildArtifact = candidate();
  namedStep(buildArtifact, "publish", "Download exact-SHA qualification record").run =
    namedStep(buildArtifact, "publish", "Download exact-SHA qualification record").run
      .replace("node .github/scripts/download-build-artifacts.mjs", "bun .github/scripts/download-build-artifacts.mjs");
  assert.throws(
    () => assertReleaseOperationWorkflow(buildArtifact),
    /every download-build-artifacts[.]mjs invocation must use the pinned Node runtime/u,
  );

  const normalRecovery = candidate();
  step(normalRecovery, "publish-registry", "restore_normal_publication_checkpoint").run =
    "bun .github/scripts/download-normal-publication-checkpoint.mjs";
  assert.throws(
    () => assertReleaseOperationWorkflow(normalRecovery),
    /every download-normal-publication-checkpoint[.]mjs invocation must use the pinned Bun launcher/u,
  );

  const bootstrapRecovery = candidate();
  step(bootstrapRecovery, "publish-bootstrap", "restore_bootstrap_checkpoint").run =
    "bun .github/scripts/download-bootstrap-ledger.mjs";
  assert.throws(
    () => assertReleaseOperationWorkflow(bootstrapRecovery),
    /every download-bootstrap-ledger[.]mjs invocation must use the pinned Node runtime/u,
  );
});

test("cross-job handoffs require immutable current-run artifact IDs and active validation", () => {
  const byName = candidate();
  const registryDownload = downloadByArtifactId(byName, "publish-registry");
  delete registryDownload.with["artifact-ids"];
  registryDownload.with.name = "github-stage-handoff-attacker-controlled";
  assert.throws(
    () => assertReleaseOperationWorkflow(byName),
    /must download exact current-run artifact id/u,
  );

  const crossRun = candidate();
  downloadByArtifactId(crossRun, "publish-finalize").with["run-id"] = "${{ github.event.inputs.run_id }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(crossRun),
    /handoff download must use only its exact current-run artifact id/u,
  );

  const deadInstaller = candidate();
  step(deadInstaller, "publish-finalize", "install_registry_handoff").run = [
    "# tools/dev/bun.sh tools/release/release-phase-handoff.mjs install --phase registry-published",
    "echo not-validated",
  ].join("\n");
  assert.throws(
    () => assertReleaseOperationWorkflow(deadInstaller),
    /must actively invoke the validated registry handoff installer/u,
  );

  const nodeMismatch = candidate();
  step(nodeMismatch, "publish-finalize", "install_registry_handoff").run =
    step(nodeMismatch, "publish-finalize", "install_registry_handoff").run
      .replace("tools/dev/bun.sh", "node");
  assert.throws(
    () => assertReleaseOperationWorkflow(nodeMismatch),
    /must actively invoke the validated registry handoff installer/u,
  );

  const unboundApproval = candidate();
  step(unboundApproval, "publish-registry", "download_approved_publication_inputs").run =
    step(unboundApproval, "publish-registry", "download_approved_publication_inputs").run
      .replace('--artifact-metadata-json "$APPROVED_ARTIFACT_METADATA_JSON"', "");
  assert.throws(
    () => assertReleaseOperationWorkflow(unboundApproval),
    /approved registry input transfer must actively bind/u,
  );
});

test("GitHub pacing state remains bound to one root release lineage through finalization", () => {
  const resetRoot = candidate();
  step(resetRoot, "publish", "github_stage_job_deadline").run =
    step(resetRoot, "publish", "github_stage_job_deadline").run
      .replace("OLIPHAUNT_RELEASE_ROOT_RUN_ID=$GITHUB_RUN_ID", "OLIPHAUNT_RELEASE_ROOT_RUN_ID=$GITHUB_RUN_ATTEMPT");
  assert.throws(
    () => assertReleaseOperationWorkflow(resetRoot),
    /root release pacing lineage initialization/u,
  );

  const missingRootOutput = candidate();
  delete missingRootOutput.jobs["publish-registry"].outputs.root_run_id;
  assert.throws(
    () => assertReleaseOperationWorkflow(missingRootOutput),
    /registry outputs must expose the exact receipt handoff or verified continuation identity/u,
  );

  const resetFinalize = candidate();
  step(resetFinalize, "publish-finalize", "install_registry_handoff").env.RELEASE_ROOT_RUN_ID =
    "${{ github.run_id }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(resetFinalize),
    /restore the exact verified root release lineage/u,
  );

  const missingDeadlineBridge = candidate();
  step(missingDeadlineBridge, "publish-finalize", "finalize_job_deadline").run =
    step(missingDeadlineBridge, "publish-finalize", "finalize_job_deadline").run
      .replace("REGISTRY_JOB_HARD_DEADLINE_EPOCH=$hard_deadline", "");
  assert.throws(
    () => assertReleaseOperationWorkflow(missingDeadlineBridge),
    /finalization pacing deadline bridge/u,
  );
});

test("normal continuations carry and monotonically merge exact GitHub pacing state", () => {
  const optionalEarlyJournal = candidate();
  step(optionalEarlyJournal, "publish-registry", "registry_job_deadline").run =
    step(optionalEarlyJournal, "publish-registry", "registry_job_deadline").run
      .replace("OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL=true", "");
  assert.throws(
    () => assertReleaseOperationWorkflow(optionalEarlyJournal),
    /pre-install registry GitHub read journal/u,
  );

  const unboundInspection = candidate();
  delete step(
    unboundInspection,
    "publish-registry",
    "inspect_registry_continuation",
  ).env.RELEASE_CONTINUATION_GITHUB_CORE_JOURNAL_PATH;
  assert.throws(
    () => assertReleaseOperationWorkflow(unboundInspection),
    /extract the contract-bound GitHub state/u,
  );

  const skippedMerge = candidate();
  step(skippedMerge, "publish-registry", "install_github_stage_handoff").run =
    step(skippedMerge, "publish-registry", "install_github_stage_handoff").run
      .replace("node .github/scripts/install-release-continuation-github-state.mjs", "echo state-assumed");
  assert.throws(
    () => assertReleaseOperationWorkflow(skippedMerge),
    /must actively invoke the continuation-safe GitHub state installer/u,
  );

  const substitutedParent = candidate();
  step(
    substitutedParent,
    "publish-registry",
    "install_github_stage_handoff",
  ).env.RELEASE_CONTINUATION_GITHUB_STATE_JSON = "{}";
  assert.throws(
    () => assertReleaseOperationWorkflow(substitutedParent),
    /install and merge the latest exact continuation GitHub state/u,
  );

  const droppedJournal = candidate();
  step(droppedJournal, "publish-registry", "preserve_deferred_registry_recovery").with.path =
    step(droppedJournal, "publish-registry", "preserve_deferred_registry_recovery").with.path
      .replace("target/release/oliphaunt-github-core-request-journal.json", "");
  assert.throws(
    () => assertReleaseOperationWorkflow(droppedJournal),
    /partial checkpoint\/result\/contract and GitHub state|pacer, and core-request journal/u,
  );
});

test("dry-run evidence cannot be relabeled as publish evidence or omit the capsule", () => {
  const widenedMutation = candidate();
  step(widenedMutation, "publish", "stage_github_releases").if =
    "${{ steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(widenedMutation),
    /condition does not guarantee/u,
  );

  const missingCapsule = candidate();
  step(missingCapsule, "publish", "approved_publication_lock").run =
    step(missingCapsule, "publish", "approved_publication_lock").run
      .replace("--artifact oliphaunt-bootstrap-capsule", "");
  assert.throws(
    () => assertReleaseOperationWorkflow(missingCapsule),
    /approved dry-run selection must actively bind --artifact oliphaunt-bootstrap-capsule/u,
  );

  const mislabeledLock = candidate();
  step(mislabeledLock, "publish", "preserve_publication_lock").if =
    "${{ inputs.operation == 'publish' && steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(mislabeledLock),
    /condition does not guarantee/u,
  );
});

test("root-admitted immutable transport and recovery blocking cannot be skipped", () => {
  const skippedTransport = candidate();
  step(skippedTransport, "publish", "ensure_release_transport_ref").run = "echo assumed-transport";
  assert.throws(
    () => assertReleaseOperationWorkflow(skippedTransport),
    /must actively invoke the immutable exact-SHA continuation transport/u,
  );

  const downstreamMainDependency = candidate();
  step(downstreamMainDependency, "publish-finalize", "reverify_publication_lock").run =
    `bash .github/scripts/require-current-main.sh "$RELEASE_HEAD_SHA"\n${step(
      downstreamMainDependency,
      "publish-finalize",
      "reverify_publication_lock",
    ).run}`;
  assert.throws(
    () => assertReleaseOperationWorkflow(downstreamMainDependency),
    /publish-finalize must keep current-main proof inside the idempotent transport boundary or remain bound to the exact release SHA/u,
  );

  const continuationCanCreateTransport = candidate();
  step(
    continuationCanCreateTransport,
    "publish-bootstrap",
    "ensure_bootstrap_transport_ref",
  ).if = "${{ steps.bootstrap_scope.outputs.required == 'true' }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(continuationCanCreateTransport),
    /condition does not guarantee.*continuation_pointer/u,
  );

  const swallowedFailure = candidate();
  step(swallowedFailure, "publish-registry", "preserve_failed_registry_recovery").if = "${{ always() }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(swallowedFailure),
    /failed recovery evidence must run only after/u,
  );

  const unconditionalComplete = candidate();
  step(unconditionalComplete, "publish-registry", "preserve_complete_registry_recovery").if =
    "${{ always() }}";
  assert.throws(
    () => assertReleaseOperationWorkflow(unconditionalComplete),
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
    () => assertReleaseOperationWorkflow(oversizedTransfer),
    /timeouts must exactly match their phase allowances/u,
  );

  const oversizedFinalizeSetup = candidate();
  namedStep(oversizedFinalizeSetup, "publish-finalize", "Set up Rust")["timeout-minutes"] += 2;
  assert.throws(
    () => assertReleaseOperationWorkflow(oversizedFinalizeSetup),
    /pre-finalization setup\/handoff operation must be bounded/u,
  );

  const unboundedRegistryStep = candidate();
  delete step(unboundedRegistryStep, "publish-registry", "verify_registry_github_staging")["timeout-minutes"];
  assert.throws(
    () => assertReleaseOperationWorkflow(unboundedRegistryStep),
    /every registry success-path operation after deadline admission must have a positive timeout/u,
  );

  for (const [jobId, stepId] of [
    ["publish-registry", "inspect_registry_continuation"],
    ["publish-bootstrap", "inspect_bootstrap_continuation"],
  ]) {
    const undersizedContinuationInspection = candidate();
    step(undersizedContinuationInspection, jobId, stepId)["timeout-minutes"] = 52;
    assert.throws(
      () => assertReleaseOperationWorkflow(undersizedContinuationInspection),
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
    () => assertReleaseOperationWorkflow(undersizedContinuationPreparation),
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
    () => assertReleaseOperationWorkflow(directPublish),
    /performs unapproved unmediated_package_publish mutation/u,
  );

  const afterPromotion = candidate();
  afterPromotion.jobs["publish-finalize"].steps.push({
    id: "after_promotion",
    run: "echo too-late",
  });
  assert.throws(
    () => assertReleaseOperationWorkflow(afterPromotion),
    /promote_github_releases must be the literal final step/u,
  );

  const promotedEarly = candidate();
  const steps = promotedEarly.jobs["publish-finalize"].steps;
  const promotion = steps.pop();
  const evidenceIndex = steps.findIndex((entry) => entry.id === "preserve_pre_promotion_evidence");
  steps.splice(evidenceIndex, 0, promotion);
  assert.throws(
    () => assertReleaseOperationWorkflow(promotedEarly),
    /preserve_pre_promotion_evidence must precede promote_github_releases/u,
  );
});
