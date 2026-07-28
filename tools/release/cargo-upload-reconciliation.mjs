import { isRegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

const DEFAULT_VISIBILITY_ATTEMPTS = 12;

function requiredFunction(value, context) {
  if (typeof value !== "function") {
    throw new Error(`cargo-upload-reconciliation: ${context} must be a function`);
  }
  return value;
}

function mutationFailureDetail(cause) {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

/**
 * Execute one immutable Cargo upload attempt and reconcile it through the
 * exact-version registry view. The upload is intentionally outside the
 * visibility loop: an ambiguous response must never cause a second mutation.
 */
export async function uploadCargoOnceAndReconcileExactVersion({
  crateName,
  version,
  upload,
  exactVersionPublished,
  waitBeforeNextProbe,
  visibilityAttempts = DEFAULT_VISIBILITY_ATTEMPTS,
}) {
  const publish = requiredFunction(upload, "upload");
  const inspectExactVersion = requiredFunction(exactVersionPublished, "exactVersionPublished");
  const wait = requiredFunction(waitBeforeNextProbe, "waitBeforeNextProbe");
  if (!Number.isSafeInteger(visibilityAttempts) || visibilityAttempts < 1) {
    throw new Error("cargo-upload-reconciliation: visibilityAttempts must be a positive integer");
  }

  let mutationFailed = false;
  let mutationFailure;
  try {
    await publish();
  } catch (cause) {
    // Typed deferrals are emitted only before an upload can become ambiguous:
    // either the bounded deadline was already exhausted or crates.io returned
    // an explicit 429 with a valid Retry-After. Preserve that control signal
    // so the caller can checkpoint and continue instead of turning it into a
    // terminal mutation failure. Every other exception remains ambiguous and
    // must be reconciled without replaying the upload.
    if (isRegistryPublicationDeferredError(cause)) throw cause;
    mutationFailed = true;
    mutationFailure = cause;
  }

  for (let attempt = 0; attempt < visibilityAttempts; attempt += 1) {
    if (await inspectExactVersion()) {
      return { reconciledMutationFailure: mutationFailed };
    }
    if (attempt + 1 < visibilityAttempts) {
      await wait();
    }
  }

  const visibilityFailure = `${crateName} ${version} did not appear on crates.io after the single frozen upload attempt`;
  if (mutationFailed) {
    throw new Error(
      `Cargo upload for ${crateName}@${version} failed (${mutationFailureDetail(mutationFailure)}) and immutable registry state did not reconcile: ${visibilityFailure}`,
      { cause: mutationFailure },
    );
  }
  throw new Error(visibilityFailure);
}
