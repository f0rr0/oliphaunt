import {
  stableJson,
  validateReleaseContinuationPointer,
} from "./release-continuation-contract.mjs";

export const RELEASE_CONTINUATION_AUTHORIZATION_SCHEMA =
  "oliphaunt-release-continuation-authorization-v1";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function error(message) {
  return new Error(`release-continuation-authorization: ${message}`);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, context) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw error(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (stableJson(actual) !== stableJson(expected)) {
    throw error(`${context} keys must be exactly ${expected.join(", ")}`);
  }
}

function positiveInteger(value, context) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw error(`${context} must be a positive safe integer`);
  }
  return value;
}

function repository(value) {
  if (typeof value !== "string" || !REPOSITORY.test(value)) {
    throw error("repository must be an owner/name slug");
  }
  return value;
}

export function continuationAuthorizationArtifactName(pointer) {
  const normalized = validateReleaseContinuationPointer(pointer);
  return `release-continuation-authorization-${normalized.parentRunId}-${normalized.parentRunAttempt}-${normalized.pointerDigest}`;
}

export function createReleaseContinuationAuthorization({ childRunId, pointer, repo }) {
  const normalized = validateReleaseContinuationPointer(pointer);
  const value = {
    childRunId: positiveInteger(childRunId, "childRunId"),
    operation: normalized.operation,
    parentRunAttempt: normalized.parentRunAttempt,
    parentRunId: normalized.parentRunId,
    pointerDigest: normalized.pointerDigest,
    releaseCommit: normalized.releaseCommit,
    repository: repository(repo),
    schema: RELEASE_CONTINUATION_AUTHORIZATION_SCHEMA,
  };
  if (value.childRunId === value.parentRunId) {
    throw error("the authorized child run must differ from its parent");
  }
  return value;
}

export function validateReleaseContinuationAuthorization(
  value,
  { currentRunId, pointer, repo },
) {
  exactKeys(value, [
    "childRunId",
    "operation",
    "parentRunAttempt",
    "parentRunId",
    "pointerDigest",
    "releaseCommit",
    "repository",
    "schema",
  ], "authorization receipt");
  if (value.schema !== RELEASE_CONTINUATION_AUTHORIZATION_SCHEMA) {
    throw error(`authorization schema must be ${RELEASE_CONTINUATION_AUTHORIZATION_SCHEMA}`);
  }
  const expected = createReleaseContinuationAuthorization({
    childRunId: positiveInteger(currentRunId, "currentRunId"),
    pointer,
    repo,
  });
  if (stableJson(value) !== stableJson(expected)) {
    throw error("authorization receipt does not authorize this exact dispatched child run");
  }
  return expected;
}

export function serializeReleaseContinuationAuthorization(value) {
  exactKeys(value, [
    "childRunId",
    "operation",
    "parentRunAttempt",
    "parentRunId",
    "pointerDigest",
    "releaseCommit",
    "repository",
    "schema",
  ], "authorization receipt");
  return `${stableJson(value)}\n`;
}
