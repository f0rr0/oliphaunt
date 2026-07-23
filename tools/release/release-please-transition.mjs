import { readFileSync } from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import { compareText, runtimeTiedContribProducts } from "./release-graph.mjs";
import {
  exactReleasePleaseQualificationTransportBaseline,
  exactReleasePleaseUnpublishedFirstReleaseRollbackTransport,
  isUnreleasedReleasePleaseManifest,
} from "./release-please-bootstrap.mjs";

const STABLE_VERSION = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u;

function transitionError(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function object(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw transitionError(prefix, `${context} must contain a JSON object`);
  }
  return value;
}

function stableVersion(value, context, prefix) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    throw transitionError(prefix, `${context} must be a stable x.y.z version, got ${JSON.stringify(value)}`);
  }
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function packageProducts(config, prefix) {
  const packages = object(config.packages, "release-please-config.json packages", prefix);
  const products = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    object(packageConfig, `release-please package ${packagePath}`, prefix);
    const product = packageConfig.component;
    if (typeof product !== "string" || product.length === 0) {
      throw transitionError(prefix, `release-please package ${packagePath} must declare a component`);
    }
    if ([...products.values()].includes(product)) {
      throw transitionError(prefix, `release-please component ${product} is declared more than once`);
    }
    products.set(packagePath, product);
  }
  if (products.size === 0) {
    throw transitionError(prefix, "release-please config must declare at least one package");
  }
  return products;
}

function readJsonObject(file, context, prefix) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw transitionError(prefix, `${context} is unreadable: ${cause.message}`);
  }
  return object(value, context, prefix);
}

function git(root, args, { check = true } = {}, prefix) {
  const result = captureCommandOutput("git", args, {
    cwd: root,
    label: `git ${args.join(" ")}`,
  });
  if (result.error !== undefined) {
    throw transitionError(prefix, `git failed: ${result.error.message}`);
  }
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw transitionError(prefix, `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

/**
 * Derive the products whose Release Please manifest entries advanced.
 * A newly introduced 0.0.0 entry is seed state, not a release transition.
 */
export function releasePleaseManifestTransitions(
  config,
  beforeManifest,
  afterManifest,
  { parentSha, prefix = "release-please-transition" } = {},
) {
  object(config, "release-please-config.json", prefix);
  const after = object(afterManifest, ".release-please-manifest.json", prefix);
  let before = beforeManifest === null
    ? null
    : object(beforeManifest, "parent .release-please-manifest.json", prefix);
  const products = packageProducts(config, prefix);

  const currentPaths = new Set(products.keys());
  const missing = [...currentPaths].filter((packagePath) => !Object.hasOwn(after, packagePath)).sort();
  const extra = Object.keys(after).filter((packagePath) => !currentPaths.has(packagePath)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw transitionError(
      prefix,
      `release-please manifest paths must exactly match configured packages; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    );
  }

  if (
    before !== null &&
    isUnreleasedReleasePleaseManifest(after) &&
    !isUnreleasedReleasePleaseManifest(before)
  ) {
    const rollback = exactReleasePleaseUnpublishedFirstReleaseRollbackTransport(
      config,
      before,
      after,
      parentSha === undefined ? [] : [parentSha],
      { prefix },
    );
    if (rollback !== null) before = rollback.normalizedBeforeManifest;
  }

  if (before !== null) {
    const removed = Object.keys(before).filter((packagePath) => !currentPaths.has(packagePath)).sort();
    if (removed.length > 0) {
      const baseline = exactReleasePleaseQualificationTransportBaseline(
        config,
        before,
        after,
        parentSha === undefined ? [] : [parentSha],
        { prefix },
      );
      if (baseline === null) {
        throw transitionError(prefix, `release-please package paths cannot disappear across normalization: ${removed.join(", ")}`);
      }
      before = baseline.normalizedBeforeManifest;
    }
  }

  const transitions = [];
  for (const [packagePath, product] of products) {
    const afterVersion = after[packagePath];
    const parsedAfter = stableVersion(afterVersion, `${product} manifest version`, prefix);
    const beforeVersion = before?.[packagePath];
    if (beforeVersion === undefined) {
      if (afterVersion !== "0.0.0") {
        transitions.push({ product, packagePath, before: null, after: afterVersion });
      }
      continue;
    }
    const parsedBefore = stableVersion(beforeVersion, `${product} parent manifest version`, prefix);
    const order = compareVersions(parsedAfter, parsedBefore);
    if (order < 0) {
      throw transitionError(prefix, `${product} manifest version regressed from ${beforeVersion} to ${afterVersion}`);
    }
    if (order > 0) {
      transitions.push({ product, packagePath, before: beforeVersion, after: afterVersion });
    }
  }
  return transitions.sort((left, right) => compareText(left.product, right.product));
}

