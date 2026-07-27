#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import process from "node:process";

function fail(message) {
  console.error(message);
  process.exit(1);
}

let matrix;
try {
  matrix = JSON.parse(process.env.MOON_TARGET_MATRIX_JSON ?? "");
} catch (error) {
  fail(`MOON_TARGET_MATRIX_JSON is invalid JSON: ${error.message}`);
}

if (!matrix || !Array.isArray(matrix.include)) {
  fail("MOON_TARGET_MATRIX_JSON must contain an include array");
}

const groups = new Map();
for (const row of matrix.include) {
  if (!row || typeof row.target !== "string" || !/^[A-Za-z0-9_:@./-]+$/u.test(row.target)) {
    fail(`invalid Moon target matrix row: ${JSON.stringify(row)}`);
  }
  const upstream = row.upstream ?? "deep";
  if (!["none", "deep"].includes(upstream)) {
    fail(`unsupported Moon upstream mode ${upstream} for ${row.target}`);
  }
  const targets = groups.get(upstream) ?? new Set();
  targets.add(row.target);
  groups.set(upstream, targets);
}

if (groups.size === 0) {
  fail("Moon target matrix must not be empty");
}

for (const [upstream, targets] of groups) {
  const ordered = [...targets].sort();
  console.log(`running ${ordered.length} Moon targets with --upstream ${upstream}`);
  const result = spawnSync(
    ".github/scripts/run-moon-targets.sh",
    ["--upstream", upstream, ...ordered],
    { stdio: "inherit", env: process.env },
  );
  if (result.error || result.status !== 0) {
    fail(result.error?.message || `Moon target group failed with status ${result.status}`);
  }
}
