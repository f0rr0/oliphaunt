import { RegistryPublicationDeferredError } from "./registry-publication-deferral.mjs";

const CRATES_IO_TOKEN_ENDPOINT = "https://crates.io/api/v1/trusted_publishing/tokens";
const CRATES_IO_AUDIENCE = "crates.io";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;
const REGISTRY_MUTATION_DEADLINE_VARIABLE = "REGISTRY_MUTATION_DEADLINE_EPOCH";
export const CRATES_IO_TRUSTED_REVOKE_RESERVE_MS = REQUEST_TIMEOUT_MS;

function error(message) {
  return new Error(`crates-io-trusted-publishing: ${message}`);
}

async function boundedText(response, context) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (response.body?.getReader === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw error(`${context} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function strictJson(response, context) {
  const text = await boundedText(response, context);
  if (!response.ok) {
    throw error(`${context} returned HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw error(`${context} returned invalid JSON: ${cause.message}`);
  }
}

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw error(`${name} is required in the protected GitHub Actions publish job`);
  return value;
}

function safeSecret(value, context) {
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw error(`${context} returned an invalid secret`);
  }
  return value;
}

function requestSignal(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REQUEST_TIMEOUT_MS) {
    throw error(`timeoutMs must be an integer from 1 through ${REQUEST_TIMEOUT_MS}`);
  }
  return AbortSignal.timeout(timeoutMs);
}

function sharedDeadlineMilliseconds({ env = process.env, deadlineEpochMs } = {}) {
  if (deadlineEpochMs !== undefined) {
    if (!Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs < 1) {
      throw error("deadlineEpochMs must be a positive Unix timestamp in milliseconds");
    }
    return deadlineEpochMs;
  }
  const raw = env[REGISTRY_MUTATION_DEADLINE_VARIABLE]?.trim();
  if (!raw) return null;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw error(`${REGISTRY_MUTATION_DEADLINE_VARIABLE} must be a positive Unix timestamp`);
  }
  const deadline = Number(raw) * 1000;
  if (!Number.isSafeInteger(deadline)) throw error(`${REGISTRY_MUTATION_DEADLINE_VARIABLE} exceeds the safe timestamp range`);
  return deadline;
}

function deadlineClampedTimeout({
  deadlineEpochMs,
  nowImpl,
  timeoutMs,
  reservedAfterMs,
  context,
  deferrable = false,
}) {
  if (deadlineEpochMs === null) return timeoutMs;
  const now = nowImpl();
  const available = deadlineEpochMs - now - reservedAfterMs;
  if (available < 1) {
    const detail = `${context} refused because mandatory later token exchange/revocation time is no longer available before the registry mutation deadline`;
    if (deferrable) {
      throw new RegistryPublicationDeferredError({
        reason: "deadline",
        notBeforeEpochSeconds: Math.floor(now / 1000) + 1,
        context: detail,
      });
    }
    throw error(detail);
  }
  return Math.min(timeoutMs, available);
}

function maskSecret(secret, maskImpl) {
  // GitHub's workflow command registers the value before it can reach any
  // downstream publisher. Secrets containing controls are rejected above, so
  // one command cannot be smuggled into another.
  maskImpl(`::add-mask::${secret.replaceAll("%", "%25")}\n`);
}

