#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalEmptyStaticRegistryManifestError,
  canonicalTarEntryMarkerError,
} from "./check-liboliphaunt-release-assets.mjs";

test("release archive validation requires canonical producer markers", () => {
  assert.equal(canonicalTarEntryMarkerError(".", "5"), null);
  assert.equal(canonicalTarEntryMarkerError("./", "5"), null);
  assert.equal(canonicalTarEntryMarkerError("runtime/", "5"), null);
  assert.equal(canonicalTarEntryMarkerError("runtime/manifest.properties", "0"), null);
  assert.match(canonicalTarEntryMarkerError("runtime", "5"), /directory member must use a trailing slash/u);
  assert.match(canonicalTarEntryMarkerError("runtime\/manifest.properties/", "0"), /regular-file member must not use a trailing slash/u);
});

test("base runtime validation requires the exact current empty static-registry manifest", () => {
  const canonical = [
    "packageLayout=oliphaunt-static-registry-v1",
    "abiVersion=1",
    "state=not-required",
    "source=",
    "registeredExtensions=",
    "pendingExtensions=",
    "nativeModuleStems=",
    "modules=",
    "archiveTargets=",
    "dependencyArchiveTargets=",
    "dependencyArchives=",
    "",
  ].join("\n");
  assert.equal(canonicalEmptyStaticRegistryManifestError(canonical), null);
  assert.match(
    canonicalEmptyStaticRegistryManifestError(
      "schema=oliphaunt-static-registry-v1\nregistered=\npending=\n",
    ),
    /canonical empty oliphaunt-static-registry-v1 manifest/u,
  );
});
