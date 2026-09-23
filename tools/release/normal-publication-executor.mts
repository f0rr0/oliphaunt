import {
  CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
  CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
  withCratesIoTrustedPublishingToken,
} from './crates-io-trusted-publishing.mts';

function error(message) {
  return new Error(`normal-publication-executor: ${message}`);
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.operations)) {
    throw error('plan must contain an operations list');
  }
  const operationIds = new Set();
  const carrierIds = new Set();
  for (const [index, operation] of plan.operations.entries()) {
    if (
      operation?.operationOrder !== index ||
      typeof operation.id !== 'string' ||
      operation.id.length === 0
    ) {
      throw error(`operation ${index} is not in a contiguous canonical order`);
    }
    if (operationIds.has(operation.id)) {
      throw error(`operation id ${operation.id} is duplicated`);
    }
    operationIds.add(operation.id);
    if (
      !Array.isArray(operation.dependencies) ||
      new Set(operation.dependencies).size !== operation.dependencies.length ||
      operation.dependencies.some(
        (dependency) => typeof dependency !== 'string' || dependency.length === 0,
      )
    ) {
      throw error(`operation ${operation.id} dependencies must be a unique string list`);
    }
    if (operation.kind === 'carrier') {
      if (
        !new Set(['cargo', 'npm']).has(operation.ecosystem) ||
        typeof operation.carrierId !== 'string' ||
        !operation.carrierId.startsWith(`${operation.ecosystem}:`) ||
        carrierIds.has(operation.carrierId)
      ) {
        throw error(`carrier operation ${operation.id} is invalid`);
      }
      carrierIds.add(operation.carrierId);
    } else if (operation.kind === 'maven-atomic-deployment') {
      if (
        operation.ecosystem !== 'maven' ||
        !Array.isArray(operation.carrierIds) ||
        operation.carrierIds.length === 0 ||
        new Set(operation.carrierIds).size !== operation.carrierIds.length ||
        operation.carrierIds.some(
          (id) => typeof id !== 'string' || !id.startsWith('maven:') || carrierIds.has(id),
        )
      ) {
        throw error(`Maven operation ${operation.id} is invalid`);
      }
      for (const id of operation.carrierIds) carrierIds.add(id);
    } else {
      throw error(
        `operation ${operation.id} has unsupported kind ${JSON.stringify(operation.kind)}`,
      );
    }
  }
  const positions = new Map(plan.operations.map((operation, index) => [operation.id, index]));
  for (const [index, operation] of plan.operations.entries()) {
    for (const dependency of operation.dependencies) {
      const dependencyPosition = positions.get(dependency);
      if (dependencyPosition === undefined) {
        throw error(`operation ${operation.id} refers to unknown dependency ${dependency}`);
      }
      if (dependencyPosition >= index) {
        throw error(`operation ${operation.id} is not ordered after dependency ${dependency}`);
      }
    }
  }
}

