import { describe, expect, test } from "bun:test";

import {
  bootstrapCheckpointBatches,
  bootstrapPublicationPlan,
} from "./bootstrap-publication-plan.mjs";
import { loadPublicationCatalog } from "./publication-catalog.mjs";

function lock(carriers) {
  return {
    products: [{ id: "runtime" }, { id: "extension" }, { id: "sdk" }],
    carriers,
  };
}

describe("registry identity bootstrap publication plan", () => {
  test("uses frozen carrier order across product boundaries", () => {
    const plan = bootstrapPublicationPlan(lock([
      {
        id: "cargo:runtime",
        product: "runtime",
        ecosystem: "cargo",
        name: "runtime",
        version: "0.1.0",
        publishOrder: 2,
        dependencies: ["cargo:extension"],
      },
      {
        id: "npm:@example/sdk",
        product: "sdk",
        ecosystem: "npm",
        name: "@example/sdk",
        version: "0.1.0",
        publishOrder: 3,
        dependencies: [],
      },
      {
        id: "cargo:extension",
        product: "extension",
        ecosystem: "cargo",
        name: "extension",
        version: "0.1.0",
        publishOrder: 1,
        dependencies: [],
      },
      {
        id: "maven:dev.example:runtime",
        product: "runtime",
        ecosystem: "maven",
        name: "dev.example:runtime",
        version: "0.1.0",
        publishOrder: 0,
        dependencies: [],
      },
    ]), ["runtime", "extension", "sdk"]);

    expect(plan.map(({ id }) => id)).toEqual([
      "cargo:extension",
      "cargo:runtime",
      "npm:@example/sdk",
    ]);
    expect(bootstrapCheckpointBatches(plan, 2)).toEqual([
      ["cargo:extension", "cargo:runtime"],
      ["npm:@example/sdk"],
    ]);
  });

  test("rejects a frozen order that precedes an internal dependency", () => {
    expect(() => bootstrapPublicationPlan(lock([
      {
        id: "cargo:runtime",
        product: "runtime",
        ecosystem: "cargo",
        name: "runtime",
        version: "0.1.0",
        publishOrder: 0,
        dependencies: ["cargo:extension"],
      },
      {
        id: "cargo:extension",
        product: "extension",
        ecosystem: "cargo",
        name: "extension",
        version: "0.1.0",
        publishOrder: 1,
        dependencies: [],
      },
    ]), ["runtime", "extension"])).toThrow(/appears before bootstrap dependency/u);
  });

  test("rejects omitted and unknown locked Cargo/npm dependencies", () => {
    const omitted = lock([
      {
        id: "cargo:runtime",
        product: "runtime",
        ecosystem: "cargo",
        name: "runtime",
        version: "0.1.0",
        publishOrder: 0,
        dependencies: [],
      },
      {
        id: "cargo:sdk",
        product: "sdk",
        ecosystem: "cargo",
        name: "sdk",
        version: "0.1.0",
        publishOrder: 1,
        dependencies: ["cargo:runtime"],
      },
    ]);
    expect(() => bootstrapPublicationPlan(omitted, ["sdk"]))
      .toThrow(/selection omits locked bootstrap dependency cargo:runtime/u);

    const unknown = lock([
      {
        id: "npm:@example/sdk",
        product: "sdk",
        ecosystem: "npm",
        name: "@example/sdk",
        version: "0.1.0",
        publishOrder: 0,
        dependencies: ["npm:@example/missing"],
      },
    ]);
    expect(() => bootstrapPublicationPlan(unknown, ["sdk"]))
      .toThrow(/refers to unknown locked dependency npm:@example\/missing/u);
  });

  test("keeps resolved Maven/JSR dependencies external to identity bootstrap", () => {
    const plan = bootstrapPublicationPlan(lock([
      {
        id: "maven:dev.example:runtime",
        product: "runtime",
        ecosystem: "maven",
        name: "dev.example:runtime",
        version: "0.1.0",
        publishOrder: 0,
        dependencies: [],
      },
      {
        id: "cargo:sdk",
        product: "sdk",
        ecosystem: "cargo",
        name: "sdk",
        version: "0.1.0",
        publishOrder: 1,
        dependencies: ["maven:dev.example:runtime"],
      },
    ]), ["sdk"]);
    expect(plan.map(({ id }) => id)).toEqual(["cargo:sdk"]);
  });

  test("the complete real catalog closes over every Cargo/npm bootstrap carrier", () => {
    const catalog = loadPublicationCatalog("bootstrap-publication-plan.test");
    const frozen = {
      products: catalog.products,
      carriers: catalog.carriers.map((carrier, publishOrder) => ({
        ...carrier,
        publishOrder,
        dependencies: [],
      })),
    };
    const plan = bootstrapPublicationPlan(
      frozen,
      catalog.products.map(({ id }) => id),
    );
    const expected = catalog.carriers.filter(({ ecosystem }) => ecosystem === "cargo" || ecosystem === "npm");
    expect(expected.filter(({ ecosystem }) => ecosystem === "cargo")).toHaveLength(417);
    expect(expected.filter(({ ecosystem }) => ecosystem === "npm")).toHaveLength(214);
    expect(plan.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
  });
});
