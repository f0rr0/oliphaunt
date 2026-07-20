#!/usr/bin/env bun

import assert from "node:assert/strict";
import test from "node:test";

import {
  NPM_TRUSTED_PUBLISHING_REPOSITORY,
  validateNpmTrustCliRuntime,
  validateNpmTrustedPublishingManifest,
  validateNpmTrustedPublishingRuntime,
} from "./npm-trusted-publishing.mjs";

function manifest(overrides = {}) {
  return {
    name: "@oliphaunt/example",
    version: "1.2.3",
    repository: {
      type: "git",
      url: NPM_TRUSTED_PUBLISHING_REPOSITORY,
    },
    publishConfig: {
      access: "public",
      provenance: true,
    },
    ...overrides,
  };
}

test("accepts the minimum supported trusted-publishing runtime", () => {
  assert.deepEqual(
    validateNpmTrustedPublishingRuntime({ nodeVersion: "v22.14.0", npmVersion: "11.5.1" }),
    { nodeVersion: "v22.14.0", npmVersion: "11.5.1" },
  );
  assert.doesNotThrow(() =>
    validateNpmTrustedPublishingRuntime({ nodeVersion: "24.1.0", npmVersion: "11.18.0" })
  );
});

test("rejects old or malformed Node.js and npm versions", () => {
  assert.throws(
    () => validateNpmTrustedPublishingRuntime({ nodeVersion: "22.13.9", npmVersion: "11.5.1" }),
    /Node\.js 22\.13\.9 is too old/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingRuntime({ nodeVersion: "22.14.0", npmVersion: "11.5.0" }),
    /npm 11\.5\.0 is too old/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingRuntime({ nodeVersion: "22", npmVersion: "11.5.1" }),
    /complete semver/u,
  );
});

test("requires npm 11.15 only for trust-configuration management", () => {
  assert.equal(validateNpmTrustCliRuntime("11.15.0"), "11.15.0");
  assert.throws(() => validateNpmTrustCliRuntime("11.14.9"), /npm trust CLI 11\.14\.9 is too old/u);
  assert.doesNotThrow(() =>
    validateNpmTrustedPublishingRuntime({ nodeVersion: "22.14.0", npmVersion: "11.5.1" })
  );
});

test("requires the exact repository URL and permits only publish-safe metadata", () => {
  assert.doesNotThrow(() => validateNpmTrustedPublishingManifest(manifest()));
  assert.doesNotThrow(() =>
    validateNpmTrustedPublishingManifest(manifest({ publishConfig: undefined }))
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({ repository: undefined })),
    /repository must be an object/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({
      repository: { type: "git", url: "https://github.com/f0rr0/oliphaunt" },
    })),
    /repository\.url must exactly match/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({
      publishConfig: { access: "public", provenance: false },
    })),
    /must not disable npm provenance/u,
  );
  assert.throws(
    () => validateNpmTrustedPublishingManifest(manifest({ private: true })),
    /must not be private/u,
  );
});
