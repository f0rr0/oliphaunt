#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import {
  releasePolicyExpectations,
  validatePublicationModel,
  validateReleasePolicyModel,
} from "./check-release-policy.mjs";
import {
  mobileE2eJobsForPlan,
  planForFullRun,
  renderPlanForFullRun,
} from "../graph/ci_plan.mjs";
import { loadPublicationCatalog } from "../release/publication-catalog.mjs";
import { loadGraph } from "../release/release-graph.mjs";

const expectations = releasePolicyExpectations();
const canonicalGraph = loadGraph("release-policy-test");
const canonicalCatalog = loadPublicationCatalog("release-policy-test");
const copy = (value) => structuredClone(value);

test("accepts the canonical release graph and Product-to-Carrier catalog", () => {
  assert.doesNotThrow(() => validateReleasePolicyModel(copy(canonicalGraph), expectations));
  assert.doesNotThrow(() => validatePublicationModel(copy(canonicalGraph), copy(canonicalCatalog)));
});

test("the full CI plan cannot omit any selected downstream E2E proof", () => {
  const fullPlan = planForFullRun();
  assert.deepEqual(mobileE2eJobsForPlan(fullPlan.jobs), [
    "mobile-e2e-android",
    "mobile-e2e-ios",
    "native-extension-lifecycle-aggregate",
    "rust-sdk-exact-candidate-consumer",
    "wasix-rust-exact-candidate-consumer",
  ]);

  const withoutIos = new Set(fullPlan.jobs);
  withoutIos.delete("mobile-build-ios");
  assert.deepEqual(mobileE2eJobsForPlan(withoutIos), [
    "mobile-e2e-android",
    "native-extension-lifecycle-aggregate",
    "rust-sdk-exact-candidate-consumer",
    "wasix-rust-exact-candidate-consumer",
  ]);
});

test("every focused dispatch closes consumers over exact producer matrices", () => {
  const wasmTargets = [
    "all",
    "macos-arm64",
    "linux-x64-gnu",
    "linux-arm64-gnu",
    "windows-x64-msvc",
  ];
  const nativeTargets = [
    "all",
    "macos-arm64",
    "linux-x64-gnu",
    "linux-arm64-gnu",
    "windows-x64-msvc",
    "android-arm64-v8a",
    "android-x86_64",
    "ios-xcframework",
  ];
  const mobileTargets = ["all", "android", "ios", "both"];
  const accepted = [];
  const matrixTargets = (plan, name) => new Set(plan[name].include.map(({ target }) => target));
  const requireTargets = (actual, required, label) => {
    for (const target of required) {
      assert.equal(actual.has(target), true, `${label} is missing ${target}`);
    }
  };

  for (const wasmTarget of wasmTargets) {
    for (const nativeTarget of nativeTargets) {
      for (const mobileTarget of mobileTargets) {
        const combination = `${wasmTarget}/${nativeTarget}/${mobileTarget}`;
        const expectedAllowed = wasmTarget !== "all"
          ? nativeTarget === "all" && mobileTarget === "all"
          : mobileTarget === "all"
            || (mobileTarget === "both" && nativeTarget === "all")
            || (mobileTarget === "android" && new Set([
              "all",
              "android-arm64-v8a",
              "android-x86_64",
            ]).has(nativeTarget))
            || (mobileTarget === "ios" && new Set(["all", "ios-xcframework"]).has(nativeTarget));
        let plan;
        try {
          plan = renderPlanForFullRun({ wasmTarget, nativeTarget, mobileTarget });
        } catch (error) {
          assert.equal(expectedAllowed, false, `valid dispatch ${combination} was rejected`);
          assert.match(
            error.message,
            /focus cannot be combined|requires native_target=all|is not valid for mobile_target/u,
          );
          continue;
        }
        assert.equal(expectedAllowed, true, `invalid dispatch ${combination} was accepted`);
        accepted.push(combination);

        const jobs = new Set(plan.jobs);
        const desktop = matrixTargets(plan, "liboliphaunt_native_desktop_runtime_matrix");
        const android = matrixTargets(plan, "liboliphaunt_native_android_runtime_matrix");
        const ios = matrixTargets(plan, "liboliphaunt_native_ios_runtime_matrix");
        const extensions = matrixTargets(plan, "extension_artifacts_native_matrix");
        const brokers = matrixTargets(plan, "broker_runtime_matrix");
        const nodeDirect = matrixTargets(plan, "node_direct_runtime_matrix");
        const jsConsumers = matrixTargets(plan, "js_exact_candidate_consumer_matrix");

        if (jobs.has("js-sdk-exact-candidate-consumer")) {
          requireTargets(desktop, jsConsumers, `${combination} native runtime producers`);
          requireTargets(brokers, jsConsumers, `${combination} broker producers`);
          requireTargets(nodeDirect, jsConsumers, `${combination} Node-direct producers`);
          requireTargets(extensions, jsConsumers, `${combination} extension producers`);
          assert.equal(desktop.has("macos-arm64"), true, `${combination} must retain portable ICU`);
          assert.equal(ios.has("ios-xcframework"), true, `${combination} must retain the Apple base carrier`);
        }
        if (jobs.has("native-extension-lifecycle") || jobs.has("rust-sdk-exact-candidate-consumer")) {
          requireTargets(desktop, ["linux-x64-gnu"], `${combination} Linux runtime producer`);
          requireTargets(brokers, ["linux-x64-gnu"], `${combination} Linux broker producer`);
          requireTargets(extensions, ["linux-x64-gnu"], `${combination} Linux extension producer`);
        }
        if (jobs.has("swift-sdk-package") || jobs.has("react-native-sdk-package")) {
          requireTargets(ios, ["ios-xcframework"], `${combination} Apple SDK producer`);
        }
        if (jobs.has("mobile-build-android")) {
          const apps = matrixTargets(plan, "react_native_android_mobile_app_matrix");
          requireTargets(android, apps, `${combination} Android runtime producers`);
          requireTargets(extensions, apps, `${combination} Android extension producers`);
        }
        if (jobs.has("mobile-build-ios")) {
          requireTargets(ios, ["ios-xcframework"], `${combination} iOS runtime producer`);
          requireTargets(extensions, ["ios-xcframework"], `${combination} iOS extension producer`);
        }
      }
    }
  }
  assert.equal(accepted.length, 18);
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
    /must synchronize src\/runtimes\/liboliphaunt\/icu\/Cargo[.]toml from its release version/u,
  );

  const missingOwnership = copy(canonicalGraph);
  missingOwnership.products["liboliphaunt-wasix"].derived_version_files = [];
  assert.throws(
    () => validateReleasePolicyModel(missingOwnership, expectations),
    /must own src\/runtimes\/liboliphaunt\/icu\/Cargo[.]toml as a derived version file/u,
  );
});

test("rejects an extension missing from independently versioned products", () => {
  const graph = copy(canonicalGraph);
  delete graph.products["oliphaunt-extension-vector"];
  assert.throws(() => validateReleasePolicyModel(graph, expectations), /release product set/u);
});

test("rejects release metadata that disagrees with its Moon owner", () => {
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
