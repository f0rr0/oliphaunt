import {
  CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
  CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
  withCratesIoTrustedPublishingToken,
} from "./crates-io-trusted-publishing.mjs";
import {
  isRegistryPublicationDeferredError,
  RegistryPublicationDeferredError,
} from "./registry-publication-deferral.mjs";

const ECOSYSTEMS = ["cargo", "npm", "maven", "jsr"];

function error(message) {
  return new Error(`normal-publication-executor: ${message}`);
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.operations)) {
    throw error("plan must contain an operations list");
  }
  const operationIds = new Set();
  const carrierIds = new Set();
  for (const [index, operation] of plan.operations.entries()) {
    if (operation?.operationOrder !== index || typeof operation.id !== "string" || operation.id.length === 0) {
      throw error(`operation ${index} is not in a contiguous canonical order`);
    }
    if (operationIds.has(operation.id)) {
      throw error(`operation id ${operation.id} is duplicated`);
    }
    operationIds.add(operation.id);
    if (
      !Array.isArray(operation.dependencies)
      || new Set(operation.dependencies).size !== operation.dependencies.length
      || operation.dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
    ) {
      throw error(`operation ${operation.id} dependencies must be a unique string list`);
    }
    if (operation.kind === "carrier") {
      if (
        !new Set(["cargo", "npm", "jsr"]).has(operation.ecosystem)
        || typeof operation.carrierId !== "string"
        || !operation.carrierId.startsWith(`${operation.ecosystem}:`)
        || carrierIds.has(operation.carrierId)
      ) {
        throw error(`carrier operation ${operation.id} is invalid`);
      }
      carrierIds.add(operation.carrierId);
    } else if (operation.kind === "maven-atomic-deployment") {
      if (
        operation.ecosystem !== "maven"
        || !Array.isArray(operation.carrierIds)
        || operation.carrierIds.length === 0
        || new Set(operation.carrierIds).size !== operation.carrierIds.length
        || operation.carrierIds.some((id) => typeof id !== "string" || !id.startsWith("maven:") || carrierIds.has(id))
      ) {
        throw error(`Maven operation ${operation.id} is invalid`);
      }
      for (const id of operation.carrierIds) carrierIds.add(id);
    } else {
      throw error(`operation ${operation.id} has unsupported kind ${JSON.stringify(operation.kind)}`);
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
  if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object" || typeof receipt.id !== "string") {
    throw error(`${context} contains an invalid registry receipt`);
  }
}

/**
 * Merge immutable bootstrap receipts with the exact receipts returned by each
 * operation. Coverage is checked against the frozen plan before the caller
 * writes evidence; no callback may omit, add, duplicate, or replace a carrier.
 */
export function collectNormalPublicationReceipts({
  plan,
  initialReceipts = [],
  operationResults,
}) {
  validatePlan(plan);
  if (!Array.isArray(initialReceipts)) throw error("initial registry receipts must be a list");
  if (!Array.isArray(operationResults) || operationResults.length !== plan.operations.length) {
    throw error("operation results must exactly cover the canonical publication plan");
  }
  const carrierOperation = new Map();
  for (const operation of plan.operations) {
    for (const id of operation.kind === "carrier" ? [operation.carrierId] : operation.carrierIds) {
      carrierOperation.set(id, operation);
    }
  }
  const collected = new Map();
  for (const receipt of initialReceipts) {
    requireReceipt(receipt, "initial registry receipts");
    const operation = carrierOperation.get(receipt.id);
    if (operation === undefined || !new Set(["cargo", "npm"]).has(operation.ecosystem)) {
      throw error(`initial registry receipt ${receipt.id} is not a selected Cargo/npm bootstrap carrier`);
    }
    if (collected.has(receipt.id)) throw error(`initial registry receipt ${receipt.id} is duplicated`);
    collected.set(receipt.id, receipt);
  }
  const initialIds = new Set(collected.keys());
  for (const [index, operation] of plan.operations.entries()) {
    const expectedIds = (operation.kind === "carrier" ? [operation.carrierId] : operation.carrierIds)
      .filter((id) => !initialIds.has(id));
    const receipts = receiptList(operationResults[index]);
    const observedIds = new Set();
    for (const receipt of receipts) {
      requireReceipt(receipt, `operation ${operation.id}`);
      if (observedIds.has(receipt.id)) throw error(`operation ${operation.id} returned duplicate registry receipt ${receipt.id}`);
      observedIds.add(receipt.id);
    }
    if (observedIds.size !== expectedIds.length || expectedIds.some((id) => !observedIds.has(id))) {
      throw error(
        `operation ${operation.id} did not return receipts for its exact non-bootstrap carrier set: expected ${expectedIds.join(", ") || "none"}`,
      );
    }
    for (const receipt of receipts) {
      if (collected.has(receipt.id)) throw error(`operation ${operation.id} attempted to replace registry receipt ${receipt.id}`);
      collected.set(receipt.id, receipt);
    }
  }
  return collected;
}

