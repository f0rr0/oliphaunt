export const toolRuntimeCalls: Array<Readonly<{ args: readonly string[] }>> = [];
export const toolRuntimeResponses: Array<
  Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>
> = [];

export function getWasixDatabaseIdentity(): Readonly<{ username: string; database: string }> {
  return { username: '-application user', database: '-application database' };
}

export async function runWasixToolProcess(
  _database: unknown,
  options: Readonly<{ args: readonly string[] }>,
): Promise<Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>> {
  toolRuntimeCalls.push(options);
  const response = toolRuntimeResponses.shift();
  if (response !== undefined) return response;
  throw new Error('unexpected WASIX tool runtime call in validation test');
}
