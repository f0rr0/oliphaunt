import assert from "node:assert/strict";
import { test } from "node:test";

import { moonCommand, moonEnvironment } from "../dev/moon-command.mjs";
import { BROAD_EXTENSION_INPUT_PROJECTS } from "../graph/ci_plan.mjs";
import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";

function moonJson(args) {
  return JSON.parse(execFileSync(moonCommand(), args, {
    encoding: "utf8",
    env: moonEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
  }));
}

test("release product tasks use semantic names and keep package independent", () => {
  const projects = moonJson(["query", "projects"]).projects;
  const tasks = moonJson(["query", "tasks"]).tasks;
  const releaseProducts = projects.filter((project) => project.config?.tags?.includes("release-product"));
  const forbidden = new Set(["test", "release-check", "assemble-release"]);

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
        !/:(?:check|format-check|lint|test|unit)$/u.test(dependency.target),
        `${project.id}:package hides unrelated quality task ${dependency.target}`,
      );
    }
  }

  const sdkProducts = [
    "oliphaunt-js",
    "oliphaunt-kotlin",
    "oliphaunt-react-native",
    "oliphaunt-rust",
    "oliphaunt-swift",
    "oliphaunt-wasix-rust",
    "oliphaunt-wasix-ts",
  ];
  for (const project of sdkProducts) {
    assert.deepEqual(
      Object.values(tasks[project]).filter((task) => task.tags?.includes("artifact-package")),
      [],
      `${project} must not own repository release orchestration`,
    );
  }

  const releaseTasks = tasks["release-tools"];
  for (const [task, product] of [
    ["js-sdk-package", "oliphaunt-js"],
    ["react-native-sdk-package", "oliphaunt-react-native"],
    ["rust-sdk-package", "oliphaunt-rust"],
    ["swift-sdk-package", "oliphaunt-swift"],
    ["wasix-rust-package", "oliphaunt-wasix-rust"],
    ["wasix-ts-sdk-package", "oliphaunt-wasix-ts"],
  ]) {
    assert.equal(
      releaseTasks[task].deps.some(
        ({ target }) => target === `${product}:package`,
      ),
      true,
      `release-tools:${task} must consume ${product}:package output`,
    );
  }
});

