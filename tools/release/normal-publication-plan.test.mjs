import { describe, expect, test } from "bun:test";

import { normalPublicationPlan } from "./normal-publication-plan.mjs";
import { loadPublicationCatalog } from "./publication-catalog.mjs";
import { extensionSqlNames } from "./release-artifact-targets.mjs";
import { buildPlan, loadGraph } from "./release-graph.mjs";
import { withDependentReleaseClosure } from "./release-dependent-candidates.mjs";

function carrier({
  id,
  product,
  publishOrder,
  dependencies = [],
}) {
  const separator = id.indexOf(":");
  return {
    id,
    product,
    ecosystem: id.slice(0, separator),
    name: id.slice(separator + 1),
    version: "1.0.0",
    publishOrder,
    dependencies,
  };
}

function lock(carriers) {
  return {
    products: [...new Set(carriers.map(({ product }) => product))].map((id) => ({ id })),
    carriers,
  };
}

function realSelection(changedFile) {
  const graph = loadGraph("normal-publication-plan.test");
  const release = withDependentReleaseClosure(
    graph,
    buildPlan(graph, [changedFile], "normal-publication-plan.test"),
    { prefix: "normal-publication-plan.test" },
  );
  const publicationProducts = release.requiredReleaseProducts;
  const catalog = loadPublicationCatalog("normal-publication-plan.test", { products: publicationProducts });
  const frozen = {
    products: catalog.products,
    carriers: catalog.carriers.map((value, publishOrder) => ({
      ...value,
      publishOrder,
      dependencies: [],
    })),
  };
  return {
    release,
    catalog,
    topology: normalPublicationPlan(frozen, publicationProducts),
  };
}

