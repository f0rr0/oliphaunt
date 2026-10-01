#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  extensionArtifactProductsForReleaseProducts,
  extensionSqlNamesForProducts,
} from '../../tools/release/release-artifact-targets.mts';

import {
  affectedPlanBinding,
  assertBindingMatches,
  assertCandidateBindingShape,
  assertQualificationProductCoverage,
  candidateQualificationMode,
  FULL_PAYLOAD_QUALIFICATION_MODE,
  nativeEvidenceBinding,
  PRODUCT_QUALIFICATION_MODE,
  wasixEvidenceBinding,
} from './release-candidate-lib.mts';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

function parseArgs(argv) {
  const candidatePath = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    if (
      ![
        '--plan',
        '--qualification-mode',
        '--products-json',
        '--native-evidence-required',
        '--native-evidence-root',
        '--wasix-evidence-required',
        '--wasix-evidence-root',
      ].includes(name)
    ) {
      fail(`unknown argument: ${name}`);
    }
    if (index + 1 >= argv.length) {
      fail(`${name} requires a value`);
    }
    values.set(name.slice(2), argv[index + 1]);
    index += 1;
  }
  if (!candidatePath || !values.has('plan') || !values.has('wasix-evidence-required')) {
    fail(
      'usage: verify-release-candidate.mts <candidate-json> --plan <ci-plan.json> ' +
        '--wasix-evidence-required true|false [--qualification-mode full-payload] ' +
        '[--wasix-evidence-root <directory>] [--native-evidence-required true|false] ' +
        '[--native-evidence-root <directory>]',
    );
  }
  const required = values.get('wasix-evidence-required');
  if (!['true', 'false'].includes(required)) {
    fail('--wasix-evidence-required must be true or false');
  }
  if (required === 'true' && !values.has('wasix-evidence-root')) {
    fail('--wasix-evidence-root is required when WASIX evidence is required');
  }
  const nativeRequired = values.get('native-evidence-required') ?? 'false';
  if (!['true', 'false'].includes(nativeRequired))
    fail('--native-evidence-required must be true or false');
  if (nativeRequired === 'true' && !values.has('native-evidence-root'))
    fail('--native-evidence-root is required when native evidence is required');
  const qualificationMode = values.get('qualification-mode') ?? FULL_PAYLOAD_QUALIFICATION_MODE;
  if (
    ![FULL_PAYLOAD_QUALIFICATION_MODE, PRODUCT_QUALIFICATION_MODE, 'release'].includes(
      qualificationMode,
    )
  ) {
    fail('--qualification-mode must be full-payload, selected-products, or release');
  }
  const products = values.has('products-json')
    ? JSON.parse(values.get('products-json'))
    : undefined;
  if (qualificationMode !== FULL_PAYLOAD_QUALIFICATION_MODE && products === undefined)
    fail('--products-json is required for product qualification');
  return {
    candidatePath,
    planPath: values.get('plan'),
    wasixEvidenceRequired: required === 'true',
    nativeEvidenceRequired: nativeRequired === 'true',
    nativeEvidenceRoot: values.get('native-evidence-root'),
    wasixEvidenceRoot: values.get('wasix-evidence-root'),
    qualificationMode,
    products,
  };
}

const args = parseArgs(process.argv.slice(2));

let candidate;
try {
  candidate = JSON.parse(readFileSync(args.candidatePath, 'utf8'));
} catch (error) {
  fail(`invalid release candidate ${args.candidatePath}: ${error.message}`);
}

try {
  assertCandidateBindingShape(candidate);
} catch (error) {
  fail(error.message);
}
if (
  args.qualificationMode !== 'release' &&
  candidateQualificationMode(candidate) !== args.qualificationMode
) {
  fail(
    `release candidate qualification mode mismatch: expected ${args.qualificationMode}, ` +
      `got ${candidateQualificationMode(candidate)}`,
  );
}
if (args.products !== undefined) {
  try {
    assertQualificationProductCoverage(candidate, args.products);
  } catch (error) {
    fail(error.message);
  }
}

