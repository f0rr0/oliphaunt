import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  defaultSourceScope,
  scopeIncludes,
  scopeIncludesExtensions,
  scopeIncludesWasix,
  sourceDomainsForScope,
  sourceOrigins,
  sourceScopes,
} from './source-fetch-scopes.mjs';

const productionDomains = [
  ['shared', sourceOrigins.sharedThirdParty],
  ['native', sourceOrigins.nativeThirdParty],
  ['wasix-postmaster', sourceOrigins.wasixPostmasterThirdParty],
];

test('production-all is the default release scope and includes every product pin', () => {
  assert.equal(defaultSourceScope, 'production-all');
  assert.equal(sourceScopes.includes(defaultSourceScope), true);
  assert.deepEqual(sourceDomainsForScope('production-all'), productionDomains);
  assert.equal(scopeIncludesWasix('production-all'), true);
  assert.equal(scopeIncludesExtensions('production-all'), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.nativeThirdParty), true);
  assert.equal(scopeIncludes('production-all', sourceOrigins.extension), true);
  assert.equal(
    scopeIncludes('production-all', sourceOrigins.wasixPostmasterThirdParty),
    true,
  );
});

test('all honestly spans every repository source domain', () => {
  assert.deepEqual(sourceDomainsForScope('all'), [
    ['shared', sourceOrigins.sharedThirdParty],
    ['native', sourceOrigins.nativeThirdParty],
    ['wasix-postmaster', sourceOrigins.wasixPostmasterThirdParty],
  ]);
  assert.equal(scopeIncludesWasix('all'), true);
  assert.equal(scopeIncludesExtensions('all'), true);
  assert.equal(scopeIncludes('all', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('all', sourceOrigins.nativeThirdParty), true);
  assert.equal(scopeIncludes('all', sourceOrigins.extension), true);
  assert.equal(scopeIncludes('all', sourceOrigins.wasixPostmasterThirdParty), true);
});

test('postmaster scope includes only its runtime dependencies and private pins', () => {
  assert.deepEqual(sourceDomainsForScope('wasix-postmaster-runtime'), [
    ['shared', sourceOrigins.sharedThirdParty],
    ['wasix-postmaster', sourceOrigins.wasixPostmasterThirdParty],
  ]);
  assert.equal(scopeIncludesWasix('wasix-postmaster-runtime'), true);
  assert.equal(scopeIncludesExtensions('wasix-postmaster-runtime'), false);
  assert.equal(
    scopeIncludes('wasix-postmaster-runtime', sourceOrigins.sharedThirdParty),
    true,
  );
  assert.equal(
    scopeIncludes('wasix-postmaster-runtime', sourceOrigins.wasixPostmasterThirdParty),
    true,
  );
  assert.equal(
    scopeIncludes('wasix-postmaster-runtime', sourceOrigins.nativeThirdParty),
    false,
  );
  assert.equal(scopeIncludes('wasix-postmaster-runtime', sourceOrigins.extension), false);
});

test('focused runtime scopes include the extension sources they package', () => {
  assert.deepEqual(sourceDomainsForScope('native-runtime'), productionDomains.slice(0, 2));
  assert.equal(scopeIncludesWasix('native-runtime'), false);
  assert.equal(scopeIncludesExtensions('native-runtime'), true);
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.nativeThirdParty), true);
  assert.equal(
    scopeIncludes('native-runtime', sourceOrigins.wasixPostmasterThirdParty),
    false,
  );
  assert.equal(scopeIncludes('native-runtime', sourceOrigins.extension), true);

  assert.deepEqual(sourceDomainsForScope('wasix-runtime'), [
    productionDomains[0],
  ]);
  assert.equal(scopeIncludesWasix('wasix-runtime'), true);
  assert.equal(scopeIncludesExtensions('wasix-runtime'), true);
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.sharedThirdParty), true);
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.nativeThirdParty), false);
  assert.equal(
    scopeIncludes('wasix-runtime', sourceOrigins.wasixPostmasterThirdParty),
    false,
  );
  assert.equal(scopeIncludes('wasix-runtime', sourceOrigins.extension), true);

  assert.deepEqual(sourceDomainsForScope('extensions'), []);
  assert.equal(scopeIncludesWasix('extensions'), false);
  assert.equal(scopeIncludesExtensions('extensions'), true);
  assert.equal(scopeIncludes('extensions', sourceOrigins.sharedThirdParty), false);
  assert.equal(scopeIncludes('extensions', sourceOrigins.extension), true);
});

test('unknown scopes include no sources', () => {
  assert.deepEqual(sourceDomainsForScope('unknown'), []);
  assert.equal(scopeIncludesWasix('unknown'), false);
  assert.equal(scopeIncludesExtensions('unknown'), false);
  for (const origin of Object.values(sourceOrigins)) {
    assert.equal(scopeIncludes('unknown', origin), false);
  }
});
