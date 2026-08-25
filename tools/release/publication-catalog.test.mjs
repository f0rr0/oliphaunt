#!/usr/bin/env bun
import { describe, expect, test } from "bun:test";

import { loadPublicationCatalog, resolveActualCarrier } from "./publication-catalog.mjs";
import {
  exactExtensionProducts,
  extensionReleaseProduct,
  extensionWasixAotMemberSqlNames,
} from "./release-artifact-targets.mjs";
import {
  EXTENSION_AOT_PACKAGE_SUFFIXES,
  EXTENSION_PORTABLE_TARGET,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";

function catalogForArtifactProducts(products) {
  return loadPublicationCatalog("publication-catalog.test", {
    products: [...new Set(products.map((product) =>
      extensionReleaseProduct(product, "wasix", "publication-catalog.test")))],
  });
}

test("the live publication catalog includes the independently versioned PostGIS product", () => {
  const catalog = loadPublicationCatalog("publication-catalog.test");
  expect(catalog.products).toHaveLength(19);
  expect(catalog.carriers).toHaveLength(199);
  expect(catalog.products.some(({ id }) => id === "oliphaunt-extension-postgis")).toBe(true);
  expect(catalog.carriers.filter(({ product }) => product === "oliphaunt-extension-postgis")).toHaveLength(18);

  const extensionProducts = exactExtensionProducts("publication-catalog.test");
  expect(extensionProducts).toHaveLength(8);
  expect(extensionProducts).toContain("oliphaunt-extension-postgis");
});

test("native tool target leaves admit exact payload parts while facades remain non-splittable", () => {
  const catalog = loadPublicationCatalog("publication-catalog.test");
  const toolLeaves = catalog.carriers
    .filter(({ ecosystem, name, role }) =>
      ecosystem === "cargo" && name.startsWith("oliphaunt-tools-") && role === "tool-leaf")
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  expect(toolLeaves.map(({ name }) => name)).toEqual([
    "oliphaunt-tools-linux-arm64-gnu",
    "oliphaunt-tools-linux-x64-gnu",
    "oliphaunt-tools-macos-arm64",
    "oliphaunt-tools-windows-x64-msvc",
  ]);
  for (const parent of toolLeaves) {
    expect(resolveActualCarrier(
      catalog,
      "cargo",
      `${parent.name}-part-001`,
      "publication-catalog.test",
    )).toMatchObject({
      declared: false,
      parentCarrier: parent.id,
      part: 1,
      role: "payload-part",
      target: parent.target,
    });
  }
  expect(() => resolveActualCarrier(
    catalog,
    "cargo",
    "oliphaunt-tools-part-001",
    "publication-catalog.test",
  )).toThrow(/non-splittable parent role tool-facade/u);

  const otherToolLeaves = catalog.carriers
    .filter(({ ecosystem, product, role }) =>
      ecosystem === "cargo" && product !== "liboliphaunt-native" && role === "tool-leaf")
    .map(({ name }) => name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  expect(otherToolLeaves).toEqual([
    "oliphaunt-broker-linux-arm64-gnu",
    "oliphaunt-broker-linux-x64-gnu",
    "oliphaunt-broker-macos-arm64",
    "oliphaunt-broker-windows-x64-msvc",
    "oliphaunt-wasix-tools-aot-aarch64-apple-darwin",
    "oliphaunt-wasix-tools-aot-aarch64-unknown-linux-gnu",
    "oliphaunt-wasix-tools-aot-x86_64-pc-windows-msvc",
    "oliphaunt-wasix-tools-aot-x86_64-unknown-linux-gnu",
  ]);
  for (const name of otherToolLeaves) {
    expect(() => resolveActualCarrier(
      catalog,
      "cargo",
      `${name}-part-001`,
      "publication-catalog.test",
    )).toThrow(/non-splittable parent role tool-leaf/u);
  }
});

describe("WASIX extension portable publication carriers", () => {
  test("assigns every independently versioned portable carrier an explicit canonical target", () => {
    const products = exactExtensionProducts("publication-catalog.test");
    const catalog = catalogForArtifactProducts(products);
    for (const product of products) {
      const owner = extensionReleaseProduct(product, "wasix", "publication-catalog.test");
      const name = wasixExtensionPackageName(product);
      const carrier = catalog.carriers.find((candidate) => candidate.name === name);
      expect(carrier).toMatchObject({
        ecosystem: "cargo",
        product: owner,
        role: "portable-leaf",
        target: EXTENSION_PORTABLE_TARGET,
      });
      const part = resolveActualCarrier(
        catalog,
        "cargo",
        `${name}-part-001`,
        "publication-catalog.test",
      );
      expect(part).toMatchObject({
        role: "payload-part",
        parentCarrier: `cargo:${name}`,
        part: 1,
        target: EXTENSION_PORTABLE_TARGET,
      });
    }
  });
});

describe("WASIX extension AOT publication carriers", () => {
  test("declares the exact host set only for products with native-module members", () => {
    const products = exactExtensionProducts("publication-catalog.test");
    const catalog = catalogForArtifactProducts(products);
    const expectedTargets = Object.keys(EXTENSION_AOT_PACKAGE_SUFFIXES).sort();
    for (const product of products) {
      const aotMembers = extensionWasixAotMemberSqlNames(product, "publication-catalog.test");
      const actualTargets = catalog.carriers
        .filter((carrier) =>
          carrier.ecosystem === "cargo"
          && carrier.role === "aot-leaf"
          && carrier.name.startsWith(`${product}-aot-`))
        .map((carrier) => carrier.target)
        .sort();
      expect(actualTargets, `${product} AOT members: ${aotMembers.join(", ") || "none"}`).toEqual(
        aotMembers.length === 0 ? [] : expectedTargets,
      );
    }
  });

  test("classifies every compact AOT suffix as a splittable canonical target leaf", () => {
    const product = "oliphaunt-extension-pg-textsearch";
    const catalog = loadPublicationCatalog("publication-catalog.test", { products: [product] });
    for (const target of Object.keys(EXTENSION_AOT_PACKAGE_SUFFIXES).sort()) {
      const name = wasixExtensionAotPackageName(product, target);
      const carrier = catalog.carriers.find((candidate) => candidate.name === name);
      expect(carrier).toMatchObject({ ecosystem: "cargo", role: "aot-leaf", target });
      const part = resolveActualCarrier(catalog, "cargo", `${name}-part-001`, "publication-catalog.test");
      expect(part).toMatchObject({ role: "payload-part", parentCarrier: `cargo:${name}`, part: 1, target });
      expect(part.name.length).toBeLessThanOrEqual(64);
    }
  });
});
