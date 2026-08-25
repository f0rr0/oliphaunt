#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCHEMA = "oliphaunt-native-mobile-abi-v1";
export const NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN = Object.freeze({
  "android-datum64": Object.freeze([
    "android-arm64-v8a",
    "android-x86_64",
    "linux-x64-gnu",
  ]),
  "ios-datum64": Object.freeze([
    "ios-arm64",
    "ios-arm64-simulator",
    "macos-arm64",
  ]),
});
export const NATIVE_MOBILE_ABI_RECEIPT_KEYS = Object.freeze([
  "schema",
  "target",
  "byteOrder",
  "datumBytes",
  "maximumAlignof",
  "float8ByVal",
  "blockSize",
  "walBlockSize",
  "relationSegmentSize",
  "nameDataLength",
  "indexMaxKeys",
  "catalogVersion",
  "pgControlVersion",
]);

function fail(message) {
  throw new Error(`native-mobile-abi-contract.mjs: ${message}`);
}

function parseProperties(text, label) {
  const values = new Map();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail(`${label}:${index + 1} is not key=value`);
    const key = line.slice(0, separator);
    if (values.has(key)) fail(`${label}:${index + 1} repeats ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

function defineValue(text, name, label) {
  const match = text.match(new RegExp(`^\\s*#define\\s+${name}\\s+([^\\s/]+)`, "mu"));
  if (match === null) fail(`${label} does not define ${name}`);
  return match[1].replace(/^\((.*)\)$/u, "$1");
}

function integerDefine(text, name, label) {
  const raw = defineValue(text, name, label).replace(/[uUlL]+$/u, "");
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/u.test(raw)) {
    fail(`${label} has invalid ${name}=${raw}`);
  }
  const value = Number.parseInt(raw, /^0[xX]/u.test(raw) ? 16 : 10);
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} has invalid ${name}=${raw}`);
  return String(value);
}

function header(buildRoot, relative) {
  const file = path.join(buildRoot, ...relative.split("/"));
  try {
    return { file, text: readFileSync(file, "utf8") };
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function nativeMobileAbiReceipt(buildRoot, target) {
  const pgConfig = header(buildRoot, "src/include/pg_config.h");
  const pgConfigManual = header(buildRoot, "src/include/pg_config_manual.h");
  const catversion = header(buildRoot, "src/include/catalog/catversion.h");
  const pgControl = header(buildRoot, "src/include/catalog/pg_control.h");
  const datumBytes = integerDefine(pgConfig.text, "SIZEOF_VOID_P", pgConfig.file);
  if (datumBytes !== "8") fail(`${target} is not a Datum64 target`);
  const maximumAlignof = integerDefine(pgConfig.text, "MAXIMUM_ALIGNOF", pgConfig.file);
  const byteOrder = /^\s*#define\s+WORDS_BIGENDIAN\s+1\b/mu.test(pgConfig.text)
    ? "big"
    : "little";
  const float8ByVal = /^\s*#define\s+USE_FLOAT8_BYVAL(?:\s+1)?\s*$/mu.test(pgConfigManual.text)
    ? "1"
    : "0";
  const values = new Map([
    ["schema", SCHEMA],
    ["target", target],
    ["byteOrder", byteOrder],
    ["datumBytes", datumBytes],
    ["maximumAlignof", maximumAlignof],
    ["float8ByVal", float8ByVal],
    ["blockSize", integerDefine(pgConfig.text, "BLCKSZ", pgConfig.file)],
    ["walBlockSize", integerDefine(pgConfig.text, "XLOG_BLCKSZ", pgConfig.file)],
    ["relationSegmentSize", integerDefine(pgConfig.text, "RELSEG_SIZE", pgConfig.file)],
    ["nameDataLength", integerDefine(pgConfigManual.text, "NAMEDATALEN", pgConfigManual.file)],
    ["indexMaxKeys", integerDefine(pgConfigManual.text, "INDEX_MAX_KEYS", pgConfigManual.file)],
    ["catalogVersion", integerDefine(catversion.text, "CATALOG_VERSION_NO", catversion.file)],
    ["pgControlVersion", integerDefine(pgControl.text, "PG_CONTROL_VERSION", pgControl.file)],
  ]);
  return `${NATIVE_MOBILE_ABI_RECEIPT_KEYS.map((key) => `${key}=${values.get(key)}`).join("\n")}\n`;
}

export function parseNativeMobileAbiReceipt(text, label = "native mobile ABI receipt") {
  const values = parseProperties(text, label);
  if (
    values.size !== NATIVE_MOBILE_ABI_RECEIPT_KEYS.length
    || NATIVE_MOBILE_ABI_RECEIPT_KEYS.some((key) => !values.has(key))
  ) {
    fail(`${label} fields must be exactly ${NATIVE_MOBILE_ABI_RECEIPT_KEYS.join(",")}`);
  }
  if (values.get("schema") !== SCHEMA) fail(`${label} has unsupported schema`);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(values.get("target"))) {
    fail(`${label} has invalid target`);
  }
  if (!new Set(["little", "big"]).has(values.get("byteOrder"))) {
    fail(`${label} has invalid byteOrder`);
  }
  for (const key of [
    "datumBytes",
    "maximumAlignof",
    "blockSize",
    "walBlockSize",
    "relationSegmentSize",
    "nameDataLength",
    "indexMaxKeys",
    "catalogVersion",
    "pgControlVersion",
  ]) {
    if (!/^[1-9][0-9]*$/u.test(values.get(key))) fail(`${label} has invalid ${key}`);
  }
  if (!new Set(["0", "1"]).has(values.get("float8ByVal"))) {
    fail(`${label} has invalid float8ByVal`);
  }
  if (values.get("datumBytes") !== "8") fail(`${label} is not a Datum64 receipt`);
  return values;
}

export function compareNativeMobileAbiReceipts(domain, receipts) {
  const expectedTargets = NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[domain];
  if (expectedTargets === undefined) fail(`unsupported compatibility domain ${domain}`);
  if (receipts.length !== expectedTargets.length) {
    fail(`${domain} requires receipts for ${expectedTargets.join(", ")}`);
  }
  const rows = receipts.map(({ text, label }) => ({
    values: parseNativeMobileAbiReceipt(text, label),
    label,
  }));
  const actualTargets = rows.map(({ values }) => values.get("target")).sort();
  if (JSON.stringify(actualTargets) !== JSON.stringify([...expectedTargets].sort())) {
    fail(`${domain} receipts must target exactly ${expectedTargets.join(", ")}`);
  }
  const baseline = rows[0];
  for (const row of rows.slice(1)) {
    for (const key of NATIVE_MOBILE_ABI_RECEIPT_KEYS) {
      if (key === "target") continue;
      if (row.values.get(key) !== baseline.values.get(key)) {
        fail(`${domain} ABI mismatch for ${key}: ${baseline.label}=${baseline.values.get(key)}, ${row.label}=${row.values.get(key)}`);
      }
    }
  }
  return Object.freeze({ domain, targets: Object.freeze([...expectedTargets]) });
}

function parseArgs(argv) {
  const command = argv[0];
  if (command === "write" && argv.length === 7 && argv[1] === "--build-root" && argv[3] === "--target" && argv[5] === "--output") {
    return { command, buildRoot: path.resolve(argv[2]), target: argv[4], output: path.resolve(argv[6]) };
  }
  if (command === "compare" && argv.length >= 6 && argv[1] === "--domain" && argv[3] === "--receipt") {
    const receiptFiles = [];
    for (let index = 3; index < argv.length; index += 2) {
      if (argv[index] !== "--receipt" || argv[index + 1] === undefined) fail("compare accepts repeated --receipt FILE");
      receiptFiles.push(path.resolve(argv[index + 1]));
    }
    return { command, domain: argv[2], receiptFiles };
  }
  fail("usage: write --build-root DIR --target TARGET --output FILE | compare --domain DOMAIN --receipt FILE --receipt FILE");
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "write") {
      writeFileSync(args.output, nativeMobileAbiReceipt(args.buildRoot, args.target));
      console.log(`nativeMobileAbiReceipt=${args.output}`);
    } else {
      const receipts = args.receiptFiles.map((file) => ({ text: readFileSync(file, "utf8"), label: file }));
      const result = compareNativeMobileAbiReceipts(args.domain, receipts);
      console.log(`nativeMobileAbiDomain=${result.domain}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
