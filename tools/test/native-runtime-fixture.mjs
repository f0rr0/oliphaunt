export function nativeRuntimeResourceManifestFixture({
  cacheKey = 'runtime-smoke',
  target = '',
  overrides = {},
  extra = {},
} = {}) {
  const fields = {
    schema: 'oliphaunt-runtime-resources-v1',
    layout: 'postgres-runtime-files-v1',
    artifactRole: 'runtime',
    catalogProfile: '',
    clusterSeedTarget: target,
    icuDataTreeSha256: '',
    mode: 'native-direct',
    cacheKey,
    selectedExtensions: '',
    extensions: '',
    runtimeFeatures: '',
    sharedPreloadLibraries: '',
    mobileStaticRegistryState: 'not-required',
    mobileStaticRegistryRegistered: '',
    mobileStaticRegistryPending: '',
    nativeModuleStems: '',
    mobileStaticRegistrySource: '',
    ...overrides,
    ...extra,
  };
  return Buffer.from(
    `${Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
}
