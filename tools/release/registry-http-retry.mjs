const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function registryStatusRetryable(status) {
  return RETRYABLE_STATUSES.has(status);
}

export function retryAfterSeconds(headers, now = Date.now()) {
  const value = headers?.get?.("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    return Math.max(0, Number(value));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - now) / 1000) : null;
}

export function registryRetryDelaySeconds({
  headers = undefined,
  attempt,
  baseSeconds = 1,
  random = Math.random,
  now = Date.now(),
}) {
  const requested = retryAfterSeconds(headers, now);
  if (requested !== null) {
    return Math.min(300, requested);
  }
  const exponential = Math.min(60, Math.max(0, baseSeconds) * (2 ** attempt));
  return exponential * (0.75 + random() * 0.5);
}
