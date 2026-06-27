import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(import.meta.dir, "../..");
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const RELEASE_DEPENDENCY_SCOPES = new Set(["production", "peer"]);

const GENERATED_PATH_PARTS = new Set([
  ".build",
  ".cxx",
  ".expo",
  ".gradle",
  ".kotlin",
  ".moon",
  ".next",
  ".source",
  "DerivedData",
  "Pods",
  "__pycache__",
  "dist",
  "lib",
  "node_modules",
  "out",
  "target",
]);

export function fail(prefix, message) {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

export function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith("..") ? file : relative.split(path.sep).join("/");
}

export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function readJson(relativePath, prefix) {
  const value = JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${relativePath} must contain a JSON object`);
  }
  return value;
}

export function readToml(relativePath, prefix) {
  const file = path.join(ROOT, relativePath);
  if (!existsSync(file)) {
    fail(prefix, `missing ${relativePath}`);
  }
  const value = Bun.TOML.parse(readFileSync(file, "utf8"));
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${relativePath} must contain a TOML table`);
  }
  return value;
}

export function moonBin() {
  if (process.env.MOON_BIN) {
    return process.env.MOON_BIN;
  }
  const protoMoon = path.join(process.env.HOME ?? "", ".proto/bin/moon");
  return existsSync(protoMoon) ? protoMoon : "moon";
}