/**
 * Release Please's pinned linked-versions plugin is responsible for creating
 * otherwise-missing candidates. Verify its complete deterministic output
 * before any derived files are rewritten.
 */
export function requireCompleteRuntimeLinkedTransitions(
  products,
  transitions,
  { prefix = "release-please-transition" } = {},
) {
  const tied = runtimeTiedContribProducts(products, prefix);
  const byProduct = new Map(transitions.map((transition) => [transition.product, transition]));
  if (!tied.some((product) => byProduct.has(product))) return null;

  const missing = tied.filter((product) => !byProduct.has(product));
  if (missing.length > 0) {
    throw transitionError(
      prefix,
      `Release Please linked-versions output is incomplete; every runtime-tied product must advance in one release bump. Missing: ${missing.join(", ")}`,
    );
  }
  const versions = new Set(tied.map((product) => byProduct.get(product).after));
  if (versions.size !== 1) {
    throw transitionError(
      prefix,
      `Release Please linked-versions output must advance every runtime-tied product to one version; got ${[...versions].sort().join(", ")}`,
    );
  }
  return versions.values().next().value;
}

export function compatibilityEntriesForBumpedProducts(entries, transitions) {
  const bumpedProducts = new Set(transitions.map(({ product }) => product));
  return entries.filter(({ product }) => bumpedProducts.has(product));
}

/**
 * Read the worktree's normalized Release Please state against HEAD's sole
 * parent. The introduction commit legitimately has no parent manifest.
 */
export function releasePleaseWorktreeTransitions(
  root,
  { headRef = "HEAD", prefix = "release-please-transition" } = {},
) {
  const config = readJsonObject(
    path.join(root, "release-please-config.json"),
    "release-please-config.json",
    prefix,
  );
  const after = readJsonObject(
    path.join(root, ".release-please-manifest.json"),
    ".release-please-manifest.json",
    prefix,
  );
  const ancestry = git(root, ["rev-list", "--parents", "-n", "1", headRef], {}, prefix)
    .stdout.trim().split(/\s+/u);
  if (ancestry.length !== 2) {
    throw transitionError(prefix, `${headRef} must resolve to one commit with exactly one parent`);
  }
  const parent = ancestry[1];
  const prior = git(
    root,
    ["show", `${parent}:.release-please-manifest.json`],
    { check: false },
    prefix,
  );
  let before = null;
  if (prior.status === 0) {
    try {
      before = object(
        JSON.parse(prior.stdout),
        `parent .release-please-manifest.json at ${parent}`,
        prefix,
      );
    } catch (cause) {
      if (cause instanceof SyntaxError) {
        throw transitionError(prefix, `parent .release-please-manifest.json at ${parent} is invalid JSON: ${cause.message}`);
      }
      throw cause;
    }
  } else {
    const stderr = prior.stderr.trim();
    if (!/does not exist|exists on disk, but not in|path .* not in/u.test(stderr)) {
      throw transitionError(prefix, `cannot read parent release-please manifest at ${parent}: ${stderr || `exit ${prior.status}`}`);
    }
    if (Object.values(after).some((version) => version !== "0.0.0")) {
      throw transitionError(prefix, "a missing parent release-please manifest is valid only for the unreleased 0.0.0 introduction state");
    }
  }
  return releasePleaseManifestTransitions(config, before, after, { parentSha: parent, prefix });
}