function strictBatchSize(value) {
  const raw = value ?? CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE) {
    throw error(`Cargo trusted-publishing batch size must be an integer from 1 through ${CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE}`);
  }
  return parsed;
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function cargoBatches(operations, operationById, batchSize) {
  const batches = [];
  let batch = [];
  for (const operation of operations) {
    const hasCrossEcosystemDependency = operation.dependencies.some(
      (dependency) => operationById.get(dependency).ecosystem !== "cargo",
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

/**
 * Execute the exact topology plan with one bounded lane per registry. The
 * frozen operation order is a topological order; each lane preserves its
 * projection of that order and awaits arbitrary cross-ecosystem dependencies.
 * Independent registries therefore overlap without allowing two mutations in
 * one ecosystem at once. Cargo additionally retains bounded temporary-token
 * batches and mandatory revocation on success, failure, or peer-lane abort.
 *
 * Callback return values are preserved in canonical operation order so the
 * caller can assemble immutable receipts without downloading every registry
 * payload a second time.
 */
export async function executeNormalPublicationPlan({
  plan,
  cargoVersionPublished,
  publishCarrier,
  publishMaven,
  completedOperationResults = new Map(),
  admittedOperationIds = undefined,
  onOperationComplete = () => {},
  tokenOptions = {},
  batchSize = CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
  nowImpl = Date.now,
}) {
  validatePlan(plan);
  if (typeof cargoVersionPublished !== "function" || typeof publishCarrier !== "function" || typeof publishMaven !== "function") {
    throw error("cargoVersionPublished, publishCarrier, and publishMaven callbacks are required");
  }
  if (!(completedOperationResults instanceof Map)) {
    throw error("completedOperationResults must be a Map keyed by canonical operation id");
  }
  if (typeof onOperationComplete !== "function") {
    throw error("onOperationComplete must be a function");
  }
  const boundedBatchSize = strictBatchSize(batchSize);
  const operations = plan.operations;
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  const completedOperationIds = new Set(completedOperationResults.keys());
  for (const operationId of completedOperationIds) {
    if (!operationById.has(operationId)) {
      throw error(`completed operation ${operationId} is absent from the canonical publication plan`);
    }
  }
  for (const operationId of completedOperationIds) {
    const operation = operationById.get(operationId);
    const missingDependencies = operation.dependencies.filter((dependency) => !completedOperationIds.has(dependency));
    if (missingDependencies.length > 0) {
      throw error(`completed operation ${operationId} is missing completed dependencies: ${missingDependencies.join(", ")}`);
    }
  }
  const canonicalRemainingOperationIds = operations
    .filter(({ id }) => !completedOperationIds.has(id))
    .map(({ id }) => id);
  const exactAdmittedOperationIds = admittedOperationIds ?? canonicalRemainingOperationIds;
  if (
    !Array.isArray(exactAdmittedOperationIds)
    || exactAdmittedOperationIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(exactAdmittedOperationIds).size !== exactAdmittedOperationIds.length
  ) {
    throw error("admittedOperationIds must be a unique string list");
  }
  const admittedOperationIdSet = new Set(exactAdmittedOperationIds);
  const canonicalAdmittedOperationIds = operations
    .filter(({ id }) => admittedOperationIdSet.has(id))
    .map(({ id }) => id);
  if (
    canonicalAdmittedOperationIds.length !== admittedOperationIdSet.size
    || canonicalAdmittedOperationIds.some((id, index) => id !== exactAdmittedOperationIds[index])
    || exactAdmittedOperationIds.some((id) => completedOperationIds.has(id))
  ) {
    throw error("admittedOperationIds must be an ordered projection of remaining canonical operations");
  }
  if (canonicalRemainingOperationIds.length > 0 && exactAdmittedOperationIds.length === 0) {
    throw error("an incomplete normal-publication invocation must admit at least one operation");
  }
  const satisfiedOperationIds = new Set([...completedOperationIds, ...exactAdmittedOperationIds]);
  for (const operationId of exactAdmittedOperationIds) {
    const missingDependencies = operationById.get(operationId).dependencies.filter(
      (dependency) => !satisfiedOperationIds.has(dependency),
    );
    if (missingDependencies.length > 0) {
      throw error(`admitted operation ${operationId} omits dependencies: ${missingDependencies.join(", ")}`);
    }
  }
  const completions = new Map(operations.map((operation) => [operation.id, deferred()]));
  const results = new Array(operations.length);
  for (const [operationId, value] of completedOperationResults) {
    const operation = operationById.get(operationId);
    results[operation.operationOrder] = value;
    completions.get(operationId).resolve();
  }
  let firstFailure;
  const deferrals = [];
  const newlyCompletedOperationIds = new Set();
  let aborted = false;
  let signalAbort;
  const abortSignal = new Promise((resolve) => {
    signalAbort = resolve;
  });

  function failAll(cause) {
    const failure = cause instanceof Error ? cause : error(String(cause));
    if (isRegistryPublicationDeferredError(failure)) {
      if (!deferrals.includes(failure)) deferrals.push(failure);
    } else if (firstFailure === undefined) {
      firstFailure = failure;
    }
    if (!aborted) {
      aborted = true;
      signalAbort();
    }
  }

  function requireActive() {
    if (aborted) throw firstFailure ?? deferrals[0];
  }

  async function waitForDependencies(operation) {
    requireActive();
    const dependencies = Promise.all(
      operation.dependencies.map((dependency) => completions.get(dependency).promise),
    );
    await Promise.race([dependencies, abortSignal]);
    requireActive();
  }

  async function complete(operation, value) {
    try {
      await onOperationComplete(operation, value);
    } catch (cause) {
      throw error(
        `immutable checkpoint failed for ${operation.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    results[operation.operationOrder] = value;
    newlyCompletedOperationIds.add(operation.id);
    completions.get(operation.id).resolve();
  }

  async function runSimpleLane(ecosystem) {
    try {
      for (const operation of operations.filter(
        (candidate) => candidate.ecosystem === ecosystem && admittedOperationIdSet.has(candidate.id),
      )) {
        await waitForDependencies(operation);
        requireActive();
        const value = operation.kind === "maven-atomic-deployment"
          ? await publishMaven(operation)
          : await publishCarrier(operation, { alreadyPublished: undefined });
        await complete(operation, value);
      }
    } catch (cause) {
      failAll(cause);
    }
  }

  async function runCargoLane() {
    const cargo = operations.filter(
      (operation) => operation.ecosystem === "cargo" && admittedOperationIdSet.has(operation.id),
    );
    try {
      for (const operationsBatch of cargoBatches(cargo, operationById, boundedBatchSize)) {
        // A batch starts at every cross-registry dependency boundary. Later
        // operations in the batch can therefore depend only on earlier Cargo
        // operations, which this lane completes in order under one token.
        await waitForDependencies(operationsBatch[0]);
        const batch = [];
        for (const operation of operationsBatch) {
          requireActive();
          batch.push({
            operation,
            alreadyPublished: await cargoVersionPublished(operation),
          });
        }
        const pending = batch.filter(({ alreadyPublished }) => !alreadyPublished);
        if (pending.length === 0) {
          for (const item of batch) {
            requireActive();
            await complete(
              item.operation,
              await publishCarrier(item.operation, { alreadyPublished: true }),
            );
          }
          continue;
        }

        requireActive();
        await withCratesIoTrustedPublishingToken(async (session) => {
          const tokenDeadlineEpochMs = Math.min(
            session.expiresAt,
            session.acquiredAt + CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
            session.publicationDeadlineEpochMs,
          );
          for (const item of batch) {
            requireActive();
            if (item.alreadyPublished) {
              await complete(
                item.operation,
                await publishCarrier(item.operation, { alreadyPublished: true }),
              );
              continue;
            }
            const operationNow = nowImpl();
            if (operationNow >= tokenDeadlineEpochMs) {
              throw new RegistryPublicationDeferredError({
                reason: "deadline",
                notBeforeEpochSeconds: Math.floor(operationNow / 1000) + 1,
                context: `temporary Cargo token batch expired before ${item.operation.carrierId}`,
              });
            }
            await complete(
              item.operation,
              await publishCarrier(item.operation, {
                alreadyPublished: false,
                cargoToken: session.token,
                tokenDeadlineEpochMs,
              }),
            );
          }
        }, { ...tokenOptions, nowImpl });
      }
    } catch (cause) {
      failAll(cause);
    }
  }

  await Promise.all([
    runCargoLane(),
    ...ECOSYSTEMS.filter((ecosystem) => ecosystem !== "cargo").map(runSimpleLane),
  ]);
  if (firstFailure !== undefined) throw firstFailure;
  const completedIds = new Set([...completedOperationIds, ...newlyCompletedOperationIds]);
  const remainingOperationIds = operations.filter(({ id }) => !completedIds.has(id)).map(({ id }) => id);
  const capacityDeferred = remainingOperationIds.length > 0 && deferrals.length === 0;
  const publicationDeferred = deferrals.length > 0 || capacityDeferred;
  const capacityNotBeforeEpochSeconds = capacityDeferred ? Math.floor(nowImpl() / 1000) + 1 : null;
  return {
    decision: publicationDeferred ? "deferred" : "complete",
    operationResults: results,
    admittedOperationIds: [...exactAdmittedOperationIds],
    completedOperationIds: operations.filter(({ id }) => completedIds.has(id)).map(({ id }) => id),
    newlyCompletedOperationIds: operations.filter(({ id }) => newlyCompletedOperationIds.has(id)).map(({ id }) => id),
    remainingOperationIds,
    deferReason: publicationDeferred
      ? deferrals.length === 0
        ? "capacity"
        : (deferrals.some(({ reason }) => reason === "deadline") ? "deadline" : "rate-limit")
      : null,
    notBeforeEpochSeconds: publicationDeferred
      ? Math.max(
          capacityNotBeforeEpochSeconds ?? 0,
          ...deferrals.map(({ notBeforeEpochSeconds }) => notBeforeEpochSeconds),
        )
      : null,
  };
}