function receiptList(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function requireReceipt(receipt, context) {
  if (
    receipt === null ||
    Array.isArray(receipt) ||
    typeof receipt !== 'object' ||
    typeof receipt.id !== 'string'
  ) {
    throw error(`${context} contains an invalid registry receipt`);
  }
}

/**
 * Merge immutable bootstrap receipts with the exact receipts returned by each
 * operation. Coverage is checked against the frozen plan before the caller
 * writes evidence; no callback may omit, add, duplicate, or replace a carrier.
 */
export function collectNormalPublicationReceipts({ plan, initialReceipts = [], operationResults }) {
  validatePlan(plan);
  if (!Array.isArray(initialReceipts)) throw error('initial registry receipts must be a list');
  if (!Array.isArray(operationResults) || operationResults.length !== plan.operations.length) {
    throw error('operation results must exactly cover the canonical publication plan');
  }
  const carrierOperation = new Map();
  for (const operation of plan.operations) {
    for (const id of operation.kind === 'carrier' ? [operation.carrierId] : operation.carrierIds) {
      carrierOperation.set(id, operation);
    }
  }
  const collected = new Map();
  for (const receipt of initialReceipts) {
    requireReceipt(receipt, 'initial registry receipts');
    const operation = carrierOperation.get(receipt.id);
    if (operation === undefined || !new Set(['cargo', 'npm']).has(operation.ecosystem)) {
      throw error(
        `initial registry receipt ${receipt.id} is not a selected Cargo/npm bootstrap carrier`,
      );
    }
    if (collected.has(receipt.id))
      throw error(`initial registry receipt ${receipt.id} is duplicated`);
    collected.set(receipt.id, receipt);
  }
  const initialIds = new Set(collected.keys());
  for (const [index, operation] of plan.operations.entries()) {
    const expectedIds = (
      operation.kind === 'carrier' ? [operation.carrierId] : operation.carrierIds
    ).filter((id) => !initialIds.has(id));
    const receipts = receiptList(operationResults[index]);
    const observedIds = new Set();
    for (const receipt of receipts) {
      requireReceipt(receipt, `operation ${operation.id}`);
      if (observedIds.has(receipt.id))
        throw error(`operation ${operation.id} returned duplicate registry receipt ${receipt.id}`);
      observedIds.add(receipt.id);
    }
    if (observedIds.size !== expectedIds.length || expectedIds.some((id) => !observedIds.has(id))) {
      throw error(
        `operation ${operation.id} did not return receipts for its exact non-bootstrap carrier set: expected ${expectedIds.join(', ') || 'none'}`,
      );
    }
    for (const receipt of receipts) {
      if (collected.has(receipt.id))
        throw error(
          `operation ${operation.id} attempted to replace registry receipt ${receipt.id}`,
        );
      collected.set(receipt.id, receipt);
    }
  }
  return collected;
}

function strictBatchSize(value) {
  const raw = value ?? CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE
  ) {
    throw error(
      `Cargo trusted-publishing batch size must be an integer from 1 through ${CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE}`,
    );
  }
  return parsed;
}

function cargoBatches(operations, operationById, batchSize) {
  const batches = [];
  let batch = [];
  for (const operation of operations) {
    const hasCrossEcosystemDependency = operation.dependencies.some(
      (dependency) => operationById.get(dependency).ecosystem !== 'cargo',
    );
    if (batch.length >= batchSize || (batch.length > 0 && hasCrossEcosystemDependency)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(operation);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function normalPublicationSchedule(plan, batchSize) {
  validatePlan(plan);
  const byId = new Map(plan.operations.map((operation) => [operation.id, operation]));
  return {
    cargoBatches: cargoBatches(
      plan.operations.filter((operation) => operation.ecosystem === 'cargo'),
      byId,
      strictBatchSize(batchSize),
    ).map((batch) => batch.map((operation) => operation.operationOrder)),
    dependencies: plan.operations.map((operation) =>
      operation.dependencies.map((id) => byId.get(id).operationOrder),
    ),
  };
}

export async function executeCargoPublicationBatch({
  operations,
  cargoVersionPublished,
  publishCarrier,
  isAborted,
  tokenOptions = {},
  nowImpl = Date.now,
}) {
  const active = () => {
    if (isAborted()) throw error('peer registry lane failed; stopping Cargo admission');
  };
  if (
    !operations.length ||
    operations.length > CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE ||
    operations.some((operation) => operation.ecosystem !== 'cargo')
  )
    throw error('invalid Cargo publication batch');
  const batch = [];
  for (const operation of operations) {
    active();
    batch.push({ operation, alreadyPublished: await cargoVersionPublished(operation) });
  }
  const publish = async (session) => {
    const tokenDeadlineEpochMs =
      session &&
      Math.min(
        session.expiresAt,
        session.acquiredAt + CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
        session.publicationDeadlineEpochMs,
      );
    for (const { operation, alreadyPublished } of batch) {
      active();
      if (!alreadyPublished && nowImpl() >= tokenDeadlineEpochMs)
        throw error('temporary Cargo token batch expired before ' + operation.carrierId);
      await publishCarrier(operation, {
        alreadyPublished,
        cargoToken: session?.token,
        tokenDeadlineEpochMs,
      });
    }
  };
  active();
  if (batch.every((item) => item.alreadyPublished)) await publish();
  else await withCratesIoTrustedPublishingToken(publish, { ...tokenOptions, nowImpl });
}
