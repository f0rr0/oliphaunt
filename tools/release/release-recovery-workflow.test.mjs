#!/usr/bin/env bun

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");

function workflow() {
  return Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8"),
  );
}

function namedStep(job, name) {
  const matches = job.steps.filter((step) => step?.name === name);
  assert.equal(matches.length, 1, `${name} must occur exactly once`);
  return matches[0];
}

function stepIndex(job, name) {
  const index = job.steps.findIndex((step) => step?.name === name);
  assert.notEqual(index, -1, `${name} must exist`);
  return index;
}

test("tag planning uses only a fully verified recovery source", () => {
  const parsed = workflow();
  for (const [jobId, name] of [
    ["publish-dry-run", "Plan product releases"],
    ["publish", "Plan product releases"],
    ["publish-registry", "Recompute exact continued release plan"],
    ["publish-bootstrap", "Plan bootstrap releases"],
  ]) {
    const plan = namedStep(parsed.jobs[jobId], name);
    const resolver = plan.run.indexOf(
      "tools/release/verify-publication-candidate.mjs",
    );
    const planner = plan.run.indexOf("tools/release/release_plan.mjs");
    assert(resolver >= 0 && resolver < planner, `${jobId} must verify recovery before tag planning`);
    assert.equal(
      (plan.run.match(/--resolve-plan-head/gu) ?? []).length,
      1,
      `${jobId} must resolve exactly one verified planning head`,
    );
    assert.equal(
      (plan.run.match(/--head-ref "\$RELEASE_HEAD_SHA"/gu) ?? []).length,
      1,
      `${jobId} resolver must bind the exact workflow commit`,
    );
    assert.equal(
      (plan.run.match(/--head-ref "\$planning_head"/gu) ?? []).length,
      1,
      `${jobId} planner must consume only the verified planning head`,
    );
    assert.match(plan.run, /--github-output "\$GITHUB_OUTPUT"/u);
    assert.match(plan.run, /planning_head.*\^\[0-9a-f\]\{40\}/su);
  }

  const root = parsed.jobs["publish-dry-run"];
  assert.equal(
    namedStep(
      root,
      "Prove workflow HEAD is a release or same-version recovery commit",
    ).if,
    "${{ steps.release_plan.outputs.has_release_changes == 'true' || steps.release_plan.outputs.plan_recovery == 'true' }}",
  );
  assert.equal(
    namedStep(root, "No package release planned").if,
    "${{ steps.release_plan.outputs.has_release_changes != 'true' && steps.release_plan.outputs.plan_recovery != 'true' }}",
  );

  const bootstrap = parsed.jobs["publish-bootstrap"];
  assert.equal(
    namedStep(
      bootstrap,
      "Prove workflow HEAD is a release or same-version recovery commit",
    ).if,
    "${{ steps.bootstrap_scope.outputs.required == 'true' || steps.release_plan.outputs.plan_recovery == 'true' }}",
  );
  assert.equal(
    namedStep(bootstrap, "Reject same-version recovery bootstrap mutation").if,
    "${{ steps.verify_bootstrap_publication_candidate.outputs.mode == 'release-recovery' }}",
  );
});

