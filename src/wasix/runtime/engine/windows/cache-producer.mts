import assert from 'node:assert/strict';

/** Stop the emulated helper only after it explicitly reports its result. */
export async function runCacheProducer(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  // Wine services can inherit stdout. A dead helper must not wait for their EOF.
  const exited = child.exited.finally(() => reader.cancel());
  const decoder = new TextDecoder();
  let log = '';
  let result: number | undefined;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs ?? 900_000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      log += decoder.decode(value, { stream: true });
      const completion = /(?:^|\n)producer_exit=(\d+)\n/.exec(log);
      if (completion === null) continue;
      result = Number(completion[1]);
      child.kill('SIGKILL');
      break;
    }
    await exited;
    assert(!timedOut, `cache producer timed out\n${log}`);
    assert(
      result !== undefined && child.signalCode === 'SIGKILL',
      `cache producer exited before supervised completion (${child.exitCode}, ${child.signalCode})\n${log}`,
    );
    assert.equal(result, 0, log);
    return log;
  } finally {
    clearTimeout(timeout);
    child.kill('SIGKILL');
    await exited;
  }
}
