import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareNativeMobileAbiReceipts,
  nativeMobileAbiReceipt,
  parseNativeMobileAbiReceipt,
} from "./native-mobile-abi-contract.mjs";

function fixture(target, overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-mobile-abi-"));
  const include = path.join(root, "src/include");
  mkdirSync(path.join(include, "catalog"), { recursive: true });
  writeFileSync(path.join(include, "pg_config.h"), [
    `#define SIZEOF_VOID_P ${overrides.pointerBytes ?? 8}`,
    `#define MAXIMUM_ALIGNOF ${overrides.alignment ?? 8}`,
    "#define BLCKSZ 8192",
    "#define XLOG_BLCKSZ 8192",
    "#define RELSEG_SIZE 131072",
    overrides.bigEndian ? "#define WORDS_BIGENDIAN 1" : "/* #undef WORDS_BIGENDIAN */",
    "",
  ].join("\n"));
  writeFileSync(path.join(include, "pg_config_manual.h"), [
    "#define USE_FLOAT8_BYVAL 1",
    `#define NAMEDATALEN ${overrides.nameDataLength ?? 64}`,
    "#define INDEX_MAX_KEYS 32",
    "",
  ].join("\n"));
  writeFileSync(path.join(include, "catalog/catversion.h"), "#define CATALOG_VERSION_NO 202506291\n");
  writeFileSync(path.join(include, "catalog/pg_control.h"), "#define PG_CONTROL_VERSION 1800\n");
  return { text: nativeMobileAbiReceipt(root, target), label: target };
}

test("qualifies matching Android Datum64 ABI receipts", () => {
  expect(compareNativeMobileAbiReceipts("android-datum64", [
    fixture("android-arm64-v8a"),
    fixture("android-x86_64"),
    fixture("linux-x64-gnu"),
  ]).domain).toBe("android-datum64");
});

test("rejects ABI differences and incorrect domain membership", () => {
  expect(() => compareNativeMobileAbiReceipts("ios-datum64", [
    fixture("ios-arm64"),
    fixture("ios-arm64-simulator", { alignment: 16 }),
    fixture("macos-arm64"),
  ])).toThrow(/ABI mismatch for maximumAlignof/u);
  expect(() => compareNativeMobileAbiReceipts("android-datum64", [
    fixture("android-arm64-v8a"),
    fixture("ios-arm64"),
    fixture("linux-x64-gnu"),
  ])).toThrow(/target exactly/u);
  expect(() => compareNativeMobileAbiReceipts("android-datum64", [
    fixture("android-arm64-v8a"),
    fixture("android-x86_64", { nameDataLength: 128 }),
    fixture("linux-x64-gnu"),
  ])).toThrow(/ABI mismatch for nameDataLength/u);
});

test("rejects non-Datum64 producer headers", () => {
  expect(() => fixture("android-x86_64", { pointerBytes: 4 })).toThrow(/not a Datum64/u);
  expect(() => fixture("android-x86_64", { pointerBytes: "8garbage" })).toThrow(
    /invalid SIZEOF_VOID_P/u,
  );
});

test("rejects malformed or internally inconsistent receipts", () => {
  const valid = fixture("android-x86_64").text;
  expect(() => parseNativeMobileAbiReceipt(
    valid.replace("byteOrder=little", "byteOrder=sideways"),
  )).toThrow(/invalid byteOrder/u);
  expect(() => parseNativeMobileAbiReceipt(
    valid.replace("datumBytes=8", "datumBytes=4"),
  )).toThrow(/not a Datum64 receipt/u);
});
