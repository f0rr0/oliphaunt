#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  githubResolverDependencies,
  resolveMobileE2e,
  runMobileE2eResolver,
} from "./resolve-mobile-e2e.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const ANDROID_ARTIFACT = "react-native-mobile-android-app-android-x86_64";
const IOS_ARTIFACT = "react-native-mobile-ios-app";

function successfulRun(databaseId, headSha = SHA) {
  return { conclusion: "success", databaseId, headSha, status: "completed" };
}

function includedArtifactInventory(...names) {
  return `HTTP/2.0 200 OK\n\n${JSON.stringify({
    artifacts: names.map((name) => ({ expired: false, name })),
  })}`;
}

function dependencies({
  sha = SHA,
  runs = [successfulRun(101)],
  gates = new Map([["101", true]]),
  artifacts = new Map([["101", new Set([ANDROID_ARTIFACT, IOS_ARTIFACT])]]),
} = {}) {
  const calls = { artifacts: [], gates: [], listRuns: [] };
  return {
    calls,
    checkoutSha: () => sha,
    listRuns(value) {
      calls.listRuns.push(value);
      return runs;
    },
    gateSucceeded(runId, gateJobName) {
      calls.gates.push([runId, gateJobName]);
      return gates.get(runId) ?? false;
    },
    artifactNames(runId) {
      calls.artifacts.push(runId);
      return artifacts.get(runId) ?? new Set();
    },
  };
}

function resolve(options = {}, injected = dependencies()) {
  return resolveMobileE2e(
    {
      repo: "f0rr0/oliphaunt",
      requestedPlatform: "all",
      requestedSha: SHA,
      ...options,
    },
    injected,
  );
}

test("resolves only an exact-SHA successful run with the successful aggregate build gate", () => {
  const injected = dependencies({
    runs: [
      successfulRun(1, OTHER_SHA),
      { ...successfulRun(2), status: "in_progress", conclusion: null },
      { ...successfulRun(3), conclusion: "failure" },
      successfulRun(4),
      successfulRun(5),
      successfulRun(6),
    ],
    gates: new Map([
      ["4", false],
      ["5", true],
      ["6", true],
    ]),
    artifacts: new Map([
      ["5", new Set([ANDROID_ARTIFACT])],
      ["6", new Set([ANDROID_ARTIFACT, IOS_ARTIFACT])],
    ]),
  });
  assert.deepEqual(resolve({}, injected), {
    android: true,
    ios: true,
    platformJobs: ["android", "ios"],
    runId: "6",
    sha: SHA,
  });
  assert.deepEqual(injected.calls.listRuns, [SHA]);
  assert.deepEqual(injected.calls.gates, [
    ["4", "Builds"],
    ["5", "Builds"],
    ["6", "Builds"],
  ]);
  assert.deepEqual(injected.calls.artifacts, ["5", "6"]);
});

test("platform selection requires only the exact requested artifact identity", () => {
  const androidOnly = dependencies({
    artifacts: new Map([["101", new Set([ANDROID_ARTIFACT, `${IOS_ARTIFACT}-near-match`])]]),
  });
  assert.deepEqual(resolve({ requestedPlatform: "android" }, androidOnly).platformJobs, ["android"]);

  const iosOnly = dependencies({
    artifacts: new Map([["101", new Set([IOS_ARTIFACT, `${ANDROID_ARTIFACT}-near-match`])]]),
  });
  assert.deepEqual(resolve({ requestedPlatform: "ios" }, iosOnly).platformJobs, ["ios"]);

  assert.throws(
    () => resolve({}, androidOnly),
    /contains requested mobile app artifacts/u,
  );
  assert.throws(
    () => resolve({}, iosOnly),
    /contains requested mobile app artifacts/u,
  );
});

test("rejects abbreviated, malformed, mismatched, or non-canonical checkout SHAs", () => {
  for (const requestedSha of ["a".repeat(39), `${"a".repeat(40)}0`, "not-a-sha"]) {
    assert.throws(
      () => resolve({ requestedSha }, dependencies()),
      /input must be a full commit SHA/u,
    );
  }
  assert.throws(
    () => resolve({ requestedSha: OTHER_SHA }, dependencies()),
    /does not match requested SHA/u,
  );
  assert.throws(
    () => resolve({}, dependencies({ sha: SHA.toUpperCase() })),
    /checked-out mobile E2E commit is not a full SHA/u,
  );
  assert.equal(resolve({ requestedSha: SHA.toUpperCase() }).sha, SHA);
});

test("fails closed on malformed successful-run metadata and artifact responses", () => {
  assert.throws(
    () => resolve({}, dependencies({ runs: [successfulRun(undefined)] })),
    /invalid databaseId/u,
  );
  assert.throws(
    () => resolve({}, dependencies({ runs: [{ ...successfulRun(1), headSha: "abc" }] })),
    /missing a full lowercase headSha/u,
  );
  assert.throws(
    () => resolve({}, dependencies({ runs: {} })),
    /gh run list must return a JSON array/u,
  );
  assert.throws(
    () => resolve({}, dependencies({ artifacts: new Map([["101", [ANDROID_ARTIFACT, null]]]) })),
    /invalid artifact name/u,
  );
});

