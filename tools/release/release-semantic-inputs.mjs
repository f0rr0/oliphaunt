import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";

export const RELEASE_SEMANTIC_INPUT_SCHEMA = "oliphaunt-release-semantic-inputs-v1";
export const RELEASE_SEMANTIC_FINGERPRINT_SCHEMA = "oliphaunt-release-semantic-fingerprint-v1";
export const RELEASE_SEMANTIC_INPUTS_PATH = "tools/release/release-semantic-inputs.toml";
export const RELEASE_SEMANTIC_FINGERPRINT_BASENAME = ".release-semantic-inputs.json";

const MANIFEST_KEYS = new Set(["schema", "rules"]);
const RULE_KEYS = new Set(["id", "paths", "products", "product_kinds"]);
const SAFE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SAFE_REPO_PATH = /^(?![/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\\0])[^\u0000-\u001f\u007f]+$/u;

function semanticError(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw semanticError(prefix, `${context} must be a table`);
  }
  return value;
}

function exactKeys(value, allowed, context, prefix) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort(compareText);
  if (unknown.length > 0) {
    throw semanticError(prefix, `${context} contains unknown key(s): ${unknown.join(", ")}`);
  }
}

function uniqueStringList(value, context, prefix, { nonEmpty = true } = {}) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
    || (nonEmpty && value.length === 0)
  ) {
    throw semanticError(prefix, `${context} must be ${nonEmpty ? "a non-empty" : "a"} string list`);
  }
  if (new Set(value).size !== value.length) {
    throw semanticError(prefix, `${context} must not contain duplicates`);
  }
  return value;
}

function normalizeCandidate(candidate, prefix) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw semanticError(prefix, "candidate path must be a non-empty string");
  }
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!SAFE_REPO_PATH.test(normalized) || path.posix.normalize(normalized) !== normalized) {
    throw semanticError(prefix, `candidate path must be a normalized repository-relative path: ${JSON.stringify(candidate)}`);
  }
  return normalized;
}

function parsePattern(raw, context, prefix) {
  const normalized = normalizeCandidate(raw, prefix);
  const directory = normalized.endsWith("/**");
  const root = directory ? normalized.slice(0, -3) : normalized;
  if (!root || root.includes("*")) {
    throw semanticError(prefix, `${context} supports only exact paths or a trailing /** directory pattern`);
  }
  return { raw: normalized, root, directory };
}

function patternsOverlap(left, right) {
  if (!left.directory && !right.directory) return left.root === right.root;
  if (left.directory && right.directory) {
    return left.root === right.root
      || left.root.startsWith(`${right.root}/`)
      || right.root.startsWith(`${left.root}/`);
  }
  const directory = left.directory ? left : right;
  const exact = left.directory ? right : left;
  return exact.root === directory.root || exact.root.startsWith(`${directory.root}/`);
}

function patternMatches(pattern, candidate) {
  return pattern.directory
    ? candidate.startsWith(`${pattern.root}/`)
    : candidate === pattern.root;
}

function repositoryPath(root, candidate, prefix) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, ...candidate.split("/"));
  if (absolute === absoluteRoot || !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw semanticError(prefix, `${candidate} escapes the repository root`);
  }
  return absolute;
}

function assertPatternRoot(root, pattern, context, prefix) {
  const absolute = repositoryPath(root, pattern.root, prefix);
  if (!existsSync(absolute)) {
    throw semanticError(prefix, `${context} references missing ${pattern.root}`);
  }
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw semanticError(prefix, `${context} must not reference symlink ${pattern.root}`);
  }
  if (pattern.directory ? !stat.isDirectory() : !stat.isFile()) {
    throw semanticError(
      prefix,
      `${context} must reference ${pattern.directory ? "a directory" : "a regular file"}: ${pattern.root}`,
    );
  }
}

function selectedProducts(rule, products, context, prefix) {
  const explicit = rule.products ?? [];
  const kinds = rule.product_kinds ?? [];
  uniqueStringList(explicit, `${context}.products`, prefix, { nonEmpty: false });
  uniqueStringList(kinds, `${context}.product_kinds`, prefix, { nonEmpty: false });
  if (explicit.length === 0 && kinds.length === 0) {
    throw semanticError(prefix, `${context} must select products or product_kinds`);
  }
  const unknownProducts = explicit.filter((product) => !(product in products)).sort(compareText);
  if (unknownProducts.length > 0) {
    throw semanticError(prefix, `${context} names unknown product(s): ${unknownProducts.join(", ")}`);
  }
  const knownKinds = new Set(Object.values(products).map((product) => product?.kind));
  const unknownKinds = kinds.filter((kind) => !knownKinds.has(kind)).sort(compareText);
  if (unknownKinds.length > 0) {
    throw semanticError(prefix, `${context} names unknown product kind(s): ${unknownKinds.join(", ")}`);
  }
  const selected = new Set(explicit);
  for (const [product, config] of Object.entries(products)) {
    if (kinds.includes(config?.kind)) selected.add(product);
  }
  if (selected.size === 0) {
    throw semanticError(prefix, `${context} selects no release products`);
  }
  return [...selected].sort(compareText);
}

