const SHA256 = /^[0-9a-f]{64}$/u;
const LICENSE_FILE_MODE = '0644';
const LICENSE_FILE_FIELDS = ['mode', 'path', 'sha256'] as const;

export type NpmExtensionLicenseFileContract = {
  path: string;
  sha256: string;
  mode: typeof LICENSE_FILE_MODE;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

export function isPortableNpmExtensionLicensePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return false;
  }
  const parts = value.split('/');
  return (
    value.startsWith('share/licenses/') &&
    value === value.normalize('NFC') &&
    decoded === value &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/u.test(value) &&
    !containsControlCharacter(value) &&
    new TextEncoder().encode(value).byteLength <= 4096 &&
    parts.length >= 3 &&
    parts.every(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        new TextEncoder().encode(part).byteLength <= 255 &&
        !/[<>:"|?*]/u.test(part) &&
        !/[ .]$/u.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  );
}

export function parseNpmExtensionLicenseFiles(
  value: unknown,
  label: string,
): NpmExtensionLicenseFileContract[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const rows = value.map((raw, index): NpmExtensionLicenseFileContract => {
    const rowLabel = `${label}[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${rowLabel} must be a JSON object`);
    }
    const row = raw as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(row).sort(compareText)) !== JSON.stringify(LICENSE_FILE_FIELDS)
    ) {
      throw new Error(`${rowLabel} fields must be exactly ${LICENSE_FILE_FIELDS.join(', ')}`);
    }
    if (!isPortableNpmExtensionLicensePath(row.path)) {
      throw new Error(`${rowLabel}.path must be a portable path under share/licenses/`);
    }
    if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) {
      throw new Error(`${rowLabel}.sha256 must be a lowercase SHA-256 digest`);
    }
    if (row.mode !== LICENSE_FILE_MODE) {
      throw new Error(`${rowLabel}.mode must be ${LICENSE_FILE_MODE}`);
    }
    return {
      path: row.path,
      sha256: row.sha256,
      mode: LICENSE_FILE_MODE,
    };
  });
  const paths = rows.map(({ path }) => path);
  const canonicalPaths = [...new Set(paths)].sort(compareText);
  if (JSON.stringify(paths) !== JSON.stringify(canonicalPaths)) {
    throw new Error(`${label} must be sorted by path with unique paths`);
  }
  const portable = new Map<string, string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    const prior = portable.get(key);
    if (prior !== undefined && prior !== path) {
      throw new Error(`${label} contains case/NFC-colliding paths ${prior} and ${path}`);
    }
    portable.set(key, path);
  }
  return rows;
}
