import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { moonCommand } from "../dev/moon-command.mjs";
import { captureCommandOutput } from "../dev/capture-command-output.mjs";
import {
  loadReleaseSemanticInputs,
  releaseSemanticProductsForPath,
} from "./release-semantic-inputs.mjs";

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
  return moonCommand();
}

export function commandJson(args, prefix) {
  const result = captureCommandOutput(args[0], args.slice(1), {
    cwd: ROOT,
    label: args.join(" "),
    maxOutputBytes: 100 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    fail(prefix, `${args[0]} failed: ${detail}`);
  }
  const value = JSON.parse(result.stdout);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${args[0]} did not return a JSON object`);
  }
  return value;
}

function gitNulRecords(args) {
  try {
    const result = captureCommandOutput("git", args, {
      cwd: ROOT,
      label: `git ${args.join(" ")}`,
      stdoutTerminator: "\0",
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr.trim() || `git exited ${result.status}`);
    }
    return result.stdout
      .split("\0")
      .filter(Boolean);
  } catch (error) {
    const detail = error.stderr || error.stdout || error.message;
    fail("release-graph", `git ${args.join(" ")} failed: ${String(detail).trim()}`);
  }
}

export function gitSucceeds(args) {
  const result = spawnSync("git", args, { cwd: ROOT, stdio: "ignore" });
  return result.status === 0;
}

export function gitOutput(args) {
  const result = captureCommandOutput("git", args, {
    cwd: ROOT,
    label: `git ${args.join(" ")}`,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `git exited ${result.status}`);
  }
  return result.stdout.trim();
}

export function runGit(args) {
  const result = captureCommandOutput("git", args, {
    cwd: ROOT,
    label: `git ${args.join(" ")}`,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr.trim() || `git exited ${result.status}`);
  }
  return result.stdout;
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

function addDependency(dependencyScopes, projectId, scope) {
  if (!projectId || scope === undefined) {
    return;
  }
  const existing = dependencyScopes[projectId];
  if (existing === "production" && scope !== "production") {
    return;
  }
  dependencyScopes[projectId] = scope;
}

function parseTaskDependencyProject(target) {
  if (typeof target !== "string" || target.length === 0 || target.startsWith("^")) {
    return undefined;
  }
  const separator = target.indexOf(":");
  return separator > 0 ? target.slice(0, separator) : undefined;
}

function readMoonProjectConfig(file, prefix) {
  const pathParts = file.split("/");
  const source = pathParts.length === 1 ? "." : pathParts.slice(0, -1).join("/");
  let config;
  try {
    config = Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf8"));
  } catch (error) {
    fail(prefix, `${file} is invalid Moon project YAML: ${error.message}`);
  }
  if (config === null || Array.isArray(config) || typeof config !== "object") {
    fail(prefix, `${file} must contain a Moon project object`);
  }
  const id = config.id;
  if (typeof id !== "string" || id.length === 0) {
    fail(prefix, `${file} must declare a non-empty Moon project id`);
  }

  const dependencyScopes = {};
  const rawDeps = config.dependsOn ?? [];
  if (!Array.isArray(rawDeps)) {
    fail(prefix, `${file}.dependsOn must be a list when present`);
  }
  for (const dependency of rawDeps) {
    if (typeof dependency === "string") {
      addDependency(dependencyScopes, dependency, "production");
    } else if (
      dependency !== null &&
      typeof dependency === "object" &&
      !Array.isArray(dependency) &&
      typeof dependency.id === "string"
    ) {
      addDependency(dependencyScopes, dependency.id, String(dependency.scope || "production"));
    } else {
      fail(prefix, `${file}.dependsOn entries must be project ids or dependency objects`);
    }
  }

  const tasks = config.tasks && typeof config.tasks === "object" && !Array.isArray(config.tasks) ? config.tasks : {};
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task === null || Array.isArray(task) || typeof task !== "object" || task.deps === undefined) {
      continue;
    }
    if (!Array.isArray(task.deps)) {
      fail(prefix, `${file}.tasks.${taskId}.deps must be a list when present`);
    }
    for (const dependency of task.deps) {
      const target = typeof dependency === "string"
        ? dependency
        : dependency !== null && typeof dependency === "object" && !Array.isArray(dependency)
          ? dependency.target
          : undefined;
      const projectId = parseTaskDependencyProject(target);
      if (projectId !== undefined && projectId !== id) {
        addDependency(dependencyScopes, projectId, "build");
      }
    }
  }

  const project =
    config.project && typeof config.project === "object" && !Array.isArray(config.project) ? { ...config.project } : {};
  if (project.release !== undefined) {
    const metadata =
      project.metadata && typeof project.metadata === "object" && !Array.isArray(project.metadata)
        ? project.metadata
        : {};
    project.metadata = { ...metadata, release: project.release };
    delete project.release;
  } else if (project.metadata === undefined && Object.keys(project).length > 0) {
    project.metadata = {};
  }
  return {
    id,
    source,
    layer: typeof config.layer === "string" ? config.layer : undefined,
    dependsOn: Object.keys(dependencyScopes).sort(compareText),
    dependencyScopes: Object.fromEntries(
      Object.entries(dependencyScopes).sort(([left], [right]) => compareText(left, right)),
    ),
    tags: Array.isArray(config.tags) ? [...config.tags].sort(compareText) : [],
    project,
  };
}

export function moonProjectsById(prefix = "release-graph") {
  const files = gitNulRecords(["ls-files", "-z", "--", "*moon.yml"]);
  if (files.length === 0) {
    fail(prefix, "repository does not contain any tracked moon.yml project files");
  }
  const parsed = new Map();
  for (const file of files.sort(compareText)) {
    const project = readMoonProjectConfig(file, prefix);
    if (parsed.has(project.id)) {
      fail(prefix, `duplicate Moon project id ${project.id}`);
    }
    parsed.set(project.id, project);
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
    const version = manifest[packagePath];
    if (metadata.id !== product) {
      fail(prefix, `${packagePath}/release.toml must declare id = ${JSON.stringify(product)}`);
    }
    if (typeof version !== "string" || version.length === 0) {
      fail(prefix, `.release-please-manifest.json is missing ${packagePath}`);
    }
    products[product] = {
      ...metadata,
      path: packagePath,
      changelog_path: changelogPath(product, prefix),
      derived_version_files: metadata.derived_version_files ?? [],
      tag_prefix: tagPrefix(product, prefix),
      version,
      version_files: versionFiles(product, prefix),
    };
  }
  return products;
}

export function loadGraph(prefix = "release-graph") {
  const moonProjects = moonProjectsById(prefix);
  const graph = {
    policy: {
      repository: "f0rr0/oliphaunt",
      default_branch: "main",
      versioning: "independent",
    },
    products: graphProducts(moonProjects, prefix),
    moon_projects: Object.fromEntries(moonProjects),
  };
  Object.defineProperty(graph, "release_semantic_inputs", {
    value: loadReleaseSemanticInputs(graph, { root: ROOT, prefix }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return graph;
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

export function moonProjectRows({ project = undefined } = {}, prefix = "release-graph") {
  const projects = loadGraph(prefix).moon_projects;
  if (project !== undefined && !(project in projects)) {
    fail(prefix, `unknown Moon project ${project}`);
  }
  return Object.entries(projects)
    .filter(([projectId]) => project === undefined || projectId === project)
    .sort(([left], [right]) => compareText(left, right))
    .map(([projectId, row]) => {
      const release = row.project?.metadata?.release;
      return {
        id: projectId,
        source: row.source,
        layer: row.layer,
        tags: row.tags,
        dependsOn: row.dependsOn,
        dependencyScopes: row.dependencyScopes,
        release: release && typeof release === "object" && !Array.isArray(release) ? release : null,
      };
    });
}

const PUBLISH_STEP_TARGET_COVERAGE = {
  "liboliphaunt-native": {
    "github-release-assets": ["github-release-assets"],
    npm: ["npm"],
    "maven-central": ["maven-central"],
    "crates-io": ["crates-io"],
  },
  "liboliphaunt-wasix": {
    "github-release-assets": ["github-release-assets"],
    "crates-io": ["crates-io"],
  },
  "oliphaunt-broker": {
    "github-release-assets": ["github-release-assets"],
    "crates-io": ["crates-io"],
    npm: ["npm"],
  },
  "oliphaunt-js": {
    npm: ["npm"],
    jsr: ["jsr"],
  },
  "oliphaunt-kotlin": {
    "maven-central": ["maven-central"],
  },
  "oliphaunt-node-direct": {
    "github-release-assets": ["github-release-assets"],
    npm: ["npm"],
  },
  "oliphaunt-react-native": {
    npm: ["npm"],
  },
  "oliphaunt-rust": {
    "crates-io": ["crates-io"],
  },
  "oliphaunt-swift": {
    "github-release": ["github-release", "swift-package-source-tag"],
  },
  "oliphaunt-wasix-rust": {
    "crates-io": ["crates-io"],
  },
};

const EXTENSION_PUBLISH_STEP_TARGET_COVERAGE = {
  "crates-io": ["crates-io"],
  "github-release-assets": ["github-release-assets"],
  "maven-central": ["maven-central"],
  npm: ["npm"],
};

export function isExtensionProduct(product) {
  return product.startsWith("oliphaunt-extension-");
}

export const LIBOLIPHAUNT_RUNTIME_PRODUCTS = ["liboliphaunt-native", "liboliphaunt-wasix"];

export function wasixEvidenceProductsForRelease(
  products,
  projects,
  selected,
  prefix = "release-graph",
) {
  const selectedProducts = new Set(selected);
  const unknown = [...selectedProducts].filter((product) => !(product in products)).sort(compareText);
  if (unknown.length > 0) {
    fail(prefix, `unknown release products in WASIX evidence selection: ${unknown.join(", ")}`);
  }
  const required = [];
  for (const product of [...selectedProducts].sort(compareText)) {
    if (product === "liboliphaunt-wasix") {
      required.push(product);
      continue;
    }
    const config = products[product];
    const compatibility = config.compatibility_versions ?? {};
    const compatibilityRequiresWasix = Object.values(compatibility).some(
      (entry) => entry !== null
        && !Array.isArray(entry)
        && typeof entry === "object"
        && entry.source_product === "liboliphaunt-wasix",
    );
    const projectId = releaseProductProjectId(product, products, projects, prefix);
    const projectRequiresWasix = (projects[projectId]?.dependsOn ?? []).includes("liboliphaunt-wasix");
    if (compatibilityRequiresWasix || projectRequiresWasix) {
      required.push(product);
    }
  }
  return required;
}

function extensionClass(product, config, prefix) {
  const extension = config?.extension;
  if (extension === undefined) {
    return undefined;
  }
  if (extension === null || Array.isArray(extension) || typeof extension !== "object") {
    fail(prefix, `${product}.extension must be a table when present`);
  }
  const klass = extension.class;
  if (typeof klass !== "string" || klass.length === 0) {
    fail(prefix, `${product}.extension.class must be a non-empty string`);
  }
  return klass;
}

export function runtimeTiedContribProducts(products, prefix = "release-graph") {
  if (products === null || Array.isArray(products) || typeof products !== "object") {
    fail(prefix, "release metadata must define [products.<id>] entries");
  }
  for (const runtimeProduct of LIBOLIPHAUNT_RUNTIME_PRODUCTS) {
    if (!(runtimeProduct in products)) {
      fail(prefix, `runtime-tied release group is missing ${runtimeProduct}`);
    }
  }
  const contrib = Object.entries(products)
    .filter(([product, config]) => isExtensionProduct(product) && extensionClass(product, config, prefix) === "contrib")
    .map(([product]) => product)
    .sort(compareText);
  return [...LIBOLIPHAUNT_RUNTIME_PRODUCTS, ...contrib];
}

export function expandRuntimeTiedProducts(products, selected, prefix = "release-graph") {
  const selectedSet = new Set(selected);
  const tiedProducts = runtimeTiedContribProducts(products, prefix);
  if (tiedProducts.some((product) => selectedSet.has(product))) {
    for (const product of tiedProducts) {
      selectedSet.add(product);
    }
  }
  return selectedSet;
}

export function publishStepTargetCoverageRows({ product = undefined } = {}, prefix = "release-graph") {
  const products = loadGraph(prefix).products;
  if (product !== undefined && !(product in products)) {
    fail(prefix, `unknown release product ${product}`);
  }
  const productIds = product === undefined ? Object.keys(products).sort(compareText) : [product];
  const rows = [];
  for (const productId of productIds) {
    const extension = isExtensionProduct(productId);
    const coverage = extension ? EXTENSION_PUBLISH_STEP_TARGET_COVERAGE : (PUBLISH_STEP_TARGET_COVERAGE[productId] ?? {});
    for (const [step, publishTargets] of Object.entries(coverage).sort(([left], [right]) => compareText(left, right))) {
      rows.push({
        product: productId,
        step,
        publishTargets: [...publishTargets].sort(compareText),
        extension,
      });
    }
  }
  return rows;
}

function assertObject(value, context, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    fail(prefix, `${context} must be a table`);
  }
  return value;
}

export function compatibilityVersionEntries(
  products,
  { requireSourceProduct = false, prefix = "release-graph", root = ROOT } = {},
) {
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
      if (!existsSync(path.join(root, specPath))) {
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

export function latestTagForPrefix(prefix, headRef, root = ROOT) {
  const args = ["describe", "--tags", "--abbrev=0", "--match", tagMatchPattern(prefix), headRef];
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput: true,
    cwd: root,
    label: `git ${args.join(" ")}`,
    stdoutTerminator: "\n",
  });
  if (result.error !== undefined) throw result.error;
  return result.status === 0 ? result.stdout.trim() : "";
}

export function latestProductTag(productConfig, headRef, prefix = "release-graph", root = ROOT) {
  for (const candidatePrefix of tagPrefixes(productConfig, prefix)) {
    const tag = latestTagForPrefix(candidatePrefix, headRef, root);
    if (tag) {
      return tag;
    }
  }
  return EMPTY_TREE;
}

function gitAt(
  root,
  args,
  { allowEmptyOutput = false, check = true, stdoutTerminator = undefined } = {},
) {
  const result = captureCommandOutput("git", args, {
    allowEmptyOutput,
    cwd: root,
    label: `git ${args.join(" ")}`,
    stdoutTerminator,
  });
  if (result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return { status: result.status, stdout: result.stdout.trim(), rawStdout: result.stdout };
}

function commitForRefAt(root, ref, { check = true } = {}) {
  const result = gitAt(
    root,
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { allowEmptyOutput: !check, check, stdoutTerminator: "\n" },
  );
  return result.status === 0 ? result.stdout : null;
}

export function commitForRef(ref, root = ROOT) {
  return commitForRefAt(root, ref);
}

export function changedFilesFromRefs(baseRef, headRef, prefix = "release-graph", root = ROOT) {
  try {
    const result =
      baseRef === EMPTY_TREE
        ? gitAt(
            root,
            ["diff", "--name-only", "-z", baseRef, headRef, "--"],
            { allowEmptyOutput: true, stdoutTerminator: "\0" },
          )
        : gitAt(
            root,
            ["diff", "--name-only", "-z", `${baseRef}...${headRef}`, "--"],
            { allowEmptyOutput: true, stdoutTerminator: "\0" },
          );
    return result.rawStdout.split("\0").filter(Boolean).sort(compareText);
  } catch (error) {
    fail(prefix, `failed to read changed files between ${baseRef} and ${headRef}: ${error.message}`);
  }
}

function manifestAtRef(root, ref, prefix) {
  let value;
  try {
    value = JSON.parse(gitAt(root, ["show", `${ref}:.release-please-manifest.json`]).stdout);
  } catch (error) {
    throw new Error(`${prefix}: cannot read .release-please-manifest.json at ${ref}: ${error.message}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${prefix}: .release-please-manifest.json at ${ref} must contain a JSON object`);
  }
  return value;
}

function canonicalVersionAtRef(root, ref, product, config, prefix) {
  const file = config?.version_files?.[0];
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`${prefix}: ${product} is missing its canonical version file metadata`);
  }
  let text;
  try {
    text = gitAt(root, ["show", `${ref}:${file}`]).stdout;
  } catch (error) {
    throw new Error(`${prefix}: cannot read ${product} canonical version file ${file} at ${ref}: ${error.message}`);
  }
  const basename = path.posix.basename(file);
  let version;
  try {
    if (basename === "Cargo.toml") {
      version = Bun.TOML.parse(text)?.package?.version;
    } else if (basename === "package.json") {
      version = JSON.parse(text)?.version;
    } else {
      version = text.trim();
    }
  } catch (error) {
    throw new Error(`${prefix}: cannot parse ${product} canonical version file ${file} at ${ref}: ${error.message}`);
  }
  transitionVersion(version, `${product} canonical version in ${file} at ${ref}`, prefix);
  return version;
}

function transitionVersion(value, context, prefix) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${prefix}: ${context} must be a stable x.y.z version, got ${JSON.stringify(value)}`);
  }
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

