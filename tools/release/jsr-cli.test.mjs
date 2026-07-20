import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT } from "./release-cli-utils.mjs";
import { resolvePinnedJsrCli, resolvePinnedJsrInvocation } from "./jsr-cli.mjs";

const scratchRoot = path.join(ROOT, "target", "jsr-cli-resolution-tests");
mkdirSync(scratchRoot, { recursive: true });
const unrelatedCwd = mkdtempSync(path.join(scratchRoot, "frozen-source-"));

afterAll(() => rmSync(unrelatedCwd, { force: true, recursive: true }));

describe("pinned JSR CLI", () => {
  test("resolves the lock-installed regular executable", () => {
    const executable = resolvePinnedJsrCli();
    const metadata = lstatSync(executable);

    expect(path.isAbsolute(executable)).toBe(true);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(metadata.mode & 0o111).not.toBe(0);
    }
    expect(readFileSync(executable, "utf8")).toStartWith("#!/usr/bin/env node\n");
  });

  test("executes from an unrelated frozen-source working directory", () => {
    const command = resolvePinnedJsrInvocation(["--help"]);
    const jsr = resolvePinnedJsrCli();
    expect(path.isAbsolute(command[0])).toBe(true);
    expect(command.slice(1)).toEqual([jsr, "--help"]);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: unrelatedCwd,
      encoding: "utf8",
      env: { ...process.env, HOME: os.homedir() },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jsr.io cli for node");
  });

  test("uses an absolute Node launcher before the exact package bin on every host", () => {
    const jsr = resolvePinnedJsrCli();
    const command = resolvePinnedJsrInvocation(["--help"]);

    expect(path.isAbsolute(command[0])).toBe(true);
    expect(command.slice(1)).toEqual([jsr, "--help"]);

    const result = spawnSync(command[0], command.slice(1), {
      cwd: unrelatedCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("jsr.io cli for node");
  });

  test("is covered by the Moon release cache inputs", () => {
    const releaseProject = Bun.YAML.parse(readFileSync(path.join(ROOT, "tools/release/moon.yml"), "utf8"));
    const inputs = new Set(releaseProject.tasks?.check?.inputs ?? []);

    expect(inputs.has("/tools/release/**/*")).toBe(true);
    expect(inputs.has("/pnpm-lock.yaml")).toBe(true);
    expect(inputs.has("/src/**/*")).toBe(true);
  });
});