export function commandJson(args, prefix) {
  const output = execFileSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const value = JSON.parse(output);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${args[0]} did not return a JSON object`);
  }
  return value;
}

export function gitOutput(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

export function runGit(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

export function parseStableVersion(version, prefix = "release-graph") {
  const match = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)$/.exec(version);
  if (!match) {
    fail(prefix, `release version must be stable x.y.z for automated publish, got ${JSON.stringify(version)}`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function formatVersion(version) {
  return version.join(".");
}

export function assertStringList(value, context, prefix = "release-graph") {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(prefix, `${context} must be a string list`);
  }
  return value;
}

function releasePleasePackagesByComponent(prefix) {
  const config = readJson("release-please-config.json", prefix);
  const packages = config.packages;
  if (packages === null || Array.isArray(packages) || typeof packages !== "object") {
    fail(prefix, "release-please-config.json must define packages");
  }
  const byComponent = new Map();
  for (const [packagePath, packageConfig] of Object.entries(packages)) {
    if (packageConfig === null || Array.isArray(packageConfig) || typeof packageConfig !== "object") {
      fail(prefix, `${packagePath} release-please config must be an object`);
    }
    const component = packageConfig.component;
    if (typeof component !== "string" || component.length === 0) {
      fail(prefix, `${packagePath}.component must be a non-empty string`);
    }
    if (byComponent.has(component)) {
      fail(prefix, `duplicate release-please component ${component}`);
    }
    byComponent.set(component, { packagePath, packageConfig });
  }
  return { config, byComponent };
}

export function moonProjectsById(prefix = "release-graph") {
  const data = commandJson([moonBin(), "query", "projects"], prefix);
  const projects = data.projects;
  if (!Array.isArray(projects)) {
    fail(prefix, "moon query projects did not return a projects array");
  }
  const parsed = new Map();
  for (const project of projects) {
    if (project === null || Array.isArray(project) || typeof project !== "object" || typeof project.id !== "string") {
      continue;
    }
    const config = project.config && typeof project.config === "object" && !Array.isArray(project.config) ? project.config : {};
    const rawDeps = project.dependencies ?? config.dependsOn ?? [];
    const dependencyScopes = {};
    if (Array.isArray(rawDeps)) {
      for (const dependency of rawDeps) {
        if (typeof dependency === "string") {
          dependencyScopes[dependency] = "production";
        } else if (
          dependency !== null &&
          typeof dependency === "object" &&
          !Array.isArray(dependency) &&
          typeof dependency.id === "string"
        ) {
          dependencyScopes[dependency.id] = String(dependency.scope || "production");
        }
      }
    }
    parsed.set(project.id, {
      id: project.id,
      source: project.source || config.source || "",
      dependsOn: Object.keys(dependencyScopes).sort(compareText),
      dependencyScopes,
      tags: Array.isArray(config.tags) ? [...config.tags].sort(compareText) : [],
      project: config.project && typeof config.project === "object" && !Array.isArray(config.project) ? config.project : {},
    });
  }
  return parsed;
}

function moonReleaseProjectsByComponent(projects, prefix) {
  const products = new Map();
  for (const project of projects.values()) {
    const metadata =
      project.project &&
      typeof project.project === "object" &&
      !Array.isArray(project.project) &&
      project.project.metadata &&
      typeof project.project.metadata === "object" &&
      !Array.isArray(project.project.metadata)
        ? project.project.metadata
        : {};
    const release =
      metadata.release && typeof metadata.release === "object" && !Array.isArray(metadata.release)
        ? metadata.release
        : undefined;
    if (!project.tags.includes("release-product")) {
      if (release !== undefined) {
        fail(prefix, `Moon project ${project.id} declares release metadata but is not tagged release-product`);
      }
      continue;
    }
    if (release === undefined) {
      fail(prefix, `Moon release product ${project.id} must declare project.metadata.release`);
    }
    if (release.component !== project.id) {
      fail(prefix, `Moon release product ${project.id} release.component must match the project id`);
    }
    if (typeof release.packagePath !== "string" || release.packagePath.length === 0) {
      fail(prefix, `Moon release product ${project.id} must declare release.packagePath`);
    }
    if (products.has(release.component)) {
      fail(prefix, `duplicate Moon release component ${release.component}`);
    }
    products.set(release.component, {
      projectId: project.id,
      projectSource: project.source,
      path: release.packagePath,
      release,
    });
  }
  if (products.size === 0) {
    fail(prefix, "Moon project graph does not contain any release-product projects");
  }
  return products;
}

function releasePackagePaths(projects, prefix) {
  const { byComponent } = releasePleasePackagesByComponent(prefix);
  const moonProducts = moonReleaseProjectsByComponent(projects, prefix);
  const moonComponents = [...moonProducts.keys()].sort(compareText);
  const releaseComponents = [...byComponent.keys()].sort(compareText);
  if (JSON.stringify(moonComponents) !== JSON.stringify(releaseComponents)) {
    fail(
      prefix,
      `Moon release-product components must match release-please components: moon=${JSON.stringify(
        moonComponents,
      )}, release-please=${JSON.stringify(releaseComponents)}`,
    );
  }
  const paths = new Map();
  for (const component of moonComponents) {
    const moonPath = moonProducts.get(component).path;
    const releasePath = byComponent.get(component).packagePath;
    if (moonPath !== releasePath) {
      fail(
        prefix,
        `${component} Moon release.packagePath ${JSON.stringify(moonPath)} must match release-please package path ${JSON.stringify(
          releasePath,
        )}`,
      );
    }
    paths.set(component, moonPath);
  }
  return paths;
}

function releasePleasePackage(product, prefix) {
  const { byComponent } = releasePleasePackagesByComponent(prefix);
  const packageInfo = byComponent.get(product);
  if (!packageInfo) {
    fail(prefix, `unknown release-please component ${product}`);
  }
  return packageInfo;
}

function packageRelativePath(product, relativePath, context, prefix) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    fail(prefix, `${context} must be a non-empty path string`);
  }
  const { packagePath } = releasePleasePackage(product, prefix);
  const packageRoot = path.posix.normalize(packagePath.replaceAll("\\", "/"));
  const relative = relativePath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(path.posix.join(packageRoot, relative));
  if (
    path.posix.isAbsolute(relative) ||
    (normalized !== packageRoot && !normalized.startsWith(`${packageRoot}/`))
  ) {
    fail(prefix, `${context} must stay within the product package path`);
  }
  return normalized;
}

function requireExistingPath(relativePath, context, prefix) {
  if (!existsSync(path.join(ROOT, relativePath))) {
    fail(prefix, `${context} does not exist: ${relativePath}`);
  }
}

export function tagPrefix(product, prefix = "release-graph") {
  const { config } = releasePleasePackagesByComponent(prefix);
  const { packageConfig } = releasePleasePackage(product, prefix);
  if (packageConfig.component !== product) {
    fail(prefix, `${product} release-please component must match product id`);
  }
  if (config["include-v-in-tag"] !== true) {
    fail(prefix, "release-please must include v in product tags");
  }
  if (config["tag-separator"] !== "-") {
    fail(prefix, "release-please tag-separator must be '-'");
  }
  return `${product}-v`;
}

export function versionFiles(product, prefix = "release-graph") {
  const { packageConfig } = releasePleasePackage(product, prefix);
  const releaseType = packageConfig["release-type"];
  const versionFile = packageConfig["version-file"];
  let canonical;
  if (typeof versionFile === "string" && versionFile.length > 0) {
    canonical = packageRelativePath(product, versionFile, `${product}.version-file`, prefix);
  } else if (releaseType === "rust") {
    canonical = packageRelativePath(product, "Cargo.toml", `${product}.rust`, prefix);
  } else if (releaseType === "node" || releaseType === "expo") {
    canonical = packageRelativePath(product, "package.json", `${product}.node`, prefix);
  } else {
    fail(
      prefix,
      `${product} release-please config must declare version-file for release type ${JSON.stringify(releaseType)}`,
    );
  }

  const extraFiles = packageConfig["extra-files"] ?? [];
  if (!Array.isArray(extraFiles)) {
    fail(prefix, `${product}.extra-files must be a list`);
  }
  const files = [canonical];
  for (const [index, entry] of extraFiles.entries()) {
    const context = `${product}.extra-files[${index}]`;
    if (typeof entry === "string") {
      files.push(packageRelativePath(product, entry, context, prefix));
    } else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      files.push(packageRelativePath(product, entry.path, `${context}.path`, prefix));
    } else {
      fail(prefix, `${context} must be a path string or object`);
    }
  }
  for (const file of files) {
    requireExistingPath(file, `${product} version file`, prefix);
  }
  return files;
}

export function changelogPath(product, prefix = "release-graph") {
  const { packageConfig } = releasePleasePackage(product, prefix);
  const relative = packageConfig["changelog-path"] ?? "CHANGELOG.md";
  const changelog = packageRelativePath(product, relative, `${product}.changelog-path`, prefix);
  requireExistingPath(changelog, `${product} changelog`, prefix);
  return changelog;
}

function graphProducts(projects, prefix) {
  const paths = releasePackagePaths(projects, prefix);
  const manifest = readJson(".release-please-manifest.json", prefix);
  const products = {};
  for (const [product, packagePath] of [...paths.entries()].sort(([left], [right]) => compareText(left, right))) {
    const metadata = readToml(path.join(packagePath, "release.toml"), prefix);
    if (metadata.id !== product) {
      fail(prefix, `${packagePath}/release.toml must declare id = ${JSON.stringify(product)}`);
    }
    if (!(packagePath in manifest)) {
      fail(prefix, `.release-please-manifest.json is missing ${packagePath}`);
    }
    products[product] = {
      ...metadata,
      path: packagePath,
      changelog_path: changelogPath(product, prefix),
      derived_version_files: metadata.derived_version_files ?? [],
      tag_prefix: tagPrefix(product, prefix),
      version_files: versionFiles(product, prefix),
    };
  }
  return products;
}

export function loadGraph(prefix = "release-graph") {
  const moonProjects = moonProjectsById(prefix);
  return {
    policy: {
      repository: "f0rr0/oliphaunt",
      default_branch: "main",
      versioning: "independent",
    },
    products: graphProducts(moonProjects, prefix),
    moon_projects: Object.fromEntries(moonProjects),
  };
}

export function productConfigRows({ product = undefined } = {}, prefix = "release-graph") {
  const products = loadGraph(prefix).products;
  if (product !== undefined && !(product in products)) {
    fail(prefix, `unknown release product ${product}`);
  }
  return Object.entries(products)
    .filter(([productId]) => product === undefined || productId === product)
    .sort(([left], [right]) => compareText(left, right))
    .map(([productId, config]) => {
      if (config.id !== productId) {
        fail(prefix, `${productId} release metadata id must match product id`);
      }
      return {
        product: productId,
        ...config,
      };
    });
}

export function moonReleaseMetadataRows({ product = undefined } = {}, prefix = "release-graph") {
  const graph = loadGraph(prefix);
  const productIds = product === undefined ? Object.keys(graph.products).sort(compareText) : [product];
  if (product !== undefined && !(product in graph.products)) {
    fail(prefix, `unknown release product ${product}`);
  }
  return productIds.map((productId) => {
    const release = graph.moon_projects?.[productId]?.project?.metadata?.release;
    if (release === null || Array.isArray(release) || typeof release !== "object") {
      fail(prefix, `Moon release metadata does not include ${productId}`);
    }
    if (release.component !== productId) {
      fail(prefix, `Moon release metadata for ${productId} must use matching component`);
    }
    if (typeof release.packagePath !== "string" || release.packagePath.length === 0) {
      fail(prefix, `Moon release metadata for ${productId} must declare packagePath`);
    }
    return {
      product: productId,
      ...release,
    };
  });
}

function assertObject(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${context} must be a table`);
  }
  return value;
}

