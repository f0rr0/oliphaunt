/** Node rejects --input-type when inherited by a file-backed worker thread. */
export function nodeWorkerExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (argument === undefined) break;
    if (argument === '--input-type') {
      index += 1;
    } else if (!argument.startsWith('--input-type=')) {
      filtered.push(argument);
    }
  }
  return filtered;
}
