import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dir, "../..");
const BUILDER = "tools/release/build-sdk-ci-artifacts.mjs";
const PRODUCT_BUILDERS = new Map([
  ["oliphaunt-js", "tools/release/sdk-artifacts/js.mjs"],
  ["oliphaunt-react-native", "tools/release/sdk-artifacts/react-native.mjs"],
  ["oliphaunt-rust", "tools/release/sdk-artifacts/rust.mjs"],
  ["oliphaunt-kotlin", "tools/release/sdk-artifacts/kotlin.mjs"],
  ["oliphaunt-swift", "tools/release/sdk-artifacts/swift.mjs"],
  ["oliphaunt-wasix-rust", "tools/release/sdk-artifacts/wasix-rust.mjs"],
]);
const NOTICE_INPUTS = [
  "/LICENSE",
  "/THIRD_PARTY_NOTICES.md",
];

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

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
    for (const imported of transpiler.scan(read(relative)).imports) {
      if (!imported.path.startsWith(".")) continue;
      const unresolved = path.resolve(ROOT, path.dirname(relative), imported.path);
      const candidates = path.extname(unresolved)
        ? [unresolved]
        : [unresolved, ...[".mjs", ".js", ".ts", ".tsx"].map((suffix) => `${unresolved}${suffix}`)];
      const matches = candidates.filter((candidate) => existsSync(candidate));
      assert.equal(matches.length, 1, `${relative} must resolve ${imported.path} to one repository file`);
      const dependency = path.relative(ROOT, matches[0]).split(path.sep).join("/");
      assert.ok(!dependency.startsWith("../"), `${relative} import must remain inside the repository`);
      pending.push(dependency);
    }
  }
  return [...result].sort();
}

function project(relative) {
  return Bun.YAML.parse(read(relative));
}

function assertInputs(task, expected, label, implicitInputs = new Set()) {
  const inputs = new Set(task.inputs ?? []);
  for (const input of expected) {
    assert.ok(
      inputs.has(input) || implicitInputs.has(input),
      `${label} must track ${input} directly or through global implicit inputs`,
    );
  }
}

test("SDK artifact tasks hash only their complete product builder module closure", () => {
  const implicit = new Set(project(".moon/tasks/inputs.yml").implicitInputs ?? []);
  for (const [product, file] of [
    ["oliphaunt-js", "src/sdks/js/moon.yml"],
    ["oliphaunt-react-native", "src/sdks/react-native/moon.yml"],
    ["oliphaunt-rust", "src/sdks/rust/moon.yml"],
    ["oliphaunt-kotlin", "src/sdks/kotlin/moon.yml"],
    ["oliphaunt-swift", "src/sdks/swift/moon.yml"],
    ["oliphaunt-wasix-rust", "src/bindings/wasix-rust/moon.yml"],
  ]) {
    const entry = PRODUCT_BUILDERS.get(product);
    const closure = localModuleClosure([BUILDER, entry]).map((candidate) => `/${candidate}`);
    assertInputs(project(file).tasks["package-artifacts"], closure, `${product}:package-artifacts`, implicit);

    const inputs = new Set(project(file).tasks["package-artifacts"].inputs ?? []);
    for (const [otherProduct, otherEntry] of PRODUCT_BUILDERS) {
      if (otherProduct === product) continue;
      assert.equal(
        inputs.has(`/${otherEntry}`),
        false,
        `${product}:package-artifacts must not hash ${otherProduct}'s byte producer`,
      );
    }
  }
});

test("source-only SDK package tasks hash their canonical notices and staging contracts", () => {
  for (const [product, file] of [
    ["oliphaunt-js", "src/sdks/js/moon.yml"],
    ["oliphaunt-react-native", "src/sdks/react-native/moon.yml"],
  ]) {
    const tasks = project(file).tasks;
    for (const taskName of ["package", "package-artifacts"]) {
      assertInputs(
        tasks[taskName],
        [
          ...NOTICE_INPUTS,
          "/tools/release/portable-archive.mjs",
          "/tools/release/release-notices.mjs",
          "/tools/release/source-only-sdk-package.mjs",
        ],
        `${product}:${taskName}`,
      );
    }
  }

  const rust = project("src/sdks/rust/moon.yml").tasks;
  for (const taskName of ["package", "package-artifacts"]) {
    assertInputs(
      rust[taskName],
      [
        ...NOTICE_INPUTS,
        "/tools/release/cargo-source-package.mjs",
        "/tools/release/portable-archive.mjs",
        "/tools/release/prepare-rust-release-source.mjs",
        "/tools/release/release-notices.mjs",
      ],
      `oliphaunt-rust:${taskName}`,
    );
  }

  assertInputs(
    project("src/bindings/wasix-rust/moon.yml").tasks["package-artifacts"],
    [
      ...NOTICE_INPUTS,
      "/tools/release/cargo-source-package.mjs",
      "/tools/release/package_oliphaunt_wasix_sdk_crate.mjs",
      "/tools/release/portable-archive.mjs",
      "/tools/release/release-notices.mjs",
    ],
    "oliphaunt-wasix-rust:package-artifacts",
  );
});

test("Kotlin and Swift packaging tasks hash every canonical notice they can stage", () => {
  const kotlin = project("src/sdks/kotlin/moon.yml").tasks;
  const swift = project("src/sdks/swift/moon.yml").tasks;

  assertInputs(kotlin.package, NOTICE_INPUTS, "oliphaunt-kotlin:package");
  assertInputs(
    kotlin["package-artifacts"],
    [...NOTICE_INPUTS, "/tools/release/release-notices.mjs", "/tools/release/portable-archive.mjs"],
    "oliphaunt-kotlin:package-artifacts",
  );
  for (const taskName of ["package", "package-artifacts"]) {
    assertInputs(
      swift[taskName],
      [...NOTICE_INPUTS, "/tools/release/release-notices.mjs", "/tools/release/portable-archive.mjs"],
      `oliphaunt-swift:${taskName}`,
    );
  }
});

test("Kotlin runtime smoke hashes its sourced Android artifact helper", () => {
  const smoke = project("src/sdks/kotlin/moon.yml").tasks.smoke;
  assertInputs(
    smoke,
    ["/src/sdks/react-native/tools/android-smoke-artifacts.sh"],
    "oliphaunt-kotlin:smoke",
  );
});
