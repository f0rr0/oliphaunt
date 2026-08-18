export const sourceOrigins = Object.freeze({
  sharedThirdParty: 'shared-third-party',
  nativeThirdParty: 'native-third-party',
  wasixThirdParty: 'wasix-third-party',
  wasixPostmasterThirdParty: 'wasix-postmaster-third-party',
  extension: 'extension',
});

export const defaultSourceScope = 'production-all';

const originsByScope = Object.freeze({
  'production-all': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.nativeThirdParty,
    sourceOrigins.wasixThirdParty,
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
    sourceOrigins.wasixThirdParty,
    sourceOrigins.extension,
  ]),
  'wasix-postmaster-runtime': Object.freeze([
    sourceOrigins.sharedThirdParty,
    sourceOrigins.wasixThirdParty,
    sourceOrigins.wasixPostmasterThirdParty,
  ]),
  extensions: Object.freeze([sourceOrigins.extension]),
});

export const sourceScopes = Object.freeze(Object.keys(originsByScope));

const domainEntries = Object.freeze([
  Object.freeze(['shared', sourceOrigins.sharedThirdParty]),
  Object.freeze(['native', sourceOrigins.nativeThirdParty]),
  Object.freeze(['wasix', sourceOrigins.wasixThirdParty]),
  Object.freeze(['wasix-postmaster', sourceOrigins.wasixPostmasterThirdParty]),
]);

export function sourceDomainsForScope(selectedScope) {
  const origins = new Set(originsByScope[selectedScope] ?? []);
  return domainEntries.filter(([, origin]) => origins.has(origin));
}

export function scopeIncludesWasix(selectedScope) {
  return scopeIncludes(selectedScope, sourceOrigins.wasixThirdParty);
}

export function scopeIncludesExtensions(selectedScope) {
  return scopeIncludes(selectedScope, sourceOrigins.extension);
}

export function scopeIncludes(selectedScope, origin) {
  return (originsByScope[selectedScope] ?? []).includes(origin);
}
