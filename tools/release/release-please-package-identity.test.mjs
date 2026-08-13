import { describe, expect, test } from 'bun:test';

import { assertReleasePleasePackageIdentity } from './release-please-package-identity.mjs';

const PACKAGE_PATH = 'packages/typescript';

describe('Release Please Node package identity', () => {
  test('accepts an exact package-name and package.json name match', () => {
    expect(() => assertReleasePleasePackageIdentity(
      PACKAGE_PATH,
      { 'release-type': 'node', 'package-name': '@oliphaunt/example' },
      { name: '@oliphaunt/example' },
    )).not.toThrow();
  });

  test('rejects a registry identity that drifted from package.json', () => {
    expect(() => assertReleasePleasePackageIdentity(
      PACKAGE_PATH,
      { 'release-type': 'node', 'package-name': '@oliphaunt/stale' },
      { name: '@oliphaunt/example' },
    )).toThrow(
      'packages/typescript.package-name "@oliphaunt/stale" must match '
        + 'packages/typescript/package.json name "@oliphaunt/example"',
    );
  });

  test('does not interpret non-Node product package names as npm identities', () => {
    expect(() => assertReleasePleasePackageIdentity(
      'packages/rust',
      { 'release-type': 'rust', 'package-name': 'example' },
      {},
    )).not.toThrow();
  });
});
