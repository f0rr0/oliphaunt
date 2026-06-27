#!/usr/bin/env bun
import {
  allArtifactTargets,
  extensionArtifactTargets,
  rawArtifactTargetRows,
} from "./release-artifact-targets.mjs";
import {
  buildPlan,
  compareText,
  loadGraph,
  normalizeFiles,
  releaseOrder,
  releaseProductProjectId,
} from "./release-graph.mjs";
import { wasixCargoArtifactContract } from "./wasix-cargo-artifact-contract.mjs";

const TOOL = "release_graph_query.mjs";

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

function printJson(value) {
  console.log(JSON.stringify(sortedValue(value), null, 2));
}

function parseJsonFlag(argv, name, { required = false } = {}) {
  const raw = stringFlag(argv, name, { required });
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`--${name} must be valid JSON: ${error.message}`);
  }
}

function stringFlag(argv, name, { required = false } = {}) {
  const flag = `--${name}`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === flag) {
      if (index + 1 >= argv.length) {
        fail(`${flag} requires a value`);
      }
      return argv[index + 1];
    }
    if (value.startsWith(`${flag}=`)) {
      return value.slice(flag.length + 1);
    }
  }
  if (required) {
    fail(`${flag} is required`);
  }
  return undefined;
}

function changedFiles(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--changed-file") {
      if (index + 1 >= argv.length) {
        fail("--changed-file requires a value");
      }
      files.push(argv[index + 1]);
      index += 1;
    } else if (value.startsWith("--changed-file=")) {
      files.push(value.slice("--changed-file=".length));
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return files;
}

function assertStringList(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${label} must be a JSON string list`);
  }
  return value;
}

function graphProductProjects(graph) {
  const products = graph.products;
  const projects = graph.moon_projects;
  return Object.fromEntries(
    Object.keys(products)
      .sort(compareText)
      .map((product) => [
        product,
        releaseProductProjectId(product, products, projects, TOOL),
      ]),
  );
}

function runGraph() {
  printJson(loadGraph(TOOL));
}

function runProductProjects() {
  printJson(graphProductProjects(loadGraph(TOOL)));
}

function runReleaseOrder(argv) {
  const graph = loadGraph(TOOL);
  const selected = assertStringList(
    parseJsonFlag(argv, "products-json", { required: true }),
    "--products-json",
  );
  const known = new Set(Object.keys(graph.products));
  const unknown = [...new Set(selected)].filter((product) => !known.has(product)).sort(compareText);
  if (unknown.length > 0) {
    fail(`unknown release products: ${unknown.join(", ")}`);
  }
  printJson(releaseOrder(graph.products, graph.moon_projects, selected, TOOL));
}

function runPlan(argv) {
  const graph = loadGraph(TOOL);
  printJson(buildPlan(graph, normalizeFiles(changedFiles(argv)), TOOL));
}

function runPlansForPaths(argv) {
  const paths = assertStringList(
    parseJsonFlag(argv, "paths-json", { required: true }),
    "--paths-json",
  );
  const graph = loadGraph(TOOL);
  printJson(
    Object.fromEntries(
      paths
        .map((file) => [file, buildPlan(graph, normalizeFiles([file]), TOOL)])
        .sort(([left], [right]) => compareText(left, right)),
    ),
  );
}

function parseArtifactTargetOptions(argv) {
  let product;
  let kind;
  let surface;
  let publishedOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      product = argv[++index];
      if (!product) {
        fail("--product requires a value");
      }
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--kind") {
      kind = argv[++index];
      if (!kind) {
        fail("--kind requires a value");
      }
    } else if (value.startsWith("--kind=")) {
      kind = value.slice("--kind=".length);
    } else if (value === "--surface") {
      surface = argv[++index];
      if (!surface) {
        fail("--surface requires a value");
      }
    } else if (value.startsWith("--surface=")) {
      surface = value.slice("--surface=".length);
    } else if (value === "--published-only") {
      publishedOnly = true;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  return { product, kind, surface, publishedOnly };
}

function runArtifactTargets(argv) {
  printJson(allArtifactTargets(parseArtifactTargetOptions(argv), TOOL));
}

function runRawArtifactTargets(argv) {
  const { product, kind, surface, publishedOnly } = parseArtifactTargetOptions(argv);
  printJson(
    rawArtifactTargetRows(TOOL).filter((target) => {
      if (product !== undefined && target.product !== product) {
        return false;
      }
      if (kind !== undefined && target.kind !== kind) {
        return false;
      }
      if (surface !== undefined && !target.surfaces?.includes(surface)) {
        return false;
      }
      if (publishedOnly && target.published !== true) {
        return false;
      }
      return true;
    }),
  );
}

function runExtensionTargets(argv) {
  let product;
  let family;
  let publishedOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--product") {
      if (index + 1 >= argv.length) {
        fail("--product requires a value");
      }
      product = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--product=")) {
      product = value.slice("--product=".length);
    } else if (value === "--family") {
      if (index + 1 >= argv.length) {
        fail("--family requires a value");
      }
      family = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--family=")) {
      family = value.slice("--family=".length);
    } else if (value === "--published-only") {
      publishedOnly = true;
    } else {
      fail(`unknown argument ${value}`);
    }
  }
  if (family !== undefined && !["native", "wasix"].includes(family)) {
    fail("--family must be native or wasix");
  }
  printJson(extensionArtifactTargets({ product, family, publishedOnly }, TOOL));
}

function runWasixCargoArtifactContract() {
  printJson(wasixCargoArtifactContract());
}

function usage() {
  return `usage: tools/release/release_graph_query.mjs <command> [options]

Commands:
  graph
  product-projects
  release-order --products-json JSON
  plan [--changed-file PATH...]
  plans-for-paths --paths-json JSON
  artifact-targets [--product PRODUCT] [--kind KIND] [--surface SURFACE] [--published-only]
  raw-artifact-targets [--product PRODUCT] [--kind KIND] [--surface SURFACE] [--published-only]
  extension-targets [--product PRODUCT] [--family native|wasix] [--published-only]
  wasix-cargo-artifact-contract
`;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "graph") {
    runGraph();
  } else if (command === "product-projects") {
    runProductProjects();
  } else if (command === "release-order") {
    runReleaseOrder(rest);
  } else if (command === "plan") {
    runPlan(rest);
  } else if (command === "plans-for-paths") {
    runPlansForPaths(rest);
  } else if (command === "artifact-targets") {
    runArtifactTargets(rest);
  } else if (command === "raw-artifact-targets") {
    runRawArtifactTargets(rest);
  } else if (command === "extension-targets") {
    runExtensionTargets(rest);
  } else if (command === "wasix-cargo-artifact-contract") {
    runWasixCargoArtifactContract();
  } else if (command === "--help" || command === "-h") {
    console.log(usage());
  } else {
    fail(command ? `unknown command ${command}` : "missing command");
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
