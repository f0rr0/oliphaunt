import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertExactFilenames,
  exactRegularDirectoryFilenames,
  expectedNodeDirectNpmPackageNames,
} from "./check-native-helper-aggregate-assets.mjs";

const scratch = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("native helper aggregate release assets", () => {
  test("derives the exact Node direct optional npm carrier set", () => {
    expect(expectedNodeDirectNpmPackageNames("1.2.3")).toEqual([
      "oliphaunt-node-direct-darwin-arm64-1.2.3.tgz",
      "oliphaunt-node-direct-linux-arm64-gnu-1.2.3.tgz",
      "oliphaunt-node-direct-linux-x64-gnu-1.2.3.tgz",
      "oliphaunt-node-direct-win32-x64-msvc-1.2.3.tgz",
    ]);
  });

  test("accepts only an exact, duplicate-free carrier filename set", () => {
    const expected = expectedNodeDirectNpmPackageNames("1.2.3");
    expect(() => assertExactFilenames([...expected].reverse(), expected, "Node carriers")).not.toThrow();
    expect(() => assertExactFilenames(expected.slice(1), expected, "Node carriers"))
      .toThrow(/must be exact/u);
    expect(() => assertExactFilenames([...expected, expected[0]], expected, "Node carriers"))
      .toThrow(/must be exact/u);
    expect(() => assertExactFilenames([...expected, "unexpected.tgz"], expected, "Node carriers"))
      .toThrow(/must be exact/u);
  });

  test("rejects non-file and symlink entries instead of hiding them from closure checks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-native-helper-closure-"));
    scratch.push(root);
    writeFileSync(path.join(root, "carrier.tgz"), "carrier");
    expect(exactRegularDirectoryFilenames(root, "carrier directory")).toEqual(["carrier.tgz"]);

    mkdirSync(path.join(root, "unexpected-directory"));
    expect(() => exactRegularDirectoryFilenames(root, "carrier directory"))
      .toThrow(/only regular non-symlink files: unexpected-directory/u);
    rmSync(path.join(root, "unexpected-directory"), { recursive: true });

    symlinkSync(path.join(root, "carrier.tgz"), path.join(root, "unexpected-link.tgz"));
    expect(() => exactRegularDirectoryFilenames(root, "carrier directory"))
      .toThrow(/only regular non-symlink files: unexpected-link[.]tgz/u);
  });
});
