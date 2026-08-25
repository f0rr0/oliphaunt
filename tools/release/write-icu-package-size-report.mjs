#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import path from "node:path";

import { filesystemTreeRows } from "./native-cluster-seed-contract.mjs";

function treeBytes(root) {
  return filesystemTreeRows(root).reduce((total, row) => total + row.bytes.length, 0);
}

export function icuPackageSizeReport(icuData) {
  const icuDataBytes = treeBytes(icuData);
  return [
    "kind\tid\textensions\tfiles\tbytes",
    `package\ttotal\t-\t-\t${icuDataBytes}`,
    `package\ticu-data\t-\t-\t${icuDataBytes}`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const [icuData, output] = process.argv.slice(2);
  if (!icuData || !output) {
    throw new Error("usage: write-icu-package-size-report.mjs ICU_DATA_DIR OUTPUT");
  }
  writeFileSync(path.resolve(output), icuPackageSizeReport(path.resolve(icuData)));
}
