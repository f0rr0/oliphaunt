type CompatibilityEntry = { id: string; path: string; parser: string };
type ParserOptions<Missing> = {
  prefix?: string;
  missingValue?: Missing;
  fail?: (prefix: string, message: string) => never;
};

function parserFailure(prefix: string, message: string): never {
  throw new Error(`${prefix}: ${message}`);
}

function valueAtPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Parse already-read source bytes without filesystem, history, or graph access. */
export function compatibilityVersionFromText<Missing = never>(
  entry: CompatibilityEntry,
  text: string,
  {
    prefix = 'release-graph',
    missingValue = undefined,
    fail = parserFailure,
  }: ParserOptions<Missing> = {},
): string | Missing {
  if (entry.parser === 'raw') return text.trim();
  if (entry.parser.startsWith('rust-const:')) {
    const name = entry.parser.slice('rust-const:'.length);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      fail(prefix, `${entry.id} has an invalid Rust constant parser`);
    }
    const matches = [
      ...text.matchAll(
        new RegExp(`(?:pub\\s+)?const\\s+${name}\\s*:[^=]+?=\\s*"([^"]+)"\\s*;`, 'gu'),
      ),
    ];
    if (matches.length !== 1) {
      if (matches.length === 0 && missingValue !== undefined) return missingValue;
      fail(prefix, `${entry.id} must name exactly one Rust string constant`);
    }
    return matches[0][1];
  }
  const separator = entry.parser.indexOf(':');
  const type = entry.parser.slice(0, separator);
  if (type !== 'json' && type !== 'toml') {
    fail(prefix, `${entry.id} uses unsupported compatibility parser ${entry.parser}`);
  }
  const parts = entry.parser.slice(separator + 1).split('.');
  let data: unknown;
  try {
    data = type === 'json' ? JSON.parse(text) : type === 'toml' ? Bun.TOML.parse(text) : null;
  } catch (cause) {
    fail(prefix, `${entry.path} is not valid ${type.toUpperCase()}: ${(cause as Error).message}`);
  }
  const value = valueAtPath(data, parts);
  if (typeof value !== 'string' || value.length === 0) {
    if (value === undefined && missingValue !== undefined) return missingValue;
    fail(prefix, `${entry.id} parser ${entry.parser} must resolve to a non-empty string`);
  }
  // Cargo's exact requirement spells the same installed version with `=`.
  // Keep every other requirement intact so the caller's stable-version check
  // still rejects ranges; package rendering retains the authored Cargo text.
  if (
    type === 'toml' &&
    parts.length === 3 &&
    ['dependencies', 'build-dependencies', 'dev-dependencies'].includes(parts[0]) &&
    parts[2] === 'version'
  ) {
    const exact = value.match(
      /^=\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u,
    );
    if (exact) return exact[1];
  }
  return value;
}