export function compatibilityVersionEntries(products, { requireSourceProduct = false, prefix = "release-graph" } = {}) {
  const source = products ?? loadGraph(prefix).products;
  const knownProducts = new Set(Object.keys(source));
  const entries = [];
  for (const [product, config] of Object.entries(source).sort(([left], [right]) => compareText(left, right))) {
    const rawSpecs = config.compatibility_versions ?? {};
    assertObject(rawSpecs, `${product}.compatibility_versions`, prefix);
    for (const [specId, spec] of Object.entries(rawSpecs).sort(([left], [right]) => compareText(left, right))) {
      if (!specId) {
        fail(prefix, `${product}.compatibility_versions keys must be non-empty strings`);
      }
      assertObject(spec, `${product}.compatibility_versions.${specId}`, prefix);
      const sourceProduct = spec.source_product;
      if (requireSourceProduct) {
        if (typeof sourceProduct !== "string" || sourceProduct.length === 0) {
          fail(prefix, `${product}.compatibility_versions.${specId}.source_product must be a non-empty string`);
        }
        if (!knownProducts.has(sourceProduct)) {
          fail(
            prefix,
            `${product}.compatibility_versions.${specId}.source_product must name a release product, got ${JSON.stringify(
              sourceProduct,
            )}`,
          );
        }
      } else if (sourceProduct !== undefined && typeof sourceProduct !== "string") {
        fail(prefix, `${product}.compatibility_versions.${specId}.source_product must be a string when present`);
      }
      const specPath = spec.path;
      const parser = spec.parser;
      if (typeof specPath !== "string" || specPath.length === 0) {
        fail(prefix, `${product}.compatibility_versions.${specId}.path must be a non-empty string`);
      }
      if (typeof parser !== "string" || parser.length === 0) {
        fail(prefix, `${product}.compatibility_versions.${specId}.parser must be a non-empty string`);
      }
      if (!existsSync(path.join(ROOT, specPath))) {
        fail(prefix, `${product}.compatibility_versions.${specId} path does not exist: ${specPath}`);
      }
      entries.push({
        id: specId,
        product,
        sourceProduct: typeof sourceProduct === "string" ? sourceProduct : null,
        path: specPath,
        parser,
      });
    }
  }
  return entries;
}

