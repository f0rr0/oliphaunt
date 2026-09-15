export const toolRuntimeCalls: Array<
  Readonly<{ args: readonly string[]; command?: string; stdin?: Uint8Array }>
> = [];
export const toolRuntimeResponses: Array<
  Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>
> = [];

export async function runWasixToolProcess(
  _database: unknown,
  options: Readonly<{ args: readonly string[]; command?: string; stdin?: Uint8Array }>,
): Promise<Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>> {
  toolRuntimeCalls.push(options);
  const response = toolRuntimeResponses.shift();
  if (response !== undefined) return response;
  throw new Error('unexpected WASIX tool runtime call in validation test');
}
