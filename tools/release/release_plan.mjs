#!/usr/bin/env bun
import {
  buildPlan,
  buildPlanFromProductTags,
  changedFilesFromRefs,
  compareText,
  loadGraph,
  normalizeFiles,
  wasixEvidenceProductsForRelease,
} from "./release-graph.mjs";

const TOOL = "release_plan.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(2);
}

function sortedValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

function printJson(plan) {
  console.log(JSON.stringify(sortedValue(plan), null, 2));
}

function printGithubOutput(plan) {
  const products = plan.releaseProducts;
  const graph = loadGraph(TOOL);
  const wasixEvidenceProducts = wasixEvidenceProductsForRelease(
    graph.products,
    graph.moon_projects,
    products,
    TOOL,
  );
  const extensionProducts = products.filter((product) => product.startsWith("oliphaunt-extension-")).sort(compareText);
  console.log(`has_release_changes=${String(plan.hasReleaseChanges).toLowerCase()}`);
  console.log(`has_extension_products=${String(extensionProducts.length > 0).toLowerCase()}`);
  console.log(`docs_only=${String(plan.docsOnly).toLowerCase()}`);
  console.log(`products_csv=${products.join(",")}`);
  console.log(`products_json=${JSON.stringify(products)}`);
  console.log(`extension_products_json=${JSON.stringify(extensionProducts)}`);
  console.log(`requires_wasix_release_regression_evidence=${String(wasixEvidenceProducts.length > 0).toLowerCase()}`);
  console.log(`wasix_evidence_products_json=${JSON.stringify(wasixEvidenceProducts)}`);
  console.log(`plan_hash=${plan.planHash}`);
  console.log(`release_branch=${plan.releaseBranch}`);
  for (const product of plan.productIds ?? []) {
    const key = `product_${product.replaceAll("-", "_")}`;
    console.log(`${key}=${String(products.includes(product)).toLowerCase()}`);
  }
  console.log(`direct_products_json=${JSON.stringify(plan.directProducts)}`);
  console.log(`product_base_refs_json=${JSON.stringify(plan.productBaseRefs ?? {})}`);
}

function printText(plan) {
  const changedFiles = plan.changedFiles ?? [];
  if (changedFiles.length === 0) {
    console.log("No changed files were provided; no product release is planned.");
  } else if (plan.hasReleaseChanges) {
    console.log(`Release products: ${plan.releaseProducts.join(", ")}`);
    console.log(`Direct products: ${plan.directProducts.join(", ")}`);
  } else {
    console.log("No product release is planned for these changes.");
  }
}

function parseArgs(argv) {
  const args = {
    baseRef: undefined,
    headRef: "HEAD",
    fromProductTags: false,
    includeCurrentTags: false,
    includeCurrentVersionTags: false,
    changedFiles: [],
    format: "text",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-ref") {
      if (index + 1 >= argv.length) {
        fail("--base-ref requires a value");
      }
      args.baseRef = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--base-ref=")) {
      args.baseRef = value.slice("--base-ref=".length);
    } else if (value === "--head-ref") {
      if (index + 1 >= argv.length) {
        fail("--head-ref requires a value");
      }
      args.headRef = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--head-ref=")) {
      args.headRef = value.slice("--head-ref=".length);
    } else if (value === "--from-product-tags") {
      args.fromProductTags = true;
    } else if (value === "--include-current-tags") {
      args.includeCurrentTags = true;
    } else if (value === "--include-current-version-tags") {
      args.includeCurrentVersionTags = true;
    } else if (value === "--changed-file") {
      if (index + 1 >= argv.length) {
        fail("--changed-file requires a value");
      }
      args.changedFiles.push(argv[index + 1]);
      index += 1;
    } else if (value.startsWith("--changed-file=")) {
      args.changedFiles.push(value.slice("--changed-file=".length));
    } else if (value === "--format") {
      if (index + 1 >= argv.length) {
        fail("--format requires a value");
      }
      args.format = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--format=")) {
      args.format = value.slice("--format=".length);
    } else if (value === "-h" || value === "--help") {
      console.log("usage: tools/release/release_plan.mjs [--base-ref REF] [--head-ref REF] [--from-product-tags] [--include-current-tags] [--include-current-version-tags] [--changed-file PATH...] [--format text|json|github-output]");
      process.exit(0);
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (!["text", "json", "github-output"].includes(args.format)) {
    fail("--format must be one of: text, json, github-output");
  }
  return args;
}

function planForArgs(args) {
  const graph = loadGraph(TOOL);
  if (args.changedFiles.length > 0) {
    return buildPlan(graph, normalizeFiles(args.changedFiles), TOOL);
  }
  if (args.fromProductTags) {
    return buildPlanFromProductTags(graph, args.headRef, {
      includeCurrentTags: args.includeCurrentTags,
      includeCurrentVersionTags: args.includeCurrentVersionTags,
      prefix: TOOL,
    });
  }
  if (args.baseRef) {
    return buildPlan(graph, normalizeFiles(changedFilesFromRefs(args.baseRef, args.headRef, TOOL)), TOOL);
  }
  return buildPlan(graph, [], TOOL);
}

function main(argv) {
  const args = parseArgs(argv);
  const plan = planForArgs(args);
  if (args.format === "json") {
    printJson(plan);
  } else if (args.format === "github-output") {
    printGithubOutput(plan);
  } else {
    printText(plan);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
