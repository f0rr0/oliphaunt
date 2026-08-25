#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  filesystemTreeRows,
  logicalTreeSha256,
  parseProperties,
} from "./native-cluster-seed-contract.mjs";

export const NATIVE_ICU_DATA_SCHEMA = "oliphaunt-icu-data-v1";
export const ICU_DATA_VERSION = "76.1";
export const ICU_DATA_FORM = "files-le";

const LOWER_SHA256 = /^[0-9a-f]{64}$/u;

export function parseNativeIcuDataIdentity(bytes, label = "native ICU data manifest") {
  const actual = parseProperties(bytes, label);
  const expected = new Map([
    ["schema", NATIVE_ICU_DATA_SCHEMA],
    ["artifactRole", "icu-data"],
    ["icuDataVersion", ICU_DATA_VERSION],
    ["icuDataForm", ICU_DATA_FORM],
  ]);
  if (actual.size !== expected.size + 1) throw new Error(`${label}: unexpected fields`);
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) {
      throw new Error(`${label}: ${key} must be ${JSON.stringify(value)}, got ${JSON.stringify(actual.get(key))}`);
    }
  }
  const dataTreeSha256 = actual.get("icuDataTreeSha256");
  if (!LOWER_SHA256.test(dataTreeSha256 ?? "")) {
    throw new Error(`${label}: icuDataTreeSha256 must be a lowercase SHA-256 digest`);
  }
  return Object.freeze({
    dataVersion: ICU_DATA_VERSION,
    dataForm: ICU_DATA_FORM,
    dataTreeSha256,
  });
}

export function nativeIcuDataManifestFromRows(rows) {
  const entries = [...rows];
  if (entries.length === 0) throw new Error("native ICU data tree is empty");
  const digest = logicalTreeSha256(entries);
  return Buffer.from([
    `schema=${NATIVE_ICU_DATA_SCHEMA}`,
    "artifactRole=icu-data",
    `icuDataVersion=${ICU_DATA_VERSION}`,
    `icuDataForm=${ICU_DATA_FORM}`,
    `icuDataTreeSha256=${digest}`,
    "",
  ].join("\n"));
}

export function nativeIcuDataManifest(icuData) {
  return nativeIcuDataManifestFromRows(filesystemTreeRows(icuData));
}

export function validateNativeIcuDataManifestRows(bytes, rows, label = "native ICU data manifest") {
  const identity = parseNativeIcuDataIdentity(bytes, label);
  const expected = logicalTreeSha256([...rows]);
  if (identity.dataTreeSha256 !== expected) {
    throw new Error(
      `${label}: icuDataTreeSha256 must be ${JSON.stringify(expected)}, got ${JSON.stringify(identity.dataTreeSha256)}`,
    );
  }
  return Object.freeze({ icuDataTreeSha256: identity.dataTreeSha256 });
}

export function validateNativeIcuDataManifest(bytes, icuData, label = "native ICU data manifest") {
  return validateNativeIcuDataManifestRows(bytes, filesystemTreeRows(icuData), label);
}

if (import.meta.main) {
  const [icuData, output] = process.argv.slice(2);
  if (!icuData || !output || process.argv.length !== 4) {
    throw new Error("usage: native-icu-data-contract.mjs ICU_DATA_DIR OUTPUT");
  }
  const manifest = nativeIcuDataManifest(path.resolve(icuData));
  writeFileSync(path.resolve(output), manifest);
  validateNativeIcuDataManifest(readFileSync(path.resolve(output)), path.resolve(icuData), output);
}
