import assert from "node:assert/strict";
import { spawnSync } from "../../tools/test/fd-backed-spawn-sync.mjs";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, ".github/scripts/configure-macos-release-toolchains.sh");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-macos-release-toolchains-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const javaHome = path.join(root, "java-17");
  const androidHome = path.join(root, "android-sdk");
  const githubEnv = path.join(root, "github-env");
  const githubPath = path.join(root, "github-path");
  mkdirSync(path.join(javaHome, "bin"), { recursive: true });
  mkdirSync(androidHome);
  writeFileSync(path.join(javaHome, "bin/java"), "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(path.join(javaHome, "bin/java"), 0o755);
  writeFileSync(githubEnv, "");
  writeFileSync(githubPath, "");
  return { androidHome, githubEnv, githubPath, javaHome, root };
}

function run(value, args = [], overrides = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ANDROID_HOME: "",
      ANDROID_SDK_ROOT: "",
      GITHUB_ENV: value.githubEnv,
      GITHUB_PATH: value.githubPath,
      HOME: value.root,
      JAVA_HOME_17_X64: "",
      JAVA_HOME_17_arm64: value.javaHome,
      RUNNER_OS: "macOS",
      ...overrides,
    },
  });
}

test("configures exact Java and Android identities for publication-host validation", (t) => {
  const value = fixture(t);
  const result = run(value, ["--android"], { ANDROID_HOME: value.androidHome });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    readFileSync(value.githubEnv, "utf8"),
    `JAVA_HOME=${value.javaHome}\nANDROID_HOME=${value.androidHome}\nANDROID_SDK_ROOT=${value.androidHome}\n`,
  );
  assert.equal(readFileSync(value.githubPath, "utf8"), `${value.javaHome}/bin\n`);
});

test("registry/finalization mode configures Java without widening to Android", (t) => {
  const value = fixture(t);
  const result = run(value);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(value.githubEnv, "utf8"), `JAVA_HOME=${value.javaHome}\n`);
  assert.equal(readFileSync(value.githubPath, "utf8"), `${value.javaHome}/bin\n`);
});

test("fails closed outside macOS and for missing or malformed toolchains", (t) => {
  for (const [args, overrides, pattern] of [
    [[], { RUNNER_OS: "Linux" }, /requires a GitHub macOS runner/u],
    [[], { JAVA_HOME_17_arm64: "/missing" }, /usable Java 17/u],
    [["--android"], {}, /usable Android SDK/u],
    [["--unknown"], {}, /usage:/u],
  ]) {
    const value = fixture(t);
    const result = run(value, args, overrides);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, pattern);
  }
});