const expected = {
  repository: requiredEnv('GITHUB_REPOSITORY'),
  runId: requiredEnv('CI_RUN_ID'),
  sha: requiredEnv('RELEASE_HEAD_SHA').toLowerCase(),
};
const expectedTree = requiredEnv('CI_SOURCE_TREE').toLowerCase();

for (const [field, value] of Object.entries({
  schemaVersion: 2,
  repository: expected.repository,
  workflow: 'CI',
  runId: expected.runId,
  ref: 'refs/heads/main',
  sha: expected.sha,
  tree: expectedTree,
})) {
  if (candidate?.[field] !== value) {
    fail(`release candidate ${field} mismatch: expected ${value}, got ${candidate?.[field]}`);
  }
}

if (!['push', 'workflow_dispatch'].includes(candidate.eventName)) {
  fail(`release candidate event must be push or workflow_dispatch, got ${candidate.eventName}`);
}
if (!Number.isSafeInteger(candidate.runAttempt) || candidate.runAttempt < 1) {
  fail(`release candidate has invalid runAttempt: ${candidate.runAttempt}`);
}
if (
  typeof candidate.workflowRef !== 'string' ||
  !candidate.workflowRef.includes('/.github/workflows/ci.yml@')
) {
  fail(`release candidate has invalid workflowRef: ${candidate.workflowRef}`);
}

let expectedPlan;
try {
  expectedPlan = affectedPlanBinding(
    args.planPath,
    candidate.affectedPlan.wasixReleaseRegressionRequired,
  );
} catch (error) {
  fail(error.message);
}
try {
  assertBindingMatches(candidate.affectedPlan, expectedPlan, 'release candidate affected plan');
} catch (error) {
  fail(error.message);
}

if (args.wasixEvidenceRequired) {
  if (!candidate.evidenceRequirements.wasixReleaseRegression) {
    fail(
      'selected release products require WASIX evidence, but the qualified CI plan did not require it',
    );
  }
  let evidence;
  try {
    evidence = wasixEvidenceBinding(args.wasixEvidenceRoot, {
      repository: expected.repository,
      workflow: 'CI',
      runId: expected.runId,
      runAttempt: candidate.runAttempt,
      sha: expected.sha,
      tree: expectedTree,
    });
  } catch (error) {
    fail(error.message);
  }
  try {
    assertBindingMatches(
      candidate.evidence.wasixReleaseRegression,
      evidence,
      'release candidate WASIX evidence',
    );
  } catch (error) {
    fail(error.message);
  }
}

if (args.nativeEvidenceRequired && !candidate.evidenceRequirements.nativeExtensionLifecycle)
  fail(
    'selected release products require native evidence, but the qualified CI plan did not require it',
  );
if (args.nativeEvidenceRequired) {
  try {
    if (args.products) {
      const requiredExtensions = extensionSqlNamesForProducts(
        extensionArtifactProductsForReleaseProducts(args.products, { family: 'native' }),
      );
      for (const extension of requiredExtensions) {
        if (!expectedPlan.nativeExtensionLifecycle.extensions.includes(extension))
          fail(`native evidence is missing published extension ${extension}`);
      }
    }
    assertBindingMatches(
      candidate.evidence.nativeExtensionLifecycle,
      nativeEvidenceBinding(args.nativeEvidenceRoot, {
        repository: expected.repository,
        runId: expected.runId,
        runAttempt: candidate.runAttempt,
        sha: expected.sha,
        tree: expectedTree,
        selection: expectedPlan.nativeExtensionLifecycle,
      }),
      'release candidate native evidence',
    );
  } catch (error) {
    fail(error.message);
  }
}

console.log(`verified qualified CI run ${candidate.runId} for ${candidate.sha}`);
