import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  RELEASE_DEPENDENCY_SCOPES,
  releaseOrder,
  runtimeTiedContribProducts,
} from "./release-graph.mjs";

const STABLE_VERSION = /^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u;
const VERSION_IN_MARKER = /(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)/gu;
const TOML_TABLE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(prefix, message) {
  return new Error(`${prefix}: ${message}`);
}

function object(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(prefix, `${context} must be an object`);
  }
  return value;
}

function stableVersion(value, context, prefix) {
  if (typeof value !== "string" || !STABLE_VERSION.test(value)) {
    throw error(prefix, `${context} must be a stable x.y.z version, got ${JSON.stringify(value)}`);
  }
  const parsed = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parsed.some((part) => !Number.isSafeInteger(part))) {
    throw error(prefix, `${context} contains a numeric component outside JavaScript's safe integer range`);
  }
  return parsed;
}

function patchVersion(value, context, prefix) {
  const [major, minor, patch] = stableVersion(value, context, prefix);
  if (major === 0 && minor === 0 && patch === 0) {
    throw error(
      prefix,
      `${context} is still 0.0.0; Release Please must create its first release candidate instead of ` +
        "letting dependent-candidate synchronization invent a first-release version",
    );
  }
  if (patch >= Number.MAX_SAFE_INTEGER) {
    throw error(prefix, `${context} cannot be patch-incremented safely`);
  }
  return `${major}.${minor}.${patch + 1}`;
}

function productProjectId(product, products, projects, prefix) {
  if (product in projects) return product;
  const packagePath = products[product]?.path;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    throw error(prefix, `${product} is missing release package path metadata`);
  }
  const matches = Object.entries(projects)
    .filter(([, project]) =>
      typeof project?.source === "string" &&
      (packagePath === project.source || packagePath.startsWith(`${project.source}/`)))
    .sort((left, right) => right[1].source.length - left[1].source.length || compareText(left[0], right[0]));
  if (matches.length === 0) {
    throw error(prefix, `${product} has no owning Moon project for ${packagePath}`);
  }
  return matches[0][0];
}

function edgeKey(edge) {
  return [edge.source, edge.target, edge.kind, edge.id].join("\u0000");
}

function reasonKey(reason) {
  return [reason.sourceProduct, reason.kind, reason.id].join("\u0000");
}

function compareEdges(left, right) {
  return compareText(edgeKey(left), edgeKey(right));
}

/**
 * Build the only dependency directions that can require another release:
 * dependency -> Moon production/peer consumer and compatibility source -> owner.
 * Build/dev/test Moon scopes and reverse compatibility traversal are excluded.
 */
export function dependentReleaseEdges(
  graph,
  { prefix = "release-dependent-candidates" } = {},
) {
  object(graph, "release graph", prefix);
  const products = object(graph.products, "release graph products", prefix);
  const projects = object(graph.moon_projects, "release graph Moon projects", prefix);
  const productIds = Object.keys(products).sort(compareText);
  const productProjects = Object.fromEntries(
    productIds.map((product) => [product, productProjectId(product, products, projects, prefix)]),
  );
  const productsByProject = new Map();
  for (const product of productIds) {
    const project = productProjects[product];
    productsByProject.set(project, [...(productsByProject.get(project) ?? []), product].sort(compareText));
  }

  const edges = [];
  for (const target of productIds) {
    const targetProject = productProjects[target];
    const project = object(projects[targetProject], `Moon project ${targetProject}`, prefix);
    const scopes = project.dependencyScopes ?? {};
    if (scopes === null || Array.isArray(scopes) || typeof scopes !== "object") {
      throw error(prefix, `Moon project ${targetProject}.dependencyScopes must be an object`);
    }
    const dependencies = project.dependsOn ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string")) {
      throw error(prefix, `Moon project ${targetProject}.dependsOn must be a string list`);
    }
    for (const dependencyProject of [...new Set(dependencies)].sort(compareText)) {
      const scope = scopes[dependencyProject] ?? "production";
      if (!RELEASE_DEPENDENCY_SCOPES.has(scope)) continue;
      for (const source of productsByProject.get(dependencyProject) ?? []) {
        if (source === target) continue;
        edges.push({
          source,
          target,
          kind: "moon",
          id: `${dependencyProject}->${targetProject}:${scope}`,
          scope,
          sourceProject: dependencyProject,
          targetProject,
        });
      }
    }
  }

  for (const target of productIds) {
    const specs = products[target].compatibility_versions ?? {};
    if (specs === null || Array.isArray(specs) || typeof specs !== "object") {
      throw error(prefix, `${target}.compatibility_versions must be an object`);
    }
    for (const [specId, spec] of Object.entries(specs).sort(([left], [right]) => compareText(left, right))) {
      object(spec, `${target}.compatibility_versions.${specId}`, prefix);
      const source = spec.source_product;
      if (typeof source !== "string" || !(source in products)) {
        throw error(
          prefix,
          `${target}.compatibility_versions.${specId}.source_product must name a release product`,
        );
      }
      if (source === target) continue;
      edges.push({
        source,
        target,
        kind: "compatibility",
        id: specId,
      });
    }
  }

  const tied = runtimeTiedContribProducts(products, prefix);
  for (const source of tied) {
    for (const target of tied) {
      if (source === target) continue;
      edges.push({
        source,
        target,
        kind: "linked-runtime",
        id: "liboliphaunt-runtime",
      });
    }
  }

  return [...new Map(edges.sort(compareEdges).map((edge) => [edgeKey(edge), edge])).values()];
}

