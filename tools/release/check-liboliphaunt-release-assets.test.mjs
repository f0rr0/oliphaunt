#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertLiboliphauntArtifactReleaseNotices,
  canonicalEmptyStaticRegistryManifestError,
  canonicalTarEntryMarkerError,
} from "./check-liboliphaunt-release-assets.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

test("release archive validation requires canonical producer markers", () => {
  assert.equal(canonicalTarEntryMarkerError(".", "5"), null);
  assert.equal(canonicalTarEntryMarkerError("./", "5"), null);
  assert.equal(canonicalTarEntryMarkerError("runtime/", "5"), null);
  assert.equal(canonicalTarEntryMarkerError("runtime/manifest.properties", "0"), null);
  assert.match(canonicalTarEntryMarkerError("runtime", "5"), /directory member must use a trailing slash/u);
  assert.match(canonicalTarEntryMarkerError("runtime\/manifest.properties/", "0"), /regular-file member must not use a trailing slash/u);
});

test("base runtime validation requires the exact current empty static-registry manifest", () => {
  const canonical = [
    "packageLayout=oliphaunt-static-registry-v1",
    "abiVersion=1",
    "state=not-required",
    "source=",
    "registeredExtensions=",
    "pendingExtensions=",
    "nativeModuleStems=",
    "modules=",
    "archiveTargets=",
    "dependencyArchiveTargets=",
    "dependencyArchives=",
    "",
  ].join("\n");
  assert.equal(canonicalEmptyStaticRegistryManifestError(canonical), null);
  assert.match(
    canonicalEmptyStaticRegistryManifestError(
      "schema=oliphaunt-static-registry-v1\nregistered=\npending=\n",
    ),
    /canonical empty oliphaunt-static-registry-v1 manifest/u,
  );
});

test("aggregate validation reads Apple notices from the canonical XCFramework member root", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "oliphaunt-apple-notice-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = path.join(root, "liboliphaunt.xcframework");
  mkdirSync(framework);
  writeFileSync(path.join(framework, "Info.plist"), "fixture\n");
  stageReleaseNotices(framework, { profile: "native-runtime" });
  const archive = path.join(root, "liboliphaunt-0.0.0-apple-spm-xcframework.zip");
  const result = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    ["tools/release/archive_dir.mjs", "--keep-parent", framework, archive],
    { cwd: ROOT, stdio: "inherit" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    assertLiboliphauntArtifactReleaseNotices(
      archive,
      "apple-swiftpm-binary",
    ),
    true,
  );

  rmSync(path.join(framework, "LICENSE"));
  const missingNoticeArchive = path.join(root, "missing-notice.zip");
  const missingNoticeResult = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    [
      "tools/release/archive_dir.mjs",
      "--keep-parent",
      framework,
      missingNoticeArchive,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  assert.equal(missingNoticeResult.status, 0, missingNoticeResult.stderr);
  assert.throws(
    () =>
      assertLiboliphauntArtifactReleaseNotices(
        missingNoticeArchive,
        "apple-swiftpm-binary",
      ),
    /liboliphaunt[.]xcframework\/LICENSE/u,
  );
});
