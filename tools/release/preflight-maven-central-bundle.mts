#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { recordPreparedMavenBundle, stageFrozenMavenBundle } from './frozen-maven-publish.mts';
import { loadPublicationLock } from './publication-lock.mts';

function error(message) {
  return new Error(`preflight-maven-central-bundle: ${message}`);
}
function requiredValue(value, context) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw error(`${context} is required`);
  }
  return value.trim();
}

export function parseMavenBundlePreflightArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--publication-lock', '--products-json', '--release-commit'].includes(flag)) {
      throw error(`unknown argument ${flag}`);
    }
    if (values.has(flag)) throw error(`${flag} may be supplied only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  const publicationLock = requiredValue(values.get('--publication-lock'), '--publication-lock');
  const releaseCommit = requiredValue(values.get('--release-commit'), '--release-commit');
  if (!/^[0-9a-f]{40}$/iu.test(releaseCommit)) {
    throw error('--release-commit must be a full 40-character Git SHA');
  }
  let products;
  try {
    products = JSON.parse(requiredValue(values.get('--products-json'), '--products-json'));
  } catch (cause) {
    throw error(`--products-json must be valid JSON: ${cause.message}`);
  }
  if (
    !Array.isArray(products) ||
    products.length === 0 ||
    products.some((product) => typeof product !== 'string' || product.length === 0)
  ) {
    throw error('--products-json must be a nonempty JSON array of product IDs');
  }
  if (new Set(products).size !== products.length) {
    throw error('--products-json must not contain duplicate product IDs');
  }
  return {
    products,
    publicationLock: path.resolve(publicationLock),
    releaseCommit: releaseCommit.toLowerCase(),
  };
}

if (import.meta.main) {
  try {
    const [phase, directory, ...argv] = process.argv.slice(2);
    const contextPath = path.join(directory, 'context.json');
    if (phase === '--stage') {
      const args = parseMavenBundlePreflightArgs(argv);
      const lock = loadPublicationLock(args.publicationLock);
      const prepared = stageFrozenMavenBundle({
        lock,
        products: args.products,
        outputRoot: directory,
      });
      writeFileSync(
        contextPath,
        JSON.stringify({
          prepared,
          lockDigest: lock.lockDigest,
          source: lock.source,
          releaseCommit: args.releaseCommit,
        }),
      );
    } else if (phase === '--record') {
      const { prepared, lockDigest } = JSON.parse(readFileSync(contextPath, 'utf8'));
      const receipt = recordPreparedMavenBundle(prepared, lockDigest);
      console.log(
        'Prepared ' +
          receipt.carriers.length +
          ' exact Maven carriers in a ' +
          receipt.size +
          '-byte signed bundle',
      );
    } else throw error('unknown Maven bundle data phase');
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}
