#!/usr/bin/env bun
import { parseArgs } from "node:util";

import {
  ciNpmPackageArtifactRows,
  ciReleaseAssetArtifactRows,
  extensionArtifactProductRoot,
  extensionArtifactProductsForReleaseProducts,
  extensionMemberPath,
  extensionMetadata,
  extensionReleaseProduct,
  extensionSqlNames,
  extensionSourceIdentity,
  exactExtensionProducts,
  sdkPackageProducts,
} from "./release-artifact-targets.mjs";
import { compareText, loadGraph, releaseOrder } from "./release-graph.mjs";
import { extensionNpmPackageForProduct } from "./extension-registry-packages.mjs";

const TOOL = "release_graph_query.mjs";

function fail(message) {
  console.error(`${TOOL}: ${message}`);
  process.exit(2);
}

function commandOptions(argv, options) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    fail(error.message);
  }
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

function printJson(value) {
  console.log(JSON.stringify(sortedValue(value), null, 2));
}

function output(rows, format, field) {
  if (format === "lines") {
    for (const row of rows) console.log(row[field]);
  } else if (format === "json") {
    printJson(rows);
  } else {
    fail("--format must be json or lines");
  }
}

function stringList(raw, flag) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`${flag} must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(`${flag} must be a JSON string list`);
  }
  return value;
}

function orderedReleaseProducts(raw) {
  const selected = stringList(raw, "--products-json");
  const graph = loadGraph(TOOL);
  const unknown = [...new Set(selected)]
    .filter((product) => !(product in graph.products))
    .sort(compareText);
  if (unknown.length > 0) fail(`unknown release products: ${unknown.join(", ")}`);
  return releaseOrder(graph.products, graph.moon_projects, selected, TOOL);
}

function runCiArtifactNames(argv) {
  const values = commandOptions(argv, {
    family: { type: "string" },
    product: { type: "string" },
    kind: { type: "string" },
    format: { type: "string", default: "json" },
  });
  if (!values.family) fail("--family is required");
  if (!values.product) fail("--product is required");

  let rows;
  if (values.family === "release-assets") {
    if (!values.kind) fail("--kind is required for release-assets artifacts");
    rows = ciReleaseAssetArtifactRows(values.product, values.kind, TOOL);
  } else if (values.family === "npm-package") {
    if (!values.kind) fail("--kind is required for npm-package artifacts");
    rows = ciNpmPackageArtifactRows(values.product, values.kind, TOOL);
  } else if (values.family === "sdk-package") {
    if (values.kind) fail("--kind is not accepted for sdk-package artifacts");
    rows = sdkPackageProducts(TOOL).filter((row) => row.product === values.product);
    if (rows.length !== 1) fail(`${values.product} is not an SDK release product`);
  } else {
    fail("--family must be release-assets, npm-package, or sdk-package");
  }
  output(rows, values.format, "artifactName");
}

function runCiProducts(argv) {
  const values = commandOptions(argv, {
    family: { type: "string" },
    "carrier-family": { type: "string" },
    field: { type: "string", default: "product" },
    "products-json": { type: "string" },
    format: { type: "string", default: "json" },
  });
  const carrierFamily = values["carrier-family"];
  if (carrierFamily !== undefined && !["native", "wasix"].includes(carrierFamily)) {
    fail("--carrier-family must be native or wasix");
  }
  if (!["product", "artifact-root"].includes(values.field)) {
    fail("--field must be product or artifact-root");
  }
  if (values.family !== "extension-artifacts" && (carrierFamily !== undefined || values.field !== "product")) {
    fail("--carrier-family and non-product --field values require --family extension-artifacts");
  }
  if (values.field !== "product" && values.format !== "lines") {
    fail("non-product --field values require --format lines");
  }

  let availableRows;
  if (values.family === "sdk-package") {
    availableRows = sdkPackageProducts(TOOL);
  } else if (values.family === "extension-artifacts") {
    availableRows = exactExtensionProducts(TOOL).map((product) => ({ product }));
  } else {
    fail("--family must be sdk-package or extension-artifacts");
  }

  const rowsByProduct = new Map(availableRows.map((row) => [row.product, row]));
  const selectedReleaseProducts = values["products-json"] === undefined
    ? undefined
    : orderedReleaseProducts(values["products-json"]);
  const products = selectedReleaseProducts === undefined
    ? availableRows.map((row) => row.product)
    : values.family === "extension-artifacts"
      ? extensionArtifactProductsForReleaseProducts(selectedReleaseProducts, {
          family: carrierFamily,
          prefix: TOOL,
        })
      : selectedReleaseProducts.filter((product) => rowsByProduct.has(product));

  if (values.field === "product") {
    output(products.map((product) => rowsByProduct.get(product)), values.format, "product");
    return;
  }

  const selectedSet = selectedReleaseProducts === undefined ? null : new Set(selectedReleaseProducts);
  const roots = products.flatMap((product) => {
    const families = carrierFamily === undefined ? ["native", "wasix"] : [carrierFamily];
    return families
      .filter((family) => selectedSet === null
        || selectedSet.has(extensionReleaseProduct(product, family, TOOL)))
      .map((family) => extensionArtifactProductRoot(
        product,
        family,
        "target/extension-artifacts",
        TOOL,
      ));
  });
  for (const root of [...new Set(roots)]) console.log(root);
}

function runExtensionArtifactRoot(argv) {
  const values = commandOptions(argv, {
    product: { type: "string" },
    family: { type: "string", default: "native" },
  });
  if (!values.product) fail("--product is required");
  if (!["native", "wasix"].includes(values.family)) fail("--family must be native or wasix");
  console.log(extensionArtifactProductRoot(
    values.product,
    values.family,
    "target/extension-artifacts",
    TOOL,
  ));
}

function runExtensionMetadata(argv) {
  const values = commandOptions(argv, { product: { type: "string" } });
  const products = values.product === undefined ? exactExtensionProducts(TOOL) : [values.product];
  printJson(products.flatMap((product) => {
    const metadata = extensionMetadata(product, TOOL);
    return extensionSqlNames(product, TOOL).map((sqlName) => ({
      product,
      cargoPackage: product,
      npmPackage: extensionNpmPackageForProduct(product),
      mavenGroup: "dev.oliphaunt.extensions",
      mavenArtifact: product,
      ...metadata,
      sqlName,
      memberPath: extensionMemberPath(product, sqlName, TOOL),
      sourceIdentity: extensionSourceIdentity(product, TOOL),
    }));
  }));
}

function usage() {
  return `usage: tools/release/release_graph_query.mjs <command> [options]

Commands:
  ci-artifact-names --family release-assets|npm-package|sdk-package --product PRODUCT [--kind KIND] [--format json|lines]
  ci-products --family sdk-package|extension-artifacts [--products-json JSON] [--carrier-family native|wasix] [--field product|artifact-root] [--format json|lines]
  extension-artifact-root --product PRODUCT [--family native|wasix]
  extension-metadata [--product PRODUCT]
`;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "ci-artifact-names") runCiArtifactNames(rest);
  else if (command === "ci-products") runCiProducts(rest);
  else if (command === "extension-artifact-root") runExtensionArtifactRoot(rest);
  else if (command === "extension-metadata") runExtensionMetadata(rest);
  else if (command === "--help" || command === "-h") console.log(usage());
  else fail(command ? `unknown command ${command}` : "missing command");
}

if (import.meta.main) main(Bun.argv.slice(2));
