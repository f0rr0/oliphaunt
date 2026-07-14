#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadPublicationLock, lockedCarriers } from "../../tools/release/publication-lock.mjs";

const ROOT = path.resolve(import.meta.dir, "../..");

function fail(message) {
  throw new Error(`registry-bootstrap-ledger-state: ${message}`);
}

function run(command, args, { check = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || (check && result.status !== 0)) {
    fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`);
  }
  return { status: result.status, stdout: result.stdout.trim() };
}

function parseProducts(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    fail(`PRODUCTS_JSON is invalid: ${cause.message}`);
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("PRODUCTS_JSON must be a non-empty product string list");
  }
  return [...new Set(value)].sort();
}

export function classifyLedgerRequirement(rows) {
  const requiring = rows
    .filter((row) => row.published > 0 && row.tagState === "missing")
    .map(({ product, ecosystem, published }) => ({ product, ecosystem, published }))
    .sort((left, right) => `${left.product}:${left.ecosystem}`.localeCompare(`${right.product}:${right.ecosystem}`));
  const conflicting = rows.filter((row) => row.tagState === "wrong");
  if (conflicting.length > 0) {
    fail(`current product tag points at another commit: ${conflicting.map(({ product }) => product).join(", ")}`);
  }
  return { needsLedger: requiring.length > 0, requiring };
}

function query(lockFile, product, ecosystem) {
  const registryKind = ecosystem === "cargo" ? "crates" : "npm";
  const result = run("tools/dev/bun.sh", [
    "tools/release/check_registry_publication.mjs",
    "query-product-publication",
    "--product", product,
    "--registry-kind", registryKind,
    "--publication-lock", lockFile,
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    fail(`registry query returned invalid JSON for ${product}/${ecosystem}: ${cause.message}`);
  }
}

function tagState(product, version, headCommit) {
  const result = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${product}-v${version}^{commit}`], { check: false });
  if (result.status !== 0) return "missing";
  return result.stdout === headCommit ? "exact" : "wrong";
}

function main() {
  const lockFile = path.resolve(ROOT, process.env.PUBLICATION_LOCK_PATH || "target/release/publication-lock.json");
  const products = parseProducts(process.env.PRODUCTS_JSON || "");
  const headCommit = run("git", ["rev-parse", `${process.env.RELEASE_HEAD_SHA || "HEAD"}^{commit}`]).stdout;
  const lock = loadPublicationLock(lockFile);
  if (lock.source.commit !== headCommit) {
    fail(`publication lock source ${lock.source.commit} does not match ${headCommit}`);
  }
  const rows = [];
  for (const product of products) {
    const productRow = lock.products.find((entry) => entry.id === product);
    if (productRow === undefined) fail(`publication lock omits selected product ${product}`);
    for (const ecosystem of ["cargo", "npm"]) {
      const carriers = lockedCarriers(lock, { product, ecosystem });
      if (carriers.length === 0) continue;
      const result = query(lockFile, product, ecosystem);
      rows.push({
        product,
        ecosystem,
        published: result.published?.length ?? 0,
        missing: result.missing?.length ?? 0,
        tagState: tagState(product, productRow.version, headCommit),
      });
    }
  }
  const state = classifyLedgerRequirement(rows);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `needs_ledger=${String(state.needsLedger)}\n`);
    appendFileSync(output, `state_json=${JSON.stringify(rows)}\n`);
  }
  console.log(JSON.stringify({ ...state, rows }, null, 2));
}

if (import.meta.main) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
