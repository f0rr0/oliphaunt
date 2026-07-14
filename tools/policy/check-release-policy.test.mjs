#!/usr/bin/env bun
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  releasePolicyExpectations,
  validatePublicationModel,
  validateReleasePolicyModel,
} from "./check-release-policy.mjs";
import {
  assertReleaseIntentScript,
  assertReleaseWorkflow,
  parseWorkflow,
} from "./assertions/workflow-semantics.mjs";
import { loadPublicationCatalog } from "../release/publication-catalog.mjs";
import { loadGraph, ROOT } from "../release/release-graph.mjs";

const expectations = releasePolicyExpectations();
const canonicalGraph = loadGraph("release-policy-test");
const canonicalCatalog = loadPublicationCatalog("release-policy-test");
const canonicalReleaseDispatcher = parseWorkflow(ROOT, ".github/workflows/release.yml");
const canonicalReleaseExecution = parseWorkflow(ROOT, ".github/workflows/release-execute.yml");
const canonicalReleaseIntent = readFileSync(path.join(ROOT, ".github/scripts/check-release-intent.sh"), "utf8");
const copy = (value) => structuredClone(value);

test("accepts the canonical release graph and Product-to-Carrier catalog", () => {
  assert.doesNotThrow(() => validateReleasePolicyModel(copy(canonicalGraph), expectations));
  assert.doesNotThrow(() => validatePublicationModel(copy(canonicalGraph), copy(canonicalCatalog)));
  assert.doesNotThrow(() => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), copy(canonicalReleaseExecution)));
});

test("rejects repository write access in dry-run or bootstrap callers", () => {
  for (const jobId of ["publish-dry-run", "publish-bootstrap"]) {
    const dispatcher = copy(canonicalReleaseDispatcher);
    dispatcher.jobs[jobId].permissions.contents = "write";
    assert.throws(
      () => assertReleaseWorkflow(dispatcher, copy(canonicalReleaseExecution)),
      /permissions must be/u,
    );
  }
});

test("requires bootstrap OIDC for npm provenance", () => {
  const dispatcher = copy(canonicalReleaseDispatcher);
  delete dispatcher.jobs["publish-bootstrap"].permissions["id-token"];
  assert.throws(
    () => assertReleaseWorkflow(dispatcher, copy(canonicalReleaseExecution)),
    /permissions must be/u,
  );
});

test("rejects inherited secrets in least-privilege release callers", () => {
  const dispatcher = copy(canonicalReleaseDispatcher);
  dispatcher.jobs["publish-dry-run"].secrets = "inherit";
  assert.throws(
    () => assertReleaseWorkflow(dispatcher, copy(canonicalReleaseExecution)),
    /must not inherit repository or organization secrets/u,
  );
});

test("rejects reusable workflows that accept caller repository secrets", () => {
  const execution = copy(canonicalReleaseExecution);
  execution.on.workflow_call.secrets = {
    registry_token: { required: true },
  };
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /must read only its selected environment secrets/u,
  );
});

test("requires live OIDC identity verification for bootstrap and normal publication", () => {
  const execution = copy(canonicalReleaseExecution);
  const oidc = execution.jobs.publish.steps.find(({ run }) =>
    run?.includes("verify-github-oidc-identity.mjs"),
  );
  oidc.if = "${{ inputs.operation == 'publish' }}";
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /must verify the live caller\/reusable-workflow OIDC identity/u,
  );
});

test("requires observed Node.js and npm trusted-publishing runtime validation", () => {
  const execution = copy(canonicalReleaseExecution);
  const runtime = execution.jobs.publish.steps.find(({ run }) =>
    run?.includes("npm-trusted-publishing.mjs check-runtime"),
  );
  runtime.run = runtime.run.replace('--node "$node_version"', '--node "22.0.0"');
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /npm trusted publishing must verify the observed runtime/u,
  );
});

test("rejects candidate-scoped serialization for registry mutations", () => {
  const dispatcher = copy(canonicalReleaseDispatcher);
  dispatcher.concurrency.group = "release-${{ inputs.operation }}-${{ github.sha }}";
  assert.throws(
    () => assertReleaseWorkflow(dispatcher, copy(canonicalReleaseExecution)),
    /concurrency group must bind|'mutation'|serialized by candidate SHA/u,
  );
});

test("rejects moving-main release staging", () => {
  const execution = copy(canonicalReleaseExecution);
  const stage = execution.jobs.publish.steps.find(({ name }) => name === "Stage exact-SHA product tags and draft releases");
  delete stage.run;
  stage.uses = "googleapis/release-please-action@0000000000000000000000000000000000000000";
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /manage-release-drafts\.mjs stage|moving main/u,
  );
});

test("rejects release PR normalization without an exact main parent", () => {
  const execution = copy(canonicalReleaseExecution);
  const sync = execution.jobs["prepare-release-pr"].steps.find(({ run }) =>
    run?.includes("sync-release-pr.mjs"),
  );
  sync.run = sync.run.replace("git rev-parse 'HEAD^'", "git rev-parse HEAD");
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /release PR normalization must enforce git rev-parse 'HEAD\^'/u,
  );
});

