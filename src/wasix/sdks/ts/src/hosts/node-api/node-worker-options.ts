/**
 * Keep runtime configuration flags while removing invocation modes which
 * replace a file-backed Worker program.
 */
export function nodeWorkerExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (argument === undefined) break;
    if (EXEC_MODE_WITH_VALUE.has(argument) || TEST_MODE_WITH_VALUE.has(argument)) {
      index += 1;
      continue;
    }
    if (
      EXEC_MODE_FLAGS.has(argument) ||
      argument.startsWith('--input-type=') ||
      argument.startsWith('--run=') ||
      argument.startsWith('--watch-kill-signal=') ||
      argument.startsWith('--watch-path=') ||
      argument.startsWith('--experimental-test-isolation=') ||
      argument === '--test' ||
      argument.startsWith('--test-')
    ) {
      continue;
    }
    filtered.push(argument);
  }
  return filtered;
}

const EXEC_MODE_WITH_VALUE = new Set([
  '--input-type',
  '--eval',
  '-e',
  '--print',
  '-p',
  '--run',
  '--watch-kill-signal',
  '--watch-path',
]);
const EXEC_MODE_FLAGS = new Set([
  '--check',
  '-c',
  '--interactive',
  '-i',
  '--watch',
  '--watch-preserve-output',
]);
const TEST_MODE_WITH_VALUE = new Set([
  '--experimental-test-isolation',
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-global-setup',
  '--test-isolation',
  '--test-name-pattern',
  '--test-random-seed',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-rerun-failures',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
]);