export function parseReleaseSemanticInputs(
  value,
  graph,
  {
    root,
    prefix = "release-semantic-inputs",
    checkPaths = root !== undefined,
  } = {},
) {
  object(value, RELEASE_SEMANTIC_INPUTS_PATH, prefix);
  exactKeys(value, MANIFEST_KEYS, RELEASE_SEMANTIC_INPUTS_PATH, prefix);
  if (value.schema !== RELEASE_SEMANTIC_INPUT_SCHEMA) {
    throw semanticError(
      prefix,
      `${RELEASE_SEMANTIC_INPUTS_PATH}.schema must be ${JSON.stringify(RELEASE_SEMANTIC_INPUT_SCHEMA)}`,
    );
  }
  const products = object(graph?.products, "release graph products", prefix);
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    throw semanticError(prefix, `${RELEASE_SEMANTIC_INPUTS_PATH}.rules must be a non-empty table list`);
  }
  const ids = new Set();
  const allPatterns = [];
  const rules = value.rules.map((rawRule, index) => {
    const context = `${RELEASE_SEMANTIC_INPUTS_PATH}.rules[${index}]`;
    const rule = object(rawRule, context, prefix);
    exactKeys(rule, RULE_KEYS, context, prefix);
    if (typeof rule.id !== "string" || !SAFE_ID.test(rule.id) || ids.has(rule.id)) {
      throw semanticError(prefix, `${context}.id must be a unique lowercase kebab-case identifier`);
    }
    ids.add(rule.id);
    const patterns = uniqueStringList(rule.paths, `${context}.paths`, prefix)
      .map((item, patternIndex) => parsePattern(item, `${context}.paths[${patternIndex}]`, prefix));
    for (const pattern of patterns) {
      for (const prior of allPatterns) {
        if (patternsOverlap(pattern, prior.pattern)) {
          throw semanticError(
            prefix,
            `${context} path ${pattern.raw} overlaps ${prior.context} path ${prior.pattern.raw}; `
              + "one shared input must have exactly one ownership rule",
          );
        }
      }
      if (checkPaths) assertPatternRoot(root, pattern, context, prefix);
      allPatterns.push({ pattern, context });
    }
    return {
      id: rule.id,
      patterns,
      products: selectedProducts(rule, products, context, prefix),
    };
  });
  return {
    schema: RELEASE_SEMANTIC_INPUT_SCHEMA,
    manifestPath: RELEASE_SEMANTIC_INPUTS_PATH,
    rules,
    products: [...new Set(rules.flatMap((rule) => rule.products))].sort(compareText),
  };
}

export function loadReleaseSemanticInputs(
  graph,
  { root, prefix = "release-semantic-inputs" } = {},
) {
  if (typeof root !== "string" || root.length === 0) {
    throw semanticError(prefix, "repository root is required");
  }
  const file = repositoryPath(root, RELEASE_SEMANTIC_INPUTS_PATH, prefix);
  let value;
  try {
    value = Bun.TOML.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw semanticError(prefix, `cannot parse ${RELEASE_SEMANTIC_INPUTS_PATH}: ${cause.message}`);
  }
  return parseReleaseSemanticInputs(value, graph, { root, prefix, checkPaths: true });
}

export function releaseSemanticProductsForPath(manifest, candidate, { prefix = "release-semantic-inputs" } = {}) {
  const normalized = normalizeCandidate(candidate, prefix);
  if (normalized === manifest.manifestPath) return [...manifest.products];
  const matches = manifest.rules.filter((rule) => rule.patterns.some((pattern) => patternMatches(pattern, normalized)));
  if (matches.length > 1) {
    throw semanticError(prefix, `${normalized} matches multiple release-semantic ownership rules`);
  }
  return matches[0] === undefined ? [] : [...matches[0].products];
}

export function releaseSemanticFingerprintPath(graph, product, { prefix = "release-semantic-inputs" } = {}) {
  const packagePath = graph?.products?.[product]?.path;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    throw semanticError(prefix, `${product} is missing its Release Please package path`);
  }
  return `${packagePath}/${RELEASE_SEMANTIC_FINGERPRINT_BASENAME}`;
}