test("dry-run separately qualifies control HEAD and reuses the frozen release payload", () => {
  const job = workflow().jobs["publish-dry-run"];
  const candidate = namedStep(
    job,
    "Prove workflow HEAD is a release or same-version recovery commit",
  );
  assert.equal(candidate.id, "verify_publication_candidate");
  assert.match(candidate.run, /verify-publication-candidate[.]mjs/u);
  assert.match(candidate.run, /--github-output "\$GITHUB_OUTPUT"/u);

  const controlCi = namedStep(job, "Require qualified release-commit CI run");
  const payloadCi = namedStep(
    job,
    "Require qualified frozen-payload CI run for same-version recovery",
  );
  const artifactSource = namedStep(job, "Resolve exact release artifact source");
  assert.match(controlCi.run, /"\$RELEASE_CONTROL_SHA"/u);
  assert.match(payloadCi.run, /"\$RECOVERY_RELEASE_SHA"/u);
  assert.match(
    payloadCi.env.RECOVERY_RELEASE_SHA,
    /verify_publication_candidate[.]outputs[.]release_sha/u,
  );
  assert.match(payloadCi.run, /--job Required/u);
  assert.match(payloadCi.run, /--job Qualified/u);
  assert.match(payloadCi.run, /PINNED_ARTIFACT_METADATA_JSON/u);
  assert.match(
    payloadCi.run,
    /qualification_args\+=\(--artifact "\$artifact"\)/u,
  );
  assert.match(
    payloadCi.run,
    /Frozen-payload CI artifact inventory differs from the pinned recovery provenance/u,
  );
  assert.match(artifactSource.run, /CANDIDATE_MODE.*release-recovery/su);
  assert.match(artifactSource.run, /artifact_sha="\$RECOVERY_RELEASE_SHA"/u);
  assert.match(
    artifactSource.run,
    /artifact_ci_run_id="\$RECOVERY_PAYLOAD_CI_RUN_ID"/u,
  );
  const identity = namedStep(
    job,
    "Resolve exact release source and controller identities",
  );
  assert.match(identity.run, /source_sha="\$RECOVERY_RELEASE_SHA"/u);
  assert.match(identity.run, /RELEASE_CONTROL_SHA=\$CONTROL_SHA/u);
  assert.match(identity.run, /RELEASE_SOURCE_SHA=\$source_sha/u);
  assert(
    stepIndex(job, "Require qualified release-commit CI run")
      < stepIndex(
        job,
        "Require qualified frozen-payload CI run for same-version recovery",
      ),
  );
  assert(
    stepIndex(
      job,
      "Require qualified frozen-payload CI run for same-version recovery",
    ) < stepIndex(job, "Resolve exact release artifact source"),
  );

  const payloadCandidate = namedStep(
    job,
    "Verify frozen-payload qualification record",
  );
  assert.match(
    payloadCandidate.env.CI_RUN_ID,
    /release_artifact_source[.]outputs[.]ci_run_id/u,
  );
  assert.match(
    payloadCandidate.env.RELEASE_HEAD_SHA,
    /release_artifact_source[.]outputs[.]sha/u,
  );
  assert.match(
    payloadCandidate.run,
    /target\/recovery-payload-candidate\/oliphaunt-release-candidate[.]json/u,
  );

  for (const name of [
    "Download WASIX release assets",
    "Download exact-extension package artifacts",
    "Download SDK package artifacts",
    "Download liboliphaunt release assets",
    "Download native helper release assets",
    "Download Node direct optional npm packages",
  ]) {
    const step = namedStep(job, name);
    assert.match(
      step.env.CI_RUN_ID,
      /release_artifact_source[.]outputs[.]ci_run_id/u,
      `${name} must use the frozen payload CI run`,
    );
    assert.match(
      step.run,
      /\$RELEASE_ARTIFACT_SHA/u,
      `${name} must use the frozen payload SHA`,
    );
    assert.doesNotMatch(
      step.run,
      /"\$RELEASE_HEAD_SHA"/u,
      `${name} must not download rebuilt recovery-HEAD artifacts`,
    );
  }
  const wasixPayload = namedStep(job, "Download WASIX runtime build artifacts");
  assert.match(
    wasixPayload.env.CI_RUN_ID,
    /release_artifact_source[.]outputs[.]ci_run_id/u,
  );
  assert.match(
    wasixPayload.env.RELEASE_ARTIFACT_SHA,
    /release_artifact_source[.]outputs[.]sha/u,
  );
  assert.equal(
    wasixPayload.env.RELEASE_HEAD_SHA,
    undefined,
    "the payload selector must not replace the controller-bound release lineage",
  );

  const productDryRun = namedStep(
    job,
    "Validate selected release product dry-runs",
  );
  assert.match(
    productDryRun.env.CI_RUN_ID,
    /steps[.]ci_qualification[.]outputs[.]run_id/u,
  );
  assert.match(productDryRun.run, /--head-ref "\$RELEASE_SOURCE_SHA"/u);
  assert.doesNotMatch(productDryRun.run, /--head-ref "\$RELEASE_HEAD_SHA"/u);

  const markable = namedStep(
    job,
    "Prove Release Please PR can complete after publication",
  );
  assert.match(
    markable.run,
    /steps[.]verify_publication_candidate[.]outputs[.]release_sha/u,
  );
  assert.doesNotMatch(markable.run, /--release-sha "\$RELEASE_HEAD_SHA"/u);

  assert(
    stepIndex(job, "Select original approved lock for same-version recovery")
      < stepIndex(job, "Freeze exhaustive publication lock"),
  );
  const prelockRegistryValidation = namedStep(
    job,
    "Validate product versions and registry state",
  );
  assert.doesNotMatch(
    prelockRegistryValidation.run,
    /--registry-inventory-output/u,
  );
  assert.match(
    prelockRegistryValidation.run,
    /check_release_versions[.]mjs/u,
  );
  assert(
    stepIndex(job, "Freeze exhaustive publication lock")
      < stepIndex(job, "Prove same-version recovery byte envelope is unchanged"),
  );
  const freeze = namedStep(job, "Freeze exhaustive publication lock");
  assert.match(freeze.run, /lock_output=target\/release\/replayed-publication-lock[.]json/u);
  assert.match(freeze.run, /lock_source="\$RELEASE_ARTIFACT_SHA"/u);
  assert.match(freeze.run, /cmp -s "\$original_lock" "\$lock_output"/u);
  assert.match(freeze.run, /cp "\$original_lock" "\$PUBLICATION_LOCK_PATH"/u);
  assert(
    stepIndex(job, "Prove same-version recovery byte envelope is unchanged")
      < stepIndex(
        job,
        "Inventory exact frozen registry state for same-version recovery",
      ),
  );
  assert(
    stepIndex(
      job,
      "Inventory exact frozen registry state for same-version recovery",
    )
      < stepIndex(
        job,
        "Prove same-version recovery follows a partial immutable publication",
      ),
  );
  assert(
    stepIndex(
      job,
      "Prove same-version recovery follows a partial immutable publication",
    )
      < stepIndex(job, "Upload same-version recovery equivalence evidence"),
  );
  const equivalence = namedStep(
    job,
    "Prove same-version recovery byte envelope is unchanged",
  );
  assert.match(equivalence.run, /verify-release-recovery-lock[.]mjs/u);
  assert.match(
    equivalence.run,
    /--replay-lock target\/release\/replayed-publication-lock[.]json/u,
  );
  assert.match(equivalence.run, /--controller-sha "\$RELEASE_CONTROL_SHA"/u);
  assert.match(
    equivalence.if,
    /verify_publication_candidate[.]outputs[.]mode == 'release-recovery'/u,
  );
  const inventory = namedStep(
    job,
    "Inventory exact frozen registry state for same-version recovery",
  );
  assert.equal(
    inventory.env.OLIPHAUNT_PUBLICATION_LOCK,
    "${{ env.PUBLICATION_LOCK_PATH }}",
  );
  assert.match(inventory.run, /release-check-registries[.]mjs/u);
  assert.match(
    inventory.run,
    /--registry-inventory-output target\/release\/recovery-registry-inventory[.]json/u,
  );
  const publication = namedStep(
    job,
    "Prove same-version recovery follows a partial immutable publication",
  );
  assert.match(publication.run, /verify-release-recovery-publication[.]mjs/u);
  assert.match(publication.run, /recovery-registry-inventory[.]json/u);
  const evidence = namedStep(
    job,
    "Upload same-version recovery equivalence evidence",
  );
  assert.equal(evidence.with.path, "target/release/recovery-evidence");
  const ledger = namedStep(job, "Download immutable registry bootstrap ledger");
  assert.match(
    ledger.env.PINNED_LEDGER_RUN_ID,
    /steps[.]recovery_source[.]outputs[.]bootstrap_ledger_run_id/u,
  );
  assert.match(
    ledger.env.PINNED_LEDGER_ARTIFACT_METADATA_JSON,
    /steps[.]recovery_source[.]outputs[.]bootstrap_ledger_artifact_metadata_json/u,
  );
  assert.match(ledger.run, /--run-id "\$PINNED_LEDGER_RUN_ID"/u);
  assert.match(
    ledger.run,
    /--artifact-metadata-json "\$PINNED_LEDGER_ARTIFACT_METADATA_JSON"/u,
  );

  const promotion = namedStep(
    job,
    "Prepare same-version recovery promotion attestation",
  );
  assert.match(
    promotion.env.CONTROLLER_CI_RUN_ID,
    /steps[.]ci_qualification[.]outputs[.]run_id/u,
  );
  assert.match(
    promotion.env.CONTROLLER_CI_RUN_ATTEMPT,
    /steps[.]ci_qualification[.]outputs[.]run_attempt/u,
  );
  assert.match(
    promotion.env.CONTROLLER_CI_ARTIFACTS_JSON,
    /steps[.]ci_qualification[.]outputs[.]artifact_metadata_json/u,
  );
  assert.match(
    promotion.env.CONTROLLER_APPROVAL_RUN_ID,
    /steps[.]approved_recovery_control[.]outputs[.]run_id/u,
  );
  assert.match(
    promotion.env.CONTROLLER_APPROVAL_RUN_ATTEMPT,
    /steps[.]approved_recovery_control[.]outputs[.]run_attempt/u,
  );
  assert.match(
    promotion.env.CONTROLLER_APPROVAL_ARTIFACTS_JSON,
    /steps[.]approved_recovery_control[.]outputs[.]artifact_metadata_json/u,
  );
  assert.match(promotion.run, /recovery-promotion-attestation[.]mjs prepare/u);
  assert.match(promotion.run, /--controller-sha "\$RELEASE_CONTROL_SHA"/u);
  assert.match(promotion.run, /--approval target\/release\/recovery-evidence\/lock-equivalence[.]json/u);
  assert.match(
    promotion.run,
    /--approval-run-id "\$CONTROLLER_APPROVAL_RUN_ID"/u,
  );
  assert.match(
    promotion.run,
    /--approval-run-attempt "\$CONTROLLER_APPROVAL_RUN_ATTEMPT"/u,
  );
  assert.match(
    promotion.run,
    /--approval-artifacts-json "\$CONTROLLER_APPROVAL_ARTIFACTS_JSON"/u,
  );

  const attestPromotion = namedStep(
    job,
    "Attest same-version recovery promotion",
  );
  assert.equal(
    attestPromotion.uses,
    "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
  );
  assert.match(
    attestPromotion.with["subject-checksums"],
    /recovery_promotion_attestation[.]outputs[.]checksums_path/u,
  );
  assert.match(
    attestPromotion.with["predicate-type"],
    /recovery_promotion_attestation[.]outputs[.]predicate_type/u,
  );
  assert.match(
    attestPromotion.with["predicate-path"],
    /recovery_promotion_attestation[.]outputs[.]predicate_path/u,
  );

  for (const name of [
    "Attest selected extension release assets (shard 1)",
    "Attest selected extension release assets (shard 2)",
    "Attest liboliphaunt release assets",
    "Attest broker release assets",
    "Attest Node direct release assets",
    "Attest WASIX release assets",
  ]) {
    assert.match(
      namedStep(job, name).if,
      /verify_publication_candidate[.]outputs[.]mode != 'release-recovery'/u,
      `${name} must not claim ordinary build provenance for frozen recovery bytes`,
    );
  }
  const freezeEvidence = namedStep(
    job,
    "Freeze exact GitHub release asset and attestation evidence",
  );
  assert.match(
    freezeEvidence.env.RECOVERY_PROMOTION_ATTESTATION_BUNDLE,
    /attest_recovery_promotion[.]outputs[.]bundle-path/u,
  );
  assert.match(
    freezeEvidence.run,
    /--recovery-controller target\/release\/recovery-evidence\/promotion-controller[.]json/u,
  );
  assert.match(
    freezeEvidence.run,
    /--recovery-provenance tools\/release\/same-version-recovery-sources[.]json/u,
  );
  assert.match(
    freezeEvidence.run,
    /--recovery-approval target\/release\/recovery-evidence\/lock-equivalence[.]json/u,
  );

  for (const name of [
    "Freeze bootstrap publication capsule",
    "Upload frozen publication lock",
    "Upload frozen bootstrap publication capsule",
  ]) {
    assert.match(
      namedStep(job, name).if,
      /verify_publication_candidate[.]outputs[.]mode != 'release-recovery'/u,
      `${name} must not relabel original release inputs under the controller run`,
    );
  }
});

