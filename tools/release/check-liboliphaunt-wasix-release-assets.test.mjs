import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import {
  exactRegularAssetDirectoryNames,
  expectedReleaseNoticeFiles,
  unexpectedTreeMembers,
  validateAotReleaseAsset,
  validateIcuReleaseAsset,
  validatePortableReleaseAsset,
} from "./check-liboliphaunt-wasix-release-assets.mjs";
import { createDeterministicTar } from "./cargo-source-package.mjs";
import { stageReleaseNotices } from "./release-notices.mjs";
import { AOT_TARGET_TRIPLES } from "./wasix-cargo-artifact-contract.mjs";
import { canonicalWasixAotMetadata } from "./wasix-aot-manifest.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "wasix-release-assets-check-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

function archiveStage(stage, archive, archiveRoot) {
  const tar = createDeterministicTar(stage, archiveRoot, {
    fail(message) {
      throw new Error(message);
    },
    fixedFileMode: 0o644,
  });
  writeFileSync(archive, zstdCompressSync(tar));
  return archive;
}

function stageIcuPayload(stage, profile = "wasix-icu-data") {
  const payload = path.join(
    stage,
    "target/oliphaunt-wasix/icu/share/icu/icudt76l/data.res",
  );
  mkdirSync(path.dirname(payload), { recursive: true });
  writeFileSync(payload, "icu-data\n");
  stageReleaseNotices(stage, { profile });
}

