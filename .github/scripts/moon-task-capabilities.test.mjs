import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  matrixTarget,
  shardCheckTargets,
  taskCapabilities,
} from "./moon-task-capabilities.mjs";

function tasks(...entries) {
  return new Map(entries.map((task) => [task.target, task]));
}

describe("Moon task capabilities", () => {
  test("propagates capabilities through dependencies and makes maintainer tools imply Rust", () => {
    const taskMap = tasks(
      { target: "repo:leaf", tags: ["ci-maintainer-tools"] },
      { target: "repo:middle", tags: ["ci-android-sdk"], deps: [{ target: "repo:leaf" }] },
      { target: "repo:root", tags: [], deps: ["repo:middle"] },
    );

    assert.deepEqual(taskCapabilities(taskMap.get("repo:root"), taskMap), {
      requires_rust: true,
      requires_maintainer_tools: true,
      requires_android_sdk: true,
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

  test("creates bounded static shards while keeping capability-bearing work dedicated", () => {
    const taskMap = tasks(
      ...Array.from({ length: 9 }, (_, index) => ({ target: `plain:${index}`, tags: [] })),
      { target: "rust:first", tags: ["ci-rust"] },
      { target: "rust:second", tags: ["ci-rust"] },
      { target: "android:check", tags: ["ci-android-sdk"] },
    );
    const targets = [...taskMap.values()].map((task) => matrixTarget(task, "deep", taskMap));
    const shards = shardCheckTargets(targets, { maxTargets: 4 });

    assert.deepEqual(shards.map(({ target_count }) => target_count), [4, 4, 1, 1, 1, 1]);
    assert.equal(shards.filter(({ requires_rust }) => requires_rust).length, 2);
    assert.equal(shards.filter(({ requires_android_sdk }) => requires_android_sdk).length, 1);
    const selected = shards.flatMap(({ targets_json }) =>
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
    };
    assert.throws(() => shardCheckTargets([row, row]), /duplicate/u);
    assert.throws(() => shardCheckTargets([row], { maxTargets: 0 }), /positive integer/u);
  });
});