/** Compute the deterministic fixed point without assigning versions. */
export function dependentReleaseClosure(
  graph,
  directProducts,
  { prefix = "release-dependent-candidates" } = {},
) {
  if (
    !Array.isArray(directProducts) ||
    directProducts.some((product) => typeof product !== "string" || product.length === 0)
  ) {
    throw error(prefix, "direct release products must be a string list");
  }
  if (new Set(directProducts).size !== directProducts.length) {
    throw error(prefix, "direct release products must not contain duplicates");
  }
  const products = object(graph?.products, "release graph products", prefix);
  const projects = object(graph?.moon_projects, "release graph Moon projects", prefix);
  const direct = [...directProducts].sort(compareText);
  const unknown = direct.filter((product) => !(product in products));
  if (unknown.length > 0) {
    throw error(prefix, `direct release products are absent from the release graph: ${unknown.join(", ")}`);
  }
  const edges = dependentReleaseEdges(graph, { prefix });
  const required = new Set(direct);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (required.has(edge.source) && !required.has(edge.target)) {
        required.add(edge.target);
        changed = true;
      }
    }
  }

  const requiredProducts = releaseOrder(products, projects, required, prefix);
  const directSet = new Set(direct);
  const reasons = {};
  for (const product of requiredProducts) {
    if (directSet.has(product)) continue;
    reasons[product] = edges
      .filter((edge) => edge.target === product && required.has(edge.source))
      .map((edge) => ({
        sourceProduct: edge.source,
        kind: edge.kind,
        id: edge.id,
        ...(edge.scope === undefined ? {} : { scope: edge.scope }),
        ...(edge.sourceProject === undefined ? {} : { sourceProject: edge.sourceProject }),
        ...(edge.targetProject === undefined ? {} : { targetProject: edge.targetProject }),
      }))
      .sort((left, right) => compareText(reasonKey(left), reasonKey(right)));
    if (reasons[product].length === 0) {
      throw error(prefix, `${product} entered the dependent release closure without a dependency reason`);
    }
  }
  return {
    directProducts: direct,
    missingProducts: requiredProducts.filter((product) => !directSet.has(product)),
    reasons,
    requiredProducts,
  };
}

/**
 * Attach the final release fixed point to a Moon build-impact plan without
 * changing the long-standing `releaseProducts` meaning used by CI task
 * selection. Callers that prepare or describe publication must consume
 * `requiredReleaseProducts`; `releaseProducts`/`buildImpactProducts` are only
 * the products selected by Moon ownership and release dependency scopes.
 */
export function withDependentReleaseClosure(
  graph,
  plan,
  { prefix = "release-dependent-candidates" } = {},
) {
  object(plan, "Moon build-impact plan", prefix);
  if (
    !Array.isArray(plan.releaseProducts)
    || plan.releaseProducts.some((product) => typeof product !== "string" || product.length === 0)
  ) {
    throw error(prefix, "Moon build-impact plan.releaseProducts must be a string list");
  }
  const closure = dependentReleaseClosure(graph, plan.releaseProducts, { prefix });
  return {
    ...plan,
    releaseProductsScope: "moon-build-impact",
    buildImpactProducts: [...plan.releaseProducts],
    requiredReleaseProducts: closure.requiredProducts,
    dependentReleaseProducts: closure.missingProducts,
    dependentReleaseReasons: closure.reasons,
    dependencyClosed: closure.missingProducts.length === 0,
  };
}

