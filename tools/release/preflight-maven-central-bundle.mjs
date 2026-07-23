#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createGpgSigner,
  prepareFrozenMavenBundle,
} from "./frozen-maven-publish.mjs";
import {
  assertPublicationLockSource,
  loadPublicationLock,
  lockedCarriers,
} from "./publication-lock.mjs";

function error(message) {
  return new Error(`preflight-maven-central-bundle: ${message}`);
}
function requiredValue(value, context) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw error(`${context} is required`);
  }
  return value.trim();
}

export function parseMavenBundlePreflightArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--publication-lock", "--products-json", "--release-commit"].includes(flag)) {
      throw error(`unknown argument ${flag}`);
    }
    if (values.has(flag)) throw error(`${flag} may be supplied only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const publicationLock = requiredValue(values.get("--publication-lock"), "--publication-lock");
  const releaseCommit = requiredValue(values.get("--release-commit"), "--release-commit");
  if (!/^[0-9a-f]{40}$/iu.test(releaseCommit)) {
    throw error("--release-commit must be a full 40-character Git SHA");
  }
  let products;
  try {
    products = JSON.parse(requiredValue(values.get("--products-json"), "--products-json"));
  } catch (cause) {
    throw error(`--products-json must be valid JSON: ${cause.message}`);
  }
  if (!Array.isArray(products) || products.length === 0 || products.some((product) => typeof product !== "string" || product.length === 0)) {
    throw error("--products-json must be a nonempty JSON array of product IDs");
  }
  if (new Set(products).size !== products.length) {
    throw error("--products-json must not contain duplicate product IDs");
  }
  return { products, publicationLock: path.resolve(publicationLock), releaseCommit: releaseCommit.toLowerCase() };
}

export function preflightMavenCentralBundle({ lock, products, releaseCommit, outputRoot, signFile }) {
  assertPublicationLockSource(lock, releaseCommit);
  const carriers = lockedCarriers(lock, { products, ecosystem: "maven" });
  if (carriers.length === 0) {
    throw error(`selected products contain no frozen Maven carriers: ${products.join(",")}`);
  }
  return prepareFrozenMavenBundle({ lock, products, outputRoot, signFile });
}

function env(name) {
  return requiredValue(process.env[name], name);
}

if (import.meta.main) {
  let temporaryRoot;
  try {
    const args = parseMavenBundlePreflightArgs(process.argv.slice(2));
    const lock = loadPublicationLock(args.publicationLock);
    const base = process.env.RUNNER_TEMP?.trim() || tmpdir();
    temporaryRoot = mkdtempSync(path.join(base, "oliphaunt-maven-bundle-preflight-"));
    const signFile = createGpgSigner({
      privateKey: env("ORG_GRADLE_PROJECT_signingInMemoryKey"),
      keyId: env("ORG_GRADLE_PROJECT_signingInMemoryKeyId"),
      passphrase: env("ORG_GRADLE_PROJECT_signingInMemoryKeyPassword"),
      home: path.join(temporaryRoot, "gpg"),
    });
    const result = preflightMavenCentralBundle({
      lock,
      products: args.products,
      releaseCommit: args.releaseCommit,
      outputRoot: path.join(temporaryRoot, "bundle"),
      signFile,
    });
    console.log(`preflighted ${result.carriers.length} exact Maven carriers in a ${result.bundleSize}-byte Central bundle before release mutation`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  } finally {
    if (temporaryRoot !== undefined) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