test("publication separately approves immutable source inputs and controller recovery evidence", () => {
  const parsed = workflow();
  const publish = parsed.jobs.publish;
  assert.equal(publish.permissions["artifact-metadata"], "write");
  const approved = namedStep(publish, "Require one approved dry-run lock and capsule");
  assert.match(approved.run, /--run-id "\$PINNED_DRY_RUN_ID"/u);
  assert.match(
    approved.run,
    /approval_sha="\$RELEASE_SOURCE_SHA"/u,
  );
  assert.match(
    approved.env.CANDIDATE_MODE,
    /steps[.]verify_publication_candidate[.]outputs[.]mode/u,
  );
  const controlEvidence = namedStep(
    publish,
    "Require approved same-version recovery control evidence",
  );
  assert.match(controlEvidence.run, /"\$RELEASE_CONTROL_SHA"/u);
  assert.match(
    controlEvidence.run,
    /--artifact oliphaunt-release-recovery-equivalence/u,
  );

  const bootstrap = parsed.jobs["publish-bootstrap"];
  const candidate = namedStep(
    bootstrap,
    "Prove workflow HEAD is a release or same-version recovery commit",
  );
  assert.equal(candidate.id, "verify_bootstrap_publication_candidate");
  assert.match(candidate.run, /verify-publication-candidate[.]mjs/u);
  const rejectRecovery = namedStep(
    bootstrap,
    "Reject same-version recovery bootstrap mutation",
  );
  assert.match(
    rejectRecovery.if,
    /verify_bootstrap_publication_candidate[.]outputs[.]mode == 'release-recovery'/u,
  );
  assert.match(
    rejectRecovery.run,
    /Reuse and verify the pinned terminal bootstrap ledger/u,
  );
  const markable = namedStep(
    bootstrap,
    "Prove Release Please PR can complete after bootstrap publication",
  );
  assert.match(
    markable.run,
    /steps[.]verify_bootstrap_publication_candidate[.]outputs[.]release_sha/u,
  );
  const capsule = namedStep(bootstrap, "Select one approved dry-run capsule");
  assert.doesNotMatch(
    capsule.run,
    /oliphaunt-release-recovery-equivalence/u,
  );
  assert.equal(
    bootstrap.steps.some(
      ({ name }) => name === "Download approved same-version recovery evidence"
        || name === "Verify approved same-version recovery publication state",
    ),
    false,
  );
  assert(
    stepIndex(bootstrap, "Reject same-version recovery bootstrap mutation")
      < stepIndex(
        bootstrap,
        "Prove Release Please PR can complete after bootstrap publication",
      ),
  );
  const credentials = namedStep(
    bootstrap,
    "Require bootstrap credentials before mutation",
  );
  assert.match(
    credentials.env.CRATES_IO_BOOTSTRAP_TOKEN,
    /secrets[.]CRATES_IO_BOOTSTRAP_TOKEN/u,
  );
  assert.match(credentials.env.NPM_BOOTSTRAP_TOKEN, /secrets[.]NPM_BOOTSTRAP_TOKEN/u);
});

