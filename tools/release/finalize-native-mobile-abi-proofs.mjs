#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
  parseNativeMobileAbiReceipt,
} from "./native-mobile-abi-contract.mjs";
import { readPortableArchiveEntries } from "./portable-archive.mjs";

function fail(message) {
  throw new Error(`finalize-native-mobile-abi-proofs.mjs: ${message}`);
}

function receiptFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const metadata = lstatSync(file);
      if (metadata.isSymbolicLink()) fail(`receipt input contains a symbolic link: ${file}`);
      if (metadata.isDirectory()) visit(file);
      else if (metadata.isFile() && /^native-mobile-abi(?:-producer)?\.properties$/u.test(name)) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function loadDomainReceipts(domain, root) {
  const required = NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[domain];
  if (required === undefined) fail(`unsupported compatibility domain ${domain}`);
  const byTarget = new Map();
  for (const file of receiptFiles(root)) {
    const text = readFileSync(file, "utf8");
    const target = parseNativeMobileAbiReceipt(text, file).get("target");
    if (!required.includes(target)) continue;
    const existing = byTarget.get(target);
    if (existing !== undefined && existing.text !== text) {
      fail(`${domain} has divergent duplicate receipts for ${target}: ${existing.file}, ${file}`);
    }
    if (existing === undefined) byTarget.set(target, { file, text });
  }
  const missing = required.filter((target) => !byTarget.has(target));
  if (missing.length > 0) fail(`${domain} is missing receipts for ${missing.join(", ")}`);
  const receipts = required.map((target) => ({
    label: byTarget.get(target).file,
    text: byTarget.get(target).text,
  }));
  compareNativeMobileAbiReceipts(domain, receipts);
  return new Map(required.map((target) => [target, byTarget.get(target).text]));
}

function materializeArchive(archive, destination) {
  for (const [rawName, entry] of readPortableArchiveEntries(archive)) {
    const name = rawName.replace(/\/$/u, "");
    if (name === "." || name.length === 0) continue;
    const output = path.join(destination, ...name.split("/"));
    if (entry.isDirectory) {
      mkdirSync(output, { recursive: true });
      continue;
    }
    if (!entry.isFile || entry.isSymbolicLink) {
      fail(`${archive} contains unsupported member ${rawName}`);
    }
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, entry.data());
    chmodSync(output, (entry.mode ?? 0o644) & 0o777);
  }
}

function finalizeArchive(archive, receipts) {
  const work = mkdtempSync(path.join(tmpdir(), "oliphaunt-mobile-abi-proof-"));
  const staging = path.join(work, "carrier");
  const output = `${archive}.tmp-${process.pid}.tar.gz`;
  try {
    mkdirSync(staging);
    materializeArchive(archive, staging);
    const proof = path.join(staging, "oliphaunt/provenance/native-mobile-abi");
    rmSync(proof, { recursive: true, force: true });
    mkdirSync(proof, { recursive: true });
    for (const [target, text] of receipts) {
      writeFileSync(path.join(proof, `${target}.properties`), text);
    }
    const archiveScript = path.resolve(import.meta.dirname, "archive_dir.mjs");
    const result = spawnSync(process.execPath, [archiveScript, staging, output], {
      stdio: "inherit",
    });
    if (result.status !== 0) fail(`failed to rebuild ${archive}`);
    renameSync(output, archive);
  } finally {
    rmSync(output, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

export function finalizeNativeMobileAbiProofs({ domain, assetDir, receiptRoot }) {
  const receipts = loadDomainReceipts(domain, receiptRoot);
  const suffix = `-runtime-resources-${domain}.tar.gz`;
  const archives = readdirSync(assetDir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => path.join(assetDir, name));
  if (archives.length !== 1) {
    fail(`${assetDir} must contain exactly one *${suffix}; found ${archives.length}`);
  }
  finalizeArchive(archives[0], receipts);
  return { archive: archives[0], targets: [...receipts.keys()] };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      fail("usage: --domain DOMAIN --asset-dir DIR --receipt-root DIR");
    }
    values.set(key, value);
  }
  if (
    values.size !== 3
    || !values.has("--domain")
    || !values.has("--asset-dir")
    || !values.has("--receipt-root")
  ) {
    fail("usage: --domain DOMAIN --asset-dir DIR --receipt-root DIR");
  }
  return {
    domain: values.get("--domain"),
    assetDir: path.resolve(values.get("--asset-dir")),
    receiptRoot: path.resolve(values.get("--receipt-root")),
  };
}

if (import.meta.main) {
  try {
    const result = finalizeNativeMobileAbiProofs(parseArgs(process.argv.slice(2)));
    console.log(`nativeMobileAbiProofArchive=${result.archive}`);
    console.log(`nativeMobileAbiProofTargets=${result.targets.join(",")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
