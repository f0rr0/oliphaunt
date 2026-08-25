export type NativeCatalogProfile = 'standard' | 'icu';

const SHA256 = /^[0-9a-f]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const DISALLOWED_CACHE_KEYS = new Set(['.', '..']);

function isPortableCacheKey(value: string): boolean {
  return PORTABLE_ID.test(value) && !DISALLOWED_CACHE_KEYS.has(value);
}
const CLUSTER_SEED_FIELDS = [
  'schema',
  'layout',
  'artifactRole',
  'catalogProfile',
  'target',
  'postgresMajor',
  'physicalFormat',
  'compatibilityKey',
  'initialSuperuser',
  'icuDataVersion',
  'icuDataForm',
  'icuDataTreeSha256',
  'runtimeFeatures',
  'cacheKey',
] as const;
const ICU_DATA_FIELDS = [
  'schema',
  'artifactRole',
  'icuDataVersion',
  'icuDataForm',
  'icuDataTreeSha256',
] as const;
const RUNTIME_CARRIER_FIELDS = [
  'schema',
  'clusterSeedTarget',
  'clusterSeedRelativePath',
  'icuClusterSeedRelativePath',
] as const;

function parseProperties(manifest: string, source: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of manifest.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`${source} manifest contains a malformed property`);
    }
    const key = line.slice(0, separator);
    if (fields.has(key)) {
      throw new Error(`${source} manifest repeats property ${key}`);
    }
    fields.set(key, line.slice(separator + 1));
  }
  return fields;
}

function requireExactFields(
  fields: ReadonlyMap<string, string>,
  expected: ReadonlyArray<string>,
  source: string,
): void {
  if (fields.size !== expected.length || expected.some((key) => !fields.has(key))) {
    throw new Error(`${source} manifest fields must be exactly ${expected.join(',')}`);
  }
}

export function requireNativeClusterSeedTarget(
  value: string | undefined,
  expected: string,
  source: string,
): string {
  if (value !== expected) {
    throw new Error(`${source} clusterSeedTarget must be ${expected}`);
  }
  return value;
}

export function requireNativeClusterSeedPath(
  value: string | undefined,
  expected: 'cluster-seed' | 'cluster-seed-icu',
  source: string,
): string {
  if (value !== expected) {
    throw new Error(`${source} must be ${expected}`);
  }
  return value;
}

export function requireIcuDataTreeSha256(value: string | undefined, source: string): string {
  if (value === undefined || !SHA256.test(value)) {
    throw new Error(`${source} does not declare canonical ICU data identity`);
  }
  return value;
}

export function requireIcuManifestRelativePath(
  dataRelativePath: string | undefined,
  manifestRelativePath: string | undefined,
  source: string,
): string {
  const data = dataRelativePath ?? 'share/icu';
  const suffix = 'share/icu';
  if (data !== suffix && !data.endsWith(`/${suffix}`)) {
    throw new Error(`${source} dataRelativePath must end in ${suffix}`);
  }
  const expected = `${data.slice(0, -suffix.length)}manifest.properties`;
  if (manifestRelativePath !== expected) {
    throw new Error(`${source} manifestRelativePath must be ${expected}`);
  }
  return manifestRelativePath;
}

export function validateNativeClusterSeedManifest(
  manifest: string,
  profile: NativeCatalogProfile,
  target: string,
  source: string,
): string | undefined {
  const fields = parseProperties(manifest, source);
  requireExactFields(fields, CLUSTER_SEED_FIELDS, source);
  const expectedFeatures = profile === 'icu' ? 'icu' : '';
  if (
    fields.get('schema') !== 'oliphaunt-runtime-resources-v1' ||
    fields.get('layout') !== 'oliphaunt-cluster-seed-v1' ||
    fields.get('artifactRole') !== `cluster-seed-${profile}` ||
    fields.get('catalogProfile') !== profile ||
    fields.get('target') !== target ||
    fields.get('postgresMajor') !== '18' ||
    fields.get('physicalFormat') !== 'native-pg18-v1' ||
    fields.get('compatibilityKey') !== `native-pg18-${target}-v1` ||
    fields.get('initialSuperuser') !== 'postgres' ||
    fields.get('runtimeFeatures') !== expectedFeatures ||
    !isPortableCacheKey(fields.get('cacheKey') ?? '')
  ) {
    throw new Error(`${source} manifest does not declare the ${profile} cluster seed contract`);
  }
  if (profile === 'icu') {
    if (
      fields.get('icuDataVersion') !== '76.1' ||
      fields.get('icuDataForm') !== 'files-le' ||
      !SHA256.test(fields.get('icuDataTreeSha256') ?? '')
    ) {
      throw new Error(`${source} manifest does not bind the canonical ICU data tree`);
    }
  } else if (
    fields.get('icuDataVersion') !== '' ||
    fields.get('icuDataForm') !== '' ||
    fields.get('icuDataTreeSha256') !== ''
  ) {
    throw new Error(`${source} standard manifest must not select ICU data`);
  }
  return fields.get('icuDataTreeSha256') || undefined;
}

export function validateNativeIcuDataReceipt(manifest: string, source: string): string {
  const fields = parseProperties(manifest, source);
  requireExactFields(fields, ICU_DATA_FIELDS, source);
  if (
    fields.get('schema') !== 'oliphaunt-icu-data-v1' ||
    fields.get('artifactRole') !== 'icu-data' ||
    fields.get('icuDataVersion') !== '76.1' ||
    fields.get('icuDataForm') !== 'files-le'
  ) {
    throw new Error(`${source} manifest does not declare canonical ICU data`);
  }
  return requireIcuDataTreeSha256(fields.get('icuDataTreeSha256'), source);
}

export function validateNativeRuntimeCarrierReceipt(
  manifest: string,
  target: string,
  source: string,
): void {
  const fields = parseProperties(manifest, source);
  requireExactFields(fields, RUNTIME_CARRIER_FIELDS, source);
  if (
    fields.get('schema') !== 'oliphaunt-native-runtime-carrier-v1' ||
    fields.get('clusterSeedTarget') !== target ||
    fields.get('clusterSeedRelativePath') !== 'cluster-seed' ||
    fields.get('icuClusterSeedRelativePath') !== 'cluster-seed-icu'
  ) {
    throw new Error(`${source} manifest does not declare the ${target} runtime carrier`);
  }
}
