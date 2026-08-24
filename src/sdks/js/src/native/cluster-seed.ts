export type NativeCatalogProfile = 'standard' | 'icu';

const SHA256 = /^[0-9a-f]{64}$/u;

export function validateNativeClusterSeedManifest(
  manifest: string,
  profile: NativeCatalogProfile,
  source: string,
): void {
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
  const expectedFeatures = profile === 'icu' ? 'icu' : '';
  if (
    fields.get('schema') !== 'oliphaunt-runtime-resources-v1' ||
    fields.get('layout') !== 'oliphaunt-cluster-seed-v1' ||
    fields.get('artifactRole') !== `cluster-seed-${profile}` ||
    fields.get('catalogProfile') !== profile ||
    fields.get('postgresMajor') !== '18' ||
    fields.get('physicalFormat') !== 'native-pg18-v1' ||
    fields.get('compatibilityKey') !== 'native-pg18-datum64-v1' ||
    fields.get('initialSuperuser') !== 'postgres' ||
    fields.get('runtimeFeatures') !== expectedFeatures
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
}
