#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { electronReleaseDependencies } from "./example-release-dependencies.mjs";
import { captureCommandOutput } from "../../tools/dev/capture-command-output.mjs";

let ROOT = process.cwd();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  console.log(`\n==> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function output(command, args, options = {}) {
  const result = captureCommandOutput(command, args, {
    cwd: ROOT,
    label: `${command} ${args.join(" ")}`,
    ...options,
  });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    fail(result.stderr.trim() || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function gitLsFiles(...pathspecs) {
  const args = ["ls-files", "-z"];
  if (pathspecs.length > 0) {
    args.push("--", ...pathspecs);
  }
  return output("git", args, {
    allowEmptyOutput: true,
    stdoutTerminator: "\0",
  })
    .split("\0")
    .filter(Boolean);
}

function requireFile(path) {
  if (!existsSync(path)) {
    fail(`missing required product-local example file: ${path}`);
  }
}

function requireText(path, pattern) {
  const text = readFileSync(path, "utf8");
  if (!new RegExp(pattern, "m").test(text)) {
    fail(`missing required example scheduling pattern in ${path}: ${pattern}`);
  }
}

function readJsonObject(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(`${path} must contain a JSON object`);
  }
  return value;
}

function requireDependencyVersion(path, packageName, expectedVersion) {
  const data = readJsonObject(path);
  const dependencies = data.dependencies;
  if (dependencies === null || Array.isArray(dependencies) || typeof dependencies !== "object") {
    fail(`${path} must declare dependencies`);
  }
  const actual = dependencies[packageName];
  if (actual !== expectedVersion) {
    fail(
      `${path} dependency ${packageName} must match current release product version ${expectedVersion}, got ${actual ?? "<missing>"}`,
    );
  }
}

function requireWasixToolsSmoke(path) {
  requireText(path, String.raw`pg_dump\(|PgDumpOptions::new\(\)`);
  requireText(path, String.raw`psql\(|PsqlOptions::new\(\)`);
}

function rejectText(path, pattern) {
  const text = readFileSync(path, "utf8");
  if (new RegExp(pattern, "m").test(text)) {
    fail(`forbidden example local dependency pattern in ${path}: ${pattern}`);
  }
}

function rejectFile(path) {
  if (existsSync(path)) {
    fail(`forbidden stale example file: ${path}`);
  }
}

ROOT = output("git", ["rev-parse", "--show-toplevel"]).trim();
if (ROOT.length === 0) {
  fail("must run inside the Oliphaunt git checkout");
}
process.chdir(ROOT);

run("bash", ["examples/tools/check-lockfiles.sh", "--check"]);
run("bash", ["examples/tools/stage-tauri-webdriver-app.test.sh"]);
run("tools/dev/bun.sh", [
  "test",
  "examples/react-native-expo/tools/smoke-pass-receipt.test.mjs",
]);
run("tools/dev/bun.sh", [
  "test",
  "examples/react-native-expo/tools/mobile-extension-proof.test.mjs",
]);

const allowedRootExamples =
  /^(examples\/moon\.yml|examples\/README\.md|examples\/assets\/[^/]+|examples\/tools\/[^/]+|examples\/(tauri|tauri-wasix|electron|electron-wasix|browser-wasix|react-native-expo)(\/.*)?)$/;
const violations = gitLsFiles("examples").filter((path) => !allowedRootExamples.test(path));
if (violations.length > 0) {
  console.error("root examples/ may contain only cross-product example policy/tooling");
  console.error(violations.join("\n"));
  process.exit(1);
}

const trackedNodeModules = gitLsFiles(
  "examples/**/node_modules/**",
  "src/**/examples/**/node_modules/**",
);
if (trackedNodeModules.length > 0) {
  console.error("example dependencies must not be tracked");
  console.error(trackedNodeModules.join("\n"));
  process.exit(1);
}

const sourceLocalExamples = gitLsFiles("src/**/examples/**");
if (sourceLocalExamples.length > 0) {
  console.error("product examples must live under the repository-level examples/ directory");
  console.error(sourceLocalExamples.join("\n"));
  process.exit(1);
}

requireFile("examples/tools/run-tauri-webdriver-smoke.sh");
requireFile("examples/tools/stage-tauri-webdriver-app.sh");
requireFile("examples/tools/stage-tauri-webdriver-app.test.sh");
requireFile("examples/tools/tauri-webdriver-smoke.mjs");
requireFile("examples/tools/run-electron-driver-smoke.sh");
requireFile("examples/tools/electron-driver-smoke.mjs");
requireFile("examples/tools/electron-test-driver.mjs");
requireFile("examples/react-native-expo/tools/smoke-pass-receipt.test.mjs");
requireFile("examples/react-native-expo/tools/mobile-extension-proof.test.mjs");
requireText("examples/tools/run-tauri-webdriver-smoke.sh", String.raw`cargo install tauri-driver --locked --version 2\.0\.6`);
requireText(
  "examples/tools/run-tauri-webdriver-smoke.sh",
  String.raw`pnpm --dir "\$app_dir" install --no-frozen-lockfile`,
);
requireText(
  "examples/tools/run-electron-driver-smoke.sh",
  String.raw`pnpm --dir "\$app_dir" install --no-frozen-lockfile`,
);
rejectText(
  "examples/tools/run-electron-driver-smoke.sh",
  String.raw`assert_npm_package\s+"@oliphaunt/[^"]+"\s+"[0-9]+\.[0-9]+\.[0-9]+"`,
);
requireText("examples/tools/run-electron-driver-smoke.sh", String.raw`OLIPHAUNT_WASIX_TODO_SIDECAR`);
requireText("examples/tools/run-electron-driver-smoke.sh", String.raw`src-wasix/Cargo\.toml`);
requireText("examples/tools/tauri-webdriver-smoke.mjs", "tauri webdriver todo smoke passed");
requireText("examples/tools/electron-driver-smoke.mjs", "electron driver todo smoke passed");
requireText("examples/tools/electron-test-driver.mjs", "installElectronTodoTestDriver");
rejectText("pnpm-workspace.yaml", '"examples/electron"');
rejectText("pnpm-workspace.yaml", '"examples/tauri"');
rejectText("pnpm-workspace.yaml", '"examples/tauri-wasix"');
rejectText("pnpm-workspace.yaml", '"examples/electron-wasix"');
rejectText("pnpm-lock.yaml", "examples/electron:");
rejectText("pnpm-lock.yaml", "examples/tauri:");
rejectText("pnpm-lock.yaml", "examples/tauri-wasix:");
rejectText("pnpm-lock.yaml", "examples/electron-wasix:");
for (const example of ["tauri", "tauri-wasix", "electron", "electron-wasix"]) {
  requireFile(`examples/${example}/package.json`);
  requireFile(`examples/${example}/pnpm-workspace.yaml`);
  requireFile(`examples/${example}/README.md`);
}
for (const example of ["electron", "electron-wasix"]) {
  requireText(`examples/${example}/pnpm-workspace.yaml`, String.raw`electron: true`);
  requireText(`examples/${example}/pnpm-workspace.yaml`, String.raw`esbuild: true`);
}
for (const example of ["tauri", "tauri-wasix"]) {
  requireText(`examples/${example}/pnpm-workspace.yaml`, String.raw`esbuild: true`);
}
requireFile("examples/tauri/src-tauri/Cargo.toml");
requireFile("examples/tauri-wasix/src-tauri/Cargo.toml");
requireFile("examples/electron-wasix/src-wasix/Cargo.toml");
requireFile("tools/release/example-cargo-policy.mjs");
for (const { packageName, version } of electronReleaseDependencies(ROOT)) {
  requireDependencyVersion("examples/electron/package.json", packageName, version);
}
requireText("examples/electron/package.json", String.raw`"pg": "\^8\.16\.3"`);
rejectFile("examples/electron/src/oliphaunt-kysely.ts");
rejectText("examples/tauri/src-tauri/Cargo.toml", 'registry\\s*=\\s*"oliphaunt-local"');
requireText("examples/tauri/src-tauri/Cargo.toml", "oliphaunt-extension-contrib-pg18-linux-x64-gnu");
requireText("examples/electron/src/todos.ts", String.raw`from "@oliphaunt/tools"`);
requireText("examples/electron/src/todos.ts", String.raw`pgDump\(connectionString`);
requireText("examples/electron/src/todos.ts", String.raw`psql\(connectionString`);
rejectText("examples/tauri-wasix/src-tauri/Cargo.toml", 'registry\\s*=\\s*"oliphaunt-local"');
requireText("examples/tauri-wasix/src-tauri/Cargo.toml", '"tools"');
requireText("examples/tauri-wasix/src-tauri/Cargo.toml", "oliphaunt-wasix-tools");
requireText("examples/tauri-wasix/src-tauri/Cargo.toml", "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu");
requireText("examples/tauri-wasix/src-tauri/Cargo.toml", "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu");
requireWasixToolsSmoke("examples/tauri-wasix/src-tauri/src/lib.rs");
rejectText("examples/electron-wasix/src-wasix/Cargo.toml", 'registry\\s*=\\s*"oliphaunt-local"');
requireText("examples/electron-wasix/src-wasix/Cargo.toml", '"tools"');
requireText("examples/electron-wasix/src-wasix/Cargo.toml", "oliphaunt-wasix-tools");
requireText("examples/electron-wasix/src-wasix/Cargo.toml", "liboliphaunt-wasix-aot-x86_64-unknown-linux-gnu");
requireText("examples/electron-wasix/src-wasix/Cargo.toml", "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu");
requireWasixToolsSmoke("examples/electron-wasix/src-wasix/src/main.rs");
rejectText("examples/electron/package.json", '"@oliphaunt/ts": "workspace:\\*"');
rejectText("examples/electron/package.json", '"typescript": "catalog:"');
rejectText("examples/tauri/package.json", '"typescript": "catalog:"');
rejectText("examples/tauri-wasix/package.json", '"typescript": "catalog:"');
rejectText("examples/electron-wasix/package.json", '"typescript": "catalog:"');
rejectText("examples/tauri/src-tauri/Cargo.toml", 'path = "../../../src/sdks/rust');
rejectText("examples/tauri-wasix/src-tauri/Cargo.toml", 'path = "../../../src/bindings/wasix-rust');
rejectText("examples/electron-wasix/src-wasix/Cargo.toml", 'path = "../../../src/bindings/wasix-rust');
for (const lockfile of [
  "examples/tauri/src-tauri/Cargo.lock",
  "examples/tauri-wasix/src-tauri/Cargo.lock",
  "examples/electron-wasix/src-wasix/Cargo.lock",
]) {
  rejectFile(lockfile);
}

requireFile("examples/browser-wasix/index.html");
requireFile("examples/browser-wasix/vite.config.ts");
requireFile("examples/react-native-expo/package.json");
requireFile("examples/react-native-expo/maestro/installed-smoke.yaml");
requireText("src/sdks/react-native/moon.yml", String.raw`^  mobile-build-android:$`);
requireText("src/sdks/react-native/moon.yml", String.raw`^  mobile-e2e-android:$`);
requireText("src/sdks/react-native/moon.yml", String.raw`^  mobile-build-ios:$`);
requireText("src/sdks/react-native/moon.yml", String.raw`^  mobile-e2e-ios:$`);

console.log("example ownership and scheduling policy verified");
