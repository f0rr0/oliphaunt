#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RELEASE_PLEASE_BOOTSTRAP_SHA } from "./release-please-bootstrap.mjs";
import { deriveReleaseProducts, verifyReleaseCommit } from "./verify-release-commit.mjs";

const RELEASE_PRODUCT = "oliphaunt-broker";
const KNOWN_DERIVED_PACKAGE = "@oliphaunt/broker-linux-x64-gnu";
const UNRELATED_DERIVED_PACKAGE = "@oliphaunt/unrelated";

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

test("permits only the exact one-time bootstrap-sha removal in a release commit", { timeout: 20_000 }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-bootstrap-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Release Test");
  git(repo, "config", "user.email", "release@example.invalid");
  const config = (bootstrapSha) => `${JSON.stringify({
    ...(bootstrapSha === undefined ? {} : { "bootstrap-sha": bootstrapSha }),
    packages: {
      "packages/alpha": {
        "release-type": "simple",
        component: RELEASE_PRODUCT,
        "version-file": "VERSION",
        "changelog-path": "CHANGELOG.md",
      },
    },
  }, null, 2)}\n`;
  write(repo, "release-please-config.json", config(RELEASE_PLEASE_BOOTSTRAP_SHA));
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.0.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n");
  const base = commit(repo, "feat: introduce bootstrap fixture");

  const writeRelease = (bootstrapSha) => {
    write(repo, "release-please-config.json", config(bootstrapSha));
    write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0"}\n');
    write(repo, "packages/alpha/VERSION", "0.1.0\n");
    write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  };

  writeRelease(undefined);
  const clean = commit(repo, "chore(release): prepare bootstrap release");
  assert.deepEqual(
    verifyReleaseCommit({ repo, headRef: clean, products: [RELEASE_PRODUCT] }).products,
    [RELEASE_PRODUCT],
  );

  git(repo, "switch", "-q", "-c", "mutated-bootstrap", base);
  writeRelease("1111111111111111111111111111111111111111");
  const mutated = commit(repo, "chore(release): prepare mutated bootstrap release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: mutated, products: [RELEASE_PRODUCT] }),
    /release-please-config[.]json contains a non-version semantic change/u,
  );
});

