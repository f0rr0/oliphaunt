import {
  CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
  CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
  withCratesIoTrustedPublishingToken,
} from "./crates-io-trusted-publishing.mjs";

function error(message) {
  return new Error(`normal-publication-executor: ${message}`);
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.operations)) {
    throw error("plan must contain an operations list");
  }
  for (const [index, operation] of plan.operations.entries()) {
    if (operation?.operationOrder !== index || typeof operation.id !== "string") {
      throw error(`operation ${index} is not in a contiguous canonical order`);
    }
    if (operation.kind === "carrier") {
      if (!new Set(["cargo", "npm", "jsr"]).has(operation.ecosystem) || typeof operation.carrierId !== "string") {
        throw error(`carrier operation ${operation.id} is invalid`);
      }
    } else if (operation.kind === "maven-atomic-deployment") {
      if (operation.ecosystem !== "maven" || !Array.isArray(operation.carrierIds) || operation.carrierIds.length === 0) {
        throw error(`Maven operation ${operation.id} is invalid`);
      }
    } else {
      throw error(`operation ${operation.id} has unsupported kind ${JSON.stringify(operation.kind)}`);
    }
  }
}

function strictBatchSize(value) {
  const raw = value ?? CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE) {
    throw error(`Cargo trusted-publishing batch size must be an integer from 1 through ${CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE}`);
  }
  return parsed;
}

/**
 * Execute the exact topology plan. The caller owns package-specific byte and
 * tag checks; this coordinator owns ordering and bounded temporary Cargo
 * credentials. A token is never acquired for an already-published Cargo batch.
 */
export async function executeNormalPublicationPlan({
  plan,
  cargoVersionPublished,
  publishCarrier,
  publishMaven,
  tokenOptions = {},
  batchSize = CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE,
  nowImpl = Date.now,
}) {
  validatePlan(plan);
  if (typeof cargoVersionPublished !== "function" || typeof publishCarrier !== "function" || typeof publishMaven !== "function") {
    throw error("cargoVersionPublished, publishCarrier, and publishMaven callbacks are required");
  }
  const boundedBatchSize = strictBatchSize(batchSize);
  const operations = plan.operations;
  for (let index = 0; index < operations.length;) {
    const operation = operations[index];
    if (operation.kind === "maven-atomic-deployment") {
      await publishMaven(operation);
      index += 1;
      continue;
    }
    if (operation.ecosystem !== "cargo") {
      await publishCarrier(operation, { alreadyPublished: undefined });
      index += 1;
      continue;
    }

    const batch = [];
    while (
      index < operations.length
      && operations[index].kind === "carrier"
      && operations[index].ecosystem === "cargo"
      && batch.length < boundedBatchSize
    ) {
      const candidate = operations[index];
      batch.push({
        operation: candidate,
        alreadyPublished: await cargoVersionPublished(candidate),
      });
      index += 1;
    }
    const pending = batch.filter(({ alreadyPublished }) => !alreadyPublished);
    if (pending.length === 0) {
      for (const item of batch) {
        await publishCarrier(item.operation, { alreadyPublished: true });
      }
      continue;
    }

    await withCratesIoTrustedPublishingToken(async (session) => {
      const tokenDeadlineEpochMs = Math.min(
        session.expiresAt,
        session.acquiredAt + CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS,
      );
      for (const item of batch) {
        if (item.alreadyPublished) {
          await publishCarrier(item.operation, { alreadyPublished: true });
          continue;
        }
        if (nowImpl() >= tokenDeadlineEpochMs) {
          throw error(`temporary Cargo token batch expired before ${item.operation.carrierId}`);
        }
        await publishCarrier(item.operation, {
          alreadyPublished: false,
          cargoToken: session.token,
          tokenDeadlineEpochMs,
        });
      }
    }, { ...tokenOptions, nowImpl });
  }
}
