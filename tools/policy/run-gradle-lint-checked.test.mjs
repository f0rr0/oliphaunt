import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = path.join(ROOT, "tools/policy/run-gradle-lint-checked.sh");
const scratchRoots = [];

afterEach(() => {
  for (const scratchRoot of scratchRoots.splice(0)) {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

function runChecked(command) {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "oliphaunt-gradle-lint-"));
  scratchRoots.push(scratchRoot);
  const logFile = path.join(scratchRoot, "nested", "lint.log");
  const result = spawnSync(
    "sh",
    [HELPER, logFile, "--", "sh", "-c", command],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { ...result, log: readFileSync(logFile, "utf8") };
}

describe("run-gradle-lint-checked", () => {
  test("accepts clean successful output and preserves the log", () => {
    const result = runChecked("printf 'lint clean\\n'");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("lint clean\n");
    expect(result.stderr).toBe("");
    expect(result.log).toBe("lint clean\n");
  });

  test("preserves the underlying command failure", () => {
    const result = runChecked("printf 'lint command failed\\n' >&2; exit 23");

    expect(result.status).toBe(23);
    expect(result.stdout).toBe("lint command failed\n");
    expect(result.stderr).toBe("");
    expect(result.log).toBe("lint command failed\n");
  });

  test("rejects incompatible Kotlin metadata even when the command exits zero", () => {
    const diagnostic =
      "e: sample.kotlin_module Module was compiled with an incompatible version of Kotlin. "
      + "The binary version of its metadata is 2.4.0, expected version is 2.2.0.";
    const result = runChecked(`printf '%s\\n' '${diagnostic}'`);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(diagnostic);
    expect(result.stderr).toContain(
      "Gradle Lint emitted fatal analyzer compatibility diagnostics despite exiting successfully",
    );
    expect(result.stderr).toContain(diagnostic);
    expect(result.log).toBe(`${diagnostic}\n`);
  });

  test("SDK entrypoints force analyzer execution before accepting cached lint output", () => {
    const kotlinCheck = readFileSync(
      path.join(ROOT, "src/sdks/kotlin/tools/check-sdk.sh"),
      "utf8",
    );
    const reactNativeCheck = readFileSync(
      path.join(ROOT, "src/sdks/react-native/tools/check-sdk.sh"),
      "utf8",
    );

    for (const source of [kotlinCheck, reactNativeCheck]) {
      expect(source).toContain("lintAnalyzeDebug --rerun");
      expect(source).toContain("lintAnalyzeDebugUnitTest --rerun");
      expect(source).toContain("lintAnalyzeDebugAndroidTest --rerun");
      expect(source).toContain("run-gradle-lint-checked.sh");
    }
  });
});