export async function acquireCratesIoTrustedPublishingToken({
  env = process.env,
  fetchImpl = fetch,
  maskImpl = (command) => process.stdout.write(command),
  nowImpl = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
  deadlineEpochMs = undefined,
} = {}) {
  if (env.GITHUB_ACTIONS !== "true") {
    throw error("temporary trusted-publishing tokens may be acquired only inside GitHub Actions");
  }
  const requestUrl = requiredEnvironment(env, "ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = requiredEnvironment(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  let oidcUrl;
  try {
    oidcUrl = new URL(requestUrl);
  } catch {
    throw error("ACTIONS_ID_TOKEN_REQUEST_URL is not a valid URL");
  }
  if (oidcUrl.protocol !== "https:") {
    throw error("ACTIONS_ID_TOKEN_REQUEST_URL must use HTTPS");
  }
  oidcUrl.searchParams.set("audience", CRATES_IO_AUDIENCE);
  requestSignal(timeoutMs);
  const sharedDeadline = sharedDeadlineMilliseconds({ env, deadlineEpochMs });
  const acquisitionReserve = (2 * timeoutMs) + CRATES_IO_TRUSTED_REVOKE_RESERVE_MS;
  const admissionNow = nowImpl();
  if (sharedDeadline !== null && sharedDeadline - admissionNow < acquisitionReserve) {
    throw new RegistryPublicationDeferredError({
      reason: "deadline",
      notBeforeEpochSeconds: Math.floor(admissionNow / 1000) + 1,
      context: `temporary token acquisition requires ${acquisitionReserve}ms for two bounded exchanges plus mandatory revocation before the registry mutation deadline`,
    });
  }

  const oidcResponse = await fetchImpl(oidcUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: requestSignal(deadlineClampedTimeout({
      deadlineEpochMs: sharedDeadline,
      nowImpl,
      timeoutMs,
      reservedAfterMs: timeoutMs + CRATES_IO_TRUSTED_REVOKE_RESERVE_MS,
      context: "GitHub OIDC token request",
      deferrable: true,
    })),
  });
  const oidc = await strictJson(oidcResponse, "GitHub OIDC token request");
  const jwt = safeSecret(oidc?.value, "GitHub OIDC token request");

  const tokenResponse = await fetchImpl(CRATES_IO_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "oliphaunt-trusted-publisher/1; https://github.com/f0rr0/oliphaunt",
    },
    body: JSON.stringify({ jwt }),
    redirect: "error",
    signal: requestSignal(deadlineClampedTimeout({
      deadlineEpochMs: sharedDeadline,
      nowImpl,
      timeoutMs,
      reservedAfterMs: CRATES_IO_TRUSTED_REVOKE_RESERVE_MS,
      context: "crates.io trusted-publishing token request",
      deferrable: true,
    })),
  });
  const body = await strictJson(tokenResponse, "crates.io trusted-publishing token request");
  const token = safeSecret(body?.token, "crates.io trusted-publishing token request");
  maskSecret(token, maskImpl);
  const acquiredAt = nowImpl();
  const publicationDeadlineEpochMs = sharedDeadline === null
    ? acquiredAt + TOKEN_LIFETIME_MS
    : Math.min(acquiredAt + TOKEN_LIFETIME_MS, sharedDeadline - CRATES_IO_TRUSTED_REVOKE_RESERVE_MS);
  if (publicationDeadlineEpochMs <= acquiredAt) {
    const reserveError = error("temporary token was acquired without the mandatory revocation reserve intact");
    try {
      await revokeCratesIoTrustedPublishingToken(token, {
        env,
        fetchImpl,
        nowImpl,
        timeoutMs,
        deadlineEpochMs: sharedDeadline ?? undefined,
      });
    } catch (revokeError) {
      throw new AggregateError(
        [reserveError, revokeError],
        "temporary trusted-publishing token was acquired too late and could not be revoked",
      );
    }
    throw reserveError;
  }
  return { token, acquiredAt, expiresAt: acquiredAt + TOKEN_LIFETIME_MS, publicationDeadlineEpochMs };
}

export async function revokeCratesIoTrustedPublishingToken(token, {
  env = process.env,
  fetchImpl = fetch,
  nowImpl = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
  deadlineEpochMs = undefined,
} = {}) {
  const secret = safeSecret(token, "trusted-publishing revoke");
  requestSignal(timeoutMs);
  const sharedDeadline = sharedDeadlineMilliseconds({ env, deadlineEpochMs });
  const response = await fetchImpl(CRATES_IO_TOKEN_ENDPOINT, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${secret}`,
      "User-Agent": "oliphaunt-trusted-publisher/1; https://github.com/f0rr0/oliphaunt",
    },
    redirect: "error",
    signal: requestSignal(deadlineClampedTimeout({
      deadlineEpochMs: sharedDeadline,
      nowImpl,
      timeoutMs,
      reservedAfterMs: 0,
      context: "crates.io trusted-publishing token revoke",
    })),
  });
  // Consume a bounded body even on the expected empty success response so a
  // malicious intermediary cannot retain an unbounded stream.
  await boundedText(response, "crates.io trusted-publishing token revoke");
  if (!response.ok) {
    throw error(`crates.io trusted-publishing token revoke returned HTTP ${response.status}`);
  }
}

export async function withCratesIoTrustedPublishingToken(callback, options = {}) {
  if (typeof callback !== "function") throw error("callback is required");
  const session = await acquireCratesIoTrustedPublishingToken(options);
  let callbackError;
  try {
    return await callback(session);
  } catch (cause) {
    callbackError = cause;
    throw cause;
  } finally {
    try {
      await revokeCratesIoTrustedPublishingToken(session.token, options);
    } catch (revokeError) {
      if (callbackError !== undefined) {
        throw new AggregateError(
          [callbackError, revokeError],
          "crates.io publication failed and its temporary trusted-publishing token could not be revoked",
        );
      }
      throw revokeError;
    }
  }
}

// Stop using a 30-minute registry token after 20 minutes. The remaining ten
// minutes bound index visibility, integrity proof, and mandatory revocation
// even when the final upload consumed its full mutation deadline.
export const CRATES_IO_TRUSTED_TOKEN_MAX_BATCH_AGE_MS = 20 * 60 * 1000;
export const CRATES_IO_TRUSTED_TOKEN_DEFAULT_BATCH_SIZE = 20;
// This is a calibrated admission estimate for ordinary upload, visibility,
// integrity, and token-exchange latency, not a worst-case promise that all 12
// visibility probes complete in 30 seconds. The hard registry/job deadlines
// bound pathological latency, and an exact-lock rerun recovers any matching
// immutable versions that became public before interruption.
export const CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER = 30;
