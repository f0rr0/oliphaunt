import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  defaultSourceScope,
  scopeIncludes,
  scopeIncludesExtensions,
  sourceDomainsForScope,
  sourceOrigins,
  sourceScopes,
} from './source-fetch-scopes.mts';

const productionDomains = [
  ['src/third-party/icu', sourceOrigins.sharedThirdParty],
  ['src/third-party/openssl', sourceOrigins.sharedThirdParty],
  ['src/native/runtime/sources', sourceOrigins.nativeThirdParty],
  ['src/wasix/postmaster/sources', sourceOrigins.wasixPostmasterThirdParty],
];

test('production-all is the default release scope and includes every product pin', () => {
  assert.equal(defaultSourceScope, 'production-all');
  assert.equal(sourceScopes.includes(defaultSourceScope), true);
  assert.deepEqual(sourceDomainsForScope('production-all'), productionDomains);
  assert.equal(scopeIncludesExtensions('production-all'), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.nativeThirdParty), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.extension), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.wasixPostmasterThirdParty), true);
});

test('all honestly spans every repository source domain', () => {
  assert.deepEqual(sourceDomainsForScope('all'), [
    ['src/third-party/icu', sourceOrigins.sharedThirdParty],
    ['src/third-party/openssl', sourceOrigins.sharedThirdParty],
    ['src/native/runtime/sources', sourceOrigins.nativeThirdParty],
    ['src/wasix/postmaster/sources', sourceOrigins.wasixPostmasterThirdParty],
  ]);
  assert.equal(scopeIncludesExtensions('all'), true);
  assert.equal(scopeIncludes('all', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('all', sourceOrigins.nativeThirdParty), true);
  assert.equal(scopeIncludes('all', sourceOrigins.extension), true);
  assert.equal(scopeIncludes('all', sourceOrigins.wasixPostmasterThirdParty), true);
});

test('postmaster scope includes only its runtime dependencies and private pins', () => {
  assert.deepEqual(sourceDomainsForScope('wasix-postmaster-runtime'), [
    ['src/third-party/icu', sourceOrigins.sharedThirdParty],
    ['src/third-party/openssl', sourceOrigins.sharedThirdParty],
    ['src/wasix/postmaster/sources', sourceOrigins.wasixPostmasterThirdParty],
  ]);
  assert.equal(scopeIncludesExtensions('wasix-postmaster-runtime'), false);
  assert.equal(scopeIncludes('wasix-postmaster-runtime', sourceOrigins.sharedThirdParty), true);
  assert.equal(
    scopeIncludes('wasix-postmaster-runtime', sourceOrigins.wasixPostmasterThirdParty),
    true,
  );
  assert.equal(scopeIncludes('wasix-postmaster-runtime', sourceOrigins.nativeThirdParty), false);
  assert.equal(scopeIncludes('wasix-postmaster-runtime', sourceOrigins.extension), false);
});

test('native runtime fetches only runtime dependencies for its host platform', () => {
  assert.deepEqual(sourceDomainsForScope('native-runtime', 'win32'), productionDomains.slice(0, 3));
  for (const platform of ['linux', 'darwin'])
    assert.deepEqual(
      sourceDomainsForScope('native-runtime', platform),
      productionDomains.slice(0, 2),
    );
  assert.equal(scopeIncludesExtensions('native-runtime'), false);
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.nativeThirdParty), true);
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.wasixPostmasterThirdParty), false);
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.extension), false);
});

test('WASIX and extension scopes retain the external sources they compile', () => {
  assert.deepEqual(sourceDomainsForScope('wasix-runtime'), productionDomains.slice(0, 2));
  assert.equal(scopeIncludesExtensions('wasix-runtime'), true);
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.nativeThirdParty), false);
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.wasixPostmasterThirdParty), false);
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.extension), true);

  assert.deepEqual(sourceDomainsForScope('extensions'), []);
  assert.equal(scopeIncludesExtensions('extensions'), true);
  assert.equal(scopeIncludes('extensions', sourceOrigins.sharedThirdParty), false);
  assert.equal(scopeIncludes('extensions', sourceOrigins.extension), true);
});

test('unknown scopes include no sources', () => {
  assert.deepEqual(sourceDomainsForScope('unknown'), []);
  assert.equal(scopeIncludesExtensions('unknown'), false);
  for (const origin of Object.values(sourceOrigins)) {
    assert.equal(scopeIncludes('unknown', origin), false);
  }
});
