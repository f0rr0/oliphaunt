export const sourceOrigins = Object.freeze({
  sharedThirdParty: 'shared-third-party',
  nativeThirdParty: 'native-third-party',
  wasixPostmasterThirdParty: 'wasix-postmaster-third-party',
  extension: 'extension',
});

export const defaultSourceScope = 'production-all';

const SOURCE_ORIGINS_BY_SCOPE = Object.freeze({
  icu: Object.freeze([sourceOrigins.sharedThirdParty]),
  'production-all': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.nativeThirdParty,
    sourceOrigins.wasixPostmasterThirdParty,
    sourceOrigins.extension,
  ]),
  all: Object.freeze(Object.values(sourceOrigins)),
  'native-runtime': Object.freeze([sourceOrigins.sharedThirdParty, sourceOrigins.nativeThirdParty]),
  'wasix-runtime': Object.freeze([sourceOrigins.sharedThirdParty, sourceOrigins.extension]),
  'wasix-postmaster-runtime': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.wasixPostmasterThirdParty,
  ]),
  extensions: Object.freeze([sourceOrigins.extension]),
});

export const sourceScopes = Object.freeze(Object.keys(SOURCE_ORIGINS_BY_SCOPE));

const domainEntries = Object.freeze([
  Object.freeze(['src/third-party/icu', sourceOrigins.sharedThirdParty]),
  Object.freeze(['src/third-party/openssl', sourceOrigins.sharedThirdParty]),
  Object.freeze(['src/runtimes/liboliphaunt-native/sources', sourceOrigins.nativeThirdParty]),
  Object.freeze([
    'src/runtimes/liboliphaunt-wasix-postmaster/sources',
    sourceOrigins.wasixPostmasterThirdParty,
  ]),
]);

export function sourceDomainsForScope(selectedScope, platform = process.platform) {
  const origins = new Set(SOURCE_ORIGINS_BY_SCOPE[selectedScope] ?? []);
  return domainEntries.filter(
    ([, origin]) =>
      origins.has(origin) &&
      !(
        selectedScope === 'native-runtime' &&
        origin === sourceOrigins.nativeThirdParty &&
        platform !== 'win32'
      ),
  );
}

export function scopeIncludesExtensions(selectedScope) {
  return scopeIncludes(selectedScope, sourceOrigins.extension);
}

export function scopeIncludes(selectedScope, origin) {
  return (SOURCE_ORIGINS_BY_SCOPE[selectedScope] ?? []).includes(origin);
}
