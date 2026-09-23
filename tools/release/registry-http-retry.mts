const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export const CRATES_IO_READ_START_INTERVAL_MILLISECONDS = 250;

function readGateError(message) {
  return new Error(`registry-http-retry: ${message}`);
}

export function createCratesIoReadGate({
  nowImpl = () => Date.now() / 1000,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  intervalMilliseconds = CRATES_IO_READ_START_INTERVAL_MILLISECONDS,
  deadlineReserveMilliseconds = 5_000,
} = {}) {
  if (!Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1) {
    throw readGateError(
      'crates.io read-start interval must be a positive integer number of milliseconds',
    );
  }
  if (!Number.isSafeInteger(deadlineReserveMilliseconds) || deadlineReserveMilliseconds < 0) {
    throw readGateError(
      'crates.io read deadline reserve must be a non-negative integer number of milliseconds',
    );
  }
  let nextStartMilliseconds = 0;
  let notBeforeMilliseconds = 0;
  let observedMilliseconds = 0;
  let queue = Promise.resolve();

  return {
    defer(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw readGateError(
          'crates.io shared read deferral must be a non-negative number of seconds',
        );
      }
      notBeforeMilliseconds = Math.max(
        notBeforeMilliseconds,
        Math.max(nowImpl() * 1000, observedMilliseconds) + Math.ceil(seconds * 1000),
      );
    },

    async beforeRequest(label, deadlineEpochSeconds = null) {
      if (
        deadlineEpochSeconds !== null &&
        (!Number.isFinite(deadlineEpochSeconds) || deadlineEpochSeconds <= 0)
      ) {
        throw readGateError('crates.io read deadline must be a positive Unix timestamp or null');
      }
      let release;
      const predecessor = queue;
      queue = new Promise((resolve) => {
        release = resolve;
      });
      await predecessor;
      try {
        for (;;) {
          const nowMilliseconds = Math.max(nowImpl() * 1000, observedMilliseconds);
          const admittedStartMilliseconds = Math.max(nextStartMilliseconds, notBeforeMilliseconds);
          const delayMilliseconds = Math.max(
            0,
            Math.ceil(admittedStartMilliseconds - nowMilliseconds),
          );
          const remainingMilliseconds =
            deadlineEpochSeconds === null
              ? Number.POSITIVE_INFINITY
              : deadlineEpochSeconds * 1000 - nowMilliseconds - deadlineReserveMilliseconds;
          if (delayMilliseconds >= remainingMilliseconds) {
            throw readGateError(
              `read-only existence check for ${label} cannot start before the registry mutation deadline`,
            );
          }
          if (delayMilliseconds === 0) {
            observedMilliseconds = nowMilliseconds;
            nextStartMilliseconds = nowMilliseconds + intervalMilliseconds;
            return nowMilliseconds / 1000;
          }
          await sleepImpl(delayMilliseconds);
          observedMilliseconds = nowMilliseconds + delayMilliseconds;
        }
      } finally {
        release();
      }
    },
  };
}

export function registryStatusRetryable(status) {
  return RETRYABLE_STATUSES.has(status);
}

export function retryAfterSeconds(headers, now = Date.now()) {
  const value = headers?.get?.('retry-after')?.trim();
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
  const exponential = Math.min(60, Math.max(0, baseSeconds) * 2 ** attempt);
  return exponential * (0.75 + random() * 0.5);
}
