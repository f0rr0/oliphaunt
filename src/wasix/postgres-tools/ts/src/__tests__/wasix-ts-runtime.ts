export const toolRuntimeCalls: Array<
  Readonly<{
    args: readonly string[];
    command?: string;
    script?: string;
    outputFile?: string;
    output?: {
      stdout(chunk: Uint8Array): Promise<void>;
      stderr?(chunk: Uint8Array): Promise<void>;
    };
  }>
> = [];
export const toolRuntimeResponses: Array<
  Readonly<{
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    stdoutBytes?: number;
    stderrTruncated?: boolean;
  }>
> = [];

export const toolRuntimeFailures: unknown[] = [];
export const toolRuntimeExecutions: Array<
  (
    options: ReturnType<Parameters<typeof runWasixToolProcess>[1]>,
  ) => ReturnType<typeof runWasixToolProcess>
> = [];

export async function runWasixToolProcess(
  _database: unknown,
  prepare: () => Readonly<{
    args: readonly string[];
    command?: string;
    script?: string;
    outputFile?: string;
    output?: {
      stdout(chunk: Uint8Array): Promise<void>;
      stderr?(chunk: Uint8Array): Promise<void>;
    };
  }>,
): Promise<
  Readonly<{
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    stdoutBytes?: number;
    stderrTruncated?: boolean;
  }>
> {
  const options = prepare();
  toolRuntimeCalls.push(options);
  const execute = toolRuntimeExecutions.shift();
  if (execute !== undefined) return execute(options);
  if (toolRuntimeFailures.length !== 0) throw toolRuntimeFailures.shift();
  const response = toolRuntimeResponses.shift();
  if (response !== undefined) return response;
  throw new Error('unexpected WASIX tool runtime call in validation test');
}