export function tagMatchPattern(prefix) {
  return prefix ? `${prefix}[0-9]*` : "[0-9]*";
}

export function tagPrefixes(config, prefix = "release-graph") {
  if (typeof config.tag_prefix !== "string" || config.tag_prefix.length === 0) {
    fail(prefix, "release products must declare tag_prefix");
  }
  const legacyPrefixes = config.legacy_tag_prefixes ?? [];
  assertStringList(legacyPrefixes, "legacy_tag_prefixes", prefix);
  return [config.tag_prefix, ...legacyPrefixes];
}

export function latestTagForPrefix(prefix, headRef) {
  const result = spawnSync("git", ["describe", "--tags", "--abbrev=0", "--match", tagMatchPattern(prefix), headRef], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function latestProductTag(productConfig, headRef, prefix = "release-graph") {
  for (const candidatePrefix of tagPrefixes(productConfig, prefix)) {
    const tag = latestTagForPrefix(candidatePrefix, headRef);
    if (tag) {
      return tag;
    }
  }
  return EMPTY_TREE;
}

export function commitForRef(ref) {
  return gitOutput(["rev-parse", `${ref}^{commit}`]);
}

export function changedFilesFromRefs(baseRef, headRef, prefix = "release-graph") {
  try {
    const output =
      baseRef === EMPTY_TREE
        ? runGit(["diff", "--name-only", baseRef, headRef, "--"])
        : runGit(["diff", "--name-only", `${baseRef}...${headRef}`, "--"]);
    return output.split(/\r?\n/).filter(Boolean).sort(compareText);
  } catch (error) {
    fail(prefix, `failed to read changed files between ${baseRef} and ${headRef}: ${error.message}`);
  }
}

export function isGeneratedLocalState(candidate) {
  if (candidate.startsWith("target/")) {
    return true;
  }
  return candidate.split(/[\\/]/).some((part) => GENERATED_PATH_PARTS.has(part));
}

export function normalizeFiles(files) {
  const normalized = new Set();
  for (const file of files) {
    let candidate = file.trim().replaceAll("\\", "/");
    if (candidate.startsWith("./")) {
      candidate = candidate.slice(2);
    }
    if (candidate && !isGeneratedLocalState(candidate)) {
      normalized.add(candidate);
    }
  }
  return [...normalized].sort(compareText);
}

function splitPatterns(patterns) {
  const includes = [];
  const excludes = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }
  return { includes, excludes };
}

function globPatternToRegExp(pattern) {
  let text = "";
  for (const char of pattern) {
    if (char === "*") {
      text += ".*";
    } else if ("\\^$+?.()|{}[]".includes(char)) {
      text += `\\${char}`;
    } else {
      text += char;
    }
  }
  return new RegExp(`^${text}$`, "u");
}

function matchesAny(candidate, patterns) {
  return patterns.some((pattern) => globPatternToRegExp(pattern).test(candidate));
}

export function productMatches(candidate, patterns) {
  const { includes, excludes } = splitPatterns(patterns);
  return matchesAny(candidate, includes) && !matchesAny(candidate, excludes);
}

export function ownerProjectForPath(projects, candidate) {
  if (isGeneratedLocalState(candidate)) {
    return undefined;
  }
  const matches = Object.values(projects)
    .filter(
      (project) =>
        project.source === "." || candidate === project.source || candidate.startsWith(`${project.source}/`),
    )
    .sort((left, right) => right.source.length - left.source.length);
  return matches[0]?.id;
}

export function dependentsByProject(projects, { releaseOnly = false } = {}) {
  const dependents = Object.fromEntries(Object.keys(projects).map((project) => [project, new Set()]));
  for (const [project, config] of Object.entries(projects)) {
    const scopes = config.dependencyScopes ?? {};
    for (const dependency of config.dependsOn ?? []) {
      if (releaseOnly && !RELEASE_DEPENDENCY_SCOPES.has(scopes[dependency] ?? "production")) {
        continue;
      }
      if (!(dependency in dependents)) {
        dependents[dependency] = new Set();
      }
      dependents[dependency].add(project);
    }
  }
  return dependents;
}

export function downstreamProjects(projects, direct, { releaseOnly = false } = {}) {
  const dependents = dependentsByProject(projects, { releaseOnly });
  const selected = new Set(direct);
  const queue = [...selected].sort(compareText);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const downstream of [...(dependents[current] ?? [])].sort(compareText)) {
      if (!selected.has(downstream)) {
        selected.add(downstream);
        queue.push(downstream);
      }
    }
  }
  return selected;
}

