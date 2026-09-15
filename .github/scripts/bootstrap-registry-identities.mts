#!/usr/bin/env bun
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateBootstrapExecutionResult } from '../../tools/release/bootstrap-execution-result.mts';
import {
  appendBootstrapCheckpoint,
  loadBootstrapLedger,
} from '../../tools/release/bootstrap-ledger.mts';
import {
  bootstrapPublicationPlan,
  bootstrapPublicationSchedule,
} from '../../tools/release/bootstrap-publication-plan.mts';
import {
  reconcileBootstrapRegistryState,
  resolveBootstrapScope,
} from '../../tools/release/bootstrap-registry-reconciliation.mts';
import {
  assessCratesIoBootstrapCapacity,
  CRATES_IO_NEW_CRATE_REFILL_SECONDS,
  cratesIoCapacitySummary,
  inspectCratesIoVersionState,
  parseRegistryMutationDeadline,
  REGISTRY_BOOTSTRAP_INTEGRITY_CONCURRENCY,
} from '../../tools/release/crates-io-bootstrap-capacity.mts';
import { inspectNpmVersionState } from '../../tools/release/frozen-npm-publish.mts';
import { loadPublicationLock } from '../../tools/release/publication-lock.mts';
import { verifyLockedRegistryIntegrity } from '../../tools/release/registry-integrity.mts';
import {
  decodeRegistryPublicationDeferral,
  REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE,
} from '../../tools/release/registry-publication-deferral.mts';

function fail(message) {
  console.error(`bootstrap-registry-identities: ${message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    fail(`${name} is required`);
  }
  return value;
}

const args = Bun.argv.slice(2);
const savedPhase = ['--prepare', '--checkpoint', '--finish'].includes(args[0]);
if (savedPhase ? args.length !== 2 : args.length !== 1 || args[0] !== '--credential-needs') {
  fail(
    'use bash .github/scripts/bootstrap-registry-identities.sh, or --credential-needs for read-only inventory',
  );
}
const credentialNeedsOnly = args[0] === '--credential-needs';

const EXECUTION_RESULT_PATH = path.resolve(
  process.env.OLIPHAUNT_BOOTSTRAP_EXECUTION_RESULT?.trim() ||
    'target/release/bootstrap-execution-result.json',
);
const CHILD_STDERR_TAIL_BYTES = 128 * 1024;

function writeExecutionResult(value) {
  const normalized = validateBootstrapExecutionResult(value, {
    releaseCommit: value.source.commit,
    releaseTree: value.source.tree,
    lock: value.lock,
    products: value.products,
  });
  mkdirSync(path.dirname(EXECUTION_RESULT_PATH), { recursive: true });
  const temporary = `${EXECUTION_RESULT_PATH}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, EXECUTION_RESULT_PATH);
  if (process.env.GITHUB_OUTPUT?.trim()) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `complete=${normalized.decision === 'complete' ? 'true' : 'false'}\n` +
        `deferred=${normalized.decision === 'deferred' ? 'true' : 'false'}\n` +
        `deferral_mode=${normalized.deferralMode ?? ''}\n` +
        `progress_count=${normalized.newlyCompletedIds.length}\n` +
        `completed_count=${normalized.completedIds.length}\n` +
        `remaining_count=${normalized.remainingIds.length}\n` +
        `not_before_epoch=${normalized.notBeforeEpochSeconds ?? 0}\n`,
    );
  }
  return normalized;
}

let products;
try {
  products = JSON.parse(requiredEnv('PRODUCTS_JSON'));
} catch (error) {
  fail(`invalid PRODUCTS_JSON: ${error.message}`);
}
if (
  !Array.isArray(products) ||
  products.length === 0 ||
  products.some((product) => typeof product !== 'string')
) {
  fail('PRODUCTS_JSON must be a non-empty product string list');
}