test("accepts the exact one-parent release-bump commit and exact selected product set", { timeout: 20_000 }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-commit-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Release Test");
  git(repo, "config", "user.email", "release@example.invalid");
  write(repo, "release-please-config.json", `${JSON.stringify({
    packages: {
      "packages/alpha": { "release-type": "simple", component: RELEASE_PRODUCT, "version-file": "VERSION", "changelog-path": "CHANGELOG.md" },
      "packages/beta": { "release-type": "node", component: "beta", "changelog-path": "CHANGELOG.md" },
    },
  }, null, 2)}\n`);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.0.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.0.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n");
  write(repo, "packages/beta/package.json", '{"name":"beta","version":"0.0.0"}\n');
  write(repo, "packages/beta/CHANGELOG.md", "# Changelog\n");
  write(repo, "src/sdks/js/package.json", `${JSON.stringify({
    name: "shadow-derived",
    oliphaunt: { brokerVersion: "0.0.0" },
    optionalDependencies: {
      [KNOWN_DERIVED_PACKAGE]: "workspace:0.0.0",
      [UNRELATED_DERIVED_PACKAGE]: "workspace:0.0.0",
    },
    dangerous: false,
  })}\n`);
  const base = commit(repo, "feat: introduce fixture");

  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.1.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n\n- Initial release.\n");
  const release = commit(repo, "chore(release): prepare alpha release");

  assert.deepEqual(deriveReleaseProducts({ repo, headRef: release }).products, [RELEASE_PRODUCT]);

  const verified = verifyReleaseCommit({ repo, headRef: release, products: [RELEASE_PRODUCT] });
  assert.deepEqual(verified.products, [RELEASE_PRODUCT]);
  assert.equal(verified.versions[RELEASE_PRODUCT], "0.1.0");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: release, products: [RELEASE_PRODUCT, "beta"] }),
    /do not exactly match/u,
  );

  write(repo, "fix.txt", "post-release fix\n");
  const laterFix = commit(repo, "fix(tools): repair publication");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: laterFix, products: [RELEASE_PRODUCT] }),
    /subject must start/u,
    "a bb7c release-bump followed by an a51c fix must be rejected before tag mutation",
  );

  git(repo, "switch", "-q", "-c", "release-downgrade", release);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.0.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.0.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.0.0 (2026-07-14)\n");
  const releaseDowngrade = commit(repo, "chore(release): prepare alpha downgrade");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: releaseDowngrade, products: [RELEASE_PRODUCT] }),
    /must advance to a semver version/u,
  );

  git(repo, "switch", "-q", "-c", "tainted-release", `${release}^`);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.1.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  write(repo, "src/fix.rs", "pub fn hidden_fix() {}\n");
  const tainted = commit(repo, "chore(release): prepare alpha release with hidden fix");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: tainted, products: [RELEASE_PRODUCT] }),
    /non-release-derived path.*src\/fix[.]rs/u,
  );

  git(repo, "switch", "-q", "-c", "hidden-version-config", base);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.0.0","packages/beta":"0.1.0"}\n');
  write(repo, "packages/beta/package.json", '{"name":"beta","version":"0.1.0","scripts":{"postinstall":"hidden-code"}}\n');
  write(repo, "packages/beta/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  const hiddenVersionConfig = commit(repo, "chore(release): prepare beta release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: hiddenVersionConfig, products: ["beta"] }),
    /canonical version file.*non-version semantic change/u,
  );

  git(repo, "switch", "-q", "-c", "hidden-derived-config", base);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.1.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  write(repo, "src/sdks/js/package.json", `${JSON.stringify({
    name: "shadow-derived",
    oliphaunt: { brokerVersion: "0.0.0" },
    optionalDependencies: {
      [KNOWN_DERIVED_PACKAGE]: "workspace:0.0.0",
      [UNRELATED_DERIVED_PACKAGE]: "workspace:0.0.0",
    },
    dangerous: true,
  })}\n`);
  const hiddenDerivedConfig = commit(repo, "chore(release): prepare alpha release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: hiddenDerivedConfig, products: [RELEASE_PRODUCT] }),
    /derived file.*non-version semantic change/u,
  );

  git(repo, "switch", "-q", "-c", "derived-version-only", base);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.1.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  write(repo, "src/sdks/js/package.json", `${JSON.stringify({
    name: "shadow-derived",
    oliphaunt: { brokerVersion: "0.1.0" },
    optionalDependencies: {
      [KNOWN_DERIVED_PACKAGE]: "workspace:0.1.0",
      [UNRELATED_DERIVED_PACKAGE]: "workspace:0.0.0",
    },
    dangerous: false,
  })}\n`);
  const derivedVersionOnly = commit(repo, "chore(release): prepare alpha release");
  assert.deepEqual(
    verifyReleaseCommit({ repo, headRef: derivedVersionOnly, products: [RELEASE_PRODUCT] }).products,
    [RELEASE_PRODUCT],
  );

  git(repo, "switch", "-q", "-c", "unrelated-derived-dependency", base);
  write(repo, ".release-please-manifest.json", '{"packages/alpha":"0.1.0","packages/beta":"0.0.0"}\n');
  write(repo, "packages/alpha/VERSION", "0.1.0\n");
  write(repo, "packages/alpha/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  write(repo, "src/sdks/js/package.json", `${JSON.stringify({
    name: "shadow-derived",
    oliphaunt: { brokerVersion: "0.0.0" },
    optionalDependencies: {
      [KNOWN_DERIVED_PACKAGE]: "workspace:0.0.0",
      [UNRELATED_DERIVED_PACKAGE]: "workspace:0.1.0",
    },
    dangerous: false,
  })}\n`);
  const unrelatedDerivedDependency = commit(repo, "chore(release): prepare alpha release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: unrelatedDerivedDependency, products: [RELEASE_PRODUCT] }),
    /derived file.*optionalDependencies[.]@oliphaunt\/unrelated/u,
    "an unrelated dependency cannot borrow another product's coincident old/new version transition",
  );
});

test("binds derived Cargo pins and lock entries to the referenced local package", { timeout: 20_000 }, () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-release-cargo-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Release Test");
  git(repo, "config", "user.email", "release@example.invalid");
  write(repo, "release-please-config.json", `${JSON.stringify({
    packages: {
      "src/runtimes/broker": {
        "release-type": "rust",
        component: RELEASE_PRODUCT,
        "changelog-path": "CHANGELOG.md",
      },
    },
  }, null, 2)}\n`);
  write(repo, ".release-please-manifest.json", '{"src/runtimes/broker":"0.0.0"}\n');
  write(repo, "src/runtimes/broker/Cargo.toml", '[package]\nname = "oliphaunt-broker"\nversion = "0.0.0"\n');
  write(repo, "src/runtimes/broker/CHANGELOG.md", "# Changelog\n");
  write(repo, "src/shared/unrelated/Cargo.toml", '[package]\nname = "unrelated"\nversion = "0.0.0"\n');
  write(
    repo,
    "src/sdks/rust/Cargo.toml",
    '[package]\nname = "shadow-sdk"\nversion = "0.0.0"\n\n[dependencies]\noliphaunt-broker = { path = "../../runtimes/broker", version = "0.0.0" }\nunrelated = { path = "../../shared/unrelated", version = "0.0.0" }\n',
  );
  write(repo, "Cargo.lock", 'version = 4\n\n[[package]]\nname = "oliphaunt-broker"\nversion = "0.0.0"\n\n[[package]]\nname = "unrelated"\nversion = "0.0.0"\n');
  const base = commit(repo, "feat: introduce Cargo fixture");

  const writeRelease = () => {
    write(repo, ".release-please-manifest.json", '{"src/runtimes/broker":"0.1.0"}\n');
    write(repo, "src/runtimes/broker/Cargo.toml", '[package]\nname = "oliphaunt-broker"\nversion = "0.1.0"\n');
    write(repo, "src/runtimes/broker/CHANGELOG.md", "# Changelog\n\n## 0.1.0 (2026-07-14)\n");
  };

  writeRelease();
  write(
    repo,
    "src/sdks/rust/Cargo.toml",
    '[package]\nname = "shadow-sdk"\nversion = "0.0.0"\n\n[dependencies]\noliphaunt-broker = { path = "../../runtimes/broker", version = "0.1.0" }\nunrelated = { path = "../../shared/unrelated", version = "0.0.0" }\n',
  );
  write(repo, "Cargo.lock", 'version = 4\n\n[[package]]\nname = "oliphaunt-broker"\nversion = "0.1.0"\n\n[[package]]\nname = "unrelated"\nversion = "0.0.0"\n');
  const exactCargoRelease = commit(repo, "chore(release): prepare broker release");
  assert.deepEqual(
    verifyReleaseCommit({ repo, headRef: exactCargoRelease, products: [RELEASE_PRODUCT] }).products,
    [RELEASE_PRODUCT],
  );

  git(repo, "switch", "-q", "-c", "unrelated-cargo-pin", base);
  writeRelease();
  write(
    repo,
    "src/sdks/rust/Cargo.toml",
    '[package]\nname = "shadow-sdk"\nversion = "0.0.0"\n\n[dependencies]\noliphaunt-broker = { path = "../../runtimes/broker", version = "0.1.0" }\nunrelated = { path = "../../shared/unrelated", version = "0.1.0" }\n',
  );
  const unrelatedCargoPin = commit(repo, "chore(release): prepare broker release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: unrelatedCargoPin, products: [RELEASE_PRODUCT] }),
    /derived file.*dependencies[.]unrelated[.]version/u,
  );

  git(repo, "switch", "-q", "-c", "unrelated-cargo-package-version", base);
  writeRelease();
  write(
    repo,
    "src/sdks/rust/Cargo.toml",
    '[package]\nname = "shadow-sdk"\nversion = "0.1.0"\n\n[dependencies]\noliphaunt-broker = { path = "../../runtimes/broker", version = "0.1.0" }\nunrelated = { path = "../../shared/unrelated", version = "0.0.0" }\n',
  );
  const unrelatedCargoPackageVersion = commit(repo, "chore(release): prepare broker release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: unrelatedCargoPackageVersion, products: [RELEASE_PRODUCT] }),
    /derived file.*package[.]version/u,
  );

  git(repo, "switch", "-q", "-c", "unrelated-cargo-lock", base);
  writeRelease();
  write(repo, "Cargo.lock", 'version = 4\n\n[[package]]\nname = "oliphaunt-broker"\nversion = "0.1.0"\n\n[[package]]\nname = "unrelated"\nversion = "0.1.0"\n');
  const unrelatedCargoLock = commit(repo, "chore(release): prepare broker release");
  assert.throws(
    () => verifyReleaseCommit({ repo, headRef: unrelatedCargoLock, products: [RELEASE_PRODUCT] }),
    /derived file.*package[.]1[.]version/u,
  );
});