export function releaseSemanticRepositoryFiles(
  root,
  prefix,
  { gitCommand = "git", gitCommandArgs = [] } = {},
) {
  let result;
  try {
    result = captureCommandOutput(
      gitCommand,
      [...gitCommandArgs, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        label: "git ls-files release-semantic inputs",
        stdoutTerminator: "\0",
      },
    );
  } catch (cause) {
    throw semanticError(prefix, `cannot inventory repository files: ${cause.message}`);
  }
  if (result.error !== undefined || result.status !== 0) {
    throw semanticError(
      prefix,
      `cannot inventory repository files: ${result.error?.message || result.stderr.trim() || `git exited ${result.status}`}`,
    );
  }
  if (result.stdout.length === 0) {
    throw semanticError(prefix, "cannot inventory repository files: git returned an empty inventory");
  }
  return [...new Set(result.stdout.split("\0").filter(Boolean).map((file) => normalizeCandidate(file, prefix)))]
    .sort(compareText);
}

function fileDigest(root, candidate, prefix) {
  const absolute = repositoryPath(root, candidate, prefix);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw semanticError(prefix, `semantic input must be a regular non-symlink file: ${candidate}`);
  }
  const resolvedRoot = realpathSync(root);
  const resolved = realpathSync(absolute);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw semanticError(prefix, `semantic input resolves outside the repository: ${candidate}`);
  }
  return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function releaseSemanticFingerprintDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function releaseSemanticFingerprints(
  graph,
  manifest,
  { root, prefix = "release-semantic-inputs" } = {},
) {
  const files = releaseSemanticRepositoryFiles(root, prefix);
  const matchedByRule = new Map();
  for (const rule of manifest.rules) {
    const matched = files.filter((file) => rule.patterns.some((pattern) => patternMatches(pattern, file)));
    if (matched.length === 0) {
      throw semanticError(prefix, `ownership rule ${rule.id} matches no repository files`);
    }
    matchedByRule.set(rule.id, matched);
  }
  const inputDigests = new Map();
  const digestFor = (file) => {
    if (!inputDigests.has(file)) inputDigests.set(file, fileDigest(root, file, prefix));
    return inputDigests.get(file);
  };
  const fingerprints = new Map();
  for (const product of manifest.products) {
    const rules = manifest.rules
      .filter((rule) => rule.products.includes(product))
      .map((rule) => ({
        id: rule.id,
        paths: rule.patterns.map((pattern) => pattern.raw),
        inputs: matchedByRule.get(rule.id).map((file) => ({ path: file, sha256: digestFor(file) })),
      }));
    const owned = {
      schema: RELEASE_SEMANTIC_FINGERPRINT_SCHEMA,
      product,
      ownershipSchema: manifest.schema,
      ownershipManifest: manifest.manifestPath,
      rules,
    };
    const sha256 = releaseSemanticFingerprintDigest(owned);
    fingerprints.set(product, { ...owned, sha256 });
  }
  return fingerprints;
}

export function releaseSemanticFingerprintText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function syncReleaseSemanticInputFingerprints(
  graph,
  {
    root,
    write = false,
    prefix = "release-semantic-inputs",
  } = {},
) {
  const manifest = loadReleaseSemanticInputs(graph, { root, prefix });
  const fingerprints = releaseSemanticFingerprints(graph, manifest, { root, prefix });
  const changes = [];
  for (const [product, fingerprint] of fingerprints) {
    const relative = releaseSemanticFingerprintPath(graph, product, { prefix });
    const absolute = repositoryPath(root, relative, prefix);
    const expected = releaseSemanticFingerprintText(fingerprint);
    const actual = existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
    if (actual === expected) continue;
    changes.push({ product, path: relative, expected, actual });
    if (write) {
      const temporary = `${absolute}.tmp-${process.pid}`;
      writeFileSync(temporary, expected, { encoding: "utf8", mode: 0o644, flag: "wx" });
      renameSync(temporary, absolute);
    }
  }
  return { manifest, fingerprints, changes };
}

export function assertReleaseSemanticInputsCurrent(
  graph,
  { root, prefix = "release-semantic-inputs" } = {},
) {
  const result = syncReleaseSemanticInputFingerprints(graph, { root, write: false, prefix });
  if (result.changes.length > 0) {
    throw semanticError(
      prefix,
      `release-semantic fingerprints are stale for ${result.changes.map((change) => change.product).join(", ")}; `
        + "run tools/dev/bun.sh tools/release/sync-release-semantic-inputs.mjs --write",
    );
  }
  return result;
}
