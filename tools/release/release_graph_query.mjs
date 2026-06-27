#!/usr/bin/env bun
import {
  buildPlan,
  compareText,
  loadGraph,
  normalizeFiles,
  releaseOrder,
  releaseProductProjectId,
} from "./release-graph.mjs";

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

function usage() {
  return `usage: tools/release/release_graph_query.mjs <command> [options]

Commands:
  graph
  product-projects
  release-order --products-json JSON
  plan [--changed-file PATH...]
  plans-for-paths --paths-json JSON
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
  } else if (command === "--help" || command === "-h") {
    console.log(usage());
  } else {
    fail(command ? `unknown command ${command}` : "missing command");
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
