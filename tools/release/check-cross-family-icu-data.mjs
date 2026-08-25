#!/usr/bin/env bun

import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  ICU_DATA_FORM,
  ICU_DATA_VERSION,
  parseNativeIcuDataIdentity,
} from "./native-icu-data-contract.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";
import { WASIX_PORTABLE_RELEASE_MEMBERS } from "./wasix-runtime-npm-contract.mjs";

const TOOL = "check-cross-family-icu-data.mjs";
const LOWER_SHA256 = /^[0-9a-f]{64}$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function onlyAsset(directory, pattern, label) {
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && pattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  if (matches.length !== 1) {
    fail(`${label} directory must contain exactly one matching release asset; found ${matches.length}`);
  }
  const metadata = lstatSync(matches[0]);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    fail(`${label} release asset must be a non-empty regular file`);
  }
  return matches[0];
}

function requiredEntry(entries, member, label) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0) {
    fail(`${label} must contain ${member} as a non-empty regular file`);
  }
  return Buffer.from(entry.data());
}

function json(bytes, label) {
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") fail(`${label} must be an object`);
  return value;
}

function checkedDigest(value, label) {
  if (typeof value !== "string" || !LOWER_SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function wasixIcuDataIdentity(portableRuntimeArchive) {
  const entries = readPortableArchiveEntries(path.resolve(portableRuntimeArchive));
  const outer = json(
    requiredEntry(entries, WASIX_PORTABLE_RELEASE_MEMBERS.manifest, "WASIX portable runtime release"),
    "WASIX portable runtime manifest",
  );
  const seed = json(
    requiredEntry(entries, WASIX_PORTABLE_RELEASE_MEMBERS.icuSeedManifest, "WASIX portable runtime release"),
    "WASIX ICU cluster-seed manifest",
  );
  const data = seed.icu;
  const closure = outer["cluster-seeds"]?.icu;
  if (
    outer["format-version"] !== 2
    || seed.schema !== "oliphaunt-cluster-seed-v1"
    || seed.artifactRole !== "cluster-seed-icu"
    || seed.catalogProfile !== "icu"
    || data?.artifactRole !== "icu-data"
    || data?.dataVersion !== ICU_DATA_VERSION
    || data?.dataForm !== ICU_DATA_FORM
    || closure?.manifest !== "cluster-seeds/icu.json"
  ) {
    fail("WASIX portable runtime does not contain the canonical ICU identity metadata");
  }
  const dataTreeSha256 = checkedDigest(data.dataTreeSha256, "WASIX ICU data tree identity");
  if (closure["icu-data-tree-sha256"] !== dataTreeSha256) {
    fail("WASIX portable runtime manifest and ICU cluster-seed manifest disagree on the ICU data tree identity");
  }
  return Object.freeze({
    dataVersion: data.dataVersion,
    dataForm: data.dataForm,
    dataTreeSha256,
  });
}

export function assertCrossFamilyIcuDataIdentity(nativeIdentity, wasixIdentity) {
  for (const field of ["dataVersion", "dataForm", "dataTreeSha256"]) {
    if (nativeIdentity[field] !== wasixIdentity[field]) {
      fail(
        `native and WASIX ICU ${field} differ: `
        + `${JSON.stringify(nativeIdentity[field])} != ${JSON.stringify(wasixIdentity[field])}`,
      );
    }
  }
  return nativeIdentity;
}

export function checkCrossFamilyIcuData(nativeReleaseAssets, wasixReleaseAssets) {
  const nativeArchive = onlyAsset(
    path.resolve(nativeReleaseAssets),
    /^liboliphaunt-[0-9][0-9A-Za-z.+-]*-icu-data[.]tar[.]gz$/u,
    "native",
  );
  const wasixArchive = onlyAsset(
    path.resolve(wasixReleaseAssets),
    /^liboliphaunt-wasix-[0-9][0-9A-Za-z.+-]*-runtime-portable[.]tar[.]zst$/u,
    "WASIX",
  );
  const nativeEntries = readPortableArchiveEntries(nativeArchive);
  const nativeIdentity = parseNativeIcuDataIdentity(
    requiredEntry(nativeEntries, "manifest.properties", "native ICU data release"),
    "native ICU data release manifest",
  );
  return assertCrossFamilyIcuDataIdentity(nativeIdentity, wasixIcuDataIdentity(wasixArchive));
}

if (import.meta.main) {
  const [nativeReleaseAssets, wasixReleaseAssets] = process.argv.slice(2);
  if (!nativeReleaseAssets || !wasixReleaseAssets || process.argv.length !== 4) {
    fail(`usage: ${TOOL} NATIVE_RELEASE_ASSET_DIR WASIX_RELEASE_ASSET_DIR`);
  }
  const identity = checkCrossFamilyIcuData(nativeReleaseAssets, wasixReleaseAssets);
  process.stdout.write(
    `ICU data identity matches across native and WASIX: ${identity.dataVersion}/${identity.dataForm}/${identity.dataTreeSha256}\n`,
  );
}
