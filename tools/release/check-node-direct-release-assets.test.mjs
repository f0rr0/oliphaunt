import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import {
  assertNodeDirectNpmArchive,
  assertNodeDirectReleaseNoticeEntries,
} from "./check-node-direct-release-assets.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TARGET = Object.freeze({
  npmPackage: "@oliphaunt/node-direct-linux-x64-gnu",
  target: "linux-x64-gnu",
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "node-direct-notices-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function archiveDirectory(source, output, { keepParent = false } = {}) {
  const archive = output.endsWith(".tar.gz") || output.endsWith(".zip")
    ? output
    : `${output}.tar.gz`;
  const args = ["tools/release/archive_dir.mjs"];
  if (keepParent) args.push("--keep-parent");
  args.push(source, archive);
  const result = spawnSync(path.join(ROOT, "tools/dev/bun.sh"), args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  if (archive !== output) renameSync(archive, output);
}

function stageNpmPackage(root) {
  const packageDir = path.join(root, "package");
  mkdirSync(path.join(packageDir, "prebuilds"), { recursive: true });
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "src/runtimes/node-direct/packages/linux-x64-gnu/package.json"), "utf8"),
  );
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(packageDir, "prebuilds/oliphaunt_node.node"), "fixture-addon\n");
  stageReleaseNotices(packageDir, { profile: "source-sdk" });
  return { manifest, packageDir };
}

test("Node direct addon and npm carriers contain only exact adapter notices", (t) => {
  const root = fixture(t);
  const addonStage = path.join(root, "addon");
  mkdirSync(addonStage);
  writeFileSync(path.join(addonStage, "oliphaunt_node.node"), "fixture-addon\n");
  stageReleaseNotices(addonStage, { profile: "source-sdk" });
  const addonArchive = path.join(root, "addon.tar.gz");
  archiveDirectory(addonStage, addonArchive);
  assert.deepEqual(
    assertNodeDirectReleaseNoticeEntries(readPortableArchiveEntries(addonArchive), {
      label: path.basename(addonArchive),
    }),
    ["LICENSE", "THIRD_PARTY_NOTICES.md"],
  );
  const addonZip = path.join(root, "addon.zip");
  archiveDirectory(addonStage, addonZip);
  assert.deepEqual(
    assertNodeDirectReleaseNoticeEntries(readPortableArchiveEntries(addonZip), {
      label: path.basename(addonZip),
    }),
    ["LICENSE", "THIRD_PARTY_NOTICES.md"],
  );

  const { manifest: sourceManifest, packageDir } = stageNpmPackage(root);
  const npmArchive = path.join(root, "node-direct.tgz");
  archiveDirectory(packageDir, npmArchive, { keepParent: true });
  const manifest = assertNodeDirectNpmArchive(npmArchive, [TARGET], sourceManifest.version);
  assert.equal(manifest.license, "MIT");
});

test("Node direct npm validation rejects notice drift and runtime-license carryover", (t) => {
  const root = fixture(t);
  let staged = stageNpmPackage(path.join(root, "byte-drift"));
  writeFileSync(path.join(staged.packageDir, "LICENSE"), "not canonical\n");
  let archive = path.join(root, "byte-drift.tgz");
  archiveDirectory(staged.packageDir, archive, { keepParent: true });
  assert.throws(
    () => assertNodeDirectNpmArchive(archive, [TARGET], staged.manifest.version),
    /differs byte-for-byte/u,
  );

  staged = stageNpmPackage(path.join(root, "stale-runtime"));
  staged.manifest.files.push("THIRD_PARTY_LICENSES");
  writeFileSync(
    path.join(staged.packageDir, "package.json"),
    `${JSON.stringify(staged.manifest, null, 2)}\n`,
  );
  stageReleaseNotices(staged.packageDir, { profile: "native-runtime" });
  archive = path.join(root, "stale-runtime.tgz");
  archiveDirectory(staged.packageDir, archive, { keepParent: true });
  assert.throws(
    () => assertNodeDirectNpmArchive(archive, [TARGET], staged.manifest.version),
    /unexpected (?:product notice|release license)/u,
  );

  staged = stageNpmPackage(path.join(root, "mode-drift"));
  chmodSync(path.join(staged.packageDir, "THIRD_PARTY_NOTICES.md"), 0o755);
  archive = path.join(root, "mode-drift.tgz");
  archiveDirectory(staged.packageDir, archive, { keepParent: true });
  assert.throws(
    () => assertNodeDirectNpmArchive(archive, [TARGET], staged.manifest.version),
    /mode 0644/u,
  );
});
