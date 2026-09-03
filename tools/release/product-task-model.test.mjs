import assert from "node:assert/strict";
import { test } from "node:test";

import { moonCommand } from "../dev/moon-command.mjs";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";

function moonJson(args) {
  return JSON.parse(execFileSync(moonCommand(), args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }));
}

test("release product tasks use semantic names and keep package independent", () => {
  const projects = moonJson(["query", "projects"]).projects;
  const tasks = moonJson(["query", "tasks"]).tasks;
  const releaseProducts = projects.filter((project) => project.config?.tags?.includes("release-product"));
  const forbidden = new Set(["check", "test", "release-check", "assemble-release"]);

  assert.ok(releaseProducts.length > 0);
  for (const project of releaseProducts) {
    const productTasks = tasks[project.id] ?? {};
    assert.deepEqual(
      Object.keys(productTasks).filter((task) => forbidden.has(task)),
      [],
      `${project.id} exposes a deceptive legacy task`,
    );
    for (const dependency of productTasks.package?.deps ?? []) {
      assert.ok(
        !/:(?:check|compile|format-check|lint|test|unit)$/u.test(dependency.target),
        `${project.id}:package depends on quality task ${dependency.target}`,
      );
    }
  }

  for (const project of [
    "oliphaunt-js",
    "oliphaunt-react-native",
    "oliphaunt-rust",
    "oliphaunt-swift",
    "oliphaunt-wasix-rust",
  ]) {
    assert.equal(
      tasks[project]["package-artifacts"].deps.some(
        ({ target }) => target === `${project}:package`,
      ),
      true,
      `${project}:package-artifacts must consume ${project}:package output`,
    );
  }
});

test("task edges distinguish artifact data from ordering gates", () => {
  const tasks = Object.values(moonJson(["query", "tasks"]).tasks).flatMap((project) =>
    Object.values(project)
  );
  const byTarget = new Map(tasks.map((task) => [task.target, task]));

  for (const consumer of tasks) {
    const consumerTags = new Set(consumer.tags ?? []);
    const isProducer = ["artifact-builder", "artifact-package", "build", "package"]
      .some((tag) => consumerTags.has(tag));
    const isQualificationAggregate = consumer.id === "qualify" || consumerTags.has("aggregate");
    const inputs = new Set((consumer.inputs ?? []).map((input) => input.file ?? input.glob));
    if (consumer.options?.cache && !isQualificationAggregate) {
      for (const output of consumer.outputs ?? []) {
        assert.equal(
          inputs.has(output.file ?? output.glob),
          false,
          `${consumer.target} declares its own output as an input`,
        );
      }
    }
    for (const dependency of consumer.deps ?? []) {
      const producer = byTarget.get(dependency.target);
      assert.ok(producer, `${consumer.target} has missing dependency ${dependency.target}`);
      const carriesOutputs = (producer.outputs ?? []).length > 0;
      assert.equal(
        carriesOutputs ? dependency.cacheStrategy !== "ignored" : dependency.cacheStrategy === "ignored",
        true,
        `${consumer.target} -> ${producer.target} misclassifies ${carriesOutputs ? "artifact data" : "ordering"}`,
      );
      if (isProducer && !isQualificationAggregate && !carriesOutputs) {
        assert.equal(
          (producer.tags ?? []).some((tag) => ["assertion", "quality", "static", "unit"].includes(tag)),
          false,
          `${consumer.target} hides quality gate ${producer.target} inside a producer task`,
        );
      }
    }
  }
});

test("WASIX Postmaster qualification includes its packaged runtime behavior", () => {
  const tasks = moonJson(["query", "tasks"]).tasks["liboliphaunt-wasix-postmaster"];
  assert.equal(
    tasks.qualify.deps.some(({ target }) =>
      target === "liboliphaunt-wasix-postmaster:release-assets"
    ),
    true,
  );
});
