export const sourceOrigins = Object.freeze({
  sharedThirdParty: 'shared-third-party',
  nativeThirdParty: 'native-third-party',
  wasixPostmasterThirdParty: 'wasix-postmaster-third-party',
  extension: 'extension',
});

export const defaultSourceScope = 'production-all';

const SOURCE_ORIGINS_BY_SCOPE = Object.freeze({
  'production-all': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.nativeThirdParty,
    sourceOrigins.wasixPostmasterThirdParty,
    sourceOrigins.extension,
  ]),
  all: Object.freeze(Object.values(sourceOrigins)),
  'native-runtime': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.nativeThirdParty,
    sourceOrigins.extension,
  ]),
  'wasix-runtime': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.extension,
  ]),
  'wasix-postmaster-runtime': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.wasixPostmasterThirdParty,
  ]),
  extensions: Object.freeze([sourceOrigins.extension]),
});

export const sourceScopes = Object.freeze(Object.keys(SOURCE_ORIGINS_BY_SCOPE));

const domainEntries = Object.freeze([
  Object.freeze(['shared', sourceOrigins.sharedThirdParty]),
  Object.freeze(['native', sourceOrigins.nativeThirdParty]),
  Object.freeze(['wasix-postmaster', sourceOrigins.wasixPostmasterThirdParty]),
]);

export function sourceDomainsForScope(selectedScope) {
  const origins = new Set(SOURCE_ORIGINS_BY_SCOPE[selectedScope] ?? []);
  return domainEntries.filter(([, origin]) => origins.has(origin));
}

export function scopeIncludesWasix(selectedScope) {
  return ['production-all', 'all', 'wasix-runtime', 'wasix-postmaster-runtime'].includes(selectedScope);
}

export function scopeIncludesExtensions(selectedScope) {
  return scopeIncludes(selectedScope, sourceOrigins.extension);
}

export function scopeIncludes(selectedScope, origin) {
  return (SOURCE_ORIGINS_BY_SCOPE[selectedScope] ?? []).includes(origin);
}