export function releaseProductProjectId(product, products, projects, prefix = "release-graph") {
  if (product in projects) {
    return product;
  }
  const packagePath = products[product]?.path;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    fail(prefix, `release product ${product} is missing package path metadata`);
  }
  const matches = Object.values(projects)
    .filter((project) => packagePath === project.source || packagePath.startsWith(`${project.source}/`))
    .sort((left, right) => right.source.length - left.source.length);
  if (matches.length === 0) {
    fail(prefix, `release product ${product} has no owning Moon project for ${packagePath}`);
  }
  return matches[0].id;
}

export function releaseProductsForProjects(products, projects, projectIds, prefix = "release-graph") {
  const selectedProjects = new Set(projectIds);
  const selected = new Set();
  for (const product of Object.keys(products)) {
    const projectId = releaseProductProjectId(product, products, projects, prefix);
    if (selectedProjects.has(projectId)) {
      selected.add(product);
    }
  }
  return selected;
}

export function releaseOrder(products, projects, selected, prefix = "release-graph") {
  const selectedSet = new Set(selected);
  const productProject = Object.fromEntries(
    Object.keys(products).map((product) => [product, releaseProductProjectId(product, products, projects, prefix)]),
  );
  const ordered = [];
  const remaining = new Set(selectedSet);
  while (remaining.size > 0) {
    const ready = [];
    for (const product of [...remaining].sort(compareText)) {
      const projectId = productProject[product];
      const projectConfig = projects[projectId] ?? {};
      const scopes = projectConfig.dependencyScopes ?? {};
      const deps = new Set(
        (projectConfig.dependsOn ?? []).filter((dependency) =>
          RELEASE_DEPENDENCY_SCOPES.has(scopes[dependency] ?? "production"),
        ),
      );
      const selectedDeps = Object.entries(productProject)
        .filter(([candidate, candidateProject]) => selectedSet.has(candidate) && deps.has(candidateProject))
        .map(([candidate]) => candidate);
      if (selectedDeps.every((dependency) => ordered.includes(dependency))) {
        ready.push(product);
      }
    }
    if (ready.length === 0) {
      fail(prefix, `Moon release product graph has a dependency cycle: ${JSON.stringify([...remaining].sort(compareText))}`);
    }
    for (const product of ready) {
      ordered.push(product);
      remaining.delete(product);
    }
  }
  return ordered;
}

