#!/usr/bin/env bun
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { loadPublicationCatalog, resolveActualCarrier } from "./publication-catalog.mjs";
import {
  exactExtensionProducts,
  extensionWasixAotMemberSqlNames,
} from "./release-artifact-targets.mjs";
import {
  EXTENSION_AOT_PACKAGE_SUFFIXES,
  EXTENSION_PORTABLE_TARGET,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from "./wasix-cargo-artifact-contract.mjs";

describe("WASIX extension portable publication carriers", () => {
  test("assigns every independently versioned portable carrier an explicit canonical target", () => {
    const products = exactExtensionProducts("publication-catalog.test");
    const catalog = loadPublicationCatalog("publication-catalog.test", { products });
    for (const product of products) {
      const name = wasixExtensionPackageName(product);
      const carrier = catalog.carriers.find((candidate) => candidate.name === name);
      expect(carrier).toMatchObject({
        ecosystem: "cargo",
        product,
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
    const catalog = loadPublicationCatalog("publication-catalog.test", { products });
    const expectedTargets = Object.keys(EXTENSION_AOT_PACKAGE_SUFFIXES).sort();
    for (const product of products) {
      const aotMembers = extensionWasixAotMemberSqlNames(product, "publication-catalog.test");
      const actualTargets = catalog.carriers
        .filter((carrier) => carrier.product === product && carrier.ecosystem === "cargo" && carrier.role === "aot-leaf")
        .map((carrier) => carrier.target)
        .sort();
      expect(actualTargets, `${product} AOT members: ${aotMembers.join(", ") || "none"}`).toEqual(
        aotMembers.length === 0 ? [] : expectedTargets,
      );
    }
  });

  test("keeps the bulk package-name query aligned with the publication catalog", () => {
    const result = spawnSync(
      process.execPath,
      ["tools/release/release_graph_query.mjs", "wasix-extension-package-names"],
      { cwd: import.meta.dir.replace(/\/tools\/release$/u, ""), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const rows = JSON.parse(result.stdout);
    const products = exactExtensionProducts("publication-catalog.test");
    const catalog = loadPublicationCatalog("publication-catalog.test", { products });
    for (const row of rows) {
      const expectedNames = catalog.carriers
        .filter((carrier) => carrier.product === row.product && carrier.ecosystem === "cargo" && carrier.role === "aot-leaf")
        .map((carrier) => carrier.name)
        .sort();
      expect(row.aotPackages.map(({ packageName }) => packageName).sort(), row.product).toEqual(expectedNames);
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
