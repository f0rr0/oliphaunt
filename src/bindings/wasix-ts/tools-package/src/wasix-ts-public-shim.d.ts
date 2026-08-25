/** Typecheck-only package-boundary shim. Published declarations import the real SDK type. */
export interface OliphauntDatabase {
  readonly transaction: unknown;
  close(): Promise<void>;
}
