import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bootstrapCarrierEnvironment } from "../../.github/scripts/bootstrap-registry-credential-env.mjs";

const parent = Object.freeze({
  CARGO_REGISTRIES_CRATES_IO_TOKEN: "cargo-alias",
  CARGO_REGISTRY_TOKEN: "cargo-primary",
  CRATES_IO_BOOTSTRAP_TOKEN: "cargo-bootstrap",
  CRATES_IO_TRUST_CONFIG_TOKEN: "cargo-trust",
  NODE_AUTH_TOKEN: "npm-node",
  NPM_BOOTSTRAP_TOKEN: "npm-bootstrap",
  NPM_CONFIG__AUTH: "npm-auth",
  NPM_CONFIG__AUTHTOKEN: "npm-auth-token",
  NPM_CONFIG_USERCONFIG: "/private/bootstrap.npmrc",
  NPM_TOKEN: "npm-token",
  RELEASE_HEAD_SHA: "a".repeat(40),
});

test("Cargo bootstrap children cannot read npm bootstrap credentials", () => {
  const environment = bootstrapCarrierEnvironment("cargo", parent);
  assert.equal(environment.CARGO_REGISTRY_TOKEN, "cargo-primary");
  assert.equal(environment.RELEASE_HEAD_SHA, parent.RELEASE_HEAD_SHA);
  for (const name of [
    "NODE_AUTH_TOKEN",
    "NPM_BOOTSTRAP_TOKEN",
    "NPM_CONFIG__AUTH",
    "NPM_CONFIG__AUTHTOKEN",
    "NPM_CONFIG_USERCONFIG",
    "NPM_TOKEN",
  ]) assert.equal(Object.hasOwn(environment, name), false, name);
});

test("npm bootstrap children cannot read Cargo bootstrap credentials", () => {
  const environment = bootstrapCarrierEnvironment("npm", parent);
  assert.equal(environment.NPM_CONFIG_USERCONFIG, "/private/bootstrap.npmrc");
  assert.equal(environment.RELEASE_HEAD_SHA, parent.RELEASE_HEAD_SHA);
  for (const name of [
    "CARGO_REGISTRIES_CRATES_IO_TOKEN",
    "CARGO_REGISTRY_TOKEN",
    "CRATES_IO_BOOTSTRAP_TOKEN",
    "CRATES_IO_TRUST_CONFIG_TOKEN",
  ]) assert.equal(Object.hasOwn(environment, name), false, name);
});

test("bootstrap credential routing rejects any unplanned registry lane", () => {
  assert.throws(
    () => bootstrapCarrierEnvironment("maven", parent),
    /unsupported bootstrap credential ecosystem/u,
  );
});

test("the concurrent bootstrap orchestrator applies lane-scoped environments to every child", () => {
  const source = readFileSync(
    new URL("../../.github/scripts/bootstrap-registry-identities.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /env:\s*bootstrapCarrierEnvironment\(carrier\.ecosystem, process\.env\)/u,
  );
  assert.doesNotMatch(source, /\{\s*stdio:\s*["']inherit["'],\s*env:\s*process\.env\s*\}/u);
});
