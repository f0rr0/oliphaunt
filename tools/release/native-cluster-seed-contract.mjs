#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT = JSON.parse(readFileSync(
  new URL("../../src/shared/cluster-seed-contract/contract.json", import.meta.url),
  "utf8",
));
const SHA256 = /^[0-9a-f]{64}$/u;

export function parseProperties(bytes, label) {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new Error(`${label} is not canonical UTF-8`);
  }
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${label}:${index + 1} is not key=value`);
    const key = line.slice(0, separator);
    if (values.has(key)) throw new Error(`${label}:${index + 1} repeats ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

export function validateNativeClusterSeedManifest(bytes, profile, options = {}) {
  const label = options.label ?? `${profile} native cluster seed manifest`;
  const profileContract = CONTRACT.profiles[profile];
  if (profileContract === undefined) throw new Error(`${label}: unsupported profile ${profile}`);
  const values = parseProperties(bytes, label);
  const expected = new Map([
    ["schema", "oliphaunt-runtime-resources-v1"],
    ["layout", "oliphaunt-cluster-seed-v1"],
    ["artifactRole", profileContract.artifactRole],
    ["catalogProfile", profile],
    ["postgresMajor", "18"],
    ["physicalFormat", CONTRACT.physicalFormats.native],
    ["compatibilityKey", CONTRACT.compatibilityKeys.nativeDatum64],
    ["initialSuperuser", "postgres"],
    ["runtimeFeatures", profileContract.requiredRuntimeFeatures.join(",")],
    ["icuDataVersion", profile === "icu" ? CONTRACT.icu.dataVersion : ""],
    ["icuDataForm", profile === "icu" ? CONTRACT.icu.dataForm : ""],
    ["icuDataTreeSha256", profile === "icu" ? options.icuDataTreeSha256 : ""],
  ]);
  if (profile === "icu" && !SHA256.test(options.icuDataTreeSha256 ?? "")) {
    throw new Error(`${label}: requires the exact lowercase ICU data tree SHA-256`);
  }
  for (const [key, value] of expected) {
    if (values.get(key) !== value) {
      throw new Error(`${label}: ${key} must be ${JSON.stringify(value)}, got ${JSON.stringify(values.get(key))}`);
    }
  }
  return values;
}

export function logicalTreeSha256(rows) {
  const normalized = [...rows].map(({ path: relative, bytes }) => {
    if (typeof relative !== "string" || relative.length === 0 || relative.includes("\0")) {
      throw new Error(`logical tree contains an invalid path: ${JSON.stringify(relative)}`);
    }
    return { path: relative.replaceAll("\\", "/"), bytes: Buffer.from(bytes) };
  });
  normalized.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const digest = createHash("sha256");
  for (const row of normalized) {
    digest.update(row.path);
    digest.update(Buffer.of(0));
    digest.update(String(row.bytes.length));
    digest.update(Buffer.of(0));
    digest.update(row.bytes);
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function filesystemTreeRows(root) {
  const absoluteRoot = path.resolve(root);
  const rows = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const metadata = lstatSync(file);
      if (metadata.isSymbolicLink()) throw new Error(`logical tree contains a symlink: ${file}`);
      if (metadata.isDirectory()) visit(file);
      else if (metadata.isFile()) {
        rows.push({
          path: path.relative(absoluteRoot, file).split(path.sep).join("/"),
          bytes: readFileSync(file),
        });
      } else {
        throw new Error(`logical tree contains a special file: ${file}`);
      }
    }
  };
  visit(absoluteRoot);
  return rows;
}

export function validateNativeClusterSeedDirectory(seed, profile, options = {}) {
  for (const relative of ["files/PG_VERSION", "files/global/pg_control", "manifest.properties"]) {
    const file = path.join(seed, ...relative.split("/"));
    if (!lstatSync(file).isFile()) throw new Error(`${seed} is missing ${relative}`);
  }
  const icuDataTreeSha256 = options.icuData === undefined
    ? undefined
    : logicalTreeSha256(filesystemTreeRows(options.icuData));
  validateNativeClusterSeedManifest(readFileSync(path.join(seed, "manifest.properties")), profile, {
    icuDataTreeSha256,
    label: path.join(seed, "manifest.properties"),
  });
  return { icuDataTreeSha256 };
}

function main(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: native-cluster-seed-contract.mjs --profile standard|icu --seed DIR [--icu-data DIR]");
    }
    values.set(key.slice(2), value);
  }
  const profile = values.get("profile");
  const seed = values.get("seed");
  if (!(profile === "standard" || profile === "icu") || seed === undefined) {
    throw new Error("usage: native-cluster-seed-contract.mjs --profile standard|icu --seed DIR [--icu-data DIR]");
  }
  const icuData = values.get("icu-data");
  const { icuDataTreeSha256 } = validateNativeClusterSeedDirectory(seed, profile, { icuData });
  process.stdout.write(`profile=${profile}\nicuDataTreeSha256=${icuDataTreeSha256 ?? ""}\n`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`native-cluster-seed-contract.mjs: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
