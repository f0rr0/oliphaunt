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

test("dry-run proves control-only lineage and original/new byte-envelope equality", () => {
  const job = workflow().jobs["publish-dry-run"];
  const candidate = namedStep(
    job,
    "Prove workflow HEAD is a release or same-version recovery commit",
  );
  assert.equal(candidate.id, "verify_publication_candidate");
  assert.match(candidate.run, /verify-publication-candidate[.]mjs/u);
  assert.match(candidate.run, /--github-output "\$GITHUB_OUTPUT"/u);

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
});

test("normal and bootstrap publication require the recovery equivalence artifact", () => {
  const parsed = workflow();
  const publish = parsed.jobs.publish;
  const approved = namedStep(publish, "Require one approved dry-run lock and capsule");
  assert.match(
    approved.run,
    /--gate-artifact oliphaunt-release-recovery-equivalence/u,
  );
  assert.match(
    approved.run,
    /steps[.]verify_publication_candidate[.]outputs[.]mode/u,
  );

  const bootstrap = parsed.jobs["publish-bootstrap"];
  const candidate = namedStep(
    bootstrap,
    "Prove workflow HEAD is a release or same-version recovery commit",
  );
  assert.equal(candidate.id, "verify_bootstrap_publication_candidate");
  assert.match(candidate.run, /verify-publication-candidate[.]mjs/u);
  const markable = namedStep(
    bootstrap,
    "Prove Release Please PR can complete after bootstrap publication",
  );
  assert.match(
    markable.run,
    /steps[.]verify_bootstrap_publication_candidate[.]outputs[.]release_sha/u,
  );
  const capsule = namedStep(bootstrap, "Select one approved dry-run capsule");
  assert.match(
    capsule.run,
    /--gate-artifact oliphaunt-release-recovery-equivalence/u,
  );
  assert.match(
    capsule.run,
    /steps[.]verify_bootstrap_publication_candidate[.]outputs[.]mode/u,
  );
  const recoveryDownload = namedStep(
    bootstrap,
    "Download approved same-version recovery evidence",
  );
  assert.match(
    recoveryDownload.env.RECOVERY_ARTIFACT_METADATA_JSON,
    /gate_artifact_metadata_json/u,
  );
  const recoveryState = namedStep(
    bootstrap,
    "Verify approved same-version recovery publication state",
  );
  assert.match(recoveryState.run, /--verify-receipt/u);
  const credentials = namedStep(
    bootstrap,
    "Require bootstrap credentials before mutation",
  );
  assert.match(
    credentials.env.CRATES_IO_BOOTSTRAP_TOKEN,
    /needs_cargo_token/u,
  );
  assert.match(credentials.env.NPM_BOOTSTRAP_TOKEN, /needs_npm_token/u);
});

test("finalization tags the original Release Please lifecycle while promoting the recovery head", () => {
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
  assert.match(promote.run, /--head-ref "\$RELEASE_HEAD_SHA"/u);
  assert.doesNotMatch(promote.run, /--release-sha "\$RELEASE_HEAD_SHA"/u);
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
