import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { afterEach, test } from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const PROJECT_FILE = "src/extensions/artifacts/packages/moon.yml";
const RELEASE_SCRIPT = "src/extensions/artifacts/packages/tools/package-release-assets.sh";
const MOBILE_SCRIPT = "src/extensions/artifacts/packages/tools/package-mobile-release-assets.sh";
const EXTENSION_ASSET_CONTRACT_INPUT = "/tools/release/extension-runtime-asset-contract.mjs";
const EXTENSION_ASSET_CONTRACT_CONSUMER_INPUTS = new Set([
  "/tools/release/build-extension-ci-artifacts.mjs",
  "/tools/release/check-staged-artifacts.mjs",
  "/tools/release/extension-registry-carrier-materializer.mjs",
  "/tools/release/publication-lock.mjs",
]);
const roots = [];

function localModuleClosure(entrypoints) {
  const pending = [...entrypoints];
  const result = new Set();
  while (pending.length > 0) {
    const relative = pending.shift();
    if (result.has(relative)) continue;
    result.add(relative);
    const extension = path.extname(relative);
    if (![".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"].includes(extension)) {
      continue;
    }
    const loader = extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "ts"
      : extension === ".tsx"
        ? "tsx"
        : "js";
    const transpiler = new Bun.Transpiler({ loader });
    const source = readFileSync(path.join(ROOT, relative), "utf8");
    for (const imported of transpiler.scan(source).imports) {
      if (!imported.path.startsWith(".")) continue;
      const unresolved = path.resolve(ROOT, path.dirname(relative), imported.path);
      const candidates = path.extname(unresolved)
        ? [unresolved]
        : [unresolved, ...[".mjs", ".js", ".ts", ".tsx"].map((suffix) => `${unresolved}${suffix}`)];
      const matches = candidates.filter((candidate) => existsSync(candidate));
      assert.equal(matches.length, 1, `${relative} must resolve ${imported.path} to one repository file`);
      const absolute = matches[0];
      const dependency = path.relative(ROOT, absolute).split(path.sep).join("/");
      assert.ok(!dependency.startsWith("../"), `${relative} import must remain inside the repository`);
      pending.push(dependency);
    }
  }
  return [...result].sort();
}

