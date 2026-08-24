#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const contractRoot = path.join(root, "src/shared/cluster-seed-contract");
const contract = readJson("contract.json");
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;

assertExactKeys(contract, [
  "compatibilityKeys",
  "icu",
  "icuDataSchema",
  "manifestSchema",
  "physicalFormats",
  "profiles",
  "schema",
], "contract");
assert(contract.schema === "oliphaunt-cluster-seed-contract-v1", "unsupported contract schema");
assert(contract.manifestSchema === "oliphaunt-cluster-seed-v1", "unsupported manifest schema");
assert(contract.icuDataSchema === "oliphaunt-icu-data-v1", "unsupported ICU-data schema");
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
  contract.compatibilityKeys.nativeDatum64 !== contract.compatibilityKeys.wasixDatum32,
  "native Datum64 and WASIX Datum32 seeds must have different compatibility keys",
);

validateSeed(readJson("fixtures/standard.valid.json"), "standard fixture");
validateSeed(readJson("fixtures/icu.valid.json"), "ICU fixture");
let rejected = false;
try {
  validateSeed(readJson("fixtures/profile-mismatch.invalid.json"), "invalid fixture");
} catch {
  rejected = true;
}
assert(rejected, "profile-mismatch.invalid.json must be rejected");

console.log("cluster seed contract passed (standard, icu, icu-data; invalid mismatch rejected)");

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
  assert(seed.schema === contract.manifestSchema, `${label} has unsupported schema`);
  const profile = contract.profiles[seed.catalogProfile];
  assert(profile !== undefined, `${label} has unsupported catalogProfile`);
  assert(seed.artifactRole === profile.artifactRole, `${label} artifactRole/profile mismatch`);
  assert(
    JSON.stringify(seed.requiredRuntimeFeatures) === JSON.stringify(profile.requiredRuntimeFeatures),
    `${label} requiredRuntimeFeatures/profile mismatch`,
  );
  assertExactKeys(seed.runtime, [
    "compatibilityKey",
    "consumerSha256",
    "engineFamily",
    "initdbSha256",
    "physicalFormat",
    "postgresMajor",
    "producerSha256",
    "product",
    "version",
  ], `${label} runtime`);
  assert(["native", "wasix"].includes(seed.runtime.engineFamily), `${label} engineFamily is invalid`);
  const family = seed.runtime.engineFamily;
  const physicalFormat = contract.physicalFormats[family];
  const compatibilityKey = family === "native"
    ? contract.compatibilityKeys.nativeDatum64
    : contract.compatibilityKeys.wasixDatum32;
  assert(seed.runtime.physicalFormat === physicalFormat, `${label} physicalFormat/family mismatch`);
  assert(seed.runtime.compatibilityKey === compatibilityKey, `${label} compatibilityKey/family mismatch`);
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
