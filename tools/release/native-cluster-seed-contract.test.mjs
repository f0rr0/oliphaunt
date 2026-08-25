import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bindNativeClusterSeedManifest,
  logicalTreeSha256,
  validateNativeClusterSeedDirectory,
  validateNativeClusterSeedManifest,
} from "./native-cluster-seed-contract.mjs";

function fixture(name) {
  return readFileSync(new URL(`../../src/shared/cluster-seed-contract/fixtures/${name}`, import.meta.url));
}

test("keeps process-argument profile probes independent of the host code page", () => {
  const probe = readFileSync(
    new URL("../../src/shared/cluster-seed-contract/profile-probe.json", import.meta.url),
  );
  expect(probe.every((byte) => byte <= 0x7f)).toBe(true);
});

test("validates independent standard and ICU native cluster seed roles", () => {
  const target = "linux-x64-gnu";
  const digest = logicalTreeSha256([
    { path: "icudt76l/coll/en.res", bytes: Buffer.from("en\n") },
    { path: "icudt76l/root.res", bytes: Buffer.from("root\n") },
  ]);
  expect(() => validateNativeClusterSeedManifest(fixture("native-standard.valid.properties"), "standard", { target })).not.toThrow();
  expect(() => validateNativeClusterSeedManifest(fixture("native-icu.valid.properties"), "icu", {
    target,
    icuDataTreeSha256: "a".repeat(64),
  })).not.toThrow();
  expect(() => validateNativeClusterSeedManifest(fixture("native-icu.valid.properties"), "icu", {
    target,
    icuDataTreeSha256: digest,
  })).toThrow(/icuDataTreeSha256/u);
});

test("rejects the shared malformed, extra-field, cache-key, target, and profile vectors", () => {
  for (const name of [
    "native-malformed.invalid.properties",
    "native-whitespace.invalid.properties",
    "native-cache-key.invalid.properties",
    "native-dot-cache-key.invalid.properties",
    "native-dotdot-cache-key.invalid.properties",
    "native-extra-field.invalid.properties",
    "native-target-mismatch.invalid.properties",
    "native-profile-mismatch.invalid.properties",
  ]) {
    expect(() => validateNativeClusterSeedManifest(fixture(name), "standard", {
      target: "linux-x64-gnu",
    }), name).toThrow();
  }
});

test("canonicalizes producer manifests and rejects extra public fields", () => {
  const producer = Buffer.from([
    "schema=oliphaunt-runtime-resources-v1",
    "layout=oliphaunt-cluster-seed-v1",
    "artifactRole=cluster-seed-standard",
    "catalogProfile=standard",
    "postgresMajor=18",
    "physicalFormat=native-pg18-v1",
    "initialSuperuser=postgres",
    "icuDataVersion=",
    "icuDataForm=",
    "icuDataTreeSha256=",
    "runtimeFeatures=",
    "cacheKey=0123456789abcdef",
    "",
  ].join("\n"));
  const canonical = bindNativeClusterSeedManifest(producer, "ios-datum64", "standard");
  expect(() => validateNativeClusterSeedManifest(canonical, "standard", {
    target: "ios-datum64",
  })).not.toThrow();
  expect(canonical.toString("utf8")).not.toContain("mode=");
  expect(() => bindNativeClusterSeedManifest(
    Buffer.concat([producer, Buffer.from("mode=native-server\n")]),
    "ios-datum64",
    "standard",
  )).toThrow(/exact unbound producer field set/u);
  expect(() => validateNativeClusterSeedManifest(Buffer.concat([canonical, Buffer.from("extra=value\n")]), "standard", {
    target: "ios-datum64",
  })).toThrow(/fields must be exactly/u);
});

test("logical ICU digest is metadata-independent and path-sensitive", () => {
  const one = logicalTreeSha256([{ path: "a.res", bytes: Buffer.from("x") }]);
  const reordered = logicalTreeSha256([
    { path: "b.res", bytes: Buffer.from("y") },
    { path: "a.res", bytes: Buffer.from("x") },
  ]);
  const canonical = logicalTreeSha256([
    { path: "a.res", bytes: Buffer.from("x") },
    { path: "b.res", bytes: Buffer.from("y") },
  ]);
  expect(reordered).toBe(canonical);
  expect(one).not.toBe(canonical);
  expect(() => logicalTreeSha256([
    { path: "a/b", bytes: Buffer.from("x") },
    { path: "a\\b", bytes: Buffer.from("x") },
  ])).toThrow(/repeats path/u);
  expect(() => logicalTreeSha256([
    { path: "../outside", bytes: Buffer.from("x") },
  ])).toThrow(/unsafe path/u);
});

test("requires a complete regular native PGDATA seed tree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-native-seed-contract-"));
  const seed = path.join(root, "seed");
  try {
    mkdirSync(path.join(seed, "files/global"), { recursive: true });
    mkdirSync(path.join(seed, "files/pg_wal"));
    writeFileSync(path.join(seed, "files/PG_VERSION"), "18\n");
    writeFileSync(path.join(seed, "files/global/pg_control"), "control\n");
    writeFileSync(path.join(seed, "manifest.properties"), fixture("native-standard.valid.properties"));
    expect(() => validateNativeClusterSeedDirectory(seed, "standard", {
      target: "linux-x64-gnu",
    })).not.toThrow();

    writeFileSync(path.join(seed, "files/postmaster.pid"), "1\n");
    expect(() => validateNativeClusterSeedDirectory(seed, "standard", {
      target: "linux-x64-gnu",
    })).toThrow(/transient postmaster[.]pid/u);
    rmSync(path.join(seed, "files/postmaster.pid"));

    if (process.platform !== "win32") {
      symlinkSync("PG_VERSION", path.join(seed, "files/linked-version"));
      expect(() => validateNativeClusterSeedDirectory(seed, "standard", {
        target: "linux-x64-gnu",
      })).toThrow(/symlink/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
