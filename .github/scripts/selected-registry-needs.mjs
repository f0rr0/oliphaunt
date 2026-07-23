#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import process from "node:process";

import { loadPublicationCatalog } from "../../tools/release/publication-catalog.mjs";

function fail(message) {
  console.error(`selected-registry-needs: ${message}`);
  process.exit(1);
}

let products;
try {
  products = JSON.parse(process.env.PRODUCTS_JSON ?? "");
} catch (error) {
  fail(`invalid PRODUCTS_JSON: ${error.message}`);
}
if (!Array.isArray(products) || products.length === 0 || products.some((product) => typeof product !== "string")) {
  fail("PRODUCTS_JSON must be a non-empty product string list");
}

const catalog = loadPublicationCatalog("selected-registry-needs", { products });
const ecosystems = new Set(catalog.carriers.map((carrier) => carrier.ecosystem));
for (const ecosystem of ["cargo", "npm", "maven", "jsr"]) {
  const line = `needs_${ecosystem}=${String(ecosystems.has(ecosystem))}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`, "utf8");
  }
}
