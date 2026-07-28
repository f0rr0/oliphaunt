#!/usr/bin/env node

import { lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureCommandOutput } from "../dev/capture-command-output.mjs";

export const NPM_TRUSTED_PUBLISHING_REPOSITORY = "git+https://github.com/f0rr0/oliphaunt.git";
export const MINIMUM_TRUSTED_PUBLISHING_NODE_VERSION = "22.14.0";
export const MINIMUM_TRUSTED_PUBLISHING_NPM_VERSION = "11.5.1";
export const MINIMUM_NPM_TRUST_CLI_VERSION = "11.15.0";

const NPM_TRUST_HELP_TIMEOUT_MS = 30_000;
const NPM_TRUST_HELP_MAX_BYTES = 256 * 1024;
const NPM_TRUST_CONTRACT_PACKAGE = "@oliphaunt/oliphaunt-cli-contract-probe";
const NPM_TRUST_CONTRACT_REGISTRY = "http://127.0.0.1:9/";
const REQUIRED_NPM_TRUST_HELP_OPTIONS = Object.freeze({
  list: Object.freeze(["--json", "--registry"]),
  github: Object.freeze([
    "--file",
    "--repository",
    "--environment",
    "--allow-publish",
    "--json",
    "--registry",
    "--yes",
  ]),
});

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

export function validateNpmTrustCliHelp({ listHelp, githubHelp }) {
  for (const [command, help] of Object.entries({ list: listHelp, github: githubHelp })) {
    if (typeof help !== "string" || help.length === 0) {
      throw new Error(`npm trust ${command} --help returned no text`);
    }
    for (const option of REQUIRED_NPM_TRUST_HELP_OPTIONS[command]) {
      if (!help.includes(option)) {
        throw new Error(`npm trust ${command} does not advertise required option ${option}`);
      }
    }
  }
  if (githubHelp.includes("--allow-stage-publish") && !githubHelp.includes("--allow-publish")) {
    throw new Error("npm trust github advertises staged publication without ordinary publication");
  }
  return { listHelp, githubHelp };
}

function capturedNpmCli(nodeExecutable, npmCli, args, captureImpl, context, env = process.env) {
  const result = captureImpl(nodeExecutable, [npmCli, ...args], {
    env,
    label: context,
    maxOutputBytes: NPM_TRUST_HELP_MAX_BYTES,
    timeout: NPM_TRUST_HELP_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = String(result.stderr ?? result.error?.message ?? "")
      .replace(/[\r\n\t]+/gu, " ")
      .trim()
      .slice(0, 300);
    throw new Error(
      `${context} failed${Number.isInteger(result.status) ? ` with exit ${result.status}` : ""}`
        + `${detail ? `: ${detail}` : ""}`,
    );
  }
  return String(result.stdout ?? "");
}

export function checkNpmTrustCliContract({
  nodeExecutable,
  npmCli,
  captureImpl = captureCommandOutput,
}) {
  if (typeof nodeExecutable !== "string" || nodeExecutable.length === 0) {
    throw new TypeError("Node.js executable must be a non-empty path");
  }
  if (typeof npmCli !== "string" || npmCli.length === 0) {
    throw new TypeError("npm CLI must be a non-empty path");
  }
  const npmVersion = capturedNpmCli(
    nodeExecutable,
    npmCli,
    ["--version"],
    captureImpl,
    "npm --version",
  ).trim();
  validateNpmTrustCliRuntime(npmVersion);
  const help = validateNpmTrustCliHelp({
    listHelp: capturedNpmCli(
      nodeExecutable,
      npmCli,
      ["trust", "list", "--help"],
      captureImpl,
      "npm trust list --help",
    ),
    githubHelp: capturedNpmCli(
      nodeExecutable,
      npmCli,
      ["trust", "github", "--help"],
      captureImpl,
      "npm trust github --help",
    ),
  });
  const probeText = capturedNpmCli(
    nodeExecutable,
    npmCli,
    [
      "trust", "github", NPM_TRUST_CONTRACT_PACKAGE,
      "--file", "release.yml",
      "--repo", "f0rr0/oliphaunt",
      "--env", "release-publish",
      "--allow-publish",
      "--yes",
      "--json",
      "--registry", NPM_TRUST_CONTRACT_REGISTRY,
      "--dry-run",
    ],
    captureImpl,
    "npm trust github dry-run contract probe",
    {
      ...process.env,
      NPM_CONFIG_FETCH_RETRIES: "0",
      NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: "1000",
      NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "5000",
      NPM_CONFIG_FETCH_TIMEOUT: "20000",
    },
  );
  let probe;
  try {
    probe = JSON.parse(probeText);
  } catch {
    throw new Error("npm trust github dry-run contract probe returned invalid JSON");
  }
  const expectedProbe = {
    package: NPM_TRUST_CONTRACT_PACKAGE,
    file: "release.yml",
    repository: "f0rr0/oliphaunt",
    environment: "release-publish",
    permissions: ["createPackage"],
  };
  if (JSON.stringify(probe) !== JSON.stringify(expectedProbe)) {
    throw new Error(
      `npm trust github dry-run contract probe returned an unexpected plan: ${JSON.stringify(probe)}`,
    );
  }
  return { npmVersion, ...help, probe };
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

function parseTrustCliArgs(argv) {
  const allowed = new Set(["--node-executable", "--npm-cli"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!allowed.has(arg)) throw new Error(`unknown argument ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    if (values.has(arg)) throw new Error(`${arg} may be specified only once`);
    values.set(arg, value);
    index += 1;
  }
  for (const arg of allowed) {
    const value = values.get(arg);
    if (value === undefined) {
      throw new Error("check-trust-cli requires --node-executable PATH --npm-cli PATH");
    }
    if (!path.isAbsolute(value)) throw new Error(`${arg} must be an absolute path`);
    let stat;
    try {
      stat = lstatSync(value);
    } catch {
      throw new Error(`${arg} does not identify a readable file`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${arg} must identify a regular, non-symlink file`);
    }
  }
  return {
    nodeExecutable: values.get("--node-executable"),
    npmCli: values.get("--npm-cli"),
  };
}

function main(argv) {
  try {
    const [command, ...rest] = argv;
    if (command === "check-runtime") {
      const versions = validateNpmTrustedPublishingRuntime(parseRuntimeArgs(rest));
      console.log(`npm trusted-publishing runtime passed: Node.js ${versions.nodeVersion}, npm ${versions.npmVersion}`);
      return;
    }
    if (command === "check-trust-cli") {
      const result = checkNpmTrustCliContract(parseTrustCliArgs(rest));
      console.log(`npm trust CLI contract passed: npm ${result.npmVersion}`);
      return;
    }
    throw new Error(
      "usage: npm-trusted-publishing.mjs "
        + "check-runtime --node VERSION --npm VERSION | "
        + "check-trust-cli --node-executable PATH --npm-cli PATH",
    );
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