const headRef = requiredEnv('RELEASE_HEAD_SHA');
const publicationLock = requiredEnv('PUBLICATION_LOCK_PATH');
const bootstrapLedger = requiredEnv('BOOTSTRAP_LEDGER_PATH');
let lock;
let plan;
try {
  lock = loadPublicationLock(publicationLock);
  plan = bootstrapPublicationPlan(lock, products);
  if (args[0] === '--prepare') rmSync(EXECUTION_RESULT_PATH, { force: true });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (args[0] === '--checkpoint' || args[0] === '--finish') {
  try {
    await savedBootstrapPhase(args[0], path.resolve(args[1]));
  } catch (cause) {
    fail(cause.message);
  }
  process.exit(0);
}

// This read-only inventory must complete before the genesis ledger is
// initialized and, critically, before npm or crates.io receives any
// publication request.
let cargoInventory;
let npmInventory;
try {
  const deadlineEpochSeconds = parseRegistryMutationDeadline(
    requiredEnv('REGISTRY_MUTATION_DEADLINE_EPOCH'),
  );
  [cargoInventory, npmInventory] = await Promise.all([
    inspectCratesIoVersionState({ plan, deadlineEpochSeconds }),
    inspectNpmVersionState({ plan, deadlineEpochSeconds }),
  ]);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (credentialNeedsOnly) {
  const needsCargo = cargoInventory.missingNames.length > 0;
  const needsNpm = npmInventory.missingNames.length > 0;
  if (process.env.GITHUB_OUTPUT?.trim()) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `needs_cargo_token=${needsCargo}\nneeds_npm_token=${needsNpm}\n`,
    );
  }
  console.log(
    `approved candidate requires bootstrap credentials for: ${
      [needsCargo ? 'Cargo' : '', needsNpm ? 'npm' : ''].filter(Boolean).join(', ') || 'none'
    }`,
  );
  process.exit(0);
}

