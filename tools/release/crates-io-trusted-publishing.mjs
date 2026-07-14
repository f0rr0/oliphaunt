const CRATES_IO_TOKEN_ENDPOINT = "https://crates.io/api/v1/trusted_publishing/tokens";
const CRATES_IO_AUDIENCE = "crates.io";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TOKEN_LIFETIME_MS = 30 * 60 * 1000;

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

  const oidcResponse = await fetchImpl(oidcUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: requestSignal(timeoutMs),
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
    signal: requestSignal(timeoutMs),
  });
  const body = await strictJson(tokenResponse, "crates.io trusted-publishing token request");
  const token = safeSecret(body?.token, "crates.io trusted-publishing token request");
  maskSecret(token, maskImpl);
  const acquiredAt = nowImpl();
  return { token, acquiredAt, expiresAt: acquiredAt + TOKEN_LIFETIME_MS };
}

export async function revokeCratesIoTrustedPublishingToken(token, {
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const secret = safeSecret(token, "trusted-publishing revoke");
  const response = await fetchImpl(CRATES_IO_TOKEN_ENDPOINT, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${secret}`,
      "User-Agent": "oliphaunt-trusted-publisher/1; https://github.com/f0rr0/oliphaunt",
    },
    redirect: "error",
    signal: requestSignal(timeoutMs),
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
// Capacity is asserted before normal mutation, so this budget covers upload,
// index visibility, integrity proof, and token exchange rather than a planned
// Retry-After wait. The hard registry/job deadlines remain authoritative.
export const CRATES_IO_TRUSTED_PUBLISH_PLANNING_SECONDS_PER_CARRIER = 30;
