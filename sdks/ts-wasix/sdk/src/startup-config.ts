const STORAGE_OWNED_GUCS = new Set(['config_file', 'data_directory']);

/** @internal Canonicalize PostgreSQL's case-insensitive startup-GUC namespace. */
export function normalizeWasixStartupGUCs(
  gucs: Readonly<Record<string, string>>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [providedName, value] of Object.entries(gucs)) {
    const name = providedName.trim().toLowerCase();
    if (!/^[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)*$/u.test(name)) {
      throw new Error(
        `PostgreSQL startup GUC name ${JSON.stringify(providedName)} must use dot-separated components that start with an ASCII letter or '_' and continue with ASCII letters, digits, '_', or '$'`,
      );
    }
    if (value.includes('\0')) {
      throw new Error(`PostgreSQL startup GUC ${JSON.stringify(name)} contains a NUL byte`);
    }
    if (STORAGE_OWNED_GUCS.has(name)) {
      throw new Error(
        `@oliphaunt/wasix-ts owns PostgreSQL startup GUC ${JSON.stringify(name)}; configure the database through Oliphaunt's storage API`,
      );
    }
    normalized[name] = value;
  }
  return normalized;
}
