#!/usr/bin/env node

// Operational npm trusted-publisher validation; this module does not produce
// package or carrier bytes.

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MINIMUM_TRUSTED_PUBLISHING_NODE_VERSION = '22.14.0';
export const MINIMUM_TRUSTED_PUBLISHING_NPM_VERSION = '11.5.1';
export const MINIMUM_NPM_TRUST_CLI_VERSION = '11.15.0';

function parsedVersion(value, label) {
  if (typeof value !== 'string') {
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
  if (
    compareVersions(parsedVersion(actual, label), parsedVersion(minimum, `${label} minimum`)) < 0
  ) {
    throw new Error(`${label} ${actual} is too old for npm trusted publishing; need >= ${minimum}`);
  }
}

export function validateNpmTrustedPublishingRuntime({ nodeVersion, npmVersion }) {
  requireMinimumVersion(nodeVersion, MINIMUM_TRUSTED_PUBLISHING_NODE_VERSION, 'Node.js');
  requireMinimumVersion(npmVersion, MINIMUM_TRUSTED_PUBLISHING_NPM_VERSION, 'npm');
  return { nodeVersion, npmVersion };
}

export function validateNpmTrustCliRuntime(npmVersion) {
  requireMinimumVersion(npmVersion, MINIMUM_NPM_TRUST_CLI_VERSION, 'npm trust CLI');
  return npmVersion;
}

function parseRuntimeArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--node' && arg !== '--npm') {
      throw new Error(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a version`);
    }
    if (values.has(arg)) {
      throw new Error(`${arg} may be specified only once`);
    }
    values.set(arg, value);
    index += 1;
  }
  if (!values.has('--node') || !values.has('--npm')) {
    throw new Error('check-runtime requires --node VERSION --npm VERSION');
  }
  return { nodeVersion: values.get('--node'), npmVersion: values.get('--npm') };
}

function main(argv) {
  try {
    const [command, ...rest] = argv;
    if (command === 'check-runtime') {
      const versions = validateNpmTrustedPublishingRuntime(parseRuntimeArgs(rest));
      console.log(
        `npm trusted-publishing runtime passed: Node.js ${versions.nodeVersion}, npm ${versions.npmVersion}`,
      );
      return;
    }
    throw new Error(
      'usage: npm-trusted-publishing-runtime.mts ' + 'check-runtime --node VERSION --npm VERSION',
    );
  } catch (error) {
    console.error(`npm-trusted-publishing-runtime: ${error.message}`);
    process.exit(1);
  }
}

if (
  import.meta.main === true ||
  (process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
) {
  main(process.argv.slice(2));
}
