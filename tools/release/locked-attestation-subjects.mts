#!/usr/bin/env bun

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PUBLICATION_LOCK,
  loadPublicationLock,
  lockedProductArtifactPaths,
} from './publication-lock.mts';
import { compareText, ROOT } from './release-graph.mts';

const ATTESTED_ROLES = Object.freeze(['github-release-asset', 'github-release-metadata']);
export const MAX_ATTESTATION_SUBJECTS_PER_BUNDLE = 1_024;

function error(message) {
  return new Error(`locked-attestation-subjects: ${message}`);
}

function selectedProducts(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((product) => typeof product !== 'string' || product.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw error('products must be a non-empty unique string list');
  }
  return value;
}

/**
 * Resolve the exact local subject set frozen for the selected products.
 *
 * `lockedProductArtifactPaths` re-hashes every returned path. This makes the
 * action input both selection-exact and byte-exact: downloading a broad CI
 * artifact cannot accidentally add another independently-versioned product to
 * the attestation bundle.
 */
export function lockedAttestationSubjects(lock, products) {
  const selected = selectedProducts(products);
  if (!Array.isArray(lock?.products) || !Array.isArray(lock?.productArtifacts)) {
    throw error('publication lock must contain products and productArtifacts lists');
  }
  const lockedProducts = new Set(lock.products.map(({ id }) => id));
  const unknown = selected.filter((product) => !lockedProducts.has(product));
  if (unknown.length > 0) {
    throw error(`selected products are absent from the publication lock: ${unknown.join(', ')}`);
  }

  const subjects = [];
  for (const product of selected) {
    const productSubjects = ATTESTED_ROLES.flatMap((role) =>
      lockedProductArtifactPaths(lock, product, { role }),
    );
    for (const subject of productSubjects) {
      if (subject.type !== 'file') {
        throw error(`${product}:${subject.artifact.id} attestation subject must be a regular file`);
      }
      const relative = path.relative(ROOT, subject.path);
      if (
        relative === '' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        /[\r\n\u0000]/u.test(relative)
      ) {
        throw error(`${product}:${subject.artifact.id} has an unsafe action subject path`);
      }
      subjects.push(relative.split(path.sep).join('/'));
    }
  }

  subjects.sort(compareText);
  if (new Set(subjects).size !== subjects.length) {
    throw error('selected products reuse a GitHub release attestation subject path');
  }
  const folded = subjects.map((subject) => subject.toLocaleLowerCase('en-US'));
  if (new Set(folded).size !== folded.length) {
    throw error('selected GitHub release attestation subject paths collide by case');
  }
  return subjects;
}

export function githubOutputForAttestationSubjects(subjects) {
  if (
    !Array.isArray(subjects) ||
    subjects.some(
      (subject) =>
        typeof subject !== 'string' || subject.length === 0 || /[\r\n\u0000]/u.test(subject),
    ) ||
    new Set(subjects).size !== subjects.length
  ) {
    throw error('GitHub output subjects must contain unique safe paths');
  }
  if (subjects.length > MAX_ATTESTATION_SUBJECTS_PER_BUNDLE) {
    throw error(
      `selected release exceeds the ${MAX_ATTESTATION_SUBJECTS_PER_BUNDLE}-subject attestation limit`,
    );
  }
  let delimiter = 'OLIPHAUNT_RELEASE_PROVENANCE_SUBJECTS';
  while (subjects.includes(delimiter)) delimiter += '_END';
  return [
    `subject_count=${subjects.length}`,
    `has_subjects=${subjects.length > 0 ? 'true' : 'false'}`,
    `subject_paths<<${delimiter}`,
    ...subjects,
    delimiter,
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--publication-lock' && arg !== '--products-json' && arg !== '--github-output') {
      throw error(`unknown argument ${arg}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw error(`${arg} requires a value`);
    }
    if (values.has(arg)) throw error(`${arg} may be specified only once`);
    values.set(arg, value);
    index += 1;
  }
  if (!values.has('--products-json')) {
    throw error(
      'usage: locked-attestation-subjects.mts --publication-lock FILE --products-json JSON [--github-output FILE]',
    );
  }
  let products;
  try {
    products = JSON.parse(values.get('--products-json'));
  } catch (cause) {
    throw error(`--products-json must be strict JSON: ${cause.message}`);
  }
  return {
    githubOutput: values.get('--github-output'),
    lockFile: path.resolve(ROOT, values.get('--publication-lock') ?? DEFAULT_PUBLICATION_LOCK),
    products: selectedProducts(products),
  };
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const lock = loadPublicationLock(args.lockFile);
    if (args.githubOutput !== undefined) {
      const subjects = lockedAttestationSubjects(lock, args.products);
      appendFileSync(args.githubOutput, githubOutputForAttestationSubjects(subjects), {
        encoding: 'utf8',
      });
    } else {
      for (const subject of lockedAttestationSubjects(lock, args.products)) console.log(subject);
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  }
}