describe("normal publication plan", () => {
  test("executes exact frozen carriers in lock-derived dependency order", () => {
    const value = lock([
      carrier({ id: "cargo:runtime", product: "runtime", publishOrder: 0 }),
      carrier({ id: "npm:@example/runtime", product: "runtime", publishOrder: 1 }),
      carrier({ id: "cargo:sdk", product: "sdk", publishOrder: 2, dependencies: ["cargo:runtime"] }),
      carrier({ id: "npm:@example/sdk", product: "sdk", publishOrder: 3, dependencies: ["npm:@example/runtime"] }),
      carrier({ id: "jsr:@example/sdk", product: "sdk", publishOrder: 4, dependencies: ["npm:@example/sdk"] }),
    ]);
    const plan = normalPublicationPlan(value, ["runtime", "sdk"]);
    expect(plan.carrierCount).toBe(5);
    expect(plan.operations.map(({ carrierId }) => carrierId)).toEqual([
      "cargo:runtime",
      "npm:@example/runtime",
      "cargo:sdk",
      "npm:@example/sdk",
      "jsr:@example/sdk",
    ]);
    expect(plan.operations.map(({ operationOrder }) => operationOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  test("recomputes readiness after every operation to preserve global lock priority", () => {
    const value = lock([
      carrier({ id: "cargo:root", product: "root", publishOrder: 0 }),
      carrier({ id: "cargo:unlocked", product: "unlocked", publishOrder: 1, dependencies: ["cargo:root"] }),
      carrier({ id: "npm:already-ready", product: "ready", publishOrder: 2 }),
    ]);
    const plan = normalPublicationPlan(value, ["root", "unlocked", "ready"]);
    expect(plan.operations.map(({ carrierId }) => carrierId)).toEqual([
      "cargo:root",
      "cargo:unlocked",
      "npm:already-ready",
    ]);
  });

  test("collapses Maven coordinates into one atomic lock-derived deployment", () => {
    const value = lock([
      carrier({ id: "maven:dev.example:runtime", product: "runtime", publishOrder: 0 }),
      carrier({ id: "npm:@example/runtime", product: "runtime", publishOrder: 1 }),
      carrier({
        id: "maven:dev.example:sdk",
        product: "sdk",
        publishOrder: 2,
        dependencies: ["maven:dev.example:runtime"],
      }),
      carrier({ id: "jsr:@example/sdk", product: "sdk", publishOrder: 3, dependencies: ["npm:@example/runtime"] }),
    ]);
    const plan = normalPublicationPlan(value, ["runtime", "sdk"]);
    expect(plan.operations).toHaveLength(3);
    expect(plan.operations[0]).toMatchObject({
      id: "maven:atomic-deployment",
      kind: "maven-atomic-deployment",
      carrierIds: ["maven:dev.example:runtime", "maven:dev.example:sdk"],
      products: ["runtime", "sdk"],
      firstPublishOrder: 0,
      lastPublishOrder: 2,
    });
    expect(plan.operations.map(({ id }) => id)).toEqual([
      "maven:atomic-deployment",
      "carrier:npm:@example/runtime",
      "carrier:jsr:@example/sdk",
    ]);
  });

  test("preserves dependencies into and out of the Maven atomic unit", () => {
    const value = lock([
      carrier({ id: "npm:@example/input", product: "input", publishOrder: 0 }),
      carrier({ id: "maven:dev.example:sdk", product: "sdk", publishOrder: 1, dependencies: ["npm:@example/input"] }),
      carrier({ id: "jsr:@example/output", product: "output", publishOrder: 2, dependencies: ["maven:dev.example:sdk"] }),
    ]);
    const plan = normalPublicationPlan(value, ["input", "sdk", "output"]);
    expect(plan.operations.map(({ id }) => id)).toEqual([
      "carrier:npm:@example/input",
      "maven:atomic-deployment",
      "carrier:jsr:@example/output",
    ]);
  });

  test("fails closed when a selected carrier omits a locked dependency", () => {
    const value = lock([
      carrier({ id: "cargo:runtime", product: "runtime", publishOrder: 0 }),
      carrier({ id: "cargo:sdk", product: "sdk", publishOrder: 1, dependencies: ["cargo:runtime"] }),
    ]);
    expect(() => normalPublicationPlan(value, ["sdk"]))
      .toThrow(/selection omits locked dependencies: cargo:runtime/u);
  });

  test("fails closed on cycles instead of inventing an execution order", () => {
    const value = lock([
      carrier({ id: "npm:a", product: "a", publishOrder: 0, dependencies: ["npm:b"] }),
      carrier({ id: "npm:b", product: "b", publishOrder: 1, dependencies: ["npm:a"] }),
    ]);
    expect(() => normalPublicationPlan(value, ["a", "b"]))
      .toThrow(/dependency cycle/u);
  });

  test("real release selections are closed without pulling unrelated products", () => {
    const external = realSelection("src/extensions/external/vector/CHANGELOG.md");
    expect(external.release.directProducts).toEqual(["oliphaunt-extension-vector"]);
    expect(external.release.releaseProducts).toEqual(["oliphaunt-extension-vector"]);
    expect(external.catalog.products.map(({ id }) => id)).toEqual(external.release.requiredReleaseProducts);
    expect(external.topology.carrierCount).toBe(external.catalog.carriers.length);

    const runtime = realSelection("src/runtimes/liboliphaunt/native/CHANGELOG.md");
    expect(runtime.release.directProducts).toEqual(["liboliphaunt-native"]);
    expect(runtime.release.releaseProducts).toContain("liboliphaunt-native");
    expect(runtime.release.releaseProducts).toContain("liboliphaunt-wasix");
    expect(runtime.release.releaseProducts).toContain("oliphaunt-extension-contrib-pg18");
    expect(extensionSqlNames("oliphaunt-extension-contrib-pg18", "normal-publication-plan.test"))
      .toContain("amcheck");
    expect(runtime.release.releaseProducts).not.toContain("oliphaunt-extension-vector");
    expect(runtime.release.requiredReleaseProducts).toContain("oliphaunt-extension-vector");
    expect(runtime.release.dependentReleaseProducts).toContain("oliphaunt-extension-vector");
    expect(runtime.catalog.products.map(({ id }) => id)).toEqual(runtime.release.requiredReleaseProducts);
    expect(runtime.topology.carrierCount).toBe(runtime.catalog.carriers.length);

    const sdk = realSelection("src/sdks/react-native/CHANGELOG.md");
    expect(sdk.release.directProducts).toEqual(["oliphaunt-react-native"]);
    expect(sdk.release.releaseProducts).toEqual(["oliphaunt-react-native"]);
    expect(sdk.catalog.products.map(({ id }) => id)).toEqual(sdk.release.requiredReleaseProducts);
    expect(sdk.topology.carrierCount).toBe(sdk.catalog.carriers.length);
  });
});