/**
 * Preserve every Release Please candidate exactly and assign patch versions
 * only to otherwise-missing, already-released dependents.
 */
export function planDependentReleaseCandidates(
  graph,
  transitions,
  { prefix = "release-dependent-candidates" } = {},
) {
  if (!Array.isArray(transitions) || transitions.length === 0) {
    throw error(prefix, "Release Please transitions must be a non-empty list");
  }
  const byProduct = new Map();
  for (const transition of transitions) {
    object(transition, "Release Please transition", prefix);
    const product = transition.product;
    if (typeof product !== "string" || product.length === 0 || byProduct.has(product)) {
      throw error(prefix, `Release Please transitions have a missing or duplicate product ${JSON.stringify(product)}`);
    }
    stableVersion(transition.after, `${product} Release Please candidate`, prefix);
    if (!(product in graph.products)) {
      throw error(prefix, `Release Please transition names unknown product ${product}`);
    }
    if (graph.products[product].version !== transition.after) {
      throw error(
        prefix,
        `${product} graph version ${JSON.stringify(graph.products[product].version)} does not match ` +
          `Release Please candidate ${transition.after}`,
      );
    }
    byProduct.set(product, transition);
  }

  const tied = runtimeTiedContribProducts(graph.products, prefix);
  if (tied.some((product) => byProduct.has(product))) {
    const missing = tied.filter((product) => !byProduct.has(product));
    if (missing.length > 0) {
      throw error(
        prefix,
        `Release Please linked runtime candidates are incomplete; missing ${missing.join(", ")}`,
      );
    }
    const versions = new Set(tied.map((product) => byProduct.get(product).after));
    if (versions.size !== 1) {
      throw error(
        prefix,
        `Release Please linked runtime candidates must share one version, got ${[...versions].sort(compareText).join(", ")}`,
      );
    }
  }

  const closure = dependentReleaseClosure(graph, [...byProduct.keys()], { prefix });
  const versions = new Map([...byProduct].map(([product, transition]) => [product, transition.after]));
  for (const product of closure.missingProducts) {
    const current = graph.products[product]?.version;
    versions.set(product, patchVersion(current, `${product} current version`, prefix));
  }
  const candidates = closure.missingProducts.map((product) => ({
    product,
    packagePath: graph.products[product].path,
    before: graph.products[product].version,
    after: versions.get(product),
    reasons: closure.reasons[product].map((reason) => ({
      ...reason,
      sourceVersion: versions.get(reason.sourceProduct),
    })),
  }));
  return { ...closure, candidates };
}

function packageRelative(packagePath, relativePath, context, prefix) {
  if (
    typeof packagePath !== "string" || packagePath.length === 0 || path.posix.isAbsolute(packagePath) ||
    typeof relativePath !== "string" || relativePath.length === 0 || path.posix.isAbsolute(relativePath)
  ) {
    throw error(prefix, `${context} must use non-empty relative package paths`);
  }
  const packageRoot = path.posix.normalize(packagePath.replaceAll("\\", "/"));
  const file = path.posix.normalize(path.posix.join(packageRoot, relativePath.replaceAll("\\", "/")));
  if (file !== packageRoot && !file.startsWith(`${packageRoot}/`)) {
    throw error(prefix, `${context} must stay inside ${packageRoot}`);
  }
  return file;
}

function jsonPathParts(expression, context, prefix) {
  if (typeof expression !== "string" || !/^[$][.][A-Za-z0-9_.-]+$/u.test(expression)) {
    throw error(prefix, `${context} must use a simple $.path JSONPath`);
  }
  return expression.slice(2).split(".");
}

