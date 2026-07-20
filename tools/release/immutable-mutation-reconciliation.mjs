function requiredFunction(value, context) {
  if (typeof value !== "function") {
    throw new Error(`immutable-mutation-reconciliation: ${context} must be a function`);
  }
  return value;
}

function requiredLabel(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("immutable-mutation-reconciliation: label must be a non-empty string");
  }
  return value.trim();
}

function failureDetail(cause) {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  return String(cause);
}

/**
 * Execute one immutable remote mutation and then require its exact public
 * state. The mutation is deliberately outside the reconciliation operation:
 * an ambiguous timeout or transport failure must never cause a blind replay.
 * The caller owns the bounded polling policy inside `reconcile`.
 */
export async function mutateOnceAndRequireExactState({
  label,
  mutate,
  reconcile,
}) {
  const operationLabel = requiredLabel(label);
  const mutateOnce = requiredFunction(mutate, "mutate");
  const requireExactState = requiredFunction(reconcile, "reconcile");

  let mutationFailure;
  try {
    await mutateOnce();
  } catch (cause) {
    mutationFailure = cause;
  }

  try {
    await requireExactState();
  } catch (reconciliationFailure) {
    if (mutationFailure === undefined) throw reconciliationFailure;
    throw new Error(
      `${operationLabel} failed (${failureDetail(mutationFailure)}) and immutable state did not reconcile: ${failureDetail(reconciliationFailure)}`,
      { cause: mutationFailure },
    );
  }

  return { reconciledMutationFailure: mutationFailure !== undefined };
}
