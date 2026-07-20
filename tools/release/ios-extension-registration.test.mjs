#!/usr/bin/env bun

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertDefinedRegistrationAddresses,
  readRegistrationSymbols,
} from "./ios-extension-registration.mjs";

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

test("iOS extension registration uses locale-independent ordinal ordering for mixed-case symbols", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "oliphaunt-ios-registration-"));
  try {
    const extension = path.join(out, "extensions", "bloom");
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      path.join(extension, "symbols.list"),
      "blbeginscan\nBloomFillMetapage\nblinsert\n",
    );

    assert.deepEqual(readRegistrationSymbols(out, "bloom"), [
      { name: "BloomFillMetapage", address: "BloomFillMetapage" },
      { name: "blbeginscan", address: "blbeginscan" },
      { name: "blinsert", address: "blinsert" },
    ]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("iOS extension registration rejects an exported-symbol address absent from the built slice", () => {
  assert.throws(
    () => assertDefinedRegistrationAddresses(
      [{ name: "ellipsoid_in", address: "ellipsoid_in" }],
      new Set(["oliphaunt_static_postgis_3_Pg_magic_func"]),
      "ios-simulator postgis",
    ),
    /ios-simulator postgis registration address\(es\).*ellipsoid_in/u,
  );
});

test("iOS extension registration rejects an alias whose linked address is absent from the built slice", () => {
  assert.throws(
    () => assertDefinedRegistrationAddresses(
      [
        {
          name: "difference",
          address: "oliphaunt_static_postgis_3_difference",
        },
      ],
      new Set(["difference"]),
      "ios-device postgis",
    ),
    /ios-device postgis registration address\(es\).*oliphaunt_static_postgis_3_difference/u,
  );
});
