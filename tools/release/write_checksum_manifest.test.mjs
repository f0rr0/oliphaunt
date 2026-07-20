import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { matchingAssets } from "./write_checksum_manifest.mjs";

const RELEASE_TOOLS = import.meta.dir;
const TOOL = path.join(RELEASE_TOOLS, "write_checksum_manifest.mjs");

function writeFixture(root, relativePath, contents = `${relativePath}\n`) {
  const file = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function relativeFiles(root, files) {
  return files.map((file) => path.relative(root, file).split(path.sep).join("/"));
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function releaseJavaScriptSources(root) {
  const sources = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate);
      } else if (entry.isFile() && /[.](?:[cm]?js|ts)$/u.test(entry.name)) {
        sources.push(candidate);
      }
    }
  };
  visit(root);
  return sources.sort();
}

test("preserves recursive and root-relative glob semantics with deterministic output order", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-checksum-walk-"));
  try {
    writeFixture(root, "z.zip");
    writeFixture(root, "root.tar.gz");
    writeFixture(root, "nested/b.tar.gz");
    writeFixture(root, "nested/deeper/a.tar.gz");
    writeFixture(root, "nested/ignored.txt");
    writeFixture(root, ".hidden.tar.gz");
    writeFixture(root, ".hidden/also-hidden.tar.gz");
    writeFixture(root, "nested/.hidden-too.tar.gz");

    expect(relativeFiles(root, matchingAssets(root, ["**/*.tar.gz", "*.zip"]))).toEqual([
      "nested/deeper/a.tar.gz",
      "nested/b.tar.gz",
      "root.tar.gz",
      "z.zip",
    ]);
    expect(relativeFiles(root, matchingAssets(root, ["*.tar.gz"]))).toEqual([
      "root.tar.gz",
    ]);
    expect(relativeFiles(root, matchingAssets(root, ["nested/*.tar.gz"]))).toEqual([
      "nested/b.tar.gz",
    ]);
    expect(relativeFiles(root, matchingAssets(root, ["./*.zip"]))).toEqual([
      "z.zip",
    ]);
    expect(matchingAssets(root, [".hidden.tar.gz", "**/.hidden*.tar.gz"])).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not follow file or directory symlinks while walking assets", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-checksum-symlink-"));
  try {
    const root = path.join(parent, "assets");
    const outside = path.join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFixture(root, "real.tar.gz");
    const outsideAsset = writeFixture(outside, "outside.tar.gz");
    symlinkSync(
      outside,
      path.join(root, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    );
    if (process.platform !== "win32") {
      symlinkSync(outsideAsset, path.join(root, "linked-file.tar.gz"), "file");
    }

    expect(relativeFiles(root, matchingAssets(root, ["**/*.tar.gz"]))).toEqual([
      "real.tar.gz",
    ]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("writes the caller-facing checksum manifest deterministically", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-checksum-output-"));
  try {
    writeFixture(root, "z.zip", "zip payload\n");
    writeFixture(root, "a.tar.gz", "tar payload\n");
    const result = spawnSync(process.execPath, [
      TOOL,
      "--asset-dir",
      root,
      "--output",
      "release-assets.sha256",
      "--pattern",
      "*.zip",
      "--pattern",
      "*.tar.gz",
    ], { encoding: "utf8" });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(path.join(root, "release-assets.sha256"), "utf8")).toBe(
      `${sha256("tar payload\n")}  ./a.tar.gz\n`
      + `${sha256("zip payload\n")}  ./z.zip\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release tooling does not use Bun.Glob filesystem scanners", () => {
  const offenders = releaseJavaScriptSources(RELEASE_TOOLS)
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.includes("Bun.Glob") && /[.]scan(?:Sync)?\s*[(]/u.test(source);
    })
    .map((file) => path.relative(RELEASE_TOOLS, file).split(path.sep).join("/"));
  expect(offenders).toEqual([]);
});
