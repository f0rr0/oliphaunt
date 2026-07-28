import { isRegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

const ECOSYSTEMS = ["cargo", "npm"];

function error(message) {
  return new Error(`bootstrap-publication-executor: ${message}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function validatePlan(plan, satisfiedCarrierIds) {
  if (!Array.isArray(plan)) throw error("plan must be a carrier list");
  if (
    !Array.isArray(satisfiedCarrierIds)
    || satisfiedCarrierIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(satisfiedCarrierIds).size !== satisfiedCarrierIds.length
  ) {
    throw error("satisfied carrier IDs must be a unique string list");
  }
  const satisfied = new Set(satisfiedCarrierIds);
  const positions = new Map();
  let priorCarrier = null;
  for (const [index, carrier] of plan.entries()) {
    if (
      carrier === null
      || typeof carrier !== "object"
      || typeof carrier.id !== "string"
      || carrier.id !== `${carrier.ecosystem}:${carrier.name}`
      || !ECOSYSTEMS.includes(carrier.ecosystem)
      || !Number.isSafeInteger(carrier.publishOrder)
      || carrier.publishOrder < 0
      || (priorCarrier !== null && (
        carrier.publishOrder < priorCarrier.publishOrder
        || (carrier.publishOrder === priorCarrier.publishOrder && carrier.id <= priorCarrier.id)
      ))
    ) {
      throw error(`carrier ${index} is not in strict canonical publish order`);
    }
    if (positions.has(carrier.id) || satisfied.has(carrier.id)) {
      throw error(`carrier ${carrier.id} is duplicated or already satisfied`);
    }
    if (
      !Array.isArray(carrier.dependencies)
      || new Set(carrier.dependencies).size !== carrier.dependencies.length
      || carrier.dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
    ) {
      throw error(`carrier ${carrier.id} dependencies must be a unique string list`);
    }
    positions.set(carrier.id, index);
    priorCarrier = carrier;
  }
  for (const [index, carrier] of plan.entries()) {
    for (const dependency of carrier.dependencies) {
      const position = positions.get(dependency);
      if (position === undefined && !satisfied.has(dependency)) {
        throw error(`${carrier.id} refers to unknown unsatisfied dependency ${dependency}`);
      }
      if (position !== undefined && position >= index) {
        throw error(`${carrier.id} is not ordered after dependency ${dependency}`);
      }
    }
  }
}

function strictBatchSize(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 128) {
    throw error("checkpoint batch size must be an integer from 1 through 128");
  }
  return parsed;
}

function normalizedFailure(cause) {
  return cause instanceof Error ? cause : error(String(cause));
}

function finalFailure(failures) {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, "bootstrap publication and/or immutable checkpoint reconciliation failed");
}

/**
 * Publish one immutable carrier at a time in each independent registry lane.
 * Explicit cross-registry dependencies are awaited, while unrelated Cargo and
 * npm carriers overlap. Checkpoint callbacks are globally serialized and
 * receive only new, unique carrier IDs in canonical plan order.
 *
 * On any failure no new callback starts after the shared abort is observed.
 * The peer lane's one in-flight immutable mutation is allowed to drain, then a
 * final checkpoint attempt reconciles every callback that returned success.
 */
export async function executeBootstrapPublicationPlan({
  plan,
  satisfiedCarrierIds = [],
  publishCarrier,
  checkpointCarrierIds,
  checkpointBatchSize = 32,
}) {
  validatePlan(plan, satisfiedCarrierIds);
  if (typeof publishCarrier !== "function" || typeof checkpointCarrierIds !== "function") {
    throw error("publishCarrier and checkpointCarrierIds callbacks are required");
  }
  const batchSize = strictBatchSize(checkpointBatchSize);
  const positions = new Map(plan.map((carrier, index) => [carrier.id, index]));
  const completions = new Map(plan.map((carrier) => [carrier.id, deferred()]));
  const completed = new Set();
  const checkpointed = new Set();
  const failures = [];
  const deferrals = [];
  let aborted = false;
  let signalAbort;
  const abortSignal = new Promise((resolve) => {
    signalAbort = resolve;
  });
  let checkpointTail = Promise.resolve();
  let checkpointFailed = false;

  function recordOutcome(cause, { allowDeferral = true } = {}) {
    const normalized = normalizedFailure(cause);
    const failure = !allowDeferral && isRegistryPublicationDeferredError(normalized)
      ? error(`typed registry deferral is invalid during immutable checkpoint reconciliation: ${normalized.message}`)
      : normalized;
    if (allowDeferral && isRegistryPublicationDeferredError(failure)) {
      if (!deferrals.includes(failure)) deferrals.push(failure);
    } else if (!failures.includes(failure)) {
      failures.push(failure);
    }
    if (!aborted) {
      aborted = true;
      signalAbort();
    }
    return failure;
  }

  function requireActive() {
    if (aborted) throw failures[0] ?? deferrals[0];
  }

  async function waitForDependencies(carrier) {
    requireActive();
    const dependencies = Promise.all(carrier.dependencies
      .filter((dependency) => positions.has(dependency))
      .map((dependency) => completions.get(dependency).promise));
    await Promise.race([dependencies, abortSignal]);
    requireActive();
  }

  function pendingCheckpointIds() {
    return plan.filter(({ id }) => completed.has(id) && !checkpointed.has(id)).map(({ id }) => id);
  }

  function serializeCheckpoint({ force, recovery }) {
    const task = checkpointTail.then(async () => {
      if (checkpointFailed && !recovery) throw failures[0];
      const ids = pendingCheckpointIds();
      if (ids.length === 0 || (!force && ids.length < batchSize)) return;
      try {
        await checkpointCarrierIds(ids);
      } catch (cause) {
        checkpointFailed = true;
        throw recordOutcome(cause, { allowDeferral: false });
      }
      for (const id of ids) checkpointed.add(id);
    });
    checkpointTail = task.catch(() => {});
    return task;
  }

  async function runLane(ecosystem) {
    try {
      for (const carrier of plan.filter((candidate) => candidate.ecosystem === ecosystem)) {
        await waitForDependencies(carrier);
        requireActive();
        await publishCarrier(carrier);
        // A peer may have failed while this immutable callback was in flight.
        // Its successful result is still checkpointable, but no next mutation
        // may start because the next loop iteration observes the shared abort.
        completed.add(carrier.id);
        completions.get(carrier.id).resolve();
        if (!aborted && pendingCheckpointIds().length >= batchSize) {
          await serializeCheckpoint({ force: false, recovery: false });
        }
      }
    } catch (cause) {
      recordOutcome(cause);
    }
  }

  await Promise.all(ECOSYSTEMS.map(runLane));
  try {
    // This recovery flush deliberately retries still-uncheckpointed IDs after
    // an earlier checkpoint failure. Appends are immutable/idempotent, and a
    // successful retry preserves evidence even though the original failure is
    // still reported to the caller.
    await serializeCheckpoint({ force: true, recovery: true });
  } catch (cause) {
    recordOutcome(cause, { allowDeferral: false });
  }

  if (failures.length > 0) throw finalFailure(failures);
  const completedCarrierIds = plan.filter(({ id }) => completed.has(id)).map(({ id }) => id);
  const checkpointedCarrierIds = plan.filter(({ id }) => checkpointed.has(id)).map(({ id }) => id);
  const remainingCarrierIds = plan.filter(({ id }) => !completed.has(id)).map(({ id }) => id);
  const publicationDeferred = deferrals.length > 0;
  return {
    decision: publicationDeferred ? "deferred" : "complete",
    completedCarrierIds,
    checkpointedCarrierIds,
    remainingCarrierIds,
    deferReason: publicationDeferred
      ? (deferrals.some(({ reason }) => reason === "deadline") ? "deadline" : "rate-limit")
      : null,
    notBeforeEpochSeconds: publicationDeferred
      ? Math.max(...deferrals.map(({ notBeforeEpochSeconds }) => notBeforeEpochSeconds))
      : null,
  };
}
