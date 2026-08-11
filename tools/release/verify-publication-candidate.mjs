#!/usr/bin/env bun

import { appendFileSync } from "node:fs";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { ROOT } from "./release-graph.mjs";
import {
  deriveReleaseProducts,
  verifyReleaseCommit,
} from "./verify-release-commit.mjs";

const TOOL = "verify-publication-candidate.mjs";

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function publicationCommit(repo, headRef) {
  const result = captureCommandOutput(
    "git",
    ["rev-parse", "--verify", `${headRef}^{commit}`],
    { cwd: repo, label: `git rev-parse --verify ${headRef}^{commit}` },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw error(`could not resolve publication commit${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trimEnd();
}

export function derivePublicationProducts({
  repo = ROOT,
  headRef = "HEAD",
} = {}) {
  return deriveReleaseProducts({ repo, headRef: publicationCommit(repo, headRef) }).products;
}

export function resolvePublicationPlanningSource({
  repo = ROOT,
  headRef = "HEAD",
} = {}) {
  const commit = publicationCommit(repo, headRef);
  return {
    planHeadSha: commit,
    publicationSha: commit,
  };
}

export function verifyPublicationCandidate({
  repo = ROOT,
  headRef = "HEAD",
  products,
} = {}) {
  const commit = publicationCommit(repo, headRef);
  const verified = verifyReleaseCommit({ repo, headRef: commit, products });
  return {
    mode: "release-bump",
    publicationSha: verified.commit,
    releaseSha: verified.commit,
    products: verified.products,
    versions: verified.versions,
  };
}

function parseArgs(argv) {
  let productsJson = "";
  let headRef = "HEAD";
  let githubOutput = "";
  let deriveProducts = false;
  let resolvePlanHead = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--products-json") {
      productsJson = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--derive-products") {
      deriveProducts = true;
    } else if (arg === "--resolve-plan-head") {
      resolvePlanHead = true;
    } else if (arg === "--head-ref") {
      headRef = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--github-output") {
      githubOutput = argv[index + 1] ?? "";
      index += 1;
    } else {
      throw error(`unknown argument ${arg}`);
    }
  }
  if (
    !headRef
    || (resolvePlanHead && (deriveProducts || Boolean(productsJson)))
    || (!resolvePlanHead && deriveProducts === Boolean(productsJson))
  ) {
    throw error(
      "usage: verify-publication-candidate.mjs "
        + "((--products-json JSON | --derive-products) | --resolve-plan-head) "
        + "[--head-ref REF] [--github-output FILE]",
    );
  }
  if (resolvePlanHead) {
    return { githubOutput, headRef, resolvePlanHead };
  }
  let products;
  if (deriveProducts) {
    products = derivePublicationProducts({ headRef });
  } else {
    try {
      products = JSON.parse(productsJson);
    } catch (cause) {
      throw error(`--products-json must be valid JSON: ${cause.message}`);
    }
  }
  return { githubOutput, headRef, products, resolvePlanHead };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.resolvePlanHead) {
      const source = resolvePublicationPlanningSource({ headRef: args.headRef });
      if (args.githubOutput) {
        appendFileSync(args.githubOutput, `plan_head_sha=${source.planHeadSha}\n`);
      }
      console.log(source.planHeadSha);
      process.exit(0);
    }
    const verified = verifyPublicationCandidate(args);
    if (args.githubOutput) {
      appendFileSync(
        args.githubOutput,
        [
          `mode=${verified.mode}`,
          `publication_sha=${verified.publicationSha}`,
          `release_sha=${verified.releaseSha}`,
          "",
        ].join("\n"),
      );
    }
    console.log(
      `verified publication commit ${verified.publicationSha} for ${verified.products.length} product(s)`,
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
