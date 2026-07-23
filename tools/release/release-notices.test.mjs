import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { spawnSync } from "../test/fd-backed-spawn-sync.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import {
  assertReleaseNoticesInArchive,
  assertReleaseNoticesInDirectory,
  assertReleaseNoticesInEntries,
  hasCanonicalReleaseStagingMode,
  releasePackageLicense,
  releaseNoticeRows,
  stageReleaseNotices,
} from "./release-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "release-notices-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage");
  mkdirSync(stage);
  return { root, stage };
}

test("defines stable canonical member names in deterministic order", () => {
  assert.deepEqual(
    releaseNoticeRows({ products: ["wasix", "native", "native"] }).map((row) => [
      row.member,
      path.relative(ROOT, row.source).split(path.sep).join("/"),
    ]),
    [
      ["LICENSE", "LICENSE"],
      ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["THIRD_PARTY_NOTICES.liboliphaunt-native.md", "src/runtimes/liboliphaunt/native/THIRD_PARTY_NOTICES.md"],
      ["THIRD_PARTY_NOTICES.oliphaunt-wasix.md", "src/bindings/wasix-rust/THIRD_PARTY_NOTICES.md"],
    ],
  );
  assert.throws(() => releaseNoticeRows({ products: ["unknown"] }), /unsupported release notice product/u);
  assert.deepEqual(
    releaseNoticeRows({ components: ["openssl", "postgresql", "icu"] }).map((row) => row.member),
    [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
      "THIRD_PARTY_LICENSES/ICU-LICENSE",
      "THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt",
    ],
  );
  assert.throws(() => releaseNoticeRows({ components: ["unknown"] }), /unsupported release license component/u);
  assert.deepEqual(releasePackageLicense({ components: ["icu", "postgresql"] }), {
    spdx: "MIT AND PostgreSQL AND Unicode-3.0",
    entries: releasePackageLicense({ components: ["postgresql", "icu"] }).entries,
  });
  assert.deepEqual(
    releaseNoticeRows({ profile: "native-tools" }).map((row) => row.member),
    [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_NOTICES.liboliphaunt-native.md",
      "THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT",
    ],
  );
});

test("stages exact bytes and removes stale product notices", (t) => {
  const { stage } = fixture(t);
  stageReleaseNotices(stage, { products: ["native", "wasix"] });
  for (const row of releaseNoticeRows({ products: ["native", "wasix"] })) {
    assert.deepEqual(readFileSync(path.join(stage, row.member)), readFileSync(row.source));
  }
  stageReleaseNotices(stage, { products: ["native"] });
  assert.deepEqual(
    assertReleaseNoticesInDirectory(stage, { products: ["native"] }),
    ["LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.liboliphaunt-native.md"],
  );
  assert.throws(
    () => assertReleaseNoticesInDirectory(stage, { products: [] }),
    /unexpected product notice/u,
  );
});

test("rejects byte drift and POSIX directory mode drift", (t) => {
  const { stage } = fixture(t);
  stageReleaseNotices(stage);
  writeFileSync(path.join(stage, "LICENSE"), "not the license\n");
  assert.throws(() => assertReleaseNoticesInDirectory(stage), /differs byte-for-byte/u);
  if (process.platform !== "win32") {
    stageReleaseNotices(stage);
    chmodSync(path.join(stage, "LICENSE"), 0o600);
    assert.throws(() => assertReleaseNoticesInDirectory(stage), /mode 0644/u);
  }
});

test("treats directory modes as POSIX-only staging metadata", () => {
  assert.equal(hasCanonicalReleaseStagingMode(0o666, "win32"), true);
  assert.equal(hasCanonicalReleaseStagingMode(0o644, "linux"), true);
  assert.equal(hasCanonicalReleaseStagingMode(0o666, "linux"), false);
});

test("keeps portable archive notice modes exact on every host", () => {
  const entries = new Map(releaseNoticeRows().map((row) => [
    row.member,
    {
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      mode: row.member === "LICENSE" ? 0o666 : 0o644,
      data: () => readFileSync(row.source),
    },
  ]));
  assert.throws(() => assertReleaseNoticesInEntries(entries), /mode 0644/u);
});