function manifestProductVersion(products, manifest, product, ref, prefix) {
  const packagePath = products[product]?.path;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    throw new Error(`${prefix}: compatibility source product ${product} is missing its Release Please package path`);
  }
  const version = manifest[packagePath];
  transitionVersion(version, `${product} manifest version at ${ref}`, prefix);
  return version;
}

function fileAtRef(root, ref, file) {
  const result = gitAt(root, ["show", `${ref}:${file}`], { check: false });
  return result.status === 0 ? result.rawStdout : null;
}

function semanticDifferences(before, after, parts = []) {
  if (Object.is(before, after)) return [];
  const beforeObject = before !== null && typeof before === "object";
  const afterObject = after !== null && typeof after === "object";
  if (beforeObject && afterObject && Array.isArray(before) === Array.isArray(after)) {
    const keys = new Set(Array.isArray(before)
      ? Array.from({ length: Math.max(before.length, after.length) }, (_value, index) => index)
      : [...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) => semanticDifferences(before[key], after[key], [...parts, key]));
  }
  return [{ parts, before, after }];
}

function compatibilityPathKey(parts) {
  return parts.map(String).join("\0");
}

function valueAtPath(value, parts) {
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function parseCompatibilityStructuredFile(text, type) {
  try {
    const value = type === "json" ? JSON.parse(text) : Bun.TOML.parse(text);
    return value !== null && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function compatibilityParser(entry) {
  const separator = entry.parser.indexOf(":");
  const type = separator === -1 ? entry.parser : entry.parser.slice(0, separator);
  const expression = separator === -1 ? "" : entry.parser.slice(separator + 1);
  if ((type === "json" || type === "toml") && /^[A-Za-z0-9_-]+(?:[.][A-Za-z0-9_-]+)*$/u.test(expression)) {
    return { type, parts: expression.split(".") };
  }
  if (type === "raw" && expression === "") return { type, parts: [] };
  if (type === "rust-const" && /^[A-Z][A-Z0-9_]*$/u.test(expression)) {
    return { type, name: expression, parts: [] };
  }
  return null;
}

function maskRustCompatibilityConst(text, name, expected, token) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `(^|\\n)([\\t ]*(?:pub[\\t ]+)?const[\\t ]+${escaped}[\\t ]*:[\\t ]*&str[\\t ]*=[\\t ]*")([^"]+)("[\\t ]*;[^\\n]*)`,
    "gu",
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1 || matches[0][3] !== expected) return null;
  return text.replace(pattern, `$1$2${token}$4`);
}

function compatibilityFileHasOnlyExpectedChanges({
  beforeText,
  afterText,
  entries,
  beforeManifest,
  afterManifest,
  products,
  baseRef,
  headRef,
  prefix,
}) {
  const rules = entries.map((entry) => {
    const parser = compatibilityParser(entry);
    if (parser === null) return null;
    return {
      entry,
      parser,
      before: manifestProductVersion(products, beforeManifest, entry.sourceProduct, baseRef, prefix),
      after: manifestProductVersion(products, afterManifest, entry.sourceProduct, headRef, prefix),
    };
  });
  if (rules.some((rule) => rule === null)) return false;

  const types = new Set(rules.map((rule) => rule.parser.type));
  if (types.size !== 1) return false;
  const type = rules[0].parser.type;
  if (type === "raw") {
    return rules.length === 1 && beforeText.trim() === rules[0].before && afterText.trim() === rules[0].after;
  }
  if (type === "rust-const") {
    let maskedBefore = beforeText;
    let maskedAfter = afterText;
    for (const rule of rules) {
      const token = `<compatibility:${rule.entry.id}>`;
      maskedBefore = maskRustCompatibilityConst(maskedBefore, rule.parser.name, rule.before, token);
      maskedAfter = maskRustCompatibilityConst(maskedAfter, rule.parser.name, rule.after, token);
      if (maskedBefore === null || maskedAfter === null) return false;
    }
    return maskedBefore === maskedAfter;
  }

  const before = parseCompatibilityStructuredFile(beforeText, type);
  const after = parseCompatibilityStructuredFile(afterText, type);
  if (before === null || after === null) return false;
  const allowed = new Map();
  for (const rule of rules) {
    const key = compatibilityPathKey(rule.parser.parts);
    const previous = allowed.get(key);
    if (
      previous !== undefined &&
      (previous.before !== rule.before || previous.after !== rule.after || previous.entry.sourceProduct !== rule.entry.sourceProduct)
    ) {
      return false;
    }
    if (
      valueAtPath(before, rule.parser.parts) !== rule.before ||
      valueAtPath(after, rule.parser.parts) !== rule.after
    ) {
      return false;
    }
    allowed.set(key, rule);
  }
  return semanticDifferences(before, after).every((difference) => {
    const rule = allowed.get(compatibilityPathKey(difference.parts));
    return rule !== undefined && difference.before === rule.before && difference.after === rule.after;
  });
}

function compatibilityOnlyChangedFiles({
  product,
  products,
  entries,
  files,
  baseRef,
  headRef,
  prefix,
  root,
}) {
  const byFile = new Map();
  for (const entry of entries) {
    if (entry.product !== product) continue;
    byFile.set(entry.path, [...(byFile.get(entry.path) ?? []), entry]);
  }
  if (byFile.size === 0) return new Set();
  const beforeManifest = manifestAtRef(root, baseRef, prefix);
  const afterManifest = manifestAtRef(root, headRef, prefix);
  const ignored = new Set();
  for (const file of files) {
    const fileEntries = byFile.get(file);
    if (fileEntries === undefined) continue;
    const beforeText = fileAtRef(root, baseRef, file);
    const afterText = fileAtRef(root, headRef, file);
    if (
      beforeText !== null &&
      afterText !== null &&
      compatibilityFileHasOnlyExpectedChanges({
        beforeText,
        afterText,
        entries: fileEntries,
        beforeManifest,
        afterManifest,
        products,
        baseRef,
        headRef,
        prefix,
      })
    ) {
      ignored.add(file);
    }
  }
  return ignored;
}

function versionFromProductTag(config, tag, prefix) {
  for (const candidatePrefix of tagPrefixes(config, prefix)) {
    if (!tag.startsWith(candidatePrefix)) continue;
    const version = tag.slice(candidatePrefix.length);
    transitionVersion(version, `product tag ${tag}`, prefix);
    return version;
  }
  throw new Error(`${prefix}: product tag ${tag} does not use a declared tag prefix`);
}

/**
 * Classify one product's immutable release identity at headRef.
 *
 * Path impact is deliberately not considered here. A normal candidate must
 * have advanced its own Release Please manifest version since its latest
 * reachable product tag. An exact current-version tag is eligible only for an
 * explicitly requested exact-commit recovery.
 */
export function productVersionTransitionStatus(
  product,
  config,
  baseRef,
  headRef,
  {
    includeCurrentTags = false,
    prefix = "release-graph",
    root = ROOT,
  } = {},
) {
  const packagePath = config?.path;
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    throw new Error(`${prefix}: ${product} is missing its Release Please package path`);
  }
  const headCommit = commitForRefAt(root, headRef);
  const headVersion = manifestAtRef(root, headCommit, prefix)[packagePath];
  const headParts = transitionVersion(headVersion, `${product} manifest version at ${headCommit}`, prefix);
  if (headVersion !== config.version) {
    throw new Error(
      `${prefix}: ${product} graph version ${JSON.stringify(config.version)} does not match ` +
      `its manifest version ${JSON.stringify(headVersion)} at ${headCommit}`,
    );
  }
  const headCanonicalVersion = canonicalVersionAtRef(root, headCommit, product, config, prefix);
  if (headCanonicalVersion !== headVersion) {
    throw new Error(
      `${prefix}: ${product} canonical version ${JSON.stringify(headCanonicalVersion)} does not match ` +
      `its manifest version ${JSON.stringify(headVersion)} at ${headCommit}`,
    );
  }

  let baseVersion = null;
  let comparison = null;
  if (baseRef !== EMPTY_TREE) {
    baseVersion = versionFromProductTag(config, baseRef, prefix);
    const taggedManifestVersion = manifestAtRef(root, baseRef, prefix)[packagePath];
    if (taggedManifestVersion !== baseVersion) {
      throw new Error(
        `${prefix}: ${product} base tag ${baseRef} names ${baseVersion}, but its manifest contains ` +
        `${JSON.stringify(taggedManifestVersion)}`,
      );
    }
    const taggedCanonicalVersion = canonicalVersionAtRef(root, baseRef, product, config, prefix);
    if (taggedCanonicalVersion !== baseVersion) {
      throw new Error(
        `${prefix}: ${product} base tag ${baseRef} names ${baseVersion}, but its canonical version file contains ` +
        `${JSON.stringify(taggedCanonicalVersion)}`,
      );
    }
    comparison = compareVersion(headParts, transitionVersion(baseVersion, `${product} base tag version`, prefix));
    if (comparison < 0) {
      throw new Error(
        `${prefix}: ${product} manifest version ${headVersion} is older than tagged version ${baseVersion}`,
      );
    }
  }

  const currentTag = `${config.tag_prefix}${headVersion}`;
  const currentTagCommit = commitForRefAt(root, `refs/tags/${currentTag}`, { check: false });
  if (currentTagCommit !== null) {
    const taggedManifestVersion = manifestAtRef(root, currentTagCommit, prefix)[packagePath];
    if (taggedManifestVersion !== headVersion) {
      throw new Error(
        `${prefix}: ${product} current-version tag ${currentTag} points at ${currentTagCommit}, whose manifest ` +
        `contains ${JSON.stringify(taggedManifestVersion)} instead of ${JSON.stringify(headVersion)}`,
      );
    }
    const taggedCanonicalVersion = canonicalVersionAtRef(root, currentTagCommit, product, config, prefix);
    if (taggedCanonicalVersion !== headVersion) {
      throw new Error(
        `${prefix}: ${product} current-version tag ${currentTag} points at ${currentTagCommit}, whose canonical ` +
        `version file contains ${JSON.stringify(taggedCanonicalVersion)} instead of ${JSON.stringify(headVersion)}`,
      );
    }
    if (currentTagCommit === headCommit) {
      return {
        eligible: includeCurrentTags,
        recovery: includeCurrentTags,
        firstRelease: false,
        baseVersion: headVersion,
        headVersion,
        currentTag,
        currentTagCommit,
      };
    }
    const ancestor = gitAt(root, ["merge-base", "--is-ancestor", currentTagCommit, headCommit], { check: false }).status === 0;
    if (!ancestor) {
      throw new Error(
        `${prefix}: ${product} current-version tag ${currentTag} points at ${currentTagCommit}, ` +
        `which is not an ancestor of release candidate ${headCommit}`,
      );
    }
    return {
      eligible: false,
      recovery: false,
      firstRelease: false,
      baseVersion: headVersion,
      headVersion,
      currentTag,
      currentTagCommit,
    };
  }

  if (baseRef === EMPTY_TREE) {
    const firstRelease = compareVersion(headParts, [0, 0, 0]) > 0;
    return {
      eligible: firstRelease,
      recovery: false,
      firstRelease,
      baseVersion: null,
      headVersion,
      currentTag,
      currentTagCommit: null,
    };
  }
  return {
    eligible: comparison > 0,
    recovery: false,
    firstRelease: false,
    baseVersion,
    headVersion,
    currentTag,
    currentTagCommit: null,
  };
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

export function releaseOwnerProjectsForPath(products, projects, candidate, prefix = "release-graph") {
  if (isGeneratedLocalState(candidate)) {
    return [];
  }
  return Object.entries(products)
    .filter(([, config]) => {
      const packagePath = config?.path;
      return typeof packagePath === "string"
        && packagePath.length > 0
        && (candidate === packagePath || candidate.startsWith(`${packagePath}/`));
    })
    .map(([product]) => releaseProductProjectId(product, products, projects, prefix))
    .filter((projectId, index, values) => values.indexOf(projectId) === index)
    .sort(compareText);
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
  const directProjects = new Set();
  const semanticInputProducts = new Set();
  for (const file of files) {
    const owner = ownerProjectForPath(projects, file);
    if (owner !== undefined) {
      directProjects.add(owner);
    }
    // A nested Moon project may own CI work without being an independently
    // versioned product. Preserve that precise CI owner while also selecting
    // every enclosing release component (for example a contrib bundle).
    for (const releaseOwner of releaseOwnerProjectsForPath(products, projects, file, prefix)) {
      directProjects.add(releaseOwner);
    }
    if (graph.release_semantic_inputs !== undefined) {
      for (const product of releaseSemanticProductsForPath(graph.release_semantic_inputs, file, { prefix })) {
        semanticInputProducts.add(product);
        directProjects.add(releaseProductProjectId(product, products, projects, prefix));
      }
    }
  }
  const affectedProjects = downstreamProjects(projects, directProjects);
  const releaseProjects = downstreamProjects(projects, directProjects, { releaseOnly: true });
  const releaseProductSet = expandRuntimeTiedProducts(
    products,
    releaseProductsForProjects(products, projects, releaseProjects, prefix),
    prefix,
  );
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
    semanticInputProducts: [...semanticInputProducts].sort(compareText),
    releaseProducts,
    directMoonProjects: [...directProjects].sort(compareText),
    affectedMoonProjects: [...affectedProjects].sort(compareText),
    releaseMoonProjects: [...releaseProductProjects].sort(compareText),
    productIds: Object.keys(products),
    hasReleaseChanges: releaseProducts.length > 0,
    docsOnly: releaseProducts.length === 0 && docsOnlyChange(files),
    versioning: graph.policy?.versioning ?? "independent",
    extensionSelection: "exact-sql-extension",
    runtimeTiedProducts: runtimeTiedContribProducts(products, prefix),
  });
}

