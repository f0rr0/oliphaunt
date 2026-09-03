const RUST_CAPABILITY_TAG = "ci-rust";
const MAINTAINER_TOOLS_CAPABILITY_TAG = "ci-maintainer-tools";
const ANDROID_SDK_CAPABILITY_TAG = "ci-android-sdk";

const DISPLAY_WORDS = Object.freeze({
  abi: "ABI",
  aot: "AOT",
  api: "API",
  ci: "CI",
  e2e: "E2E",
  icu: "ICU",
  ios: "iOS",
  js: "JavaScript",
  liboliphaunt: "liboliphaunt",
  macos: "macOS",
  napi: "Node-API",
  node: "Node.js",
  npm: "npm",
  sdk: "SDK",
  sql: "SQL",
  ts: "TypeScript",
  wasm: "WebAssembly",
  wasix: "WASIX",
  xtask: "xtask",
});

export const CHECK_SHARD_MAX_TARGETS = 4;

function taskTags(task) {
  return new Set(Array.isArray(task?.tags) ? task.tags : []);
}

export function taskDependencies(task) {
  return (Array.isArray(task?.deps) ? task.deps : [])
    .map((dependency) => {
      if (typeof dependency === "string") return dependency;
      if (dependency && typeof dependency === "object" && typeof dependency.target === "string") {
        return dependency.target;
      }
      return "";
    })
    .filter(Boolean);
}

function taskTarget(task) {
  if (typeof task?.target !== "string" || task.target.length === 0) {
    throw new Error("Moon task capability resolution requires a task target");
  }
  return task.target;
}

export function taskCapabilities(task, taskMap, state = {}) {
  const target = taskTarget(task);
  const memo = state.memo ?? new Map();
  const visiting = state.visiting ?? new Set();
  const cached = memo.get(target);
  if (cached !== undefined) return cached;
  if (visiting.has(target)) {
    throw new Error(`Moon task capability dependency cycle through ${target}`);
  }

  visiting.add(target);
  const tags = taskTags(task);
  let requiresMaintainerTools = tags.has(MAINTAINER_TOOLS_CAPABILITY_TAG);
  let requiresRust = tags.has(RUST_CAPABILITY_TAG) || requiresMaintainerTools;
  let requiresAndroidSdk = tags.has(ANDROID_SDK_CAPABILITY_TAG);

  for (const dependency of taskDependencies(task)) {
    const dependencyTask = taskMap.get(dependency);
    if (dependencyTask === undefined) {
      throw new Error(`${target} capability dependency ${dependency} is missing from Moon task metadata`);
    }
    const capabilities = taskCapabilities(dependencyTask, taskMap, { memo, visiting });
    requiresMaintainerTools ||= capabilities.requires_maintainer_tools;
    requiresRust ||= capabilities.requires_rust;
    requiresAndroidSdk ||= capabilities.requires_android_sdk;
  }

  visiting.delete(target);
  const capabilities = Object.freeze({
    requires_rust: requiresRust,
    requires_maintainer_tools: requiresMaintainerTools,
    requires_android_sdk: requiresAndroidSdk,
  });
  memo.set(target, capabilities);
  return capabilities;
}

export function matrixTarget(task, upstream, taskMap) {
  return {
    target: taskTarget(task),
    label: taskLabel(taskTarget(task)),
    upstream,
    ...taskCapabilities(task, taskMap),
  };
}

export function taskLabel(target) {
  return target.split(":").map((part) => part.split("-").map((word) =>
    DISPLAY_WORDS[word] ?? `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`
  ).join(" ")).join(" / ");
}

function compareTargets(left, right) {
  return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
}

function shardRow(targets) {
  const first = targets[0];
  return {
    label: targets.map(({ label }) => label).join(" + "),
    target_count: targets.length,
    requires_rust: first.requires_rust,
    requires_maintainer_tools: first.requires_maintainer_tools,
    requires_android_sdk: first.requires_android_sdk,
    targets_json: JSON.stringify({
      include: targets.map(({ target, upstream }) => ({ target, upstream })),
    }),
  };
}

export function shardCheckTargets(targets, { maxTargets = CHECK_SHARD_MAX_TARGETS } = {}) {
  if (!Number.isInteger(maxTargets) || maxTargets < 1) {
    throw new Error("check shard size must be a positive integer");
  }
  const ordered = [...targets].sort(compareTargets);
  const unique = new Set(ordered.map(({ target }) => target));
  if (unique.size !== ordered.length) {
    throw new Error("check shard input contains duplicate Moon targets");
  }

  const shardable = ordered.filter((target) =>
    !target.requires_rust
    && !target.requires_maintainer_tools
    && !target.requires_android_sdk);
  const dedicated = ordered.filter((target) => !shardable.includes(target));
  const groups = [];
  for (let index = 0; index < shardable.length; index += maxTargets) {
    groups.push(shardable.slice(index, index + maxTargets));
  }
  groups.push(...dedicated.map((target) => [target]));

  return groups.map(shardRow);
}
