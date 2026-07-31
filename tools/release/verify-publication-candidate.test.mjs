#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { execFileSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  derivePublicationProducts,
  RELEASE_RECOVERY_TRAILER,
  resolvePublicationPlanningSource,
  verifyPublicationCandidate,
  verifyPublicationRecoveryCandidate,
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

function commit(repo, subject, trailers = []) {
  git(repo, "add", ".");
  const args = ["commit", "-m", subject];
  if (trailers.length > 0) args.push("-m", trailers.join("\n"));
  git(repo, ...args);
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
  write(repo, "tools/release/release-semantic-inputs.toml", [
    'schema = "oliphaunt-release-semantic-inputs-v1"',
    "",
    "[[rules]]",
    'id = "product-input"',
    'paths = ["src/product.txt", "src/product/**"]',
    'products = ["alpha"]',
    "",
  ].join("\n"));
  write(repo, "packages/alpha/VERSION", "0.0.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n");
  write(repo, "src/product.txt", "seed\n");
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

function recovery(repo, release, file = "tools/test/recovery.txt", contents = "repair\n") {
  write(repo, file, contents);
  return commit(
    repo,
    "fix(release): repair publication control",
    [`${RELEASE_RECOVERY_TRAILER}: ${release}`],
  );
}

function verify(repo, headRef, products = [PRODUCT], recoveryProducts = []) {
  return verifyPublicationCandidate({
    repo,
    headRef,
    products,
    deriveRecoveryProducts: () => recoveryProducts,
  });
}

test("accepts normal release commits and explicit control-only recovery chains", { timeout: 20_000 }, () => {
  const { repo, release } = fixture();
  assert.deepEqual(
    resolvePublicationPlanningSource({
      repo,
      headRef: release,
      deriveRecoveryProducts: () => [],
    }),
    {
      planHeadSha: release,
      publicationSha: release,
      recovery: false,
    },
  );
  assert.deepEqual(
    verify(repo, release),
    {
      mode: "release-bump",
      publicationSha: release,
      releaseSha: release,
      products: [PRODUCT],
      versions: { [PRODUCT]: "0.1.0" },
      recoveryChangedFiles: [],
    },
  );

  const first = recovery(repo, release);
  assert.deepEqual(
    derivePublicationProducts({ repo, headRef: first }),
    [PRODUCT],
  );
  assert.equal(
    verifyPublicationRecoveryCandidate({
      repo,
      headRef: release,
      deriveRecoveryProducts: () => [],
    }),
    null,
  );
  git(repo, "switch", "-q", "-c", "untrailed-control", release);
  write(repo, "tools/test/untrailed.txt", "untrailed\n");
  const untrailed = commit(repo, "fix: untrailed publication control");
  assert.equal(
    verifyPublicationRecoveryCandidate({
      repo,
      headRef: untrailed,
      deriveRecoveryProducts: () => [],
    }),
    null,
  );
  assert.deepEqual(
    resolvePublicationPlanningSource({
      repo,
      headRef: untrailed,
      deriveRecoveryProducts: () => [],
    }),
    {
      planHeadSha: untrailed,
      publicationSha: untrailed,
      recovery: false,
    },
  );
  git(repo, "switch", "-q", "--detach", first);
  assert.equal(
    verifyPublicationRecoveryCandidate({
      repo,
      headRef: first,
      deriveRecoveryProducts: () => [],
    })?.releaseSha,
    release,
  );
  assert.deepEqual(
    resolvePublicationPlanningSource({
      repo,
      headRef: first,
      deriveRecoveryProducts: () => [],
    }),
    {
      planHeadSha: release,
      publicationSha: first,
      recovery: true,
    },
  );
  const verifiedFirst = verify(repo, first);
  assert.equal(verifiedFirst.mode, "release-recovery");
  assert.equal(verifiedFirst.publicationSha, first);
  assert.equal(verifiedFirst.releaseSha, release);
  assert.deepEqual(verifiedFirst.recoveryChangedFiles, ["tools/test/recovery.txt"]);

  const second = recovery(repo, release, ".github/workflows/recovery.yml", "name: recovery\n");
  const verifiedSecond = verify(repo, second);
  assert.deepEqual(
    resolvePublicationPlanningSource({
      repo,
      headRef: second,
      deriveRecoveryProducts: () => [],
    }),
    {
      planHeadSha: release,
      publicationSha: second,
      recovery: true,
    },
  );
  assert.equal(verifiedSecond.publicationSha, second);
  assert.equal(verifiedSecond.releaseSha, release);
  assert.deepEqual(
    verifiedSecond.recoveryChangedFiles,
    [".github/workflows/recovery.yml", "tools/test/recovery.txt"],
  );
});

test("rejects product-owned, release-metadata, nonlinear, and ambiguously authorized recovery", { timeout: 30_000 }, () => {
  const { repo, release } = fixture();

  git(repo, "switch", "-q", "-c", "owned", release);
  const owned = recovery(repo, release, "src/product/nested.txt", "changed\n");
  assert.throws(
    () => verify(repo, owned),
    /product-semantic path.*src\/product\/nested[.]txt/u,
  );
  assert.throws(
    () => verifyPublicationRecoveryCandidate({
      repo,
      headRef: owned,
      deriveRecoveryProducts: () => [],
    }),
    /product-semantic path.*src\/product\/nested[.]txt/u,
  );
  assert.throws(
    () => resolvePublicationPlanningSource({
      repo,
      headRef: owned,
      deriveRecoveryProducts: () => [],
    }),
    /product-semantic path.*src\/product\/nested[.]txt/u,
  );

  git(repo, "switch", "-q", "-c", "product-range", release);
  const productRange = recovery(
    repo,
    release,
    "packages/alpha/source.txt",
    "changed\n",
  );
  assert.throws(
    () => verify(repo, productRange, [PRODUCT], [PRODUCT]),
    /selects release-impacting product.*alpha/u,
  );

  git(repo, "switch", "-q", "-c", "metadata", release);
  write(repo, "release-please-config.json", `${JSON.stringify({
    packages: {
      "packages/alpha": {
        "release-type": "simple",
        component: PRODUCT,
        "version-file": "VERSION",
        "changelog-path": "CHANGELOG.md",
        "extra-files": [],
      },
    },
  }, null, 2)}\n`);
  const metadata = commit(
    repo,
    "fix(release): mutate release metadata",
    [`${RELEASE_RECOVERY_TRAILER}: ${release}`],
  );
  assert.throws(
    () => verify(repo, metadata),
    /immutable release metadata release-please-config[.]json/u,
  );

  git(repo, "switch", "-q", "-c", "missing-intermediate-trailer", release);
  write(repo, "tools/test/first.txt", "first\n");
  commit(repo, "fix(release): unbound intermediate");
  const missingIntermediate = recovery(repo, release, "tools/test/second.txt", "second\n");
  assert.throws(
    () => verify(repo, missingIntermediate),
    /must carry Oliphaunt-Release-Recovery-Of/u,
  );

  git(repo, "switch", "-q", "-c", "duplicate-trailer", release);
  write(repo, "tools/test/duplicate.txt", "duplicate\n");
  const duplicate = commit(
    repo,
    "fix(release): duplicate authorization",
    [
      `${RELEASE_RECOVERY_TRAILER}: ${release}`,
      `${RELEASE_RECOVERY_TRAILER}: ${release}`,
    ],
  );
  assert.throws(
    () => verify(repo, duplicate),
    /exactly one Oliphaunt-Release-Recovery-Of trailer/u,
  );

  git(repo, "switch", "-q", "-c", "wrong-product", release);
  const wrongProduct = recovery(repo, release, "tools/test/wrong-product.txt", "wrong\n");
  assert.throws(
    () => verify(repo, wrongProduct, ["beta"]),
    /selected release product beta is absent/u,
  );

  git(repo, "switch", "-q", "-c", "wrong-subject", release);
  write(repo, "tools/test/wrong-subject.txt", "wrong\n");
  const wrongSubject = commit(
    repo,
    "ci: repair publication",
    [`${RELEASE_RECOVERY_TRAILER}: ${release}`],
  );
  assert.throws(
    () => verify(repo, wrongSubject),
    /subject must start with "fix\(release\): "/u,
  );
});

test("rejects malformed, non-ancestor, and non-release recovery anchors", { timeout: 20_000 }, () => {
  const { repo, release } = fixture();

  git(repo, "switch", "-q", "-c", "uppercase", release);
  write(repo, "tools/test/uppercase.txt", "uppercase\n");
  const uppercase = commit(
    repo,
    "fix(release): uppercase recovery anchor",
    [`${RELEASE_RECOVERY_TRAILER}: ${release.toUpperCase()}`],
  );
  assert.throws(
    () => verify(repo, uppercase),
    /lowercase-full-sha/u,
  );

  git(repo, "switch", "-q", "-c", "unrelated", `${release}^`);
  write(repo, "tools/test/unrelated.txt", "unrelated\n");
  const unrelated = commit(repo, "fix(release): unrelated anchor target");
  write(repo, "tools/test/unrelated-recovery.txt", "recovery\n");
  const nonAncestor = commit(
    repo,
    "fix(release): point outside ancestry",
    [`${RELEASE_RECOVERY_TRAILER}: ${release}`],
  );
  assert.throws(
    () => verify(repo, nonAncestor),
    /is not an ancestor/u,
  );

  git(repo, "switch", "-q", "-c", "non-release-anchor", unrelated);
  const nonReleaseRecovery = recovery(
    repo,
    unrelated,
    "tools/test/non-release-anchor.txt",
    "recovery\n",
  );
  assert.throws(
    () => verify(repo, nonReleaseRecovery),
    /release commit .* subject must start/u,
  );
});