export function buildPlanFromProductTags(
  graph,
  headRef,
  { includeCurrentTags = false, prefix = "release-graph", root = ROOT } = {},
) {
  const products = graph.products;
  const direct = new Set();
  const changed = new Set();
  const productBaseRefs = {};
  const currentTaggedProducts = new Set();
  const versionEligibleProducts = new Set();
  const compatibilityEntries = compatibilityVersionEntries(products, {
    requireSourceProduct: true,
    prefix,
    root,
  });

  for (const [product, config] of Object.entries(products)) {
    const baseRef = latestProductTag(config, headRef, prefix, root);
    productBaseRefs[product] = baseRef;
    const transition = productVersionTransitionStatus(product, config, baseRef, headRef, {
      includeCurrentTags,
      prefix,
      root,
    });
    const productFiles = transition.eligible || baseRef !== EMPTY_TREE
      ? changedFilesFromRefs(baseRef, headRef, prefix, root)
      : [];
    for (const file of productFiles) {
      changed.add(file);
    }
    if (!transition.eligible) {
      if (baseRef !== EMPTY_TREE && productFiles.length > 0) {
        const ignored = compatibilityOnlyChangedFiles({
          product,
          products,
          entries: compatibilityEntries,
          files: productFiles,
          baseRef,
          headRef,
          prefix,
          root,
        });
        const impactFiles = productFiles.filter((file) => !ignored.has(file));
        const impactPlan = buildPlan(graph, normalizeFiles(impactFiles), prefix);
        if (impactPlan.releaseProducts.includes(product)) {
          const selectingFiles = impactFiles.filter((file) =>
            buildPlan(graph, normalizeFiles([file]), prefix).releaseProducts.includes(product)
          );
          const relevantFiles = selectingFiles.length > 0 ? selectingFiles : impactFiles;
          const shown = relevantFiles.slice(0, 12);
          const suffix = relevantFiles.length > shown.length ? `, ... (${relevantFiles.length - shown.length} more)` : "";
          throw new Error(
            `${prefix}: ${product} has release-affecting changes since ${baseRef}, but its manifest version ` +
            `remains ${transition.headVersion}; bump the product version before publishing. ` +
            `Non-compatibility changed paths: ${shown.join(", ")}${suffix}`,
          );
        }
      }
      continue;
    }
    versionEligibleProducts.add(product);
    if (transition.recovery) {
      direct.add(product);
      currentTaggedProducts.add(product);
      continue;
    }
    const productPlan = buildPlan(graph, normalizeFiles(productFiles), prefix);
    if (!productPlan.releaseProducts.includes(product)) {
      throw new Error(
        `${prefix}: ${product} manifest advanced from ${transition.baseVersion ?? "first release"} to ` +
        `${transition.headVersion}, but its changed paths do not select the product in the Moon release graph`,
      );
    }
    direct.add(product);
  }

  const projects = graph.moon_projects;
  const directProjects = new Set(
    [...direct].map((product) => releaseProductProjectId(product, products, projects, prefix)),
  );
  const affectedProjects = downstreamProjects(projects, directProjects);
  const releaseProjects = downstreamProjects(projects, directProjects, { releaseOnly: true });
  const releaseProductSet = expandRuntimeTiedProducts(
    products,
    releaseProductsForProjects(products, projects, releaseProjects, prefix),
    prefix,
  );
  const ineligibleClosure = [...releaseProductSet].filter((product) => !versionEligibleProducts.has(product)).sort(compareText);
  if (ineligibleClosure.length > 0) {
    throw new Error(
      `${prefix}: release dependency/runtime-tied closure requires product(s) without a verified manifest ` +
      `version transition or exact-tag recovery: ${ineligibleClosure.join(", ")}`,
    );
  }
  const releaseProducts = releaseOrder(products, projects, releaseProductSet, prefix);
  const releaseProductProjects = new Set(
    releaseProducts.map((product) => releaseProductProjectId(product, products, projects, prefix)),
  );
  return finalizePlan({
    changedFiles: [...changed].sort(compareText),
    directProducts: releaseOrder(products, projects, direct, prefix),
    releaseProducts,
    directMoonProjects: [...directProjects].sort(compareText),
    affectedMoonProjects: [...affectedProjects].sort(compareText),
    releaseMoonProjects: [...releaseProductProjects].sort(compareText),
    productIds: Object.keys(products),
    hasReleaseChanges: releaseProducts.length > 0,
    docsOnly: releaseProducts.length === 0 && docsOnlyChange([...changed]),
    versioning: graph.policy?.versioning ?? "independent",
    extensionSelection: "exact-sql-extension",
    productBaseRefs,
    currentTaggedProducts: [...currentTaggedProducts].sort(compareText),
    runtimeTiedProducts: runtimeTiedContribProducts(products, prefix),
  });
}

export function releaseProductsSlug(products, { runtimeTiedProducts = [] } = {}) {
  if (products.length === 0) {
    return "none";
  }
  const runtimeTiedSet = new Set(runtimeTiedProducts);
  const slugProducts =
    runtimeTiedProducts.length > 0 && runtimeTiedProducts.every((product) => products.includes(product))
      ? ["liboliphaunt-runtime", ...products.filter((product) => !runtimeTiedSet.has(product))]
      : products;
  const shortNames = {
    "liboliphaunt-runtime": "runtime",
    "liboliphaunt-native": "native",
    "liboliphaunt-wasix": "wasix",
  };
  return slugProducts.map((product) => shortNames[product] ?? product.replace("oliphaunt-", "")).join("-");
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
  const slug = releaseProductsSlug(plan.releaseProducts ?? [], {
    runtimeTiedProducts: plan.runtimeTiedProducts ?? [],
  });
  plan.releaseBranch = `release/${slug}-${digest}`;
  return plan;
}