test("rejects reusable-workflow display-name coupling", () => {
  const execution = copy(canonicalReleaseExecution);
  const lock = execution.jobs.publish.steps.find(({ name }) => name === "Download prior approved publication lock");
  lock.run = lock.run.replace(
    "--artifact oliphaunt-publication-lock",
    '--job "Publish release" --artifact oliphaunt-publication-lock',
  );
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /must not depend on reusable-workflow display names/u,
  );
});

test("rejects a non-dry-run operation that can emit the approved lock artifact", () => {
  const execution = copy(canonicalReleaseExecution);
  const upload = execution.jobs.publish.steps.find(({ with: inputs }) =>
    inputs?.name === "oliphaunt-publication-lock",
  );
  upload.if = "${{ steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /approved publication-lock artifact must be emitted only by publish-dry-run/u,
  );
});

test("rejects Cargo candidate validation outside its release and registry guard", () => {
  const execution = copy(canonicalReleaseExecution);
  const validate = execution.jobs.publish.steps.find(({ run }) =>
    run?.includes("validate-example-cargo-candidates.mjs"),
  );
  validate.if = "${{ steps.release_plan.outputs.has_release_changes == 'true' }}";
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /must run only for a selected release with Cargo carriers/u,
  );
});

test("rejects Cargo candidate validation after publication bytes are frozen", () => {
  const execution = copy(canonicalReleaseExecution);
  const steps = execution.jobs.publish.steps;
  const validateIndex = steps.findIndex(({ run }) => run?.includes("validate-example-cargo-candidates.mjs"));
  const [validate] = steps.splice(validateIndex, 1);
  const freezeIndex = steps.findIndex(({ run }) => run?.includes("publication-lock.mjs") && run?.includes("create"));
  steps.splice(freezeIndex + 1, 0, validate);
  assert.throws(
    () => assertReleaseWorkflow(copy(canonicalReleaseDispatcher), execution),
    /after all selected dry-runs and before the publication lock is frozen/u,
  );
});

test("rejects generated release PR checks without exact-parent and derived-product verification", () => {
  for (const [from, to] of [
    ['head_parent="$(git rev-parse "${head_ref}^{commit}^")"', 'head_parent="${base_commit}"'],
    ["--derive-products", "--derive-any-products"],
    ['--products-json "${release_products_json}"', '--products-json "[]"'],
  ]) {
    assert.throws(
      () => assertReleaseIntentScript(canonicalReleaseIntent.replace(from, to)),
      /generated release PR validation must/u,
    );
  }
});

test("rejects a broad generated-release branch exemption", () => {
  assert.throws(
    () => assertReleaseIntentScript(canonicalReleaseIntent.replace(
      '[[ "${head_branch}" == "release-please--branches--main" ]]',
      '[[ "${head_branch}" == release/* ]]',
    )),
    /canonical Release Please branch/u,
  );
});

test("rejects repository-wide version coupling", () => {
  const graph = copy(canonicalGraph);
  graph.policy.versioning = "fixed";
  assert.throws(
    () => validateReleasePolicyModel(graph, expectations),
    /products must use independent versioning/u,
  );
});

test("requires first-release synchronization for the WASIX ICU carrier", () => {
  const graph = copy(canonicalGraph);
  delete graph.products["liboliphaunt-wasix"].compatibility_versions["liboliphaunt-wasix-icu"];
  assert.throws(
    () => validateReleasePolicyModel(graph, expectations),
    /must synchronize src\/runtimes\/liboliphaunt\/icu\/Cargo\.toml from its release version/u,
  );

  const missingOwnership = copy(canonicalGraph);
  missingOwnership.products["liboliphaunt-wasix"].derived_version_files = [];
  assert.throws(
    () => validateReleasePolicyModel(missingOwnership, expectations),
    /must own src\/runtimes\/liboliphaunt\/icu\/Cargo\.toml as a derived version file/u,
  );
});

test("rejects an extension missing from the independently versioned product set", () => {
  const graph = copy(canonicalGraph);
  delete graph.products["oliphaunt-extension-vector"];
  assert.throws(
    () => validateReleasePolicyModel(graph, expectations),
    /release product set/u,
  );
});

test("rejects release metadata that disagrees with its owning Moon project", () => {
  const graph = copy(canonicalGraph);
  graph.moon_projects["oliphaunt-extension-vector"].project.metadata.release.component = "wrong-product";
  assert.throws(
    () => validateReleasePolicyModel(graph, expectations),
    /release component must be oliphaunt-extension-vector/u,
  );
});

test("rejects an external extension coupled to runtime release propagation", () => {
  const graph = copy(canonicalGraph);
  graph.moon_projects["oliphaunt-extension-vector"].dependencyScopes["liboliphaunt-native"] = "production";
  assert.throws(
    () => validateReleasePolicyModel(graph, expectations),
    /must depend on liboliphaunt-native with build scope/u,
  );
});

test("rejects a missing or substituted registry carrier", () => {
  const catalog = copy(canonicalCatalog);
  catalog.carriers = catalog.carriers.slice(1);
  assert.throws(
    () => validatePublicationModel(copy(canonicalGraph), catalog),
    /publication carrier set/u,
  );

  const substituted = copy(canonicalCatalog);
  substituted.carriers[0].version = "9.9.9";
  assert.throws(
    () => validatePublicationModel(copy(canonicalGraph), substituted),
    /version must match/u,
  );
});
