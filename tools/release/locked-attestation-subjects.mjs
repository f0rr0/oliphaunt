#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
  lockedProductArtifactPaths,
} from "./publication-lock.mjs";
import { ROOT, compareText } from "./release-graph.mjs";

const ATTESTED_ROLES = Object.freeze([
  "github-release-asset",
  "github-release-metadata",
]);
export const EXTENSION_ATTESTATION_SHARD_COUNT = 2;
export const MAX_ATTESTATION_SUBJECTS_PER_BUNDLE = 1_024;

function error(message) {
  return new Error(`locked-attestation-subjects: ${message}`);
}

function selectedProducts(value) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((product) => typeof product !== "string" || product.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw error("products must be a non-empty unique string list");
  }
  return value;
}

/**
 * Resolve the exact local subject set frozen for the selected products.
 *
 * `lockedProductArtifactPaths` re-hashes every returned path. This makes the
 * action input both selection-exact and byte-exact: downloading a broad CI
 * artifact cannot accidentally add another independently-versioned product to
 * the attestation bundle.
 */
export function lockedAttestationSubjects(lock, products) {
  const selected = selectedProducts(products);
  if (!Array.isArray(lock?.products) || !Array.isArray(lock?.productArtifacts)) {
    throw error("publication lock must contain products and productArtifacts lists");
  }
  const lockedProducts = new Set(lock.products.map(({ id }) => id));
  const unknown = selected.filter((product) => !lockedProducts.has(product));
  if (unknown.length > 0) {
    throw error(`selected products are absent from the publication lock: ${unknown.join(", ")}`);
  }

  const subjects = [];
  for (const product of selected) {
    const productSubjects = ATTESTED_ROLES.flatMap((role) =>
      lockedProductArtifactPaths(lock, product, { role }));
    if (productSubjects.length === 0) {
      throw error(`${product} has no frozen GitHub release asset or metadata subjects`);
    }
    for (const subject of productSubjects) {
      if (subject.type !== "file") {
        throw error(`${product}:${subject.artifact.id} attestation subject must be a regular file`);
      }
      const relative = path.relative(ROOT, subject.path);
      if (
        relative === ""
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || /[\r\n\u0000]/u.test(relative)
      ) {
        throw error(`${product}:${subject.artifact.id} has an unsafe action subject path`);
      }
      subjects.push(relative.split(path.sep).join("/"));
    }
  }

  subjects.sort(compareText);
  if (new Set(subjects).size !== subjects.length) {
    throw error("selected products reuse a GitHub release attestation subject path");
  }
  const folded = subjects.map((subject) => subject.toLocaleLowerCase("en-US"));
  if (new Set(folded).size !== folded.length) {
    throw error("selected GitHub release attestation subject paths collide by case");
  }
  return subjects;
}

/**
 * Partition the exact subject union into stable, count-balanced action inputs.
 *
 * GitHub's attestation action accepts at most 1,024 subjects per invocation.
 * Round-robin assignment over the sorted exact-lock paths keeps the two bundle
 * sizes within one subject of each other without weakening selection or byte
 * verification. Empty trailing shards are intentional for very small partial
 * releases and are exposed to the workflow through explicit nonempty flags.
 */
export function lockedAttestationSubjectShards(lock, products, {
  maxSubjectsPerShard = MAX_ATTESTATION_SUBJECTS_PER_BUNDLE,
  shardCount = EXTENSION_ATTESTATION_SHARD_COUNT,
} = {}) {
  if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
    throw error("attestation shard count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxSubjectsPerShard) || maxSubjectsPerShard <= 0) {
    throw error("maximum subjects per attestation shard must be a positive safe integer");
  }
  const capacity = shardCount * maxSubjectsPerShard;
  if (!Number.isSafeInteger(capacity)) {
    throw error("attestation shard capacity exceeds the safe integer range");
  }

  const subjects = lockedAttestationSubjects(lock, products);
  if (subjects.length > capacity) {
    throw error(
      `${subjects.length} selected subjects exceed ${shardCount} attestation shards `
      + `at the ${maxSubjectsPerShard}-subject per-bundle limit`,
    );
  }
  const shards = Array.from({ length: shardCount }, () => []);
  for (const [index, subject] of subjects.entries()) {
    shards[index % shardCount].push(subject);
  }
  if (shards.some((shard) => shard.length > maxSubjectsPerShard)) {
    throw error(`an attestation shard exceeds the ${maxSubjectsPerShard}-subject per-bundle limit`);
  }

  const flattened = shards.flat();
  if (
    flattened.length !== subjects.length
    || new Set(flattened).size !== subjects.length
    || [...flattened].sort(compareText).some((subject, index) => subject !== subjects[index])
  ) {
    throw error("attestation shards do not form the exact disjoint selected subject union");
  }
  return shards;
}

export function githubOutputForAttestationSubjectShards(shards) {
  if (
    !Array.isArray(shards)
    || shards.length !== EXTENSION_ATTESTATION_SHARD_COUNT
    || shards.some((shard) => !Array.isArray(shard))
  ) {
    throw error(`GitHub output requires exactly ${EXTENSION_ATTESTATION_SHARD_COUNT} subject shards`);
  }
  if (shards.some((shard) => shard.length > MAX_ATTESTATION_SUBJECTS_PER_BUNDLE)) {
    throw error(
      `GitHub output shard exceeds the ${MAX_ATTESTATION_SUBJECTS_PER_BUNDLE}-subject per-bundle limit`,
    );
  }
  const flattened = shards.flat();
  if (
    flattened.some((subject) =>
      typeof subject !== "string"
      || subject.length === 0
      || /[\r\n\u0000]/u.test(subject))
    || new Set(flattened).size !== flattened.length
  ) {
    throw error("GitHub output subject shards must contain unique safe paths");
  }

  const lines = [`total_count=${flattened.length}`];
  const subjects = new Set(flattened);
  for (const [index, shard] of shards.entries()) {
    const number = index + 1;
    let delimiter = `OLIPHAUNT_EXTENSION_ATTESTATION_SUBJECTS_${number}`;
    while (subjects.has(delimiter)) delimiter += "_END";
    lines.push(
      `count_${number}=${shard.length}`,
      `nonempty_${number}=${shard.length > 0 ? "true" : "false"}`,
      `paths_${number}<<${delimiter}`,
      ...shard,
      delimiter,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--publication-lock" && arg !== "--products-json" && arg !== "--github-output") {
      throw error(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw error(`${arg} requires a value`);
    }
    if (values.has(arg)) throw error(`${arg} may be specified only once`);
    values.set(arg, value);
    index += 1;
  }
  if (!values.has("--products-json")) {
    throw error(
      "usage: locked-attestation-subjects.mjs --publication-lock FILE --products-json JSON [--github-output FILE]",
    );
  }
  let products;
  try {
    products = JSON.parse(values.get("--products-json"));
  } catch (cause) {
    throw error(`--products-json must be strict JSON: ${cause.message}`);
  }
  return {
    githubOutput: values.get("--github-output"),
    lockFile: path.resolve(ROOT, values.get("--publication-lock") ?? DEFAULT_PUBLICATION_LOCK),
    products: selectedProducts(products),
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const lock = loadPublicationLock(args.lockFile);
    if (args.githubOutput !== undefined) {
      const shards = lockedAttestationSubjectShards(lock, args.products);
      appendFileSync(args.githubOutput, githubOutputForAttestationSubjectShards(shards), {
        encoding: "utf8",
      });
    } else {
      for (const subject of lockedAttestationSubjects(lock, args.products)) console.log(subject);
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
