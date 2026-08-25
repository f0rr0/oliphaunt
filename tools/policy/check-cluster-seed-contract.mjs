#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import { validateNativeClusterSeedManifest } from "../release/native-cluster-seed-contract.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const contractRoot = path.join(root, "src/shared/cluster-seed-contract");
const contract = readJson("contract.json");
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

assertExactKeys(contract, [
  "compatibilityKeys",
  "icu",
  "icuDataSchema",
  "manifests",
  "physicalFormats",
  "profiles",
  "schema",
], "contract");
assert(contract.schema === "oliphaunt-cluster-seed-contract-v1", "unsupported contract schema");
assert(contract.icuDataSchema === "oliphaunt-icu-data-v1", "unsupported ICU-data schema");
assertExactKeys(contract.manifests, ["native", "wasix"], "manifest families");
assertExactKeys(contract.manifests.native, [
  "cacheKeyDisallowedValues",
  "cacheKeyPattern",
  "layout",
  "schema",
], "native manifest contract");
assertExactKeys(contract.manifests.wasix, ["schema"], "WASIX manifest contract");
assert(
  contract.manifests.native.schema === "oliphaunt-runtime-resources-v1"
    && contract.manifests.native.layout === "oliphaunt-cluster-seed-v1",
  "unsupported native manifest contract",
);
assert(contract.manifests.wasix.schema === "oliphaunt-cluster-seed-v1", "unsupported WASIX manifest schema");
assert(
  contract.manifests.native.cacheKeyPattern === "^[A-Za-z0-9._-]{1,128}$",
  "cluster-seed cache-key grammar is invalid",
);
assert(
  JSON.stringify(contract.manifests.native.cacheKeyDisallowedValues) === JSON.stringify([".", ".."]),
  "cluster-seed cache-key path components are invalid",
);
assertExactKeys(contract.profiles, ["icu", "standard"], "contract profiles");
assertProfileContract("standard", "cluster-seed-standard", []);
assertProfileContract("icu", "cluster-seed-icu", ["icu"]);
assertExactKeys(contract.icu, [
  "artifactRole",
  "dataForm",
  "dataVersion",
  "internalReadinessEnvironment",
  "internalReadinessValue",
  "logicalTreeDigest",
  "runtimePath",
], "contract ICU");
assert(contract.icu.artifactRole === "icu-data", "ICU artifact role must be icu-data");
assert(contract.icu.dataForm === "files-le", "ICU data form must be files-le");
assert(contract.icu.dataVersion === "76.1", "ICU data version must be 76.1");
assert(contract.icu.runtimePath === "share/icu", "ICU runtime path must be share/icu");
assert(
  contract.icu.logicalTreeDigest === "sha256(path-nul-size-nul-bytes-lf)",
  "ICU logical tree digest algorithm is invalid",
);
assert(
  contract.icu.internalReadinessEnvironment === "OLIPHAUNT_INTERNAL_ICU_READY"
    && contract.icu.internalReadinessValue === "1",
  "internal ICU readiness must use the exact locked name and value",
);
assert(
  Object.keys(contract.compatibilityKeys.native).length === 6,
  "native compatibility domains must be explicit",
);
for (const [target, key] of Object.entries(contract.compatibilityKeys.native)) {
  assert(key === `native-pg18-${target}-v1`, `native compatibility key for ${target} is invalid`);
  assert(key !== contract.compatibilityKeys.wasixDatum32, `${target} and WASIX seeds must have different compatibility keys`);
}

validateSeed(readJson("fixtures/standard.valid.json"), "standard fixture");
validateSeed(readJson("fixtures/icu.valid.json"), "ICU fixture");
validateNativeClusterSeedManifest(
  readFixture("native-standard.valid.properties"),
  "standard",
  { target: "linux-x64-gnu" },
);
validateNativeClusterSeedManifest(
  readFixture("native-icu.valid.properties"),
  "icu",
  { target: "linux-x64-gnu", icuDataTreeSha256: "a".repeat(64) },
);
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
  let nativeRejected = false;
  try {
    validateNativeClusterSeedManifest(readFixture(name), "standard", {
      target: "linux-x64-gnu",
    });
  } catch {
    nativeRejected = true;
  }
  assert(nativeRejected, `${name} must be rejected`);
}
let rejected = false;
try {
  validateSeed(readJson("fixtures/profile-mismatch.invalid.json"), "invalid fixture");
} catch {
  rejected = true;
}
assert(rejected, "profile-mismatch.invalid.json must be rejected");

console.log("cluster seed contract passed (WASIX and native standard/ICU fixtures; invalid vectors rejected)");