function packageDescriptors(product, graphProduct, packagePath, config, prefix) {
  const releaseType = config["release-type"];
  const versionFile = config["version-file"];
  let canonical;
  if (typeof versionFile === "string" && versionFile.length > 0) {
    canonical = { path: packageRelative(packagePath, versionFile, `${product}.version-file`, prefix), type: "raw" };
  } else if (releaseType === "rust") {
    canonical = {
      path: packageRelative(packagePath, "Cargo.toml", `${product}.Cargo.toml`, prefix),
      type: "toml",
      parts: ["package", "version"],
    };
  } else if (releaseType === "node" || releaseType === "expo") {
    canonical = {
      path: packageRelative(packagePath, "package.json", `${product}.package.json`, prefix),
      type: "json",
      parts: ["version"],
    };
  } else {
    throw error(prefix, `${product} has no supported canonical version file declaration`);
  }

  const rawExtraFiles = config["extra-files"] ?? [];
  if (!Array.isArray(rawExtraFiles)) {
    throw error(prefix, `${product}.extra-files must be a list`);
  }
  const extra = rawExtraFiles.map((entry, index) => {
    const context = `${product}.extra-files[${index}]`;
    if (typeof entry === "string") {
      return { path: packageRelative(packagePath, entry, context, prefix), type: "generic" };
    }
    object(entry, context, prefix);
    const type = entry.type ?? "generic";
    if (!["generic", "json", "toml"].includes(type)) {
      throw error(prefix, `${context}.type ${JSON.stringify(type)} is unsupported`);
    }
    return {
      path: packageRelative(packagePath, entry.path, `${context}.path`, prefix),
      type,
      ...((type === "json" || type === "toml")
        ? { parts: jsonPathParts(entry.jsonpath, `${context}.jsonpath`, prefix) }
        : {}),
    };
  });
  const descriptors = [canonical, ...extra];
  const paths = descriptors.map((descriptor) => descriptor.path);
  if (new Set(paths).size !== paths.length) {
    throw error(prefix, `${product} release-please version files must not contain duplicates`);
  }
  const graphPaths = graphProduct.version_files;
  if (!Array.isArray(graphPaths) || graphPaths.some((file) => typeof file !== "string")) {
    throw error(prefix, `${product}.version_files must be a string list`);
  }
  if (
    JSON.stringify([...paths].sort(compareText)) !==
    JSON.stringify([...graphPaths].sort(compareText))
  ) {
    throw error(
      prefix,
      `${product} graph version files must exactly match release-please declarations: ` +
        `graph=${JSON.stringify([...graphPaths].sort(compareText))} ` +
        `releasePlease=${JSON.stringify([...paths].sort(compareText))}`,
    );
  }
  return descriptors;
}

function replaceRaw(text, before, after, context, prefix) {
  if (text.trim() !== before) {
    throw error(prefix, `${context} contains ${JSON.stringify(text.trim())}, expected ${before}`);
  }
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) >= 0) {
    throw error(prefix, `${context} must contain its current version exactly once`);
  }
  return `${text.slice(0, index)}${after}${text.slice(index + before.length)}`;
}

function setObjectPath(value, parts, before, after, context, prefix) {
  let cursor = object(value, context, prefix);
  for (const part of parts.slice(0, -1)) {
    if (!(part in cursor)) throw error(prefix, `${context} is missing path ${parts.join(".")}`);
    cursor = object(cursor[part], `${context}.${part}`, prefix);
  }
  const key = parts.at(-1);
  if (cursor[key] !== before) {
    throw error(prefix, `${context}.${parts.join(".")} contains ${JSON.stringify(cursor[key])}, expected ${before}`);
  }
  cursor[key] = after;
}

function replaceJson(text, parts, before, after, context, prefix) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw error(prefix, `${context} is invalid JSON: ${cause.message}`);
  }
  setObjectPath(value, parts, before, after, context, prefix);
  return `${JSON.stringify(value, null, 2)}\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceToml(text, parts, before, after, context, prefix) {
  if (parts.length < 2) {
    throw error(prefix, `${context} TOML path must include a table and key`);
  }
  const table = parts.slice(0, -1).join(".");
  const key = parts.at(-1);
  const pattern = new RegExp(
    `^(\\s*${escapeRegExp(key)}\\s*=\\s*)(["'])${escapeRegExp(before)}\\2(\\s*(?:#.*)?)$`,
    "u",
  );
  const lines = text.split(/(?<=\n)/u);
  let currentTable = "";
  let matched = 0;
  for (const [index, line] of lines.entries()) {
    const newline = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = line.slice(0, line.length - newline.length);
    const tableMatch = TOML_TABLE.exec(body);
    if (tableMatch !== null) {
      currentTable = tableMatch[1].trim();
      continue;
    }
    if (currentTable !== table) continue;
    const match = pattern.exec(body);
    if (match === null) {
      if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u").test(body)) {
        throw error(prefix, `${context}.${parts.join(".")} does not equal ${before}`);
      }
      continue;
    }
    matched += 1;
    lines[index] = `${match[1]}${match[2]}${after}${match[2]}${match[3]}${newline}`;
  }
  if (matched !== 1) {
    throw error(prefix, `${context} must contain exactly one TOML string at ${parts.join(".")}`);
  }
  return lines.join("");
}