function fixtureRun(script, { environment = {}, failTool = "" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-extension-package-"));
  roots.push(root);
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);

  const toolDirectory = path.join(root, "tools/dev");
  mkdirSync(toolDirectory, { recursive: true });
  const callsFile = path.join(root, "calls.txt");
  const bunShim = path.join(toolDirectory, "bun.sh");
  writeFileSync(bunShim, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$OLIPHAUNT_TEST_CALLS_FILE"
if [[ "\${OLIPHAUNT_TEST_FAIL_TOOL:-}" == "$1" ]]; then
  exit 73
fi
`);
  chmodSync(bunShim, 0o755);

  const execution = spawnSync("bash", [path.join(ROOT, script)], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      OLIPHAUNT_TEST_CALLS_FILE: callsFile,
      OLIPHAUNT_TEST_FAIL_TOOL: failTool,
    },
  });
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trimEnd().split("\n")
    : [];
  return { calls, execution };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("Moon plans both extension assembly tasks for every producer and validator module", () => {
  const project = Bun.YAML.parse(readFileSync(path.join(ROOT, PROJECT_FILE), "utf8"));
  const workspaceTasks = Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".moon/tasks/inputs.yml"), "utf8"),
  );
  const implicitInputs = new Set(workspaceTasks.implicitInputs ?? []);
  assert.ok(
    implicitInputs.has("/tools/dev/capture-command-output.mjs"),
    "the shared file-backed command transport must invalidate every Moon task",
  );
  assert.equal(
    project.tasks["assemble-release"].command,
    `bash ${RELEASE_SCRIPT}`,
  );
  assert.equal(
    project.tasks["assemble-mobile"].command,
    `bash ${MOBILE_SCRIPT}`,
  );

  const moduleInputs = localModuleClosure([
    "tools/release/build-extension-ci-artifacts.mjs",
    "tools/release/check-staged-artifacts.mjs",
  ]).map((file) => `/${file}`);
  const commonDataInputs = [
    "/.release-please-manifest.json",
    "/release-please-config.json",
    "/src/postgres/versions/18/source.toml",
    "/src/runtimes/liboliphaunt/native/moon.yml",
    "/src/runtimes/liboliphaunt/native/release.toml",
    "/src/runtimes/liboliphaunt/native/VERSION",
    "/src/runtimes/liboliphaunt/wasix/moon.yml",
    "/src/runtimes/liboliphaunt/wasix/release.toml",
    "/src/runtimes/liboliphaunt/wasix/VERSION",
    "/src/shared/extension-runtime-contract/**/*",
    "/tools/dev/bun.sh",
    "/tools/release/extension-target-profiles.toml",
    "/tools/release/release-semantic-inputs.toml",
  ];
  for (const taskName of ["assemble-mobile", "assemble-release"]) {
    const taskInputs = new Set(project.tasks[taskName].inputs);
    for (const input of [...moduleInputs, ...commonDataInputs]) {
      assert.ok(
        taskInputs.has(input) || implicitInputs.has(input),
        `${taskName} must track ${input} directly or through global implicit inputs`,
      );
    }
  }
});

test("Moon tasks that consume the public extension asset projection own its exact source input", () => {
  const listed = spawnSync("git", ["ls-files", "--", "*moon.yml"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  const projectFiles = listed.stdout.split(/\r?\n/u).filter(Boolean);
  assert.ok(projectFiles.length > 0, "repository must contain Moon project files");

  for (const projectFile of projectFiles) {
    const project = Bun.YAML.parse(readFileSync(path.join(ROOT, projectFile), "utf8"));
    for (const [taskName, task] of Object.entries(project.tasks ?? {})) {
      const inputs = new Set(Array.isArray(task?.inputs) ? task.inputs : []);
      if (![...EXTENSION_ASSET_CONTRACT_CONSUMER_INPUTS].some((input) => inputs.has(input))) {
        continue;
      }
      assert.ok(
        inputs.has(EXTENSION_ASSET_CONTRACT_INPUT),
        `${projectFile} ${taskName} must track ${EXTENSION_ASSET_CONTRACT_INPUT}`,
      );
    }
  }
});

test("full extension assembly validates exactly the planner-selected products and all targets", () => {
  const { calls, execution } = fixtureRun(RELEASE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS:
        "oliphaunt-extension-postgis, oliphaunt-extension-vector",
    },
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "tools/release/check-staged-artifacts.mjs --require-full-extension-targets --require-extension-product oliphaunt-extension-postgis --require-extension-product oliphaunt-extension-vector",
  ]);
});

test("full extension assembly requires every product when no focused selection exists", () => {
  const { calls, execution } = fixtureRun(RELEASE_SCRIPT);
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "tools/release/check-staged-artifacts.mjs --require-full-extension-targets --require-extension-product all",
  ]);
});

test("extension assembly stops after producer failure and propagates validator failure", () => {
  const producerFailure = fixtureRun(RELEASE_SCRIPT, {
    failTool: "tools/release/build-extension-ci-artifacts.mjs",
  });
  assert.equal(producerFailure.execution.status, 73);
  assert.deepEqual(producerFailure.calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
  ]);

  const validatorFailure = fixtureRun(RELEASE_SCRIPT, {
    failTool: "tools/release/check-staged-artifacts.mjs",
  });
  assert.equal(validatorFailure.execution.status, 73);
  assert.deepEqual(validatorFailure.calls, [
    "tools/release/build-extension-ci-artifacts.mjs --all --require-native --require-wasix",
    "tools/release/check-staged-artifacts.mjs --require-full-extension-targets --require-extension-product all",
  ]);
});

test("mobile extension assembly propagates its immediate validator failure", () => {
  const { calls, execution } = fixtureRun(MOBILE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS: "android-arm64-v8a,ios-xcframework",
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: "oliphaunt-extension-postgis",
    },
    failTool: "tools/release/check-staged-artifacts.mjs",
  });
  assert.equal(execution.status, 73);
  assert.deepEqual(calls, [
    "tools/release/build-extension-ci-artifacts.mjs oliphaunt-extension-postgis --require-native-target android-arm64-v8a --require-native-target ios-xcframework",
    "tools/release/check-staged-artifacts.mjs --require-extension-product oliphaunt-extension-postgis",
  ]);
});

test("mobile extension assembly rejects delimiter-only selections without nounset errors", () => {
  const emptyProducts = fixtureRun(MOBILE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS: "android-arm64-v8a",
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: ", ,",
    },
  });
  assert.equal(emptyProducts.execution.status, 1);
  assert.match(emptyProducts.execution.stderr, /did not contain any products/u);
  assert.doesNotMatch(emptyProducts.execution.stderr, /unbound variable/u);

  const emptyTargets = fixtureRun(MOBILE_SCRIPT, {
    environment: {
      OLIPHAUNT_EXTENSION_PACKAGE_NATIVE_TARGETS: ", ,",
      OLIPHAUNT_EXTENSION_PACKAGE_PRODUCTS: "oliphaunt-extension-postgis",
    },
  });
  assert.equal(emptyTargets.execution.status, 1);
  assert.match(emptyTargets.execution.stderr, /did not contain any targets/u);
  assert.doesNotMatch(emptyTargets.execution.stderr, /unbound variable/u);
});