function stageAotPayload(stage, target, profile = "wasix-aot") {
  const canonical = canonicalWasixAotMetadata();
  const raw = Buffer.from(`aot-payload:${target}\n`);
  const compressed = zstdCompressSync(raw);
  const manifest = {
    "format-version": 1,
    "source-lane": canonical.sourceLane,
    "target-triple": target,
    engine: canonical.engine,
    "wasmer-version": canonical.wasmerVersion,
    "wasmer-wasix-version": canonical.wasmerWasixVersion,
    artifacts: [{
      name: "runtime:oliphaunt",
      path: "runtime.bin.zst",
      sha256: sha256(compressed),
      "raw-sha256": sha256(raw),
      "raw-size": raw.length,
      "module-sha256": sha256(Buffer.from("runtime-module")),
      compressed: true,
    }],
  };
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(stage, "runtime.bin.zst"), compressed);
  stageReleaseNotices(stage, { profile });
  return {
    artifact: path.join(stage, "runtime.bin.zst"),
    manifest: path.join(stage, "manifest.json"),
    raw,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stagePortablePayload(stage, runtimeBytes) {
  const root = path.join(stage, "target/oliphaunt-wasix/assets");
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "bin/pg_dump.wasix.wasm"), "pg_dump\n");
  writeFileSync(path.join(root, "bin/psql.wasix.wasm"), "psql\n");
  writeFileSync(path.join(root, "oliphaunt.wasix.tar.zst"), runtimeBytes);
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({
    "format-version": 1,
    runtime: {
      archive: "oliphaunt.wasix.tar.zst",
      sha256: sha256(runtimeBytes),
    },
    extensions: [],
  }, null, 2)}\n`);
  stageReleaseNotices(stage, { profile: "wasix-runtime" });
}

function runtimeArchive(root, name = "runtime.tar.zst") {
  const stage = path.join(root, `${name}-stage`, "oliphaunt");
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  writeFileSync(path.join(stage, "bin/initdb"), "initdb\n");
  writeFileSync(path.join(stage, "bin/postgres"), "postgres\n");
  return readFileSync(archiveStage(stage, path.join(root, name), "oliphaunt"));
}

function withParents(files) {
  const members = new Set(files);
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      members.add(parts.slice(0, index).join("/"));
    }
  }
  return members;
}

test("ICU release assets admit only their exact canonical notice closure", () => {
  const payload = "target/oliphaunt-wasix/icu/share/icu/76.1/icudt76l/data.bin";
  const notices = expectedReleaseNoticeFiles("wasix-icu-data");
  assert.deepEqual(
    [...notices].sort(),
    [
      "LICENSE",
      "THIRD_PARTY_LICENSES/ICU-LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "THIRD_PARTY_NOTICES.oliphaunt-wasix.md",
    ],
  );

  const expected = new Set([payload, ...notices]);
  const members = withParents(expected);
  assert.deepEqual(unexpectedTreeMembers(members, expected), []);

  members.add("THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT");
  assert.deepEqual(
    unexpectedTreeMembers(members, expected),
    ["THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT"],
  );
});

test("the release asset directory rejects entries hidden from a regular-file inventory", (t) => {
  const root = fixture(t);
  const asset = path.join(root, "asset.tar.zst");
  writeFileSync(asset, "asset\n");
  assert.deepEqual(exactRegularAssetDirectoryNames(root), ["asset.tar.zst"]);

  const directory = path.join(root, "unexpected-directory");
  mkdirSync(directory);
  assert.throws(
    () => exactRegularAssetDirectoryNames(root),
    /only regular non-symlink files: unexpected-directory/u,
  );
  rmSync(directory, { recursive: true });

  if (process.platform !== "win32") {
    symlinkSync(asset, path.join(root, "unexpected-link.tar.zst"));
    assert.throws(
      () => exactRegularAssetDirectoryNames(root),
      /only regular non-symlink files: unexpected-link[.]tar[.]zst/u,
    );
  }
});

test("every AOT target admits its prefixed canonical notice closure and rejects extras", () => {
  for (const target of Object.values(AOT_TARGET_TRIPLES).sort()) {
    const root = `target/oliphaunt-wasix/aot/${target}`;
    const notices = expectedReleaseNoticeFiles("wasix-aot", root);
    assert.ok(notices.has(`${root}/LICENSE`), target);
    assert.ok(notices.has(`${root}/THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT`), target);
    assert.ok(notices.has(`${root}/THIRD_PARTY_LICENSES/ICU-LICENSE`), target);

    const expected = new Set([
      `${root}/manifest.json`,
      `${root}/runtime.cwasm`,
      ...notices,
    ]);
    const members = withParents(expected);
    assert.deepEqual(unexpectedTreeMembers(members, expected), [], target);

    const extra = `${root}/THIRD_PARTY_LICENSES/Unknown-LICENSE`;
    members.add(extra);
    assert.deepEqual(unexpectedTreeMembers(members, expected), [extra], target);
  }
});

test("the real ICU validator accepts producer-shaped notices and rejects extra or wrong-profile notices", (t) => {
  const root = fixture(t);
  const validStage = path.join(root, "icu-valid");
  stageIcuPayload(validStage);
  const valid = archiveStage(validStage, path.join(root, "icu-valid.tar.zst"), ".");
  assert.doesNotThrow(() => validateIcuReleaseAsset(valid));

  const payloadExtraStage = path.join(root, "icu-payload-extra");
  stageIcuPayload(payloadExtraStage);
  const payloadExtra = path.join(
    payloadExtraStage,
    "target/oliphaunt-wasix/icu/share/icu/config/mh-linux",
  );
  mkdirSync(path.dirname(payloadExtra), { recursive: true });
  writeFileSync(payloadExtra, "build-only-config\n");
  const payloadExtraArchive = archiveStage(
    payloadExtraStage,
    path.join(root, "icu-payload-extra.tar.zst"),
    ".",
  );
  assert.throws(
    () => validateIcuReleaseAsset(payloadExtraArchive),
    /unexpected non-ICU files: target\/oliphaunt-wasix\/icu\/share\/icu\/config\/mh-linux/u,
  );

  const unknown = path.join(validStage, "THIRD_PARTY_LICENSES/Unknown-LICENSE");
  writeFileSync(unknown, "unknown\n");
  const extra = archiveStage(validStage, path.join(root, "icu-extra.tar.zst"), ".");
  assert.throws(
    () => validateIcuReleaseAsset(extra),
    /unexpected release license member THIRD_PARTY_LICENSES\/Unknown-LICENSE/u,
  );

  const wrongStage = path.join(root, "icu-wrong-profile");
  stageIcuPayload(wrongStage, "wasix-runtime");
  const wrong = archiveStage(wrongStage, path.join(root, "icu-wrong-profile.tar.zst"), ".");
  assert.throws(
    () => validateIcuReleaseAsset(wrong),
    /unexpected release license member THIRD_PARTY_LICENSES\/PostgreSQL-COPYRIGHT/u,
  );
});

test("the real AOT validator accepts every target and rejects extra or wrong-profile notices", (t) => {
  const root = fixture(t);
  const targets = Object.values(AOT_TARGET_TRIPLES).sort();
  for (const [index, target] of targets.entries()) {
    const stage = path.join(root, `aot-valid-${index}`);
    const archiveRoot = `target/oliphaunt-wasix/aot/${target}`;
    stageAotPayload(stage, target);
    const archive = archiveStage(stage, path.join(root, `aot-valid-${index}.tar.zst`), archiveRoot);
    assert.doesNotThrow(() => validateAotReleaseAsset(archive, target), target);
  }

  const target = targets[0];
  const archiveRoot = `target/oliphaunt-wasix/aot/${target}`;
  const extraStage = path.join(root, "aot-extra");
  stageAotPayload(extraStage, target);
  writeFileSync(path.join(extraStage, "THIRD_PARTY_LICENSES/Unknown-LICENSE"), "unknown\n");
  const extra = archiveStage(extraStage, path.join(root, "aot-extra.tar.zst"), archiveRoot);
  assert.throws(
    () => validateAotReleaseAsset(extra, target),
    new RegExp(`${archiveRoot}/THIRD_PARTY_LICENSES/Unknown-LICENSE`, "u"),
  );

  const wrongStage = path.join(root, "aot-wrong-profile");
  stageAotPayload(wrongStage, target, "wasix-icu-data");
  const wrong = archiveStage(wrongStage, path.join(root, "aot-wrong-profile.tar.zst"), archiveRoot);
  assert.throws(
    () => validateAotReleaseAsset(wrong, target),
    new RegExp(`${archiveRoot}/THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT`, "u"),
  );
});

test("the portable validator strictly checks nested runtime bytes and their manifest digest", (t) => {
  const root = fixture(t);
  const runtime = runtimeArchive(root);
  const validStage = path.join(root, "portable-valid");
  stagePortablePayload(validStage, runtime);
  const valid = archiveStage(validStage, path.join(root, "portable-valid.tar.zst"), ".");
  assert.doesNotThrow(() => validatePortableReleaseAsset(valid));

  const badDigestStage = path.join(root, "portable-bad-digest");
  stagePortablePayload(badDigestStage, runtime);
  const manifestPath = path.join(
    badDigestStage,
    "target/oliphaunt-wasix/assets/manifest.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.runtime.sha256 = "0".repeat(64);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const badDigest = archiveStage(
    badDigestStage,
    path.join(root, "portable-bad-digest.tar.zst"),
    ".",
  );
  assert.throws(
    () => validatePortableReleaseAsset(badDigest),
    /runtime[.]sha256 mismatch/u,
  );

  const concatenatedStage = path.join(root, "portable-concatenated");
  stagePortablePayload(concatenatedStage, Buffer.concat([runtime, runtime]));
  const concatenated = archiveStage(
    concatenatedStage,
    path.join(root, "portable-concatenated.tar.zst"),
    ".",
  );
  assert.throws(
    () => validatePortableReleaseAsset(concatenated),
    /trailing data or multiple Zstandard frames/u,
  );
});

test("the AOT validator rejects duplicate metadata, tampering, and non-canonical zstd payloads", (t) => {
  const root = fixture(t);
  const target = Object.values(AOT_TARGET_TRIPLES).sort()[0];
  const archiveRoot = `target/oliphaunt-wasix/aot/${target}`;

  function rejected(name, mutate, pattern) {
    const stage = path.join(root, name);
    const fixtureData = stageAotPayload(stage, target);
    const manifest = JSON.parse(readFileSync(fixtureData.manifest, "utf8"));
    mutate({ ...fixtureData, manifest });
    writeFileSync(fixtureData.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = archiveStage(stage, path.join(root, `${name}.tar.zst`), archiveRoot);
    assert.throws(() => validateAotReleaseAsset(archive, target), pattern, name);
  }

  rejected("duplicate-name", ({ manifest }) => {
    manifest.artifacts.push({ ...manifest.artifacts[0], path: "second.bin.zst" });
  }, /repeats AOT artifact name/u);

  rejected("duplicate-path", ({ manifest }) => {
    manifest.artifacts.push({ ...manifest.artifacts[0], name: "runtime-support:other" });
  }, /repeats AOT artifact path/u);

  rejected("unnormalized-path", ({ manifest }) => {
    manifest.artifacts[0].path = "./runtime.bin.zst";
  }, /path must already be normalized/u);

  rejected("tampered-compressed", ({ artifact }) => {
    const bytes = Buffer.from(readFileSync(artifact));
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(artifact, bytes);
  }, /compressed SHA-256 mismatch/u);

  rejected("concatenated-zstd", ({ artifact, manifest }) => {
    const bytes = readFileSync(artifact);
    const concatenated = Buffer.concat([bytes, bytes]);
    writeFileSync(artifact, concatenated);
    manifest.artifacts[0].sha256 = sha256(concatenated);
  }, /trailing data or multiple Zstandard frames/u);

  rejected("wrong-raw-size", ({ manifest }) => {
    manifest.artifacts[0]["raw-size"] += 1;
  }, /bounded readable Zstandard stream|raw-size mismatch/u);

  rejected("wrong-raw-digest", ({ manifest }) => {
    manifest.artifacts[0]["raw-sha256"] = "0".repeat(64);
  }, /raw SHA-256 mismatch/u);

  rejected("malformed-compressed", ({ manifest }) => {
    manifest.artifacts[0].compressed = "true";
  }, /compressed must be a Boolean/u);

  rejected("extra-metadata", ({ manifest }) => {
    manifest.artifacts[0].unexpected = true;
  }, /metadata fields must be exactly/u);

  rejected("empty-artifact", ({ artifact, manifest }) => {
    writeFileSync(artifact, Buffer.alloc(0));
    manifest.artifacts[0].sha256 = sha256(Buffer.alloc(0));
  }, /non-empty regular file/u);
});