export function validateSeed(seed, label = "cluster seed") {
  assertObject(seed, label);
  assertExactKeys(seed, [
    "archive",
    "artifactRole",
    "catalogProfile",
    "extensions",
    "icu",
    "initProfile",
    "requiredRuntimeFeatures",
    "runtime",
    "schema",
    "source",
  ], label);
  assert(seed.schema === contract.manifests.wasix.schema, `${label} has unsupported schema`);
  const profile = contract.profiles[seed.catalogProfile];
  assert(profile !== undefined, `${label} has unsupported catalogProfile`);
  assert(seed.artifactRole === profile.artifactRole, `${label} artifactRole/profile mismatch`);
  assert(
    JSON.stringify(seed.requiredRuntimeFeatures) === JSON.stringify(profile.requiredRuntimeFeatures),
    `${label} requiredRuntimeFeatures/profile mismatch`,
  );
  const runtimeKeys = [
    "compatibilityKey",
    "consumerSha256",
    "engineFamily",
    "initdbSha256",
    "physicalFormat",
    "postgresMajor",
    "producerSha256",
    "product",
    "version",
  ];
  assertExactKeys(seed.runtime, runtimeKeys, `${label} runtime`);
  assert(seed.runtime.engineFamily === "wasix", `${label} engineFamily must be wasix`);
  assert(
    seed.runtime.physicalFormat === contract.physicalFormats.wasix,
    `${label} physicalFormat must be the WASIX format`,
  );
  assert(
    seed.runtime.compatibilityKey === contract.compatibilityKeys.wasixDatum32,
    `${label} compatibilityKey must be the WASIX Datum32 key`,
  );
  assert(seed.runtime.postgresMajor === 18, `${label} must target PostgreSQL 18`);
  for (const key of ["consumerSha256", "producerSha256", "initdbSha256"]) {
    assert(SHA256.test(seed.runtime[key]), `${label} runtime.${key} must be SHA-256`);
  }
  for (const key of ["product", "version"]) assertText(seed.runtime[key], `${label} runtime.${key}`);
  assertExactKeys(seed.source, ["catalogVersion", "fingerprint", "lane", "producer"], `${label} source`);
  for (const [key, value] of Object.entries(seed.source)) assertText(value, `${label} source.${key}`);
  assertText(seed.initProfile, `${label} initProfile`);
  assertExactKeys(seed.archive, [
    "compressedBytes",
    "directories",
    "expandedBytes",
    "path",
    "regularFiles",
    "sha256",
  ], `${label} archive`);
  assert(seed.archive.path === `cluster-seeds/${seed.catalogProfile}.tar.zst`, `${label} archive path/profile mismatch`);
  assert(SHA256.test(seed.archive.sha256), `${label} archive SHA-256 is invalid`);
  for (const key of ["compressedBytes", "expandedBytes", "regularFiles", "directories"]) {
    assert(Number.isSafeInteger(seed.archive[key]) && seed.archive[key] > 0, `${label} archive.${key} is invalid`);
  }
  assertExactKeys(seed.extensions, ["selected", "startupConfiguration"], `${label} extensions`);
  assert(
    Array.isArray(seed.extensions.selected) && seed.extensions.selected.length === 0
      && Array.isArray(seed.extensions.startupConfiguration)
      && seed.extensions.startupConfiguration.length === 0,
    `${label} must be extension-free`,
  );
  if (seed.catalogProfile === "standard") {
    assert(seed.icu === null, `${label} standard profile must not identify ICU data`);
  } else {
    assertExactKeys(seed.icu, [
      "artifactRole",
      "dataForm",
      "dataTreeSha256",
      "dataVersion",
      "sourceCommit",
      "upstreamVersion",
    ], `${label} ICU`);
    assert(seed.icu.artifactRole === contract.icu.artifactRole, `${label} ICU artifact role is invalid`);
    assert(seed.icu.dataForm === contract.icu.dataForm, `${label} ICU data form is invalid`);
    assert(seed.icu.dataVersion === contract.icu.dataVersion, `${label} ICU data version is invalid`);
    assert(seed.icu.upstreamVersion === contract.icu.dataVersion, `${label} ICU upstream version is invalid`);
    assert(SHA256.test(seed.icu.dataTreeSha256), `${label} ICU tree SHA-256 is invalid`);
    assert(COMMIT.test(seed.icu.sourceCommit), `${label} ICU source commit is invalid`);
  }
  return seed;
}

function assertProfileContract(profile, artifactRole, requiredRuntimeFeatures) {
  assertExactKeys(contract.profiles[profile], ["artifactRole", "requiredRuntimeFeatures"], `profile ${profile}`);
  assert(contract.profiles[profile].artifactRole === artifactRole, `profile ${profile} role mismatch`);
  assert(
    JSON.stringify(contract.profiles[profile].requiredRuntimeFeatures) === JSON.stringify(requiredRuntimeFeatures),
    `profile ${profile} features mismatch`,
  );
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(contractRoot, ...relative.split("/")), "utf8"));
}

function readFixture(name) {
  return readFileSync(path.join(contractRoot, "fixtures", name));
}

function assertObject(value, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertExactKeys(value, expected, label) {
  assertObject(value, label);
  const actual = Object.keys(value).sort();
  assert(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `${label} has non-canonical fields`);
}

function assertText(value, label) {
  assert(typeof value === "string" && value.length > 0 && !value.includes("\0"), `${label} must be non-empty text`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`cluster seed contract: ${message}`);
}
