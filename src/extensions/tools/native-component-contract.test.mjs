import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadNativeComponentContract,
  resolveNativeComponentClosure,
  validateNativeComponentContract,
} from './native-component-contract.mjs';

const contract = loadNativeComponentContract();

function resolve(extension, family, kind, target) {
  return resolveNativeComponentClosure(contract, { extension, family, kind, target });
}

test('PROJ brings SQLite and its runtime database into every PostGIS closure', () => {
  const ios = resolve('postgis', 'native', 'native-static-registry', 'ios-xcframework');
  assert.deepEqual(ios.components, ['geos', 'sqlite', 'proj', 'libxml2', 'json-c']);
  assert.deepEqual(ios.runtimeFiles, ['proj/proj.db']);
  assert.deepEqual(ios.linkUnits, ['geos-c', 'geos', 'proj', 'sqlite', 'libxml2', 'json-c']);
});

test('PostGIS target differences are explicit', () => {
  const ios = resolve('postgis', 'native', 'native-static-registry', 'ios-xcframework');
  const android = resolve('postgis', 'native', 'native-static-registry', 'android-arm64-v8a');
  const wasix = resolve('postgis', 'wasix', 'wasix-runtime', 'wasix-portable');
  assert.equal(ios.components.includes('libiconv'), false);
  assert.deepEqual(android.components.slice(-1), ['libiconv']);
  assert.deepEqual(wasix.components, android.components);
  assert.deepEqual(android.linkUnits.slice(-2), ['libiconv', 'libcharset']);
});

test('contrib native dependencies share the same cross-platform contract', () => {
  assert.deepEqual(
    resolve('pgcrypto', 'native', 'native-static-registry', 'android-x86_64').components,
    ['openssl'],
  );
  assert.deepEqual(
    resolve('uuid-ossp', 'wasix', 'wasix-runtime', 'wasix-portable').linkUnits,
    ['uuid'],
  );
});

test('extensions without native components resolve to an empty closure', () => {
  assert.deepEqual(
    resolve('pgtap', 'wasix', 'wasix-runtime', 'wasix-portable').components,
    [],
  );
});

test('queries must use a real target with its declared family and kind', () => {
  assert.throws(
    () => resolve('pgtapp', 'wasix', 'wasix-runtime', 'wasix-portable'),
    /query uses unknown catalog extension/u,
  );
  assert.throws(
    () => resolve('postgis', 'native', 'native-dynamic', 'linux-x65-gnu'),
    /query uses unknown target/u,
  );
  assert.throws(
    () => resolve('postgis', 'wasix', 'wasix-runtime', 'linux-x64-gnu'),
    /conflicts with target profile/u,
  );
});

function fixture(overrides = {}) {
  return {
    schema: 'oliphaunt-native-components-v1',
    components: [
      {
        id: 'alpha',
        source: 'alpha',
        'depends-on': [],
        'runtime-files': [],
        'link-units': [{ id: 'alpha', 'archive-candidates': ['alpha/lib/libalpha.a'] }],
      },
    ],
    requirements: [
      {
        extension: 'demo',
        family: 'native',
        kind: 'native-dynamic',
        targets: ['demo-target'],
        roots: ['alpha'],
      },
    ],
    ...overrides,
  };
}

const fixtureOptions = {
  checkSourcePaths: false,
  knownExtensions: new Set(['demo']),
  targetProfiles: new Map([['demo-target', 'native\0native-dynamic']]),
};

test('cycles fail closed', () => {
  const raw = fixture();
  raw.components.push({
    id: 'beta',
    source: 'beta',
    'depends-on': ['alpha'],
    'runtime-files': [],
    'link-units': [{ id: 'beta', 'archive-candidates': ['beta/lib/libbeta.a'] }],
  });
  raw.components[0]['depends-on'] = ['beta'];
  assert.throws(
    () => validateNativeComponentContract(raw, fixtureOptions),
    /component dependency cycle/u,
  );
});

test('overlapping target requirements fail closed', () => {
  const raw = fixture();
  raw.requirements.push({ ...raw.requirements[0] });
  assert.throws(
    () => validateNativeComponentContract(raw, fixtureOptions),
    /duplicate requirement/u,
  );
});

test('typos in schema fields fail closed', () => {
  const raw = fixture();
  raw.components[0].dependz = [];
  assert.throws(
    () => validateNativeComponentContract(raw, fixtureOptions),
    /unknown fields: dependz/u,
  );
});

test('archive candidates have one canonical link-unit owner', () => {
  const raw = fixture();
  raw.components.push({
    id: 'beta',
    source: 'beta',
    'depends-on': [],
    'runtime-files': [],
    'link-units': [{ id: 'beta', 'archive-candidates': ['alpha/lib/libalpha.a'] }],
  });
  assert.throws(
    () => validateNativeComponentContract(raw, fixtureOptions),
    /archive candidate .* is owned by both/u,
  );
});