test("exact validation rejects unknown legal namespace members and staging removes only safe stale files", (t) => {
  const { root, stage } = fixture(t);
  stageReleaseNotices(stage, { components: ["postgresql"] });
  const unknownProductNotice = path.join(stage, "THIRD_PARTY_NOTICES.unrecognized-runtime.md");
  const unknownLicense = path.join(stage, "THIRD_PARTY_LICENSES", "Unrecognized-LICENSE");
  writeFileSync(unknownProductNotice, "unknown product notice\n");
  writeFileSync(unknownLicense, "unknown component license\n");

  assert.throws(
    () => assertReleaseNoticesInDirectory(stage, { components: ["postgresql"] }),
    /unexpected product notice member THIRD_PARTY_NOTICES\.unrecognized-runtime\.md/u,
  );
  rmSync(unknownProductNotice);
  assert.throws(
    () => assertReleaseNoticesInDirectory(stage, { components: ["postgresql"] }),
    /unexpected release license member THIRD_PARTY_LICENSES\/Unrecognized-LICENSE/u,
  );

  writeFileSync(unknownProductNotice, "unknown product notice\n");
  stageReleaseNotices(stage, { components: ["postgresql"] });
  assertReleaseNoticesInDirectory(stage, { components: ["postgresql"] });

  const outside = path.join(root, "outside-license");
  writeFileSync(outside, "not safe to remove\n");
  symlinkSync(outside, unknownLicense);
  assert.throws(
    () => stageReleaseNotices(stage, { components: ["postgresql"] }),
    /stale release license path is not a regular non-symlink file/u,
  );
});

test("rejects unsafe prefixes and unsafe staging destinations", (t) => {
  const { root, stage } = fixture(t);
  for (const prefix of ["/", "\\", "a\\b", "../escape", "C:/escape", "a//b", "./../escape"]) {
    assert.throws(
      () => assertReleaseNoticesInEntries(new Map(), { prefix }),
      /unsafe release notice archive prefix/u,
      prefix,
    );
  }

  const nonDirectory = path.join(root, "not-a-directory");
  writeFileSync(nonDirectory, "file\n");
  assert.throws(
    () => stageReleaseNotices(nonDirectory),
    /real directory|cannot be inspected|symlink or non-directory ancestor/u,
  );

  const outside = path.join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(stage, "THIRD_PARTY_LICENSES"));
  assert.throws(
    () => stageReleaseNotices(stage, { components: ["postgresql"] }),
    /stale release license path is not a regular non-symlink file/u,
  );

  const realAncestor = path.join(root, "real-ancestor");
  const existingStage = path.join(realAncestor, "existing-stage");
  mkdirSync(existingStage, { recursive: true });
  const linkedAncestor = path.join(root, "linked-ancestor");
  symlinkSync(realAncestor, linkedAncestor);
  assert.throws(
    () => stageReleaseNotices(path.join(linkedAncestor, "existing-stage")),
    /symlink or non-directory ancestor/u,
  );

  const linkedStage = path.join(root, "linked-stage");
  symlinkSync(existingStage, linkedStage);
  assert.throws(
    () => stageReleaseNotices(linkedStage),
    /symlink or non-directory ancestor/u,
  );
});

test("rejects caller-created directory aliases and non-directory ancestors", (t) => {
  const { root } = fixture(t);
  const outside = path.join(root, "outside");
  const stage = path.join(outside, "stage");
  mkdirSync(stage, { recursive: true });

  const callerAlias = path.join(root, "var");
  symlinkSync(outside, callerAlias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => stageReleaseNotices(path.join(callerAlias, "stage")),
    /symlink or non-directory ancestor/u,
  );

  const nonDirectory = path.join(root, "ordinary-file");
  writeFileSync(nonDirectory, "not a directory\n");
  assert.throws(
    () => stageReleaseNotices(path.join(nonDirectory, "stage")),
    /symlink or non-directory ancestor/u,
  );
});

