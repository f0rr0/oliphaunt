// Complete in-memory output: bounded by available memory and Buffer/string
// representability, not an application output quota.
export function createCapturedOutput() {
  return { stdout: [], stderr: [], failure: undefined };
}

export function captureOutput(captured, channel, chunk) {
  if (captured.failure !== undefined) return;
  try {
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
