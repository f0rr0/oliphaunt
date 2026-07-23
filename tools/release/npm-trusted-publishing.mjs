#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const NPM_TRUSTED_PUBLISHING_REPOSITORY = "git+https://github.com/f0rr0/oliphaunt.git";
export const MINIMUM_TRUSTED_PUBLISHING_NODE_VERSION = "22.14.0";
export const MINIMUM_TRUSTED_PUBLISHING_NPM_VERSION = "11.5.1";
export const MINIMUM_NPM_TRUST_CLI_VERSION = "11.15.0";

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedVersion(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} version must be a string`);
  }
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (match === null) {
    throw new TypeError(`${label} version must be complete semver; got ${JSON.stringify(value)}`);
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function requireMinimumVersion(actual, minimum, label) {
  if (compareVersions(parsedVersion(actual, label), parsedVersion(minimum, `${label} minimum`)) < 0) {
    throw new Error(`${label} ${actual} is too old for npm trusted publishing; need >= ${minimum}`);
  }
}

export function validateNpmTrustedPublishingRuntime({ nodeVersion, npmVersion }) {
  requireMinimumVersion(nodeVersion, MINIMUM_TRUSTED_PUBLISHING_NODE_VERSION, "Node.js");
  requireMinimumVersion(npmVersion, MINIMUM_TRUSTED_PUBLISHING_NPM_VERSION, "npm");
  return { nodeVersion, npmVersion };
}

export function validateNpmTrustCliRuntime(npmVersion) {
  requireMinimumVersion(npmVersion, MINIMUM_NPM_TRUST_CLI_VERSION, "npm trust CLI");
  return npmVersion;
}

export function validateNpmTrustedPublishingManifest(manifest, context = "npm package") {
  if (!object(manifest)) {
    throw new TypeError(`${context} package.json must be an object`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@oliphaunt/")) {
    throw new Error(`${context} must declare an @oliphaunt package name`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${context} must declare a package version`);
  }
  if (!object(manifest.repository)) {
    throw new Error(`${context} repository must be an object for npm trusted publishing`);
  }
  if (manifest.repository.type !== "git") {
    throw new Error(`${context} repository.type must be "git" for npm trusted publishing`);
  }
  if (manifest.repository.url !== NPM_TRUSTED_PUBLISHING_REPOSITORY) {
    throw new Error(
      `${context} repository.url must exactly match ${NPM_TRUSTED_PUBLISHING_REPOSITORY}; got ${JSON.stringify(manifest.repository.url ?? null)}`,
    );
  }
  if (manifest.private === true) {
    throw new Error(`${context} must not be private`);
  }
  if (manifest.publishConfig !== undefined && !object(manifest.publishConfig)) {
    throw new Error(`${context} publishConfig must be an object when present`);
  }
  if (manifest.publishConfig?.provenance === false) {
    throw new Error(`${context} must not disable npm provenance`);
  }
  if (manifest.publishConfig?.access !== undefined && manifest.publishConfig.access !== "public") {
    throw new Error(`${context} publishConfig.access must be "public" when present`);
  }
  return manifest;
}

function parseRuntimeArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--node" && arg !== "--npm") {
      throw new Error(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a version`);
    }
    if (values.has(arg)) {
      throw new Error(`${arg} may be specified only once`);
    }
    values.set(arg, value);
    index += 1;
  }
  if (!values.has("--node") || !values.has("--npm")) {
    throw new Error("check-runtime requires --node VERSION --npm VERSION");
  }
  return { nodeVersion: values.get("--node"), npmVersion: values.get("--npm") };
}

function main(argv) {
  try {
    const [command, ...rest] = argv;
    if (command !== "check-runtime") {
      throw new Error("usage: npm-trusted-publishing.mjs check-runtime --node VERSION --npm VERSION");
    }
    const versions = validateNpmTrustedPublishingRuntime(parseRuntimeArgs(rest));
    console.log(`npm trusted-publishing runtime passed: Node.js ${versions.nodeVersion}, npm ${versions.npmVersion}`);
  } catch (error) {
    console.error(`npm-trusted-publishing: ${error.message}`);
    process.exit(1);
  }
}

if (
  import.meta.main === true
    || (process.argv[1] !== undefined
      && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
) {
  main(process.argv.slice(2));
}