test("deduplicates repeated attempts and preserves GitHub run ordering", () => {
  const injected = dependencies({
    runs: [successfulRun(201), successfulRun(201), successfulRun(202)],
    gates: new Map([
      ["201", true],
      ["202", true],
    ]),
    artifacts: new Map([
      ["201", new Set([ANDROID_ARTIFACT])],
      ["202", new Set([ANDROID_ARTIFACT, IOS_ARTIFACT])],
    ]),
  });
  assert.equal(resolve({}, injected).runId, "202");
  assert.deepEqual(injected.calls.gates, [
    ["201", "Builds"],
    ["202", "Builds"],
  ]);
});

test("skips ambiguous duplicate gate and artifact identities", () => {
  const duplicateArtifacts = dependencies({
    runs: [successfulRun(301), successfulRun(302)],
    gates: new Map([
      ["301", true],
      ["302", true],
    ]),
    artifacts: new Map([
      ["301", [ANDROID_ARTIFACT, ANDROID_ARTIFACT, IOS_ARTIFACT]],
      ["302", [ANDROID_ARTIFACT, IOS_ARTIFACT]],
    ]),
  });
  assert.equal(resolve({}, duplicateArtifacts).runId, "302");

  const commands = [];
  const adapter = githubResolverDependencies("f0rr0/oliphaunt", {
    execute(command, args) {
      commands.push([command, args]);
      if (command === "git") return `${SHA}\n`;
      if (args[0] === "run" && args[1] === "list") return JSON.stringify([successfulRun(303)]);
      if (args[0] === "run" && args[1] === "view") {
        return JSON.stringify({ jobs: [
          { conclusion: "success", name: "Builds" },
          { conclusion: "success", name: "Builds" },
        ] });
      }
      return `${ANDROID_ARTIFACT}\n${IOS_ARTIFACT}\n`;
    },
  });
  assert.throws(() => resolve({}, adapter), /contains requested mobile app artifacts/u);
  assert.equal(commands.some(([, args]) => args[0] === "api"), false);
});

test("environment entry point emits the complete exact resolver contract", () => {
  const emitted = [];
  const result = runMobileE2eResolver({
    environment: {
      BUILD_GATE_JOB: "Builds",
      GH_REPO: "f0rr0/oliphaunt",
      INPUT_PLATFORM: "ios",
      INPUT_SHA: SHA,
    },
    dependencies: dependencies({ artifacts: new Map([["101", new Set([IOS_ARTIFACT])]]) }),
    writeOutput: (name, value) => emitted.push([name, value]),
  });
  assert.deepEqual(result.platformJobs, ["ios"]);
  assert.deepEqual(emitted, [
    ["sha", SHA],
    ["run_id", "101"],
    ["android", "false"],
    ["ios", "true"],
    ["platform_jobs", '["ios"]'],
  ]);
});

test("production adapter pins repository, exact commit, gate run, and non-expired artifacts", () => {
  const commands = [];
  const execute = (command, args) => {
    commands.push([command, args]);
    if (command === "git") return `${SHA}\n`;
    if (args[0] === "run" && args[1] === "list") {
      return JSON.stringify([successfulRun(901)]);
    }
    if (args[0] === "run" && args[1] === "view") {
      return JSON.stringify({ jobs: [{ conclusion: "success", name: "Builds" }] });
    }
    return includedArtifactInventory(ANDROID_ARTIFACT, IOS_ARTIFACT);
  };
  const result = resolve({}, githubResolverDependencies("f0rr0/oliphaunt", { execute }));
  assert.equal(result.runId, "901");

  const list = commands.find(([command, args]) => command === "gh" && args[1] === "list")[1];
  assert.deepEqual(list.slice(0, 6), ["run", "list", "--repo", "f0rr0/oliphaunt", "--workflow", "ci.yml"]);
  assert.equal(list[list.indexOf("--commit") + 1], SHA);
  assert.equal(list[list.indexOf("--limit") + 1], "100");
  assert.equal(list[list.indexOf("--json") + 1], "databaseId,status,conclusion,headSha");

  const view = commands.find(([command, args]) => command === "gh" && args[1] === "view")[1];
  assert.deepEqual(view.slice(0, 5), ["run", "view", "901", "--repo", "f0rr0/oliphaunt"]);
  assert.equal(view[view.indexOf("--json") + 1], "jobs");

  const artifacts = commands.find(([command, args]) => command === "gh" && args[0] === "api")[1];
  assert.equal(artifacts[1], "--include");
  assert.equal(
    artifacts[2],
    "repos/f0rr0/oliphaunt/actions/runs/901/artifacts?per_page=100&page=1",
  );
});

test("production adapter survives a transient GitHub read without weakening exact identity", () => {
  let listAttempts = 0;
  const execute = (command, args) => {
    if (command === "git") return `${SHA}\n`;
    if (args[0] === "run" && args[1] === "list") {
      listAttempts += 1;
      if (listAttempts === 1) throw new Error("HTTP 503 temporary failure");
      return JSON.stringify([successfulRun(902)]);
    }
    if (args[0] === "run" && args[1] === "view") {
      return JSON.stringify({ jobs: [{ conclusion: "success", name: "Builds" }] });
    }
    return includedArtifactInventory(ANDROID_ARTIFACT, IOS_ARTIFACT);
  };
  const resolved = resolve(
    {},
    githubResolverDependencies("f0rr0/oliphaunt", {
      execute,
      retryOptions: {
        baseDelayMs: 0,
        deadlineMs: 100,
        maxAttempts: 2,
        maxDelayMs: 0,
      },
    }),
  );
  assert.equal(resolved.runId, "902");
  assert.equal(resolved.sha, SHA);
  assert.equal(listAttempts, 2);
});