export function docsOnlyChange(files) {
  return files.length > 0 && files.every(
    (file) => file.startsWith("docs/") || file.startsWith("src/docs/") || file === "README.md",
  );
}

export function buildPlan(graph, files, prefix = "release-graph") {
  const products = graph.products;
  const projects = graph.moon_projects;
  if (products === null || Array.isArray(products) || typeof products !== "object") {
    fail(prefix, "release metadata must define [products.<id>] entries");
  }
  if (projects === null || Array.isArray(projects) || typeof projects !== "object") {
    fail(prefix, "Moon project graph is missing from release plan metadata");
  }
  const directProjects = new Set(
    files.map((file) => ownerProjectForPath(projects, file)).filter((project) => project !== undefined),
  );
  const affectedProjects = downstreamProjects(projects, directProjects);
  const releaseProjects = downstreamProjects(projects, directProjects, { releaseOnly: true });
  const releaseProductSet = releaseProductsForProjects(products, projects, releaseProjects, prefix);
  const releaseProducts = releaseOrder(products, projects, releaseProductSet, prefix);
  const releaseProductProjects = new Set(
    releaseProducts.map((product) => releaseProductProjectId(product, products, projects, prefix)),
  );
  const direct = releaseOrder(
    products,
    projects,
    releaseProductsForProjects(products, projects, directProjects, prefix),
    prefix,
  );
  return finalizePlan({
    changedFiles: files,
    directProducts: direct,
    releaseProducts,
    directMoonProjects: [...directProjects].sort(compareText),
    affectedMoonProjects: [...affectedProjects].sort(compareText),
    releaseMoonProjects: [...releaseProductProjects].sort(compareText),
    productIds: Object.keys(products),
    hasReleaseChanges: releaseProducts.length > 0,
    docsOnly: releaseProducts.length === 0 && docsOnlyChange(files),
    versioning: graph.policy?.versioning ?? "independent",
    extensionSelection: "exact-sql-extension",
  });
}

