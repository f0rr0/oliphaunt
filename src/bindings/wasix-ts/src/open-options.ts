import type { ExecutionMode, OpenConfig } from './types.js';

export function resolveExecutionMode(config: OpenConfig): ExecutionMode {
  const execution = config.execution ?? 'worker';
  if (execution !== 'direct' && execution !== 'worker') {
    throw new TypeError(
      `@oliphaunt/wasix-ts execution must be "direct" or "worker", received ${JSON.stringify(execution)}`,
    );
  }
  return execution;
}
