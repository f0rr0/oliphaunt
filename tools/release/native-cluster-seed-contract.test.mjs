import { expect, test } from "bun:test";

import {
  logicalTreeSha256,
  validateNativeClusterSeedManifest,
} from "./native-cluster-seed-contract.mjs";

function manifest(profile, digest = "") {
  return Buffer.from([
    "schema=oliphaunt-runtime-resources-v1",
    "layout=oliphaunt-cluster-seed-v1",
    `artifactRole=cluster-seed-${profile}`,
    `catalogProfile=${profile}`,
    "postgresMajor=18",
    "physicalFormat=native-pg18-v1",
    "compatibilityKey=native-pg18-datum64-v1",
    "initialSuperuser=postgres",
    `icuDataVersion=${profile === "icu" ? "76.1" : ""}`,
    `icuDataForm=${profile === "icu" ? "files-le" : ""}`,
    `icuDataTreeSha256=${digest}`,
    `runtimeFeatures=${profile === "icu" ? "icu" : ""}`,
    "",
  ].join("\n"));
}

test("validates independent standard and ICU native cluster seed roles", () => {
  const digest = logicalTreeSha256([
    { path: "icudt76l/coll/en.res", bytes: Buffer.from("en\n") },
    { path: "icudt76l/root.res", bytes: Buffer.from("root\n") },
  ]);
  expect(() => validateNativeClusterSeedManifest(manifest("standard"), "standard")).not.toThrow();
  expect(() => validateNativeClusterSeedManifest(manifest("icu", digest), "icu", {
    icuDataTreeSha256: digest,
  })).not.toThrow();
  expect(() => validateNativeClusterSeedManifest(manifest("icu", "a".repeat(64)), "icu", {
    icuDataTreeSha256: digest,
  })).toThrow(/icuDataTreeSha256/u);
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
});