export function buildPlanFromProductTags(graph, headRef, { includeCurrentTags = false, prefix = "release-graph" } = {}) {
  const products = graph.products;
  const direct = new Set();
  const changed = new Set();
  const productBaseRefs = {};
  const currentTaggedProducts = new Set();
  const headCommit = includeCurrentTags ? commitForRef(headRef) : "";

  for (const [product, config] of Object.entries(products)) {
    const baseRef = latestProductTag(config, headRef, prefix);
    productBaseRefs[product] = baseRef;
    if (includeCurrentTags && baseRef !== EMPTY_TREE) {
      const tagCommit = commitForRef(baseRef);
      if (tagCommit === headCommit) {
        direct.add(product);
        currentTaggedProducts.add(product);
        continue;
      }
    }
    const productFiles = changedFilesFromRefs(baseRef, headRef, prefix);
    for (const file of productFiles) {
      changed.add(file);
    }
    const productPlan = buildPlan(graph, normalizeFiles(productFiles), prefix);
    if (productPlan.releaseProducts.includes(product)) {
      direct.add(product);
    }
  }

  const projects = graph.moon_projects;
  const directProjects = new Set(
    [...direct].map((product) => releaseProductProjectId(product, products, projects, prefix)),
  );
  const affectedProjects = downstreamProjects(projects, directProjects);
  const releaseProjects = downstreamProjects(projects, directProjects, { releaseOnly: true });
  const releaseProducts = releaseOrder(
    products,
    projects,
    releaseProductsForProjects(products, projects, releaseProjects, prefix),
    prefix,
  );
  return finalizePlan({
    changedFiles: [...changed].sort(compareText),
    directProducts: releaseOrder(products, projects, direct, prefix),
    releaseProducts,
    directMoonProjects: [...directProjects].sort(compareText),
    affectedMoonProjects: [...affectedProjects].sort(compareText),
    releaseMoonProjects: [...releaseProjects].sort(compareText),
    productIds: Object.keys(products),
    hasReleaseChanges: releaseProducts.length > 0,
    docsOnly: releaseProducts.length === 0 && docsOnlyChange([...changed]),
    versioning: graph.policy?.versioning ?? "independent",
    extensionSelection: "exact-sql-extension",
    productBaseRefs,
    currentTaggedProducts: [...currentTaggedProducts].sort(compareText),
  });
}

export function releaseProductsSlug(products) {
  if (products.length === 0) {
    return "none";
  }
  const shortNames = {
    "liboliphaunt-native": "native",
  };
  return products.map((product) => shortNames[product] ?? product.replace("oliphaunt-", "")).join("-");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function finalizePlan(plan) {
  const hashInput = {
    changedFiles: plan.changedFiles ?? [],
    directProducts: plan.directProducts ?? [],
    releaseProducts: plan.releaseProducts ?? [],
    productBaseRefs: plan.productBaseRefs ?? {},
    currentTaggedProducts: plan.currentTaggedProducts ?? [],
  };
  const digest = crypto.createHash("sha256").update(stableJson(hashInput)).digest("hex").slice(0, 12);
  plan.planHash = digest;
  plan.releaseBranch = `release/${releaseProductsSlug(plan.releaseProducts ?? [])}-${digest}`;
  return plan;
}