function replaceGeneric(text, before, after, context, prefix) {
  const markedLines = text.split(/\r?\n/u).filter((line) => line.includes("x-release-please-version"));
  if (markedLines.length === 1) {
    const versions = markedLines[0].match(VERSION_IN_MARKER) ?? [];
    if (versions.length !== 1 || versions[0] !== before) {
      throw error(prefix, `${context} version marker must own exactly the current version ${before}`);
    }
    return text.replace(markedLines[0], markedLines[0].replace(before, after));
  }
  const blockMatch = /x-release-please-start-version(?<body>[\s\S]*?)x-release-please-end/u.exec(text);
  const body = blockMatch?.groups?.body;
  const versions = body?.match(VERSION_IN_MARKER) ?? [];
  if (markedLines.length !== 0 || body === undefined || versions.length !== 1 || versions[0] !== before) {
    throw error(prefix, `${context} must have one Release Please marker or marker block owning ${before}`);
  }
  return text.replace(body, body.replace(before, after));
}

function changelogHeadingVersion(line) {
  return line.match(/^##[ \t]+(?:\[)?([^\] (]+)(?:\])?(?:[ \t(]|$)/u)?.[1];
}

function reasonText(reason) {
  if (reason.kind === "moon") {
    return (
      `align with \`${reason.sourceProduct}\` ${reason.sourceVersion} ` +
      `(Moon ${reason.scope} dependency: \`${reason.sourceProject}\` -> \`${reason.targetProject}\`)`
    );
  }
  if (reason.kind === "compatibility") {
    return (
      `align with \`${reason.sourceProduct}\` ${reason.sourceVersion} ` +
      `(release compatibility field \`${reason.id}\`)`
    );
  }
  return (
    `align with \`${reason.sourceProduct}\` ${reason.sourceVersion} ` +
    `(linked runtime group \`${reason.id}\`)`
  );
}

function updateChangelog(text, candidate, context, prefix) {
  const lines = text.split(/\r?\n/u);
  if (lines.some((line) => changelogHeadingVersion(line) === candidate.after)) {
    throw error(prefix, `${context} already contains release heading ${candidate.after}`);
  }
  if (!lines.some((line) => changelogHeadingVersion(line) === candidate.before)) {
    throw error(
      prefix,
      `${context} has no prior release heading for ${candidate.before}; dependent synthesis is post-first-release only`,
    );
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const bullets = candidate.reasons
    .map((reason) => `* **dependencies:** ${reasonText(reason)}`)
    .join(newline);
  const entry = [`## ${candidate.after}`, "", "### Dependencies", "", bullets].join(newline);
  const heading = /^# [^\r\n]+(?:\r?\n|$)/u.exec(text);
  if (heading === null) {
    return `${entry}${newline}${newline}${text}`;
  }
  const remainder = text.slice(heading[0].length).replace(/^(?:\r?\n)*/u, "");
  return `${heading[0]}${newline}${entry}${newline}${newline}${remainder}`;
}

function stageFile(root, relativePath, updated, detail, changes, prefix) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw error(prefix, `${relativePath} escapes the repository root`);
  }
  if (!existsSync(absolute)) throw error(prefix, `missing ${relativePath}`);
  const before = readFileSync(absolute, "utf8");
  const next = updated(before);
  if (next === before) throw error(prefix, `${relativePath} did not change while applying ${detail}`);
  changes.push({ path: absolute, detail, text: next });
}

function packagesByProduct(releasePleaseConfig, prefix) {
  const packages = object(releasePleaseConfig?.packages, "release-please packages", prefix);
  const byProduct = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages).sort(([left], [right]) => compareText(left, right))) {
    object(packageConfig, `release-please package ${packagePath}`, prefix);
    const product = packageConfig.component;
    if (typeof product !== "string" || product.length === 0 || byProduct.has(product)) {
      throw error(prefix, `release-please package ${packagePath} has a missing or duplicate component`);
    }
    byProduct.set(product, { packagePath, packageConfig });
  }
  return byProduct;
}

