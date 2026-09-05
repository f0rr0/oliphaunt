#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { synchronizeReleaseCandidates } from "./release-candidate-sync.mjs";

const PRODUCT = "liboliphaunt-native";
const PACKAGE_PATH = "packages/native";

function write(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-candidate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const graph = {
    products: {
      [PRODUCT]: {
        path: PACKAGE_PATH,
        version: "1.0.0",
        version_files: [`${PACKAGE_PATH}/VERSION`],
        changelog_path: `${PACKAGE_PATH}/CHANGELOG.md`,
      },
    },
  };
  const releasePleaseConfig = {
    packages: {
      [PACKAGE_PATH]: {
        component: PRODUCT,
        "release-type": "simple",
        "version-file": "VERSION",
        "changelog-path": "CHANGELOG.md",
      },
    },
  };
  const manifest = { [PACKAGE_PATH]: "1.0.0" };
  write(root, `${PACKAGE_PATH}/VERSION`, "1.0.0\n");
  write(root, `${PACKAGE_PATH}/CHANGELOG.md`, "# Changelog\n\n## 1.0.0\n");
  write(root, ".release-please-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, graph, releasePleaseConfig, manifest };
}

test("shared-source release candidates update only their declared release files", (t) => {
  const state = fixture(t);
  const changes = synchronizeReleaseCandidates({
    ...state,
    candidates: [{
      product: PRODUCT,
      packagePath: PACKAGE_PATH,
      before: "1.0.0",
      after: "1.0.1",
      changelogSection: "Bug Fixes",
      reasons: [{
        kind: "shared-source",
        commit: "1234567890abcdef",
        summary: "update PostgreSQL source baseline",
      }],
    }],
    write: true,
    prefix: "release-candidate-test",
  });

  assert.deepEqual(
    changes.map(({ path: file }) => path.relative(state.root, file)).sort(),
    [
      ".release-please-manifest.json",
      `${PACKAGE_PATH}/CHANGELOG.md`,
      `${PACKAGE_PATH}/VERSION`,
    ],
  );
  assert.equal(readFileSync(path.join(state.root, `${PACKAGE_PATH}/VERSION`), "utf8"), "1.0.1\n");
  assert.equal(
    JSON.parse(readFileSync(path.join(state.root, ".release-please-manifest.json"), "utf8"))[PACKAGE_PATH],
    "1.0.1",
  );
  assert.match(
    readFileSync(path.join(state.root, `${PACKAGE_PATH}/CHANGELOG.md`), "utf8"),
    /shared contrib carrier source: update PostgreSQL source baseline \(12345678\)/u,
  );
});
