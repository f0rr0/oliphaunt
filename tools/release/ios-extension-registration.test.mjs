#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readRegistrationSymbols } from "./ios-extension-registration.mjs";

test("iOS extension registration accepts an absent optional symbol alias list", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-ios-registration-"));
  try {
    const extension = path.join(out, "extensions", "amcheck");
    mkdirSync(extension, { recursive: true });
    writeFileSync(path.join(extension, "symbols.list"), "verify_nbtree\n");

    assert.deepEqual(readRegistrationSymbols(out, "amcheck"), [
      { name: "verify_nbtree", address: "verify_nbtree" },
    ]);
    assert.throws(
      () => readRegistrationSymbols(out, "missing"),
      /symbols\.list/u,
      "the required exported-symbol list must remain mandatory",
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("iOS extension registration merges and sorts explicit symbol aliases", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-ios-registration-"));
  try {
    const extension = path.join(out, "extensions", "postgis-3");
    mkdirSync(extension, { recursive: true });
    writeFileSync(path.join(extension, "symbols.list"), "zeta\n");
    writeFileSync(
      path.join(extension, "symbol-aliases.list"),
      "difference\toliphaunt_static_postgis_3_difference\n",
    );

    assert.deepEqual(readRegistrationSymbols(out, "postgis-3"), [
      { name: "difference", address: "oliphaunt_static_postgis_3_difference" },
      { name: "zeta", address: "zeta" },
    ]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
