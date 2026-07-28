#!/usr/bin/env bun
import assert from "node:assert/strict";
import test from "node:test";

import { classifyLedgerRequirement } from "../../.github/scripts/registry-bootstrap-ledger-state.mjs";

test("requires a ledger only for pre-tag current-version registry publications", () => {
  assert.deepEqual(classifyLedgerRequirement([
    { product: "new", ecosystem: "npm", published: 0, tagState: "missing" },
    { product: "retry", ecosystem: "cargo", published: 1, tagState: "exact" },
  ]), { needsLedger: false, requiring: [] });

  const bootstrap = classifyLedgerRequirement([
    { product: "bootstrap", ecosystem: "npm", published: 2, tagState: "missing" },
  ]);
  assert.equal(bootstrap.needsLedger, true);
  assert.deepEqual(bootstrap.requiring, [{ product: "bootstrap", ecosystem: "npm", published: 2 }]);

  assert.throws(
    () => classifyLedgerRequirement([{ product: "conflict", ecosystem: "npm", published: 1, tagState: "wrong" }]),
    /another commit/u,
  );
});