// Validate a restored immutable chain before using its receipts. Inventory is
// authoritative for current public visibility; a receipt whose exact version
// disappeared is a hard pre-mutation failure. Existing names lacking the
// locked exact version remain normal trusted-publication work.
let checkpoint;
let reconciliation;
let startingCompletedIds;
let scopedPlan;
let scopedIds;
let capacityAssessment;
try {
  checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { allowEmpty: true });
  startingCompletedIds = new Set(checkpoint?.receipts.map(({ id }) => id) ?? []);
  reconciliation = reconcileBootstrapRegistryState({
    plan,
    cargoInventory,
    npmInventory,
    checkpoint,
  });
  scopedPlan = resolveBootstrapScope(plan, reconciliation, checkpoint);
  scopedIds = new Set(scopedPlan.map(({ id }) => id));

  capacityAssessment = assessCratesIoBootstrapCapacity({
    inventory: cargoInventory,
    npmInventory,
    bootstrapPlan: scopedPlan,
    cargoSecondsPerCarrier: process.env.REGISTRY_BOOTSTRAP_CARGO_SECONDS_PER_CARRIER,
    npmSecondsPerCarrier: process.env.REGISTRY_BOOTSTRAP_NPM_SECONDS_PER_CARRIER,
    reconciliationSecondsPerCarrier:
      process.env.REGISTRY_BOOTSTRAP_RECONCILIATION_SECONDS_PER_CARRIER,
    reserveSeconds: process.env.REGISTRY_BOOTSTRAP_RESERVE_SECONDS,
    deadlineEpochSeconds: parseRegistryMutationDeadline(
      requiredEnv('REGISTRY_MUTATION_DEADLINE_EPOCH'),
    ),
  });
  const summary = cratesIoCapacitySummary(capacityAssessment);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY?.trim()) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  const missing = reconciliation.missingCarriers.filter(({ id }) => scopedIds.has(id));
  if (
    missing.some(({ ecosystem }) => ecosystem === 'cargo') &&
    !process.env.CARGO_REGISTRY_TOKEN?.trim()
  ) {
    throw new Error(
      'CRATES_IO_BOOTSTRAP_TOKEN is required because the approved candidate contains absent Cargo names',
    );
  }
  if (missing.some(({ ecosystem }) => ecosystem === 'npm')) {
    const npmrc = process.env.NPM_CONFIG_USERCONFIG?.trim();
    let npmrcBody = '';
    try {
      npmrcBody = npmrc ? readFileSync(npmrc, 'utf8') : '';
    } catch {}
    if (!/^\/\/registry[.]npmjs[.]org\/:_authToken=[^\r\n]+\r?\n?$/u.test(npmrcBody)) {
      throw new Error(
        'NPM_BOOTSTRAP_TOKEN is required because the approved candidate contains absent npm names',
      );
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// Prove every matching public version against the frozen bytes in one bounded,
// concurrent preflight. This both recovers publications accepted before an
// interrupted checkpoint and ensures public recovery skips cannot conceal an
// immutable checksum/SRI conflict. No registry mutation has happened yet.
let publicReceipts = [];
try {
  const scopedPublicCarrierIds = reconciliation.publicCarrierIds.filter((id) => scopedIds.has(id));
  if (scopedPublicCarrierIds.length > 0) {
    publicReceipts = await verifyLockedRegistryIntegrity(lock, {
      carrierIds: scopedPublicCarrierIds,
      concurrency: REGISTRY_BOOTSTRAP_INTEGRITY_CONCURRENCY,
    });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// A genesis checkpoint is written only after every pre-mutation conflict and
// public-byte proof has passed. Every later file is append-only and
// content-addressed, so `if: always()` can upload a useful resume chain.
try {
  if (checkpoint === null) {
    checkpoint = appendBootstrapCheckpoint(bootstrapLedger, lock, products, [], {
      publicationIds: scopedPlan.map(({ id }) => id),
    });
  }
  if (publicReceipts.length > 0) {
    checkpoint = appendBootstrapCheckpoint(bootstrapLedger, lock, products, publicReceipts);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (args[0] === '--prepare') {
  const admitted = new Set(
    capacityAssessment.decision === 'defer' ? [] : capacityAssessment.admittedCarrierIds,
  );
  const admittedPlan = scopedPlan.filter(({ id }) => admitted.has(id));
  if (admittedPlan.length !== admitted.size)
    throw new Error('bootstrap admission contains a carrier outside its exact scope');
  const context = {
    lockDigest: lock.lockDigest,
    headRef,
    admittedPlan,
    scopedPlan,
    capacityAssessment,
    startingCompletedIds: [...startingCompletedIds],
    publicCarrierIds: reconciliation.publicCarrierIds,
    dependencies: bootstrapPublicationSchedule(admittedPlan, reconciliation.publicCarrierIds),
  };
  writeFileSync(path.join(path.resolve(args[1]), 'context.json'), JSON.stringify(context), {
    flag: 'wx',
    mode: 0o600,
  });
  process.exit(0);
}

function stderrTail(file) {
  const size = statSync(file).size;
  const bytes = Buffer.alloc(Math.min(size, CHILD_STDERR_TAIL_BYTES));
  const descriptor = openSync(file, 'r');
  try {
    readSync(descriptor, bytes, 0, bytes.length, size - bytes.length);
  } finally {
    closeSync(descriptor);
  }
  return bytes.toString('utf8');
}

async function savedBootstrapPhase(phase, directory) {
  const context = JSON.parse(readFileSync(path.join(directory, 'context.json'), 'utf8'));
  if (context.lockDigest !== lock.lockDigest || context.headRef !== headRef)
    throw new Error('bootstrap state does not match the current frozen lock/source');
  const { scopedPlan, capacityAssessment } = context;
  const startingCompletedIds = new Set(context.startingCompletedIds);
  let checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { allowEmpty: true });
  if (phase === '--checkpoint') {
    const recorded = new Set(checkpoint?.receipts.map((receipt) => receipt.id) ?? []);
    const receipts = [];
    for (const [index, carrier] of context.admittedPlan.entries()) {
      const file = path.join(directory, 'operation-' + index + '.json');
      if (!existsSync(file) || recorded.has(carrier.id)) continue;
      const receipt = JSON.parse(readFileSync(file, 'utf8'));
      if (receipt?.id !== carrier.id)
        throw new Error('bootstrap receipt does not match its admitted carrier');
      receipts.push(receipt);
    }
    if (receipts.length)
      checkpoint = appendBootstrapCheckpoint(bootstrapLedger, lock, products, receipts);
    writeFileSync(
      path.join(directory, 'checkpoint-count'),
      String(
        context.admittedPlan.filter((carrier) =>
          checkpoint?.receipts.some((receipt) => receipt.id === carrier.id),
        ).length,
      ),
    );
    return;
  }
  const deferrals = [];
  for (const [index, carrier] of context.admittedPlan.entries()) {
    const status = path.join(directory, 'status-' + index);
    if (!existsSync(status)) continue;
    const code = Number(readFileSync(status, 'utf8'));
    if (code === 0) continue;
    if (code !== REGISTRY_PUBLICATION_DEFERRAL_EXIT_CODE)
      throw new Error(carrier.id + ' bootstrap failed with exit ' + code);
    deferrals.push(
      decodeRegistryPublicationDeferral(stderrTail(path.join(directory, 'stderr-' + index))),
    );
  }
  if (
    existsSync(path.join(directory, 'checkpoint-failed')) ||
    existsSync(path.join(directory, 'lane-failed'))
  )
    throw new Error(
      'bootstrap execution or checkpoint failed; recovered receipts remain available for resume',
    );
  const execution = {
    deferReason:
      capacityAssessment.decision === 'defer'
        ? 'capacity'
        : deferrals.some((row) => row.reason === 'deadline')
          ? 'deadline'
          : deferrals.length
            ? 'rate-limit'
            : null,
    notBeforeEpochSeconds: deferrals.length
      ? Math.max(...deferrals.map((row) => row.notBeforeEpochSeconds))
      : capacityAssessment.decision === 'defer'
        ? capacityAssessment.notBeforeEpochSeconds
        : null,
  };
  let result;

  checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { allowEmpty: true });
  const completedSet = new Set(checkpoint?.receipts.map(({ id }) => id) ?? []);
  const completedIds = scopedPlan.filter(({ id }) => completedSet.has(id)).map(({ id }) => id);
  if (completedIds.length !== completedSet.size) {
    throw new Error('bootstrap ledger contains a receipt outside the exact canonical plan');
  }
  const remainingIds = scopedPlan.filter(({ id }) => !completedSet.has(id)).map(({ id }) => id);
  const newlyCompletedIds = completedIds.filter((id) => !startingCompletedIds.has(id));
  const decision = remainingIds.length === 0 ? 'complete' : 'deferred';
  if (decision === 'complete') {
    checkpoint = loadBootstrapLedger(bootstrapLedger, lock, products, { requireComplete: true });
  }
  const remainingHasCargo = scopedPlan.some(
    ({ id, ecosystem }) => ecosystem === 'cargo' && remainingIds.includes(id),
  );
  const notBeforeEpochSeconds =
    decision === 'complete'
      ? null
      : (execution.notBeforeEpochSeconds ??
        Math.floor(Date.now() / 1000) +
          (remainingHasCargo ? CRATES_IO_NEW_CRATE_REFILL_SECONDS : 1));
  const deferralMode =
    decision === 'complete'
      ? null
      : newlyCompletedIds.length > 0
        ? 'progress'
        : execution.deferReason === 'rate-limit'
          ? 'rate-limit'
          : execution.deferReason === 'capacity'
            ? 'pre-mutation-capacity'
            : execution.deferReason === 'deadline'
              ? 'pre-mutation-deadline'
              : (() => {
                  throw new Error(
                    `zero-progress bootstrap deferral requires an explicit rate-limit or deadline reason; got ` +
                      `${execution.deferReason ?? 'none'}`,
                  );
                })();
  result = writeExecutionResult({
    schema: 'oliphaunt-bootstrap-execution-result-v1',
    operation: 'publish-bootstrap',
    decision,
    deferralMode,
    source: { commit: lock.source.commit, tree: lock.source.tree },
    lock: {
      lockDigest: lock.lockDigest,
      catalogDigest: lock.catalogDigest,
      packageEnvelopeDigest: lock.packageEnvelopeDigest,
    },
    products: [...products].sort(),
    admittedIds: scopedPlan
      .filter(({ id }) => capacityAssessment.admittedCarrierIds.includes(id))
      .map(({ id }) => id),
    completedIds,
    newlyCompletedIds,
    remainingIds,
    notBeforeEpochSeconds,
  });
  console.log(
    'Bootstrap ' +
      result.decision +
      ': ' +
      result.newlyCompletedIds.length +
      ' new receipts, ' +
      result.remainingIds.length +
      ' remaining',
  );
}
