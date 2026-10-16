// Complete in-memory output: bounded by available memory and Buffer/string
// representability, not an application output quota.
export function createCapturedOutput(boundedDiagnostics = false) {
  return { stdout: [], stderr: [], failure: undefined, boundedDiagnostics, stderrTruncated: false };
}

export function captureOutput(captured, channel, chunk) {
  if (captured.failure !== undefined) return;
  try {
    if (channel === 'stderr' && captured.boundedDiagnostics) {
      const previous = captured.stderr[0] ?? Buffer.alloc(0);
      const excess = Math.max(0, previous.length + chunk.length - 8192);
      captured.stderrTruncated ||= excess > 0;
      captured.stderr = [
        chunk.length >= 8192
          ? Buffer.from(chunk.subarray(chunk.length - 8192))
          : Buffer.concat([previous.subarray(excess), chunk]),
      ];
      return;
    }
    captured[channel].push(chunk);
  } catch (cause) {
    discardCapture(captured, cause);
  }
}

export function finishCapture(captured) {
  if (captured.failure !== undefined) throw captured.failure;
  try {
    const stdout = concatenate(captured.stdout);
    const stderr = concatenate(captured.stderr);
    captured.stdout = [];
    captured.stderr = [];
    return { stdout, stderr };
  } catch (cause) {
    discardCapture(captured, cause);
    throw cause;
  }
}

function discardCapture(captured, cause) {
  // Keep draining both child pipes, but never return a partial dump.
  captured.failure = cause;
  captured.stdout = [];
  captured.stderr = [];
}

function concatenate(chunks) {
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}
