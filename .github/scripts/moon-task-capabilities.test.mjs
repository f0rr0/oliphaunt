import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  groupTargets,
  matrixTarget,
  taskCapabilities,
  taskLabel,
} from "./moon-task-capabilities.mjs";

function tasks(...entries) {
  return new Map(entries.map((task) => [task.target, task]));
}

describe("Moon task capabilities", () => {
  test("renders human-readable task labels", () => {
    assert.equal(
      taskLabel("oliphaunt-wasix-napi:format-check"),
      "Oliphaunt WASIX Node-API / Format Check",
    );
    assert.equal(taskLabel("extension-artifacts-native:unit"), "Native Extension Artifacts / Unit");
  });

  test("propagates capabilities through dependencies and makes maintainer tools imply Rust", () => {
    const taskMap = tasks(
      { target: "repo:leaf", tags: ["requires-maintainer-tools", "requires-wasmer-llvm"], toolchains: ["pnpm"] },
      { target: "repo:middle", tags: ["requires-android-sdk"], deps: [{ target: "repo:leaf" }] },
      { target: "repo:root", tags: [], deps: ["repo:middle"] },
    );

    assert.deepEqual(taskCapabilities(taskMap.get("repo:root"), taskMap), {
      requires_rust: true,
      requires_maintainer_tools: true,
      requires_android_sdk: true,
      requires_apple: false,
      requires_wasmer_llvm: true,
      requires_workspace: true,
    });
  });

  test("fails closed for incomplete or cyclic dependency metadata", () => {
    const incomplete = tasks({ target: "repo:root", deps: ["repo:missing"] });
    assert.throws(
      () => taskCapabilities(incomplete.get("repo:root"), incomplete),
      /repo:missing/u,
    );

    const cyclic = tasks(
      { target: "repo:first", deps: ["repo:second"] },
      { target: "repo:second", deps: ["repo:first"] },
    );
    assert.throws(
      () => taskCapabilities(cyclic.get("repo:first"), cyclic),
      /dependency cycle/u,
    );
  });

  test("creates bounded groups with one setup profile per job", () => {
    const taskMap = tasks(
      ...Array.from({ length: 9 }, (_, index) => ({ target: `plain:${index}`, tags: [] })),
      { target: "rust:first", tags: ["requires-rust"] },
      { target: "rust:second", tags: ["requires-rust"] },
      { target: "android:check", tags: ["requires-android-sdk"] },
      { target: "apple:check", tags: ["requires-apple"] },
      { target: "workspace:check", tags: [], toolchains: ["pnpm"] },
      { target: "aot:check", tags: ["requires-wasmer-llvm"] },
    );
    const targets = [...taskMap.values()].map((task) => matrixTarget(task, "deep", taskMap));
    const groups = groupTargets(targets, { maxTargets: 4 });

    assert.deepEqual(groups.map(({ target_count }) => target_count), [1, 1, 1, 4, 4, 1, 2, 1]);
    assert.equal(groups[3].label, "Plain / 0 + Plain / 1 + Plain / 2 + Plain / 3");
    assert.equal(groups.filter(({ requires_rust }) => requires_rust).length, 1);
    assert.equal(groups.filter(({ requires_android_sdk }) => requires_android_sdk).length, 1);
    assert.equal(groups.filter(({ requires_apple }) => requires_apple).length, 1);
    assert.equal(groups.filter(({ requires_workspace }) => requires_workspace).length, 1);
    assert.equal(groups.filter(({ requires_wasmer_llvm }) => requires_wasmer_llvm).length, 1);
    assert.equal(groups.find(({ requires_apple }) => requires_apple).runner, "macos-26");
    const selected = groups.flatMap(({ targets_json }) =>
      JSON.parse(targets_json).include.map(({ target }) => target));
    assert.deepEqual(selected.sort(), [...taskMap.keys()].sort());
  });

  test("rejects duplicate targets and invalid shard limits", () => {
    const row = {
      target: "repo:check",
      upstream: "deep",
      requires_rust: false,
      requires_maintainer_tools: false,
      requires_android_sdk: false,
      requires_apple: false,
      requires_wasmer_llvm: false,
      requires_workspace: false,
    };
    assert.throws(() => groupTargets([row, row]), /duplicate/u);
    assert.throws(() => groupTargets([row], { maxTargets: 0 }), /positive integer/u);
  });
});