test("finalization tags the original Release Please lifecycle and source commit", () => {
  const finalize = workflow().jobs["publish-finalize"];
  const candidate = namedStep(finalize, "Re-prove release lifecycle identity");
  assert.equal(candidate.id, "finalize_publication_candidate");
  assert.match(candidate.run, /verify-publication-candidate[.]mjs/u);

  const promote = namedStep(finalize, "Promote verified GitHub release drafts");
  assert.equal(
    promote.run.match(
      /steps[.]finalize_publication_candidate[.]outputs[.]release_sha/gu,
    )?.length,
    2,
  );
  assert.match(promote.run, /--head-ref "\$RELEASE_SOURCE_SHA"/u);
  assert.doesNotMatch(promote.run, /--release-sha "\$RELEASE_HEAD_SHA"/u);
});

test("same-version recovery cannot escape into a source-relabeling continuation", () => {
  const parsed = workflow();
  const registry = parsed.jobs["publish-registry"];
  const restore = namedStep(
    registry,
    "Restore exact-SHA normal-publication checkpoint",
  );
  assert.match(
    restore.env.RELEASE_SOURCE_SHA,
    /registry_release_identity[.]outputs[.]source_sha/u,
  );
  assert.equal(restore.env.RELEASE_HEAD_SHA, undefined);
  const deferral = namedStep(
    registry,
    "Seal typed zero-mutation capacity or deadline deferral",
  );
  assert.match(
    deferral.env.RELEASE_SOURCE_SHA,
    /registry_release_identity[.]outputs[.]source_sha/u,
  );
  assert.equal(deferral.env.RELEASE_HEAD_SHA, undefined);

  const decision = namedStep(
    registry,
    "Require a typed registry execution decision",
  );
  assert.match(
    decision.env.RELEASE_CONTROL_SHA,
    /registry_release_identity[.]outputs[.]controller_sha/u,
  );
  assert.match(
    decision.env.RELEASE_SOURCE_SHA,
    /registry_release_identity[.]outputs[.]source_sha/u,
  );
  assert.match(
    decision.run,
    /DEFERRED.*RELEASE_CONTROL_SHA.*RELEASE_SOURCE_SHA/su,
  );
  assert.match(
    decision.run,
    /Same-version recovery cannot create a continuation/u,
  );

  for (const name of [
    "Seal exact normal-publication continuation contract",
    "Preserve immutable deferred normal-publication continuation",
  ]) {
    assert.match(
      namedStep(registry, name).if,
      /controller_sha == steps[.]registry_release_identity[.]outputs[.]source_sha/u,
    );
  }
  assert.match(
    parsed.jobs["dispatch-publish-continuation"].if,
    /release_control_sha == needs[.]publish-registry[.]outputs[.]release_source_sha/u,
  );
});

test("CI rejects a malformed recovery lineage before expensive planning", () => {
  const intent = readFileSync(
    path.join(ROOT, ".github/scripts/check-release-intent.sh"),
    "utf8",
  );
  const verifier = intent.indexOf(
    "tools/release/verify-publication-candidate.mjs",
  );
  const planner = intent.indexOf(
    'release_plan="$(tools/dev/bun.sh tools/release/release_plan.mjs',
  );
  assert.notEqual(verifier, -1);
  assert.notEqual(planner, -1);
  assert(verifier < planner);
  assert.match(intent, /--derive-products/u);
  assert.match(intent, /Oliphaunt-Release-Recovery-Of/u);
});
