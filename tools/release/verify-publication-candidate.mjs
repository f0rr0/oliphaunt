#!/usr/bin/env bun

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { ROOT } from "./release-graph.mjs";
import { RELEASE_SEMANTIC_INPUTS_PATH } from "./release-semantic-inputs.mjs";
import {
  deriveReleaseProducts,
  verifyReleaseCommit,
} from "./verify-release-commit.mjs";

const TOOL = "verify-publication-candidate.mjs";
export const RELEASE_RECOVERY_TRAILER = "Oliphaunt-Release-Recovery-Of";
const SHA = /^[0-9a-f]{40}$/u;
const RECOVERY_SUBJECT = /^fix\(release\): .+/u;

function error(message) {
  return new Error(`${TOOL}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(
  repo,
  args,
  {
    allowEmptyOutput = false,
    input = undefined,
    stdoutTerminator = undefined,
  } = {},
) {
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput,
    cwd: repo,
    input,
    label: `git ${args.join(" ")}`,
    stdoutTerminator,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

function show(repo, commit, file) {
  return git(repo, ["show", `${commit}:${file}`]);
}

function showJson(repo, commit, file) {
  let value;
  try {
    value = JSON.parse(show(repo, commit, file));
  } catch (cause) {
    throw error(`${file} at ${commit} is not valid JSON: ${cause.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${file} at ${commit} must contain a JSON object`);
  }
  return value;
}

function parsedTrailers(repo, commit) {
  const body = git(repo, ["show", "-s", "--format=%B", commit]);
  const parsed = git(
    repo,
    ["interpret-trailers", "--parse"],
    {
      allowEmptyOutput: true,
      input: body,
      stdoutTerminator: "\n",
    },
  );
  return parsed
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) throw error(`git interpret-trailers emitted malformed line ${JSON.stringify(line)}`);
      return {
        key: line.slice(0, separator),
        value: line.slice(separator + 1).trimStart(),
      };
    });
}

function recoveryTrailer(repo, commit) {
  const matches = parsedTrailers(repo, commit)
    .filter(({ key }) => key.toLowerCase() === RELEASE_RECOVERY_TRAILER.toLowerCase());
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw error(`${commit} must contain exactly one ${RELEASE_RECOVERY_TRAILER} trailer`);
  }
  const [{ key, value }] = matches;
  if (key !== RELEASE_RECOVERY_TRAILER || !SHA.test(value)) {
    throw error(
      `${commit} recovery trailer must be exactly `
        + `${RELEASE_RECOVERY_TRAILER}: <lowercase-full-sha>`,
    );
  }
  return value;
}

function changedFiles(repo, base, head) {
  return git(
    repo,
    [
      "diff",
      "--no-renames",
      "--name-only",
      "--diff-filter=ACDMRT",
      "-z",
      base,
      head,
    ],
    { allowEmptyOutput: true, stdoutTerminator: "\0" },
  )
    .split("\0")
    .filter(Boolean)
    .sort(compareText);
}

function canonicalPath(value, context) {
  if (
    typeof value !== "string"
    || value.length === 0
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === ".."
    || value.startsWith("../")
    || /[\\\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw error(`${context} must be a canonical repository-relative path`);
  }
  return value;
}

function semanticPatterns(repo, commit) {
  let value;
  try {
    value = Bun.TOML.parse(show(repo, commit, RELEASE_SEMANTIC_INPUTS_PATH));
  } catch (cause) {
    throw error(
      `${RELEASE_SEMANTIC_INPUTS_PATH} at ${commit} is not valid TOML: ${cause.message}`,
    );
  }
  if (
    value === null
    || Array.isArray(value)
    || typeof value !== "object"
    || value.schema !== "oliphaunt-release-semantic-inputs-v1"
    || !Array.isArray(value.rules)
    || value.rules.length === 0
  ) {
    throw error(`${RELEASE_SEMANTIC_INPUTS_PATH} at ${commit} has an invalid ownership shape`);
  }
  return value.rules.flatMap((rule, ruleIndex) => {
    const products = rule?.products ?? [];
    const productKinds = rule?.product_kinds ?? [];
    if (
      rule === null
      || Array.isArray(rule)
      || typeof rule !== "object"
      || !Array.isArray(rule.paths)
      || rule.paths.length === 0
      || !Array.isArray(products)
      || products.some((product) => typeof product !== "string" || product.length === 0)
      || !Array.isArray(productKinds)
      || productKinds.some((kind) => typeof kind !== "string" || kind.length === 0)
      || products.length + productKinds.length === 0
    ) {
      throw error(
        `${RELEASE_SEMANTIC_INPUTS_PATH} rule ${ruleIndex} has an invalid ownership shape`,
      );
    }
    return rule.paths.map((candidate, pathIndex) => {
      const raw = canonicalPath(
        candidate,
        `${RELEASE_SEMANTIC_INPUTS_PATH} rule ${ruleIndex} path ${pathIndex}`,
      );
      const directory = raw.endsWith("/**");
      const root = directory ? raw.slice(0, -3) : raw;
      if (!root || root.includes("*")) {
        throw error(
          `${RELEASE_SEMANTIC_INPUTS_PATH} rule ${ruleIndex} path ${pathIndex} `
            + "must be exact or end in /**",
        );
      }
      return { directory, raw, root };
    });
  });
}

function semanticallyOwnedFiles(repo, commit, files) {
  const patterns = semanticPatterns(repo, commit);
  return files.filter((file) =>
    file === RELEASE_SEMANTIC_INPUTS_PATH
    || patterns.some((pattern) =>
      pattern.directory ? file.startsWith(`${pattern.root}/`) : file === pattern.root));
}

function releaseProductsForRange(repo, releaseCommit, publicationCommit) {
  const script = path.join(repo, "tools/release/release_plan.mjs");
  const result = captureCommandOutput(
    process.execPath,
    [
      script,
      "--base-ref",
      releaseCommit,
      "--head-ref",
      publicationCommit,
      "--format",
      "json",
    ],
    {
      cwd: repo,
      env: process.env,
      label: `${process.execPath} ${script} recovery range`,
      maxOutputBytes: 64 * 1024 * 1024,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
    throw error(`could not derive recovery release impact${detail ? `: ${detail}` : ""}`);
  }
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch (cause) {
    throw error(`recovery release plan returned invalid JSON: ${cause.message}`);
  }
  if (
    !Array.isArray(plan?.releaseProducts)
    || plan.releaseProducts.some((product) =>
      typeof product !== "string" || product.length === 0)
  ) {
    throw error("recovery release plan has an invalid releaseProducts list");
  }
  return [...plan.releaseProducts].sort(compareText);
}

function assertLinearRecoveryChain(repo, releaseCommit, publicationCommit) {
  const rows = git(
    repo,
    ["rev-list", "--reverse", "--topo-order", "--parents", `${releaseCommit}..${publicationCommit}`],
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (rows.length === 0) {
    throw error("release recovery commit must be a strict descendant of its release-bump commit");
  }
  let expectedParent = releaseCommit;
  for (const row of rows) {
    const fields = row.split(/\s+/u);
    if (fields.length !== 2 || fields[1] !== expectedParent) {
      throw error(
        "release recovery history must be one linear, one-parent chain directly after "
          + `${releaseCommit}`,
      );
    }
    const [commit] = fields;
    const subject = git(repo, ["show", "-s", "--format=%s", commit]).trimEnd();
    if (!RECOVERY_SUBJECT.test(subject)) {
      throw error(
        `release recovery commit ${commit} subject must start with "fix(release): "; `
          + `got ${JSON.stringify(subject)}`,
      );
    }
    const trailer = recoveryTrailer(repo, commit);
    if (trailer !== releaseCommit) {
      throw error(
        `release recovery commit ${commit} must carry `
          + `${RELEASE_RECOVERY_TRAILER}: ${releaseCommit}`,
      );
    }
    expectedParent = commit;
  }
  if (expectedParent !== publicationCommit) {
    throw error("release recovery history did not terminate at the publication commit");
  }
}

function sameFile(repo, left, right, file) {
  return show(repo, left, file) === show(repo, right, file);
}

export function derivePublicationProducts({
  repo = ROOT,
  headRef = "HEAD",
} = {}) {
  const publicationCommit = git(
    repo,
    ["rev-parse", "--verify", `${headRef}^{commit}`],
  ).trimEnd();
  const releaseCommit = recoveryTrailer(repo, publicationCommit) ?? publicationCommit;
  return deriveReleaseProducts({ repo, headRef: releaseCommit }).products;
}

/**
 * Resolve the commit whose product tags define publication planning.
 *
 * Ordinary commits plan against themselves. A recovery controller may plan
 * against its release source only after the complete recovery contract has
 * been verified. This keeps the tag planner strict for arbitrary descendants
 * while allowing a failed publication that already staged its immutable
 * product tags to resume from the frozen release source.
 */
export function resolvePublicationPlanningSource({
  repo = ROOT,
  headRef = "HEAD",
  deriveRecoveryProducts = releaseProductsForRange,
} = {}) {
  const publicationCommit = git(
    repo,
    ["rev-parse", "--verify", `${headRef}^{commit}`],
  ).trimEnd();
  const recovery = verifyPublicationRecoveryCandidate({
    repo,
    headRef: publicationCommit,
    deriveRecoveryProducts,
  });
  return {
    planHeadSha: recovery?.releaseSha ?? publicationCommit,
    publicationSha: publicationCommit,
    recovery: recovery !== null,
  };
}

/**
 * Return a fully verified recovery context when HEAD explicitly carries the
 * recovery trailer. Ordinary source and release-bump commits return null so
 * general repository checks retain their existing behavior.
 */
export function verifyPublicationRecoveryCandidate({
  repo = ROOT,
  headRef = "HEAD",
  deriveRecoveryProducts = releaseProductsForRange,
} = {}) {
  const publicationCommit = git(
    repo,
    ["rev-parse", "--verify", `${headRef}^{commit}`],
  ).trimEnd();
  if (recoveryTrailer(repo, publicationCommit) === null) return null;
  return verifyPublicationCandidate({
    repo,
    headRef: publicationCommit,
    products: derivePublicationProducts({ repo, headRef: publicationCommit }),
    deriveRecoveryProducts,
  });
}

export function verifyPublicationCandidate({
  repo = ROOT,
  headRef = "HEAD",
  products,
  deriveRecoveryProducts = releaseProductsForRange,
} = {}) {
  const publicationCommit = git(
    repo,
    ["rev-parse", "--verify", `${headRef}^{commit}`],
  ).trimEnd();
  const releaseCommit = recoveryTrailer(repo, publicationCommit);
  if (releaseCommit === null) {
    const verified = verifyReleaseCommit({ repo, headRef: publicationCommit, products });
    return {
      mode: "release-bump",
      publicationSha: verified.commit,
      releaseSha: verified.commit,
      products: verified.products,
      versions: verified.versions,
      recoveryChangedFiles: [],
    };
  }

  const ancestor = captureCommandOutput(
    "git",
    ["merge-base", "--is-ancestor", releaseCommit, publicationCommit],
    { cwd: repo, label: `git merge-base --is-ancestor ${releaseCommit} ${publicationCommit}` },
  );
  if (ancestor.error !== undefined || ancestor.status !== 0) {
    throw error(
      `${releaseCommit} is not an ancestor of recovery publication commit ${publicationCommit}`,
    );
  }
  assertLinearRecoveryChain(repo, releaseCommit, publicationCommit);

  const verified = verifyReleaseCommit({ repo, headRef: releaseCommit, products });
  for (const file of [
    ".release-please-manifest.json",
    "release-please-config.json",
    RELEASE_SEMANTIC_INPUTS_PATH,
  ]) {
    if (!sameFile(repo, releaseCommit, publicationCommit, file)) {
      throw error(`release recovery changes immutable release metadata ${file}`);
    }
  }

  const changed = changedFiles(repo, releaseCommit, publicationCommit);
  if (changed.length === 0) {
    throw error("release recovery must contain at least one control-plane change");
  }
  const recoveryProducts = deriveRecoveryProducts(
    repo,
    releaseCommit,
    publicationCommit,
  );
  if (
    !Array.isArray(recoveryProducts)
    || recoveryProducts.some((product) =>
      typeof product !== "string" || product.length === 0)
  ) {
    throw error("release recovery impact derivation must return a product string list");
  }
  if (recoveryProducts.length > 0) {
    throw error(
      "release recovery selects release-impacting product(s): "
        + `${[...new Set(recoveryProducts)].sort(compareText).join(", ")}; `
        + "create a new product version instead",
    );
  }
  const owned = semanticallyOwnedFiles(repo, publicationCommit, changed);
  if (owned.length > 0) {
    throw error(
      "release recovery changes product-semantic path(s): "
        + `${owned.join(", ")}; create a new product version instead`,
    );
  }

  const manifest = showJson(repo, publicationCommit, ".release-please-manifest.json");
  const config = showJson(repo, publicationCommit, "release-please-config.json");
  const packages = config.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    throw error("release-please-config.json must define a packages object");
  }
  const currentVersions = new Map(
    Object.entries(packages).map(([packagePath, packageConfig]) => [
      packageConfig?.component,
      manifest[packagePath],
    ]),
  );
  for (const [product, version] of Object.entries(verified.versions)) {
    if (currentVersions.get(product) !== version) {
      throw error(
        `release recovery changed ${product} from ${version} to `
          + `${JSON.stringify(currentVersions.get(product))}`,
      );
    }
  }

  return {
    mode: "release-recovery",
    publicationSha: publicationCommit,
    releaseSha: releaseCommit,
    products: verified.products,
    versions: verified.versions,
    recoveryChangedFiles: changed,
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
        appendFileSync(
          args.githubOutput,
          [
            `plan_head_sha=${source.planHeadSha}`,
            `plan_recovery=${String(source.recovery)}`,
            "",
          ].join("\n"),
        );
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
      `verified ${verified.mode} publication commit ${verified.publicationSha} `
        + `for release ${verified.releaseSha} and ${verified.products.length} product(s)`,
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
