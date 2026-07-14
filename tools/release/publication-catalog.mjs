#!/usr/bin/env bun
import { createHash } from "node:crypto";

import {
  compareText,
  loadGraph,
  releaseOrder,
} from "./release-graph.mjs";

export const PUBLICATION_CATALOG_SCHEMA = "oliphaunt-publication-catalog-v1";

export const REGISTRY_KIND_TO_ECOSYSTEM = Object.freeze({
  crates: "cargo",
  npm: "npm",
  maven: "maven",
  jsr: "jsr",
});

const TARGET_MARKERS = [
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "android-arm64-v8a",
  "android-x86_64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "macos-arm64",
  "windows-x64-msvc",
  "darwin-arm64",
  "win32-x64-msvc",
  "portable",
];

function fail(prefix, message) {
  throw new Error(`${prefix}: ${message}`);
}

function sortedUniqueStrings(value, context, prefix) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(prefix, `${context} must be a list of non-empty strings`);
  }
  const sorted = [...new Set(value)].sort(compareText);
  if (sorted.length !== value.length) {
    fail(prefix, `${context} must not contain duplicates`);
  }
  return sorted;
}

function parseRegistryIdentity(raw, product, prefix) {
  if (typeof raw !== "string") {
    fail(prefix, `${product}.registry_packages entries must be strings`);
  }
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail(prefix, `${product}.registry_packages entry ${JSON.stringify(raw)} must use kind:name`);
  }
  const kind = raw.slice(0, separator);
  const ecosystem = REGISTRY_KIND_TO_ECOSYSTEM[kind];
  if (ecosystem === undefined) {
    fail(prefix, `${product}.registry_packages entry ${JSON.stringify(raw)} uses unsupported kind ${kind}`);
  }
  return { ecosystem, name: raw.slice(separator + 1) };
}

function carrierTarget(name) {
  return TARGET_MARKERS.find((target) => name.includes(target)) ?? null;
}

function carrierRole(product, ecosystem, name, target) {
  if (/-part-[0-9]{3}$/u.test(name)) {
    return "payload-part";
  }
  if (ecosystem === "jsr") {
    return "facade";
  }
  if (ecosystem === "maven" && (name.includes("gradle-plugin") || name.endsWith(".gradle.plugin"))) {
    return "plugin";
  }
  if (name.includes("icu") || name.includes("resources")) {
    return "resource";
  }
  if (name.includes("tools") || name.includes("broker")) {
    return target === null ? "tool-facade" : "tool-leaf";
  }
  if (target !== null) {
    return name.includes("aot-") ? "aot-leaf" : "platform-leaf";
  }
  if (product.startsWith("oliphaunt-extension-")) {
    return name.endsWith("-wasix") ? "portable-leaf" : "facade";
  }
  return "facade";
}

function productDependencies(product, config, graph) {
  const dependencies = new Set();
  const compatibility = config.compatibility_versions ?? {};
  if (compatibility !== null && !Array.isArray(compatibility) && typeof compatibility === "object") {
    for (const entry of Object.values(compatibility)) {
      if (
        entry !== null
        && !Array.isArray(entry)
        && typeof entry === "object"
        && typeof entry.source_product === "string"
        && entry.source_product in graph.products
        && entry.source_product !== product
      ) {
        dependencies.add(entry.source_product);
      }
    }
  }
  const project = graph.moon_projects?.[product];
  for (const dependency of project?.dependsOn ?? []) {
    if (dependency in graph.products && dependency !== product) {
      dependencies.add(dependency);
    }
  }
  return [...dependencies].sort(compareText);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function publicationCatalogDigest(catalog) {
  return createHash("sha256").update(stableJson(catalog)).digest("hex");
}

export function loadPublicationCatalog(prefix = "publication-catalog", { products = undefined } = {}) {
  const graph = loadGraph(prefix);
  const known = new Set(Object.keys(graph.products));
  const selected = products === undefined ? [...known] : sortedUniqueStrings(products, "products", prefix);
  const unknown = selected.filter((product) => !known.has(product));
  if (unknown.length > 0) {
    fail(prefix, `unknown release products: ${unknown.join(", ")}`);
  }
  const ordered = releaseOrder(graph.products, graph.moon_projects, new Set(selected), prefix);
  const productRows = [];
  const carriers = [];
  const identities = new Map();
  for (const product of ordered) {
    const config = graph.products[product];
    const publishTargets = sortedUniqueStrings(config.publish_targets ?? [], `${product}.publish_targets`, prefix);
    const registryPackages = sortedUniqueStrings(config.registry_packages ?? [], `${product}.registry_packages`, prefix);
    productRows.push({
      id: product,
      kind: config.kind,
      path: config.path,
      version: config.version,
      publishTargets,
      dependencies: productDependencies(product, config, graph),
    });
    for (const raw of registryPackages) {
      const { ecosystem, name } = parseRegistryIdentity(raw, product, prefix);
      const id = `${ecosystem}:${name}`;
      const previous = identities.get(id);
      if (previous !== undefined) {
        fail(prefix, `registry carrier ${id} is declared by both ${previous} and ${product}`);
      }
      identities.set(id, product);
      const target = carrierTarget(name);
      carriers.push({
        id,
        product,
        version: config.version,
        ecosystem,
        name,
        role: carrierRole(product, ecosystem, name, target),
        target,
        declared: true,
      });
    }
    // Exact extension products expose one stable Rust-facing facade in
    // addition to their target leaves. The facade is derived here so legacy
    // colocated release.toml files remain readable while this loader is the
    // sole canonical Product -> Carrier projection.
    if (config.kind === "exact-extension-artifact") {
      const id = `cargo:${product}`;
      if (identities.has(id)) {
        fail(prefix, `${product} must not declare its generated Cargo facade twice`);
      }
      identities.set(id, product);
      carriers.push({
        id,
        product,
        version: config.version,
        ecosystem: "cargo",
        name: product,
        role: "facade",
        target: null,
        declared: true,
      });
    }
  }
  carriers.sort((left, right) => compareText(left.id, right.id));
  return {
    schema: PUBLICATION_CATALOG_SCHEMA,
    products: productRows,
    carriers,
  };
}

export function declaredCarrierMap(catalog) {
  return new Map(catalog.carriers.map((carrier) => [carrier.id, carrier]));
}

export function resolveActualCarrier(catalog, ecosystem, name, prefix = "publication-catalog") {
  const id = `${ecosystem}:${name}`;
  const declared = declaredCarrierMap(catalog).get(id);
  if (declared !== undefined) {
    return declared;
  }
  if (ecosystem !== "cargo") {
    fail(prefix, `artifact identity ${id} is not declared; dynamic identities are permitted only for Cargo payload part crates`);
  }
  const match = name.match(/^(.*)-part-([0-9]{3})$/u);
  if (match === null) {
    fail(prefix, `artifact identity ${id} is not declared and is not a Cargo payload part crate`);
  }
  const parent = declaredCarrierMap(catalog).get(`cargo:${match[1]}`);
  if (parent === undefined) {
    fail(prefix, `Cargo payload part ${id} has no declared parent carrier cargo:${match[1]}`);
  }
  return {
    ...parent,
    id,
    name,
    role: "payload-part",
    declared: false,
    parentCarrier: parent.id,
    part: Number.parseInt(match[2], 10),
  };
}

function main() {
  const catalog = loadPublicationCatalog("publication-catalog.mjs");
  console.log(`${JSON.stringify({ ...catalog, digest: publicationCatalogDigest(catalog) }, null, 2)}\n`);
}

if (import.meta.main) {
  main();
}
