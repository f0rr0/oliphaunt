import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import {
  assertReleaseNoticesInArchive,
  releaseNoticeRows,
  releaseProfilePackageLicense,
  stageReleaseNotices,
} from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NATIVE_ROOT = path.join(ROOT, "src/runtimes/liboliphaunt/native");

function platformPackages(relativeRoot, profile) {
  const root = path.join(NATIVE_ROOT, relativeRoot);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ directory: path.join(root, entry.name), profile }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

const CARRIERS = [
  ...platformPackages("packages", "native-runtime"),
  ...platformPackages("tools-packages", "native-tools"),
  { directory: path.join(NATIVE_ROOT, "icu-npm"), profile: "native-icu-data" },
];

function pack(directory, output) {
  const result = spawnSync(
    "pnpm",
    ["pack", "--pack-destination", output, "--json"],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${directory} failed to pack:\n${result.stdout}\n${result.stderr}`);
  const rows = JSON.parse(result.stdout);
  const filename = (Array.isArray(rows) ? rows[0] : rows)?.filename;
  assert.equal(typeof filename, "string", `${directory} pack output must identify its tarball`);
  return path.isAbsolute(filename) ? filename : path.join(output, path.basename(filename));
}

test("every native npm payload carrier declares and physically packs its exact legal profile", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "native-npm-notices-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "tarballs");
  mkdirSync(output);

  for (const [index, carrier] of CARRIERS.entries()) {
    const manifest = JSON.parse(readFileSync(path.join(carrier.directory, "package.json"), "utf8"));
    const noticeMembers = releaseNoticeRows({ profile: carrier.profile }).map((row) => row.member);
    assert.equal(
      manifest.license,
      releaseProfilePackageLicense(carrier.profile).spdx,
      `${manifest.name} must declare its exact ${carrier.profile} SPDX expression`,
    );
    for (const member of noticeMembers) {
      assert.ok(manifest.files.includes(member), `${manifest.name} files must include ${member}`);
    }
    const selectedLegalMembers = manifest.files.filter((member) =>
      member === "LICENSE"
      || member === "THIRD_PARTY_NOTICES.md"
      || /^THIRD_PARTY_NOTICES\.[^/]+\.md$/u.test(member)
      || member.startsWith("THIRD_PARTY_LICENSES/")
    );
    assert.deepEqual(selectedLegalMembers, noticeMembers, `${manifest.name} files must select no stale legal members`);

    const stage = path.join(root, `stage-${index}`);
    cpSync(carrier.directory, stage, { recursive: true });
    stageReleaseNotices(stage, { profile: carrier.profile });
    const tarball = pack(stage, output);
    assertReleaseNoticesInArchive(tarball, { profile: carrier.profile, prefix: "package" });
    const packedManifest = JSON.parse(
      Buffer.from(readPortableArchiveEntries(tarball).get("package/package.json").data()).toString("utf8"),
    );
    assert.equal(packedManifest.name, manifest.name);
    assert.equal(packedManifest.license, releaseProfilePackageLicense(carrier.profile).spdx);
  }
});
