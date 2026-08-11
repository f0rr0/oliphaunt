#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  derivePublicationProducts,
  resolvePublicationPlanningSource,
  verifyPublicationCandidate,
} from "./verify-publication-candidate.mjs";

const PRODUCT = "alpha";

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function write(repo, file, contents) {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(repo, subject) {
  git(repo, "add", ".");
  git(repo, "commit", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

function fixture() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-publication-candidate-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Release Test");
  git(repo, "config", "user.email", "release@example.invalid");
  write(repo, "release-please-config.json", `${JSON.stringify({
    packages: {
      "packages/alpha": {
        "release-type": "simple",
        component: PRODUCT,
        "version-file": "VERSION",
        "changelog-path": "CHANGELOG.md",
      },
    },
  }, null, 2)}\n`);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.0.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n");
  commit(repo, "feat: introduce fixture");

  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.1.0\n");
  write(
    repo,
    "packages/alpha/CHANGELOG.md",
    "# Changelog\n\n## 0.1.0 (2026-07-30)\n\n- Initial release.\n",
  );
  const release = commit(repo, "chore(release): publish alpha 0.1.0");
  return { repo, release };
}

test("accepts an exact same-SHA rerun after its product tag exists", () => {
  const { repo, release } = fixture();
  git(repo, "tag", "alpha-v0.1.0", release);

  assert.deepEqual(derivePublicationProducts({ repo, headRef: release }), [PRODUCT]);
  assert.deepEqual(resolvePublicationPlanningSource({ repo, headRef: release }), {
    planHeadSha: release,
    publicationSha: release,
  });
  assert.deepEqual(
    verifyPublicationCandidate({ repo, headRef: release, products: [PRODUCT] }),
    {
      mode: "release-bump",
      publicationSha: release,
      releaseSha: release,
      products: [PRODUCT],
      versions: { [PRODUCT]: "0.1.0" },
    },
  );
});

test("rejects a later commit because only the exact tagged SHA can rerun", () => {
  const { repo, release } = fixture();
  write(repo, "tools/release-control.txt", "changed\n");
  const controller = commit(repo, "fix(release): change release control");

  assert.throws(
    () => verifyPublicationCandidate({ repo, headRef: controller, products: [PRODUCT] }),
    /release commit .* subject must start/u,
  );
  assert.notEqual(controller, release);
});
