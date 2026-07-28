import { describe, expect, test } from "bun:test";

import {
  bootstrapCheckpointBatches,
  bootstrapPublicationPlan,
} from "./bootstrap-publication-plan.mjs";
import {
  loadPublicationCatalog,
  resolveActualCarrier,
} from "./publication-catalog.mjs";

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
    expect(plan.find(({ id }) => id === "cargo:runtime").dependencies).toEqual(["cargo:extension"]);
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
    expect(plan[0].dependencies).toEqual([]);
  });

  test("the complete real catalog closes over every Cargo/npm bootstrap carrier", () => {
    const catalog = loadPublicationCatalog("bootstrap-publication-plan.test");
    const splitParent = catalog.carriers.find(({ ecosystem, role }) =>
      ecosystem === "cargo" && role === "platform-leaf"
    );
    const splitPart = resolveActualCarrier(
      catalog,
      "cargo",
      `${splitParent.name}-part-001`,
      "bootstrap-publication-plan.test",
    );
    const frozenCarriers = catalog.carriers.flatMap((carrier) =>
      carrier.id === splitParent.id
        ? [splitPart, { ...carrier, dependencies: [splitPart.id] }]
        : [{ ...carrier, dependencies: [] }]
    );
    const frozen = {
      products: catalog.products,
      carriers: frozenCarriers.map((carrier, publishOrder) => ({
        ...carrier,
        publishOrder,
        dependencies: carrier.dependencies ?? [],
      })),
    };
    const plan = bootstrapPublicationPlan(
      frozen,
      catalog.products.map(({ id }) => id),
    );
    const expected = frozen.carriers.filter(({ ecosystem }) => ecosystem === "cargo" || ecosystem === "npm");
    expect(plan.filter(({ ecosystem }) => ecosystem === "cargo")).toHaveLength(
      expected.filter(({ ecosystem }) => ecosystem === "cargo").length,
    );
    expect(plan.filter(({ ecosystem }) => ecosystem === "npm")).toHaveLength(
      expected.filter(({ ecosystem }) => ecosystem === "npm").length,
    );
    expect(plan.map(({ id }) => id)).toContain(splitPart.id);
    expect(plan.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
  });
});
