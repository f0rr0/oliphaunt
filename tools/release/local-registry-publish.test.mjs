import { expect, test } from "bun:test";

import {
  createCargoCandidateScope,
  parseCargoCandidateProductsJson,
  selectScopedCargoCandidates,
} from "./local-registry-publish.mjs";

function candidate(carrier, checksum = carrier.name) {
  return {
    cratePath: `/tmp/${carrier.name}-${carrier.version}.crate`,
    checksum,
    packageData: {
      name: carrier.name,
      version: carrier.version,
    },
  };
}

function expectedCandidates(scope) {
  return [...scope.expectedCarriers.values()].map((carrier) => candidate(carrier));
}

test("parses an exact, unique release product selection", () => {
  expect(parseCargoCandidateProductsJson('["oliphaunt-rust"]')).toEqual(["oliphaunt-rust"]);
  expect(() => parseCargoCandidateProductsJson("not-json")).toThrow("must be valid JSON");
  expect(() => parseCargoCandidateProductsJson("[]")).toThrow("non-empty JSON string list");
  expect(() => parseCargoCandidateProductsJson('["oliphaunt-rust","oliphaunt-rust"]')).toThrow(
    "must not contain duplicate products",
  );
});

test("keeps exactly selected Cargo carriers and excludes known unselected products", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  expect([...scope.expectedCarriers.keys()].sort()).toEqual(["oliphaunt", "oliphaunt-build"]);
  const unselected = scope.fullCatalog.carriers.find(
    (carrier) => carrier.ecosystem === "cargo" && carrier.product === "oliphaunt-wasix-rust",
  );
  expect(unselected).toBeDefined();
  const result = selectScopedCargoCandidates(scope, [
    ...expectedCandidates(scope),
    candidate(unselected),
  ]);
  expect(result.selected.map((entry) => entry.packageData.name)).toEqual(["oliphaunt", "oliphaunt-build"]);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]).toContain("excluded unselected Cargo carrier");
});

test("requires every declared selected Cargo carrier", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  expect(() => selectScopedCargoCandidates(scope, expectedCandidates(scope).slice(0, 1))).toThrow(
    "missing selected Cargo carriers",
  );
});

test("rejects version drift and conflicting bytes for a selected carrier", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  const candidates = expectedCandidates(scope);
  const drifted = structuredClone(candidates[0]);
  drifted.packageData.version = "999.0.0";
  expect(() => selectScopedCargoCandidates(scope, [drifted, ...candidates.slice(1)])).toThrow(
    "has artifact version 999.0.0",
  );

  const conflicting = { ...candidates[0], cratePath: "/tmp/conflicting.crate", checksum: "different" };
  expect(() => selectScopedCargoCandidates(scope, [...candidates, conflicting])).toThrow(
    "has conflicting candidate bytes",
  );
});

test("deduplicates byte-identical archives and permits selected dynamic part crates", () => {
  const rustScope = createCargoCandidateScope(["oliphaunt-rust"]);
  const rustCandidates = expectedCandidates(rustScope);
  const duplicate = { ...rustCandidates[0], cratePath: "/tmp/duplicate.crate" };
  const deduplicated = selectScopedCargoCandidates(rustScope, [...rustCandidates, duplicate]);
  expect(deduplicated.selected).toHaveLength(rustScope.expectedCarriers.size);
  expect(deduplicated.skipped.some((message) => message.includes("deduplicated byte-identical"))).toBe(true);

  const runtimeScope = createCargoCandidateScope(["liboliphaunt-native"]);
  const parent = runtimeScope.expectedCarriers.get("liboliphaunt-native-linux-x64-gnu");
  expect(parent).toBeDefined();
  const part = candidate({ ...parent, name: `${parent.name}-part-000` }, "part-bytes");
  const selected = selectScopedCargoCandidates(runtimeScope, [
    ...expectedCandidates(runtimeScope),
    part,
  ]);
  expect(selected.selected.some((entry) => entry.packageData.name === part.packageData.name)).toBe(true);
});

test("rejects undeclared Cargo archive identities in exact candidate roots", () => {
  const scope = createCargoCandidateScope(["oliphaunt-rust"]);
  expect(() => selectScopedCargoCandidates(scope, [
    ...expectedCandidates(scope),
    {
      cratePath: "/tmp/undeclared-0.1.0.crate",
      checksum: "undeclared",
      packageData: { name: "undeclared", version: "0.1.0" },
    },
  ])).toThrow("artifact identity cargo:undeclared is not declared");
});
