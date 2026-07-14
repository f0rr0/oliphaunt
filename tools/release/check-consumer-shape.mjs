#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { extensionRegistryPackageStrings } from "./extension-registry-packages.mjs";
import {
  allArtifactTargets,
  currentProductVersionSync,
  extensionArtifactTargets,
  extensionMetadata,
  extensionRegistryPackageTargetSets,
  extensionSourceIdentity,
  typescriptOptionalRuntimePackageProducts,
} from "./release-artifact-targets.mjs";
import { ROOT, compareText, loadGraph, releaseProductProjectId } from "./release-graph.mjs";
import { declaredCarrierMap, loadPublicationCatalog } from "./publication-catalog.mjs";

const TOOL = "check-consumer-shape.mjs";
const SCHEMA = "oliphaunt-consumer-shape-v1";
const SEVERITIES = new Set(["P0", "P1", "P2"]);
const INSTALL_LIFECYCLE = new Set(["preinstall", "install", "postinstall", "prepare"]);
const REGISTRY_ECOSYSTEM = Object.freeze({
  "crates-io": "cargo",
  jsr: "jsr",
  "maven-central": "maven",
  npm: "npm",
});

function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function sorted(values) {
  return [...values].sort(compareText);
}

function sameStrings(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function readJson(relativePath) {
  try {
    return object(JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8")), relativePath);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function readToml(relativePath) {
  try {
    return object(Bun.TOML.parse(readFileSync(path.join(ROOT, relativePath), "utf8")), relativePath);
  } catch (error) {
    fail(`${relativePath} is not valid TOML: ${error.message}`);
  }
}

function finding(product, check, message, evidence, severity = "P0") {
  return {
    id: `${product}.${check}`,
    severity,
    product,
    check,
    message,
    evidence: Array.isArray(evidence) ? evidence : [evidence],
  };
}

function requireCondition(findings, product, check, condition, message, evidence, severity = "P0") {
  if (!condition) {
    findings.push(finding(product, check, message, evidence, severity));
  }
}

function taskTarget(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    return entry.target;
  }
  return undefined;
}

function taskCommandPresent(task) {
  if (typeof task.command === "string") {
    return task.command.trim().length > 0;
  }
  return Array.isArray(task.command) && task.command.length > 0 && task.command.every((part) => typeof part === "string");
}

function requiredProofTasks(product, config) {
  if (config.kind === "exact-extension-artifact") {
    return [
      { id: "check", tags: ["quality"] },
      { id: "assemble-release", tags: ["release", "artifact-package"], dependency: `${product}:check` },
    ];
  }
  if (config.kind === "sdk") {
    return [
      { id: "check", tags: ["quality"] },
      { id: "test", tags: ["quality"] },
      { id: "package", tags: ["package"], dependencies: [`${product}:check`, `${product}:test`] },
      { id: "release-check", tags: ["release", "package"] },
    ];
  }
  const required = [
    { id: "check", tags: ["quality"] },
    { id: "release-check", tags: ["release", "package"] },
  ];
  if (["oliphaunt-broker", "oliphaunt-node-direct"].includes(product)) {
    required.splice(1, 0, { id: "package", tags: ["package"] });
  }
  return required;
}

function validateExecutableProofs(findings, graph, product, config) {
  const projectId = releaseProductProjectId(product, graph.products, graph.moon_projects, TOOL);
  const project = graph.moon_projects[projectId];
  const source = project?.source;
  const moonFile = source === "." ? "moon.yml" : `${source}/moon.yml`;
  if (typeof source !== "string" || !existsSync(path.join(ROOT, moonFile))) {
    findings.push(finding(product, "proof-project", "Release product has no executable Moon project.", moonFile));
    return 0;
  }
  const moon = object(Bun.YAML.parse(readFileSync(path.join(ROOT, moonFile), "utf8")), moonFile);
  const tasks = object(moon.tasks ?? {}, `${moonFile}.tasks`);
  let count = 0;
  for (const proof of requiredProofTasks(product, config)) {
    const task = tasks[proof.id];
    if (task === null || typeof task !== "object" || Array.isArray(task)) {
      findings.push(finding(product, "proof-task", `Missing executable consumer proof task ${product}:${proof.id}.`, moonFile));
      continue;
    }
    count += 1;
    const tags = Array.isArray(task.tags) ? task.tags : [];
    requireCondition(
      findings,
      product,
      "proof-tags",
      proof.tags.every((tag) => tags.includes(tag)),
      `${product}:${proof.id} is not classified as a ${proof.tags.join("/")} proof.`,
      moonFile,
    );
    const dependencies = (Array.isArray(task.deps) ? task.deps : []).map(taskTarget).filter(Boolean);
    requireCondition(
      findings,
      product,
      "proof-command",
      taskCommandPresent(task) || dependencies.length > 0,
      `${product}:${proof.id} has neither an executable command nor delegated proof dependencies.`,
      moonFile,
    );
    const requiredDependencies = proof.dependencies ?? (proof.dependency === undefined ? [] : [proof.dependency]);
    requireCondition(
      findings,
      product,
      "proof-dependencies",
      requiredDependencies.every((target) => dependencies.includes(target)),
      `${product}:${proof.id} does not depend on its prerequisite product proofs.`,
      [`${moonFile}: ${requiredDependencies.join(", ")}`],
    );
    if (task.command === "true") {
      requireCondition(
        findings,
        product,
        "delegated-proof",
        dependencies.includes(`${product}:package`),
        `${product}:${proof.id} delegates execution without depending on the package proof.`,
        moonFile,
      );
    }
  }
  return count;
}

function validateNpmManifest(findings, product, config, file, carriers) {
  const manifest = readJson(file);
  requireCondition(findings, product, "npm-name", typeof manifest.name === "string" && manifest.name.length > 0, "npm package name is missing.", file);
  requireCondition(findings, product, "npm-version", manifest.version === config.version, "npm package version does not match the release product.", `${file}: ${manifest.version}`);
  const scripts = object(manifest.scripts ?? {}, `${file}.scripts`);
  const installHooks = Object.keys(scripts).filter((name) => INSTALL_LIFECYCLE.has(name));
  requireCondition(findings, product, "install-lifecycle", installHooks.length === 0, "Consumer installation must not execute package lifecycle hooks.", installHooks.map((name) => `${file}: scripts.${name}`));
  if (manifest.private !== true && typeof manifest.name === "string") {
    requireCondition(findings, product, "npm-identity", carriers.get(`npm:${manifest.name}`)?.product === product, "Public npm manifest is not owned by this release product.", `${file}: ${manifest.name}`);
    requireCondition(findings, product, "npm-provenance", manifest.publishConfig?.access === "public" && manifest.publishConfig?.provenance === true, "Public npm package must request public access and registry provenance.", file);
  }
  return manifest;
}

function validateCargoManifest(findings, product, config, file, carriers) {
  const manifest = readToml(file);
  const packageConfig = object(manifest.package, `${file}.package`);
  requireCondition(findings, product, "cargo-name", typeof packageConfig.name === "string" && packageConfig.name.length > 0, "Cargo package name is missing.", file);
  requireCondition(findings, product, "cargo-version", packageConfig.version === config.version, "Cargo package version does not match the release product.", `${file}: ${packageConfig.version}`);
  if (packageConfig.publish !== false && typeof packageConfig.name === "string") {
    requireCondition(findings, product, "cargo-identity", carriers.get(`cargo:${packageConfig.name}`)?.product === product, "Publishable Cargo manifest is not owned by this release product.", `${file}: ${packageConfig.name}`);
  }
}

function arrayMatches(value, expected) {
  return Array.isArray(value) && sameStrings(value, expected);
}

function validatePlatformNpmPackages(findings, product, config, manifests, carriers) {
  const byName = new Map([...manifests.values()].map((manifest) => [manifest.name, manifest]));
  const targets = allArtifactTargets({ product, publishedOnly: true }, TOOL).filter(
    (target) => target.npmPackage !== undefined && target.npmOs !== undefined && target.npmCpu !== undefined,
  );
  for (const target of targets) {
    const manifest = byName.get(target.npmPackage);
    requireCondition(findings, product, "platform-manifest", manifest !== undefined, "Published npm platform target has no release-owned source manifest.", `${target.id}: ${target.npmPackage}`);
    if (manifest === undefined) {
      continue;
    }
    requireCondition(findings, product, "platform-identity", carriers.get(`npm:${target.npmPackage}`)?.product === product, "Published npm platform target is missing from the publication catalog.", target.npmPackage);
    requireCondition(findings, product, "platform-version", manifest.version === config.version, "Platform npm version does not match its release product.", target.npmPackage);
    requireCondition(findings, product, "platform-optional", manifest.optional === true, "Platform npm carrier must be optional so package managers select it by OS/CPU.", target.npmPackage);
    requireCondition(findings, product, "platform-os", arrayMatches(manifest.os, [target.npmOs]), "Platform npm OS selector does not match the artifact target.", target.npmPackage);
    requireCondition(findings, product, "platform-cpu", arrayMatches(manifest.cpu, [target.npmCpu]), "Platform npm CPU selector does not match the artifact target.", target.npmPackage);
    const expectedLibc = target.npmLibc === undefined ? undefined : [target.npmLibc];
    requireCondition(findings, product, "platform-libc", expectedLibc === undefined ? manifest.libc === undefined : arrayMatches(manifest.libc, expectedLibc), "Platform npm libc selector does not match the artifact target.", target.npmPackage);
    requireCondition(findings, product, "platform-target", manifest.oliphaunt?.target === target.target, "Platform npm metadata does not identify the canonical artifact target.", target.npmPackage);
  }
}

function validateTypescript(findings, graph, config, carriers) {
  const packageJson = readJson("src/sdks/js/package.json");
  const optional = object(packageJson.optionalDependencies ?? {}, "src/sdks/js/package.json.optionalDependencies");
  const expected = Object.fromEntries(typescriptOptionalRuntimePackageProducts(TOOL).map((row) => [
    row.packageName,
    `workspace:${graph.products[row.product].version}`,
  ]));
  requireCondition(findings, "oliphaunt-js", "optional-runtime-carriers", sameStrings(Object.keys(optional), Object.keys(expected)) && Object.entries(expected).every(([name, spec]) => optional[name] === spec), "TypeScript optional runtime dependencies must exactly follow published runtime target metadata.", "src/sdks/js/package.json");
  requireCondition(findings, "oliphaunt-js", "optional-runtime-identities", Object.keys(expected).every((name) => carriers.has(`npm:${name}`)), "TypeScript optional runtime dependency is missing from the publication catalog.", Object.keys(expected));
  const jsr = readJson("src/sdks/js/jsr.json");
  requireCondition(findings, "oliphaunt-js", "jsr-identity", jsr.name === packageJson.name && carriers.get(`jsr:${jsr.name}`)?.product === "oliphaunt-js", "JSR and npm package identities must represent the same SDK product.", "src/sdks/js/jsr.json");
  requireCondition(findings, "oliphaunt-js", "jsr-version", jsr.version === config.version, "JSR package version must match the SDK release version.", "src/sdks/js/jsr.json");
  const exports = object(jsr.exports, "src/sdks/js/jsr.json.exports");
  requireCondition(findings, "oliphaunt-js", "jsr-portable-exports", Object.keys(exports).every((name) => !["./native", "./node", "./bun", "./deno"].includes(name)), "JSR must expose only portable TypeScript entrypoints.", Object.keys(exports));
}

function validateExactExtension(findings, graph, product, config, carriers) {
  const metadata = extensionMetadata(product, TOOL);
  extensionSourceIdentity(product, TOOL);
  const targets = extensionArtifactTargets({ product }, TOOL);
  const published = targets.filter((target) => target.published);
  requireCondition(findings, product, "extension-native-target", published.some((target) => target.family === "native"), "Exact extension has no published native consumer target.", `${config.path}/targets/artifacts.toml`);
  requireCondition(findings, product, "extension-wasix-target", published.some((target) => target.family === "wasix"), "Exact extension has no published WASIX consumer target.", `${config.path}/targets/artifacts.toml`);
  const expected = extensionRegistryPackageStrings({
    product,
    sqlName: metadata.sqlName,
    ...extensionRegistryPackageTargetSets(product, TOOL),
  });
  requireCondition(findings, product, "extension-carriers", sameStrings(expected, config.registry_packages), "Exact-extension registry carriers must be derived from its published target rows.", `${config.path}/release.toml`);
  requireCondition(findings, product, "extension-facade", carriers.get(`cargo:${product}`)?.product === product, "Exact extension is missing its stable Cargo facade carrier.", `cargo:${product}`);
  requireCondition(findings, product, "extension-version", currentProductVersionSync(product, TOOL) === config.version, "Exact-extension version does not match the release graph.", `${config.path}/VERSION`);
}

function validateProduct(findings, graph, catalog, carriers, product) {
  const config = graph.products[product];
  const catalogProduct = catalog.products.find((row) => row.id === product);
  requireCondition(findings, product, "catalog-product", catalogProduct?.version === config.version, "Release product is missing or version-skewed in the publication catalog.", config.path);
  for (const [target, ecosystem] of Object.entries(REGISTRY_ECOSYSTEM)) {
    const hasTarget = config.publish_targets.includes(target);
    const hasCarrier = catalog.carriers.some((carrier) => carrier.product === product && carrier.ecosystem === ecosystem);
    requireCondition(findings, product, "registry-surface", hasTarget === hasCarrier, `${target} publication target and ${ecosystem} carrier inventory disagree.`, `${config.path}/release.toml`);
  }
  const manifests = new Map();
  for (const file of config.version_files) {
    if (path.basename(file) === "package.json") {
      manifests.set(file, validateNpmManifest(findings, product, config, file, carriers));
    } else if (path.basename(file) === "Cargo.toml") {
      validateCargoManifest(findings, product, config, file, carriers);
    }
  }
  validatePlatformNpmPackages(findings, product, config, manifests, carriers);
  const proofs = validateExecutableProofs(findings, graph, product, config);
  if (product === "oliphaunt-js") {
    validateTypescript(findings, graph, config, carriers);
  }
  if (config.kind === "exact-extension-artifact") {
    validateExactExtension(findings, graph, product, config, carriers);
  }
  return proofs;
}

function parseValue(argv, index, name) {
  if (index + 1 >= argv.length) {
    fail(`${name} requires a value`);
  }
  return argv[index + 1];
}

function parseArgs(argv) {
  const options = {
    productsJson: undefined,
    products: [],
    severities: [],
    ids: [],
    format: "text",
    requireReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--products-json") {
      options.productsJson = parseValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--products-json=")) {
      options.productsJson = arg.slice("--products-json=".length);
    } else if (arg === "--product") {
      options.products.push(parseValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--product=")) {
      options.products.push(arg.slice("--product=".length));
    } else if (arg === "--severity") {
      options.severities.push(parseValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--severity=")) {
      options.severities.push(arg.slice("--severity=".length));
    } else if (arg === "--id") {
      options.ids.push(parseValue(argv, index, arg));
      index += 1;
    } else if (arg.startsWith("--id=")) {
      options.ids.push(arg.slice("--id=".length));
    } else if (arg === "--format") {
      options.format = parseValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
    } else if (arg === "--require-ready") {
      options.requireReady = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log("usage: tools/release/check-consumer-shape.mjs [--products-json JSON] [--product PRODUCT] [--severity P0|P1|P2] [--id FINDING] [--format text|json|markdown] [--require-ready]");
      process.exit(0);
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  if (!["text", "json", "markdown"].includes(options.format)) {
    fail(`--format must be text, json, or markdown; got ${options.format}`);
  }
  if (options.severities.some((severity) => !SEVERITIES.has(severity))) {
    fail(`--severity must be P0, P1, or P2`);
  }
  return options;
}

function selectedProducts(options, graph) {
  let selected;
  if (options.products.length > 0) {
    selected = options.products;
  } else if (options.productsJson !== undefined) {
    try {
      selected = JSON.parse(options.productsJson);
    } catch (error) {
      fail(`--products-json must be valid JSON: ${error.message}`);
    }
    if (!Array.isArray(selected) || selected.some((product) => typeof product !== "string")) {
      fail("--products-json must be a JSON string list");
    }
  } else {
    selected = Object.keys(graph.products).sort(compareText);
  }
  const unknown = [...new Set(selected.filter((product) => !(product in graph.products)))].sort(compareText);
  if (unknown.length > 0) {
    fail(`unknown consumer-shape products: ${unknown.join(", ")}`);
  }
  return [...new Set(selected)];
}

function reportFor(products, findings, proofTargetCount) {
  const countsBySeverity = {};
  for (const item of findings) {
    countsBySeverity[item.severity] = (countsBySeverity[item.severity] ?? 0) + 1;
  }
  return {
    schema: SCHEMA,
    products,
    ready: findings.length === 0,
    findingCount: findings.length,
    countsBySeverity,
    proofTargetCount,
    findings,
  };
}

function printReport(report, format) {
  if (format === "json") {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (format === "markdown") {
    console.log("# Consumer Shape Readiness\n");
    if (report.ready) {
      console.log(`No consumer-shape gaps were found. ${report.proofTargetCount} product-owned executable proof targets are wired.`);
      return;
    }
    console.log("| Severity | Finding | Message | Evidence |");
    console.log("| --- | --- | --- | --- |");
    for (const item of report.findings) {
      const evidence = item.evidence.map((entry) => String(entry).replaceAll("|", "\\|")).join("<br>");
      console.log(`| ${item.severity} | \`${item.id}\` | ${item.message.replaceAll("|", "\\|")} | ${evidence} |`);
    }
    return;
  }
  if (report.ready) {
    console.log(`consumer shape checks passed (${report.products.length} products, ${report.proofTargetCount} executable proof targets)`);
    return;
  }
  console.log(`consumer shape gaps found: ${report.findingCount}`);
  for (const item of report.findings) {
    console.log(`- [${item.severity}] ${item.id}: ${item.message}`);
    for (const evidence of item.evidence) {
      console.log(`  evidence: ${evidence}`);
    }
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const graph = loadGraph(TOOL);
  const catalog = loadPublicationCatalog(TOOL);
  const carriers = declaredCarrierMap(catalog);
  const products = selectedProducts(options, graph);
  const findings = [];
  let proofTargetCount = 0;
  for (const product of products) {
    proofTargetCount += validateProduct(findings, graph, catalog, carriers, product);
  }
  findings.sort((left, right) =>
    compareText(left.severity, right.severity)
    || compareText(left.product, right.product)
    || compareText(left.check, right.check));
  const filtered = findings.filter((item) =>
    (options.severities.length === 0 || options.severities.includes(item.severity))
    && (options.ids.length === 0 || options.ids.includes(item.id)));
  const report = reportFor(products, filtered, proofTargetCount);
  printReport(report, options.format);
  if (options.requireReady && !report.ready) {
    process.exitCode = 1;
  }
}

try {
  main(Bun.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
