import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { localWindowsTarInvocation } from "./tar-command.mjs";

test("localizes absolute Windows archive and extraction-directory operands", () => {
  expect(localWindowsTarInvocation(
    [
      "-xf",
      String.raw`D:\a\oliphaunt\artifacts\runtime.tar.gz`,
      "-C",
      String.raw`D:\a\oliphaunt\target\extract`,
      "files",
    ],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({
    args: [
      "-xf",
      "runtime.tar.gz",
      "-C",
      "../target/extract",
      "files",
    ],
    cwd: String.raw`D:\a\oliphaunt\artifacts`,
  });
  expect(localWindowsTarInvocation(
    [`--file=${String.raw`E:\release\candidate.tgz`}`, "-tz"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({
    args: ["--file=candidate.tgz", "-tz"],
    cwd: String.raw`E:\release`,
  });
});

test("preserves the meaning of relative and sequential Windows directory operands", () => {
  expect(localWindowsTarInvocation(
    [
      "-xf",
      String.raw`D:\a\oliphaunt\artifacts\runtime.tar.gz`,
      "-C",
      "target/extract",
      "-C",
      "nested",
      "files",
    ],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({
    args: [
      "-xf",
      "runtime.tar.gz",
      "-C",
      "../target/extract",
      "-C",
      "nested",
      "files",
    ],
    cwd: String.raw`D:\a\oliphaunt\artifacts`,
  });
  expect(localWindowsTarInvocation(
    [
      "-xf",
      String.raw`D:\a\oliphaunt\artifacts\runtime.tar.gz`,
      `--directory=${String.raw`D:\a\oliphaunt\target\extract`}`,
      "files",
    ],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  ).args).toEqual([
    "-xf",
    "runtime.tar.gz",
    "--directory=../target/extract",
    "files",
  ]);
});

test("preserves relative and non-Windows archive invocations", () => {
  expect(localWindowsTarInvocation(
    ["-tzf", "candidate.tgz"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({ args: ["-tzf", "candidate.tgz"], cwd: String.raw`D:\a\oliphaunt` });
  expect(localWindowsTarInvocation(
    ["-tzf", "/tmp/candidate.tgz"],
    { platform: "linux", cwd: "/workspace" },
  )).toEqual({ args: ["-tzf", "/tmp/candidate.tgz"], cwd: "/workspace" });
});

test("supports every archive option cluster used by release consumers", () => {
  for (const option of ["-xOf", "-xOzf", "-tzf", "-xf", "-tvzf", "-tf", "-xzf"]) {
    const invocation = localWindowsTarInvocation(
      [option, String.raw`D:\a\oliphaunt\candidate.tgz`, "member"],
      { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
    );
    expect(invocation.args).toEqual([option, "candidate.tgz", "member"]);
    expect(invocation.cwd).toBe(String.raw`D:\a\oliphaunt`);
  }
  expect(localWindowsTarInvocation(
    ["--file", String.raw`D:\a\candidate.tgz`, "-tz"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({ args: ["--file", "candidate.tgz", "-tz"], cwd: String.raw`D:\a` });
  expect(localWindowsTarInvocation(
    ["--zstd", "-tf", String.raw`D:\a\candidate.tar.zst`],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toEqual({ args: ["--zstd", "-tf", "candidate.tar.zst"], cwd: String.raw`D:\a` });
});

test("lists, reads, and extracts a local archive without exposing its colon-bearing path to tar", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-tar-local-"));
  try {
    const archiveDirectory = path.join(root, "drive:D");
    const payloadDirectory = path.join(root, "payload");
    const extractDirectory = path.join(root, "extract");
    mkdirSync(archiveDirectory);
    mkdirSync(payloadDirectory);
    mkdirSync(extractDirectory);
    writeFileSync(path.join(payloadDirectory, "proof.txt"), "local archive\n");
    const archive = path.join(archiveDirectory, "candidate.tar.gz");
    const packed = spawnSync("tar", ["-czf", "candidate.tar.gz", "-C", payloadDirectory, "proof.txt"], {
      cwd: archiveDirectory,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);

    for (const args of [
      ["-tzf", archive],
      ["-xOzf", archive, "proof.txt"],
      ["-xzf", archive, "-C", extractDirectory, "proof.txt"],
    ]) {
      const invocation = localWindowsTarInvocation(args, {
        platform: "win32",
        cwd: root,
        pathApi: path.posix,
      });
      expect(invocation.args.join(" ")).not.toContain("drive:D");
      expect(invocation.args.join(" ")).not.toContain(extractDirectory);
      const result = spawnSync("tar", invocation.args, { cwd: invocation.cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(readFileSync(path.join(extractDirectory, "proof.txt"), "utf8")).toBe("local archive\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for ambiguous or incomplete tar archive options", () => {
  expect(() => localWindowsTarInvocation(
    ["-tz"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("explicit archive file option");
  expect(() => localWindowsTarInvocation(
    ["-tzf"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("missing its path argument");
  expect(() => localWindowsTarInvocation(
    ["--file="],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("missing its path argument");
  expect(() => localWindowsTarInvocation(
    ["-tzf", String.raw`D:candidate.tgz`],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("drive-relative or alternate-stream");
  expect(() => localWindowsTarInvocation(
    ["-tfx", String.raw`D:\a\candidate.tgz`],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("path as the next argument");
  expect(() => localWindowsTarInvocation(
    ["-xf", String.raw`D:\a\candidate.tgz`, "-C"],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("missing its path argument");
  expect(() => localWindowsTarInvocation(
    ["-xf", String.raw`D:\a\candidate.tgz`, "-C", String.raw`E:\extract`],
    { platform: "win32", cwd: String.raw`D:\a\oliphaunt` },
  )).toThrow("same Windows volume");
});