/**
 * Apply (or report in check mode) candidate manifest, version-file, extra-file,
 * and changelog updates using only the declarations Release Please already owns.
 */
export function synchronizeDependentReleaseCandidates({
  root,
  graph,
  transitions,
  releasePleaseConfig,
  manifest,
  write = false,
  prefix = "release-dependent-candidates",
}) {
  if (typeof root !== "string" || root.length === 0) throw error(prefix, "root must be a path");
  const manifestObject = object(manifest, ".release-please-manifest.json", prefix);
  const packages = packagesByProduct(releasePleaseConfig, prefix);
  const plan = planDependentReleaseCandidates(graph, transitions, { prefix });
  const changes = [];
  if (plan.candidates.length === 0) return { ...plan, changes };

  const nextManifest = { ...manifestObject };
  const manifestDetails = [];
  for (const candidate of plan.candidates) {
    const packageInfo = packages.get(candidate.product);
    if (packageInfo === undefined) {
      throw error(prefix, `${candidate.product} is missing from release-please-config.json`);
    }
    const { packagePath, packageConfig } = packageInfo;
    if (packagePath !== candidate.packagePath) {
      throw error(
        prefix,
        `${candidate.product} graph path ${JSON.stringify(candidate.packagePath)} does not match ` +
          `release-please path ${JSON.stringify(packagePath)}`,
      );
    }
    if (nextManifest[packagePath] !== candidate.before) {
      throw error(
        prefix,
        `${candidate.product} manifest contains ${JSON.stringify(nextManifest[packagePath])}, expected ${candidate.before}`,
      );
    }
    nextManifest[packagePath] = candidate.after;
    manifestDetails.push(`${candidate.product} ${candidate.before} -> ${candidate.after}`);

    const descriptors = packageDescriptors(
      candidate.product,
      graph.products[candidate.product],
      packagePath,
      packageConfig,
      prefix,
    );
    for (const descriptor of descriptors) {
      const detail = `${candidate.product} dependent candidate ${candidate.before} -> ${candidate.after}`;
      stageFile(
        root,
        descriptor.path,
        (text) => {
          if (descriptor.type === "raw") {
            return replaceRaw(text, candidate.before, candidate.after, descriptor.path, prefix);
          }
          if (descriptor.type === "json") {
            return replaceJson(text, descriptor.parts, candidate.before, candidate.after, descriptor.path, prefix);
          }
          if (descriptor.type === "toml") {
            return replaceToml(text, descriptor.parts, candidate.before, candidate.after, descriptor.path, prefix);
          }
          return replaceGeneric(text, candidate.before, candidate.after, descriptor.path, prefix);
        },
        detail,
        changes,
        prefix,
      );
    }

    const changelog = packageRelative(
      packagePath,
      packageConfig["changelog-path"] ?? "CHANGELOG.md",
      `${candidate.product}.changelog-path`,
      prefix,
    );
    if (graph.products[candidate.product].changelog_path !== changelog) {
      throw error(
        prefix,
        `${candidate.product} graph changelog ${JSON.stringify(graph.products[candidate.product].changelog_path)} ` +
          `does not match release-please changelog ${JSON.stringify(changelog)}`,
      );
    }
    stageFile(
      root,
      changelog,
      (text) => updateChangelog(text, candidate, changelog, prefix),
      `${candidate.product} dependency-only changelog for ${candidate.after}`,
      changes,
      prefix,
    );
  }

  stageFile(
    root,
    ".release-please-manifest.json",
    () => `${JSON.stringify(nextManifest, null, 2)}\n`,
    manifestDetails.join("; "),
    changes,
    prefix,
  );
  const duplicatePaths = changes
    .map(({ path: file }) => file)
    .filter((file, index, files) => files.indexOf(file) !== index);
  if (duplicatePaths.length > 0) {
    throw error(prefix, `dependent candidate outputs overlap: ${[...new Set(duplicatePaths)].join(", ")}`);
  }
  if (write) {
    for (const change of changes) writeFileSync(change.path, change.text, "utf8");
  }
  return {
    ...plan,
    changes: changes.map(({ path: file, detail }) => ({ path: file, detail })),
  };
}