test("validates exact archive members and canonical bytes", (t) => {
  const { root, stage } = fixture(t);
  stageReleaseNotices(stage, { products: ["native"] });
  writeFileSync(path.join(stage, "payload.txt"), "payload\n");
  const archive = path.join(root, "carrier.tar.gz");
  const result = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    ["tools/release/archive_dir.mjs", "--keep-parent", stage, archive],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    assertReleaseNoticesInArchive(archive, {
      prefix: path.basename(stage),
      products: ["native"],
    }),
    [
      `${path.basename(stage)}/LICENSE`,
      `${path.basename(stage)}/THIRD_PARTY_NOTICES.md`,
      `${path.basename(stage)}/THIRD_PARTY_NOTICES.liboliphaunt-native.md`,
    ],
  );
  assert.throws(
    () => assertReleaseNoticesInArchive(archive, { prefix: path.basename(stage) }),
    /unexpected product notice/u,
  );
});

test("exact archive validation rejects unknown legal namespace members", (t) => {
  const { root, stage } = fixture(t);
  const prefix = "carrier";
  stageReleaseNotices(stage, { components: ["postgresql"] });

  const productNotice = path.join(stage, "THIRD_PARTY_NOTICES.unknown-product.md");
  writeFileSync(productNotice, "unknown product notice\n");
  let archive = path.join(root, "unknown-product.tar.zst");
  writeFileSync(archive, zstdCompressSync(createDeterministicTar(stage, prefix, {
    fail(message) {
      throw new Error(message);
    },
  })));
  assert.throws(
    () => assertReleaseNoticesInArchive(archive, { prefix, components: ["postgresql"] }),
    /unexpected product notice member carrier\/THIRD_PARTY_NOTICES\.unknown-product\.md/u,
  );

  rmSync(productNotice);
  writeFileSync(path.join(stage, "THIRD_PARTY_LICENSES", "Unknown-LICENSE"), "unknown license\n");
  archive = path.join(root, "unknown-license.tar.zst");
  writeFileSync(archive, zstdCompressSync(createDeterministicTar(stage, prefix, {
    fail(message) {
      throw new Error(message);
    },
  })));
  assert.throws(
    () => assertReleaseNoticesInArchive(archive, { prefix, components: ["postgresql"] }),
    /unexpected release license member carrier\/THIRD_PARTY_LICENSES\/Unknown-LICENSE/u,
  );
});

test("validates exact notices in a real zstd-compressed ustar carrier", (t) => {
  const { root, stage } = fixture(t);
  const profile = "wasix-runtime";
  const prefix = "liboliphaunt-wasix-runtime-portable";
  stageReleaseNotices(stage, { profile });
  writeFileSync(path.join(stage, "runtime.bin"), "runtime\n");
  const archive = path.join(root, `${prefix}.tar.zst`);
  const tar = createDeterministicTar(stage, prefix, {
    fail(message) {
      throw new Error(message);
    },
  });
  writeFileSync(archive, zstdCompressSync(tar));

  assert.deepEqual(
    assertReleaseNoticesInArchive(archive, { prefix, profile }),
    releaseNoticeRows({ profile }).map((row) => `${prefix}/${row.member}`),
  );
});

test("rejects archive byte and mode drift", (t) => {
  const { root, stage } = fixture(t);
  stageReleaseNotices(stage, { components: ["postgresql"] });
  writeFileSync(path.join(stage, "LICENSE"), "not the license\n");
  const byteArchive = path.join(root, "byte-drift.tar.gz");
  let result = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    ["tools/release/archive_dir.mjs", "--keep-parent", stage, byteArchive],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.throws(
    () => assertReleaseNoticesInArchive(byteArchive, {
      prefix: path.basename(stage),
      components: ["postgresql"],
    }),
    /differs byte-for-byte/u,
  );

  stageReleaseNotices(stage, { components: ["postgresql"] });
  chmodSync(path.join(stage, "LICENSE"), 0o755);
  const modeArchive = path.join(root, "mode-drift.tar.gz");
  result = spawnSync(
    path.join(ROOT, "tools/dev/bun.sh"),
    ["tools/release/archive_dir.mjs", "--keep-parent", stage, modeArchive],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.throws(
    () => assertReleaseNoticesInArchive(modeArchive, {
      prefix: path.basename(stage),
      components: ["postgresql"],
    }),
    /mode 0644/u,
  );
});
