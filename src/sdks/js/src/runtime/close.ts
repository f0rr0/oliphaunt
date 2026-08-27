export function throwCollectedCloseFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}
