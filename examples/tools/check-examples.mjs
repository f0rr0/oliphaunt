#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
process.chdir(root);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function tracked(...pathspecs) {
  return execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

run("bash", ["examples/tools/stage-tauri-webdriver-app.test.sh"]);
run("bun", ["test", "examples/react-native-expo/tools/smoke-pass-receipt.test.mjs"]);
run("bun", ["test", "examples/react-native-expo/tools/mobile-extension-proof.test.mjs"]);

const allowed = /^(examples\/(moon\.yml|README\.md|assets\/[^/]+|tools\/[^/]+|(tauri|tauri-wasix|electron|electron-wasix|browser-wasix|react-native-expo)(\/.*)?))$/u;
const misplaced = tracked("examples").filter((file) => !allowed.test(file));
const vendored = tracked("examples/**/node_modules/**", "src/**/examples/**/node_modules/**");
const productExamples = tracked("src/**/examples/**");
if (misplaced.length || vendored.length || productExamples.length) {
  throw new Error([
    ...misplaced.map((file) => `unsupported root example path: ${file}`),
    ...vendored.map((file) => `tracked example dependency: ${file}`),
    ...productExamples.map((file) => `product-local example must move under examples/: ${file}`),
  ].join("\n"));
}

console.log("example behavior and ownership verified");
