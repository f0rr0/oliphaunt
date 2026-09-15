import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cargoPackageMemberContractViolation,
  parseUniquePropertiesText,
} from './release-carrier.mts';

test('Cargo packages exactly match their complete package listing', () => {
  const listed = ['Cargo.toml', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'src/lib.rs'];
  assert.equal(cargoPackageMemberContractViolation(listed, listed), null);

  const unexpected = cargoPackageMemberContractViolation([...listed, 'UNDECLARED.md'], listed);
  assert.deepEqual(unexpected, {
    kind: 'mismatch',
    actual: [
      'Cargo.toml',
      'LICENSE',
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'UNDECLARED.md',
      'src/lib.rs',
    ],
    expected: ['Cargo.toml', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'src/lib.rs'],
  });

  assert.deepEqual(cargoPackageMemberContractViolation(listed, [...listed, 'LICENSE']), {
    kind: 'listing-duplicate',
  });
});

test('preserves hostile property names and rejects repeated keys', () => {
  const hostile = parseUniquePropertiesText('__proto__=undeclared\n');
  assert.equal(Object.hasOwn(hostile, '__proto__'), true);
  assert.equal(hostile.__proto__, 'undeclared');
  assert.throws(
    () =>
      parseUniquePropertiesText(
        'asset.native.ios-xcframework.runtime=first.tar.gz\nasset.native.ios-xcframework.runtime=second.tar.gz\n',
      ),
    /repeats key "asset\.native\.ios-xcframework\.runtime"/u,
  );
  assert.throws(
    () =>
      parseUniquePropertiesText(
        'asset.native.ios-xcframework.ios-dependency-xcframework=geos.zip\nasset.native.ios-xcframework.ios-dependency-xcframework=geos-c.zip\n',
      ),
    /repeats key "asset\.native\.ios-xcframework\.ios-dependency-xcframework"/u,
  );
  assert.throws(
    () => parseUniquePropertiesText('__proto__=first\n__proto__=second\n'),
    /repeats key "__proto__"/u,
  );
});