test("task edges distinguish artifact data from ordering gates", () => {
  const tasks = Object.values(moonJson(["task-graph", "--json"]).data);
  const byTarget = new Map(tasks.map((task) => [task.target, task]));
  const projectSources = new Map(
    moonJson(["query", "projects"]).projects.map(({ id, source }) => [id, source]),
  );
  const outputs = [];

  for (const consumer of tasks) {
    const consumerTags = new Set(consumer.tags ?? []);
    const isProducer = ["artifact-builder", "artifact-package", "build", "package"]
      .some((tag) => consumerTags.has(tag));
    const isQualificationAggregate = consumer.id === "qualify" || consumerTags.has("aggregate");
    const project = consumer.target.split(":", 1)[0];
    const projectSource = projectSources.get(project);
    const resolvePath = (value) => value.startsWith("/") ? value : `${projectSource}/${value}`;
    const inputs = new Set(
      (consumer.inputs ?? [])
        .map((input) => input.file ?? input.glob)
        .filter((input) => typeof input === "string")
        .map(resolvePath),
    );
    for (const output of consumer.outputs ?? []) {
      const path = output.file ?? output.glob;
      const resolvedPath = resolvePath(path);
      outputs.push({ path: resolvedPath, task: consumer });
      if (inputs.has(resolvedPath)) {
        assert.equal(
          consumer.options?.cache,
          false,
          `${consumer.target} caches a path declared as both input and output`,
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

  const staticRoot = (value) => value.slice(0, value.search(/[?*[{]/u) < 0 ? value.length : value.search(/[?*[{]/u));
  const overlaps = (left, right) => {
    const leftRoot = staticRoot(left);
    const rightRoot = staticRoot(right);
    return leftRoot === rightRoot || leftRoot.startsWith(rightRoot) || rightRoot.startsWith(leftRoot);
  };
  for (let left = 0; left < outputs.length; left += 1) {
    for (let right = left + 1; right < outputs.length; right += 1) {
      const first = outputs[left];
      const second = outputs[right];
      if (first.task.target === second.task.target || !overlaps(first.path, second.path)) continue;
      const pair = [first.task, second.task];
      const alternatives = pair.every((task) => task.tags?.includes("alternative-producer"));
      const finalizer = pair.find((task) => task.tags?.includes("in-place-finalizer"));
      const input = pair.find((task) => task.tags?.includes("in-place-finalizer-input"));
      assert.equal(
        alternatives || Boolean(finalizer && input),
        true,
        `${first.path} and ${second.path} have overlapping owners without an explicit ownership contract: ${pair.map(({ target }) => target).join(", ")}`,
      );
      assert.equal(
        pair.every((task) => task.options?.cache === false),
        true,
        `overlapping output owners must not be cached: ${pair.map(({ target }) => target).join(", ")}`,
      );
      if (finalizer && input) {
        assert.equal(
          finalizer.deps.some(({ target }) => target === input.target),
          true,
          `${finalizer.target} must directly finalize ${input.target}`,
        );
      }
    }
  }
});

test("WASIX Postmaster qualification includes its packaged runtime behavior", () => {
  const tasks = moonJson(["query", "tasks"]).tasks["liboliphaunt-wasix-postmaster"];
  assert.deepEqual(
    tasks["runtime-patch-tests"].deps.map(({target}) => target),
    ["liboliphaunt-wasix-postmaster:prepare-runtime"],
  );
  assert.deepEqual(
    tasks.qualify.deps.map(({target}) => target).sort(),
    [
      "liboliphaunt-wasix-postmaster:immediate-recovery",
      "liboliphaunt-wasix-postmaster:linear-memory-integration",
      "liboliphaunt-wasix-postmaster:lint",
      "liboliphaunt-wasix-postmaster:regression",
      "liboliphaunt-wasix-postmaster:release-assets",
      "liboliphaunt-wasix-postmaster:runtime-patch-tests",
      "liboliphaunt-wasix-postmaster:unit",
    ],
  );
});

test("WASIX TypeScript products build packages and root integration consumes them", () => {
  const tasks = moonJson(["query", "tasks"]).tasks;
  const integration = tasks["wasix-ts-integration"].runtime;
  const dependencies = new Set(integration.deps.map(({ target }) => target));

  assert.deepEqual(
    [...dependencies].sort(),
    [
      "liboliphaunt-wasix:runtime-portable",
      "oliphaunt-wasix-tools-ts:package",
      "oliphaunt-wasix-ts:package",
      "release-tools:wasix-napi-runtime",
    ],
  );
  assert.deepEqual(integration.outputs ?? [], []);
  assert.equal(integration.options.cache, false);
  assert.equal(
    tasks["release-tools"]["wasix-ts-sdk-package"].deps.some(
      ({ target }) => target === integration.target,
    ),
    false,
  );
});

test("WASIX Node-API release build consumes its runtime and extension artifacts", () => {
  const task = moonJson(["query", "tasks"]).tasks["release-tools"]["wasix-napi-runtime"];
  assert.deepEqual(task.deps.map(({ target }) => target).sort(), [
    "liboliphaunt-wasix:runtime-aot",
    "release-tools:wasix-extension-packages",
  ]);
});

test("CI planner project selectors resolve to Moon projects", () => {
  const projects = moonJson(["query", "projects"]).projects;
  const projectIds = new Set(projects.map(({ id }) => id));
  for (const project of BROAD_EXTENSION_INPUT_PROJECTS) {
    assert.equal(projectIds.has(project), true, `unknown CI planner project ${project}`);
  }
});

test("Moon projects do not duplicate inferred dependency edges", () => {
  for (const project of moonJson(["query", "projects"]).projects) {
    const configured = project.config.dependsOn ?? [];
    const dependencies = configured
      .filter((dependency) => typeof dependency === "string" || dependency.source !== "implicit")
      .map((dependency) => typeof dependency === "string" ? dependency : dependency.id);
    const inferred = new Set(
      configured
        .filter((dependency) => typeof dependency !== "string" && dependency.source === "implicit")
        .map((dependency) => dependency.id),
    );
    assert.equal(
      new Set(dependencies).size,
      dependencies.length,
      `${project.id} duplicates a project dependency already inferred by Moon`,
    );
    assert.deepEqual(
      dependencies.filter((dependency) => inferred.has(dependency)),
      [],
      `${project.id} explicitly repeats an inferred project dependency`,
    );
    assert.equal(
      dependencies.includes(project.id),
      false,
      `${project.id} depends on itself`,
    );
  }
});

test("Moon project metadata has no source-to-tool dependency edges", () => {
  const projects = moonJson(["query", "projects"]).projects;
  const tooling = new Set(
    projects.filter(({ source }) => source.startsWith("tools/")).map(({ id }) => id),
  );
  for (const project of projects.filter(({ source }) => source.startsWith("src/"))) {
    const dependencies = (project.config.dependsOn ?? []).map((dependency) =>
      typeof dependency === "string" ? dependency : dependency.id
    );
    assert.deepEqual(
      dependencies.filter((dependency) => tooling.has(dependency)),
      [],
      `${project.id} depends on repository tooling`,
    );
  }
});
