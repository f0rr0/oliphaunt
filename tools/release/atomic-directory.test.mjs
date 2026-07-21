import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createSiblingStage,
  promoteDirectory,
  stageExistingDirectory,
} from "./atomic-directory.mjs";

test("promotes a staged directory and removes the old bytes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-atomic-directory-"));
  try {
    const destination = path.join(root, "live");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "old"), "old");
    const stage = createSiblingStage(destination);
    writeFileSync(path.join(stage, "new"), "new");

    promoteDirectory(stage, destination);

    assert.equal(readFileSync(path.join(destination, "new"), "utf8"), "new");
    assert.equal(existsSync(path.join(destination, "old")), false);
    assert.equal(existsSync(stage), false);
    assert.equal(existsSync(`${stage}.previous`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a normal termination cleans an unpromoted sibling stage", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-atomic-directory-exit-"));
  try {
    const destination = path.join(root, "live");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createSiblingStage } from ${JSON.stringify(new URL("./atomic-directory.mjs", import.meta.url).href)}; createSiblingStage(${JSON.stringify(destination)});`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging an existing directory copies bytes without symbolic links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-atomic-directory-copy-"));
  try {
    const destination = path.join(root, "live");
    mkdirSync(destination);
    writeFileSync(path.join(destination, "kept"), "bytes");
    const stage = stageExistingDirectory(destination);
    assert.equal(readFileSync(path.join(stage, "kept"), "utf8"), "bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
