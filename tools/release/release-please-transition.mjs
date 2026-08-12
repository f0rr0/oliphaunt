import { readFileSync } from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  compareText,
  EMPTY_TREE,
  latestProductTag,
} from "./release-graph.mjs";
import { CONTRIB_CARRIERS_PATH, loadContribCarriers } from "./contrib-carriers.mjs";

const STABLE_VERSION = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u;
const INTENT_RANK = { patch: 1, minor: 2, major: 3 };
const RETIRED_CONTRIB_RELEASE_PATH = path.posix.dirname(CONTRIB_CARRIERS_PATH);

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

function bumpVersion(version, intent, context, prefix) {
  const [major, minor, patch] = stableVersion(version, context, prefix);
  if (version === "0.0.0") {
    throw transitionError(prefix, `${context} has no released baseline; let Release Please create its first release`);
  }
  if (intent === "major") return `${major + 1}.0.0`;
  if (intent === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function transitionIntent(before, after, context, prefix) {
  const left = stableVersion(before, `${context} before`, prefix);
  const right = stableVersion(after, `${context} after`, prefix);
  if (right[0] > left[0]) return "major";
  if (right[0] === left[0] && right[1] > left[1]) return "minor";
  if (right[0] === left[0] && right[1] === left[1] && right[2] > left[2]) return "patch";
  throw transitionError(prefix, `${context} does not advance from ${before} to ${after}`);
}

function conventionalIntent(subject, body, version, commit, prefix) {
  const match = /^(feat|fix|perf|refactor|revert)(?:\([^)]+\))?(!)?:[ \t]+(.+)$/u.exec(subject);
  if (match === null) {
    throw transitionError(
      prefix,
      `shared contrib source commit ${commit.slice(0, 8)} has unsupported release intent: ${JSON.stringify(subject)}`,
    );
  }
  const breaking = match[2] === "!" || /^BREAKING[ -]CHANGE:/mu.test(body);
  const [major] = stableVersion(version, "shared contrib owner version", prefix);
  const intent = breaking ? (major === 0 ? "minor" : "major") : match[1] === "feat" && major > 0 ? "minor" : "patch";
  return { intent, summary: match[3], type: match[1] };
}

function carrierDescriptor(root, prefix) {
  const carriers = loadContribCarriers(root, prefix);
  const owners = [carriers.nativeOwner, carriers.wasixOwner];
  if (owners.some((owner) => typeof owner !== "string" || owner.length === 0) || new Set(owners).size !== 2) {
    throw transitionError(prefix, `${CONTRIB_CARRIERS_PATH} must name distinct native_owner and wasix_owner products`);
  }
  return {
    inputs: carriers.inputFiles,
    owners,
  };
}

function commitsAffecting(root, baseRef, headRef, inputs, prefix) {
  const result = git(root, ["rev-list", "--reverse", `${baseRef}..${headRef}`, "--", ...inputs], {}, prefix);
  return result.stdout.trim().split(/\s+/u).filter(Boolean).map((commit) => {
    const subject = git(root, ["show", "-s", "--format=%s", commit], {}, prefix).stdout.trim();
    const body = git(root, ["show", "-s", "--format=%b", commit], {}, prefix).stdout.trim();
    return { commit, subject, body };
  });
}

/**
 * Bridge the one shared source tree that Release Please cannot assign to two
 * package paths. Existing runtime candidates merge the shared-source reasons
 * into their Release Please entry and are promoted when that bump is too
 * small; missing owners receive the conventional-commit bump inferred from
 * the shared byte inputs.
 */
export function sharedContribReleaseCandidates(
  root,
  graph,
  transitions,
  { headRef = "HEAD", prefix = "release-please-transition" } = {},
) {
  const { inputs, owners } = carrierDescriptor(root, prefix);
  const transitionsByProduct = new Map(transitions.map((transition) => [transition.product, transition]));
  const candidates = [];
  for (const owner of owners) {
    const product = graph.products?.[owner];
    if (product === undefined) {
      throw transitionError(prefix, `${CONTRIB_CARRIERS_PATH} owner ${owner} is not a release product`);
    }
    const baseRef = latestProductTag(product, headRef, prefix, root);
    if (baseRef === EMPTY_TREE) {
      throw transitionError(prefix, `${owner} has no release tag from which to derive shared contrib intent`);
    }
    const commits = commitsAffecting(root, baseRef, headRef, inputs, prefix);
    if (commits.length === 0) continue;

    const transition = transitionsByProduct.get(owner);
    const before = transition?.before ?? product.version;
    if (before === null) {
      throw transitionError(prefix, `${owner} shared contrib bridge cannot replace a first-release candidate`);
    }
    const reasons = commits.map(({ commit, subject, body }) => ({
      commit,
      kind: "shared-source",
      ...conventionalIntent(subject, body, before, commit, prefix),
    }));
    const requiredIntent = reasons
      .map(({ intent }) => intent)
      .sort((left, right) => INTENT_RANK[right] - INTENT_RANK[left])[0];
    const changelogSection = reasons.some(({ type, intent }) => type === "feat" || intent !== "patch")
      ? "Features"
      : "Bug Fixes";
    const requiredAfter = bumpVersion(before, requiredIntent, `${owner} current version`, prefix);

    if (transition !== undefined) {
      const actualIntent = transitionIntent(transition.before, transition.after, owner, prefix);
      candidates.push({
        product: owner,
        packagePath: product.path,
        before: transition.after,
        after: INTENT_RANK[actualIntent] < INTENT_RANK[requiredIntent] ? requiredAfter : transition.after,
        changelogMode: "merge-existing",
        changelogSection,
        reasons,
      });
      continue;
    }

    candidates.push({
      product: owner,
      packagePath: product.path,
      before,
      after: requiredAfter,
      changelogSection,
      reasons,
    });
  }
  return candidates.sort((left, right) => compareText(left.product, right.product));
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
  { prefix = "release-please-transition" } = {},
) {
  object(config, "release-please-config.json", prefix);
  const after = object(afterManifest, ".release-please-manifest.json", prefix);
  const before = beforeManifest === null
    ? null
    : object(beforeManifest, "parent .release-please-manifest.json", prefix);
  const products = packageProducts(config, prefix);

  const currentPaths = new Set(products.keys());
  const retiredParentPaths = before === null
    ? []
    : Object.keys(before).filter((packagePath) => !currentPaths.has(packagePath)).sort();
  const unexpectedRetirements = retiredParentPaths.filter(
    (packagePath) => packagePath !== RETIRED_CONTRIB_RELEASE_PATH,
  );
  if (unexpectedRetirements.length > 0) {
    throw transitionError(
      prefix,
      `release-please packages cannot disappear from both config and manifest: ${JSON.stringify(unexpectedRetirements)}`,
    );
  }
  const missing = [...currentPaths].filter((packagePath) => !Object.hasOwn(after, packagePath)).sort();
  const extra = Object.keys(after).filter((packagePath) => !currentPaths.has(packagePath)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw transitionError(
      prefix,
      `release-please manifest paths must exactly match configured packages; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`,
    );
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
  return releasePleaseManifestTransitions(config, before, after, { prefix });
}
