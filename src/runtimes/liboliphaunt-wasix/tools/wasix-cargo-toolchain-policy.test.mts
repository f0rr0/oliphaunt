import { expect, test } from 'bun:test';
import {
  REQUIRED_WASIX_CONSUMER_PINS,
  validateWasixConsumerDependencyPins,
} from './wasix-cargo-toolchain-policy.mts';
const toolchainVersions = { wasmer: '7.2.1', wasmerWasix: '0.702.1', webc: '12.0.0' };

test('requires exact non-optional pins for the published WASIX family closure', () => {
  const dependencies = Object.fromEntries(
    REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
      name,
      name === 'webc' ? '=12.0.0' : { version: '=0.702.1', 'default-features': false },
    ]),
  );
  expect(
    validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: 'fixture.toml', toolchainVersions },
    ),
  ).toEqual([]);

  dependencies['virtual-mio'] = { version: '0.702.1', 'default-features': false };
  dependencies['virtual-net'] = {
    version: '=0.702.1',
    optional: true,
    'default-features': false,
  };
  delete dependencies['virtual-fs'];
  expect(
    validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: 'fixture.toml', toolchainVersions },
    ),
  ).toEqual([
    'fixture.toml must declare non-optional virtual-fs exactly once, found 0',
    'fixture.toml dependencies.virtual-mio must pin virtual-mio exactly to =0.702.1, got "0.702.1"',
    'fixture.toml dependencies.virtual-net must keep virtual-net non-optional',
  ]);
});

test('rejects default-feature and source substitutions in published WASIX pins', () => {
  const dependencies = Object.fromEntries(
    REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
      name,
      name === 'webc' ? '=12.0.0' : { version: '=0.702.1', 'default-features': false },
    ]),
  );
  delete dependencies['wasmer-config']['default-features'];
  dependencies['wasmer-journal']['default-features'] = true;
  dependencies['wasmer-package'].path = '../../substituted';
  dependencies['wasmer-wasix-types'].git = 'https://example.invalid/wasix';
  dependencies['virtual-fs'].registry = 'substituted';

  expect(
    validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: 'fixture.toml', toolchainVersions },
    ),
  ).toEqual([
    'fixture.toml dependencies.wasmer-config must set default-features = false for wasmer-config',
    'fixture.toml dependencies.wasmer-journal must set default-features = false for wasmer-journal',
    'fixture.toml dependencies.wasmer-package must resolve wasmer-package from crates.io without source selectors, found path',
    'fixture.toml dependencies.wasmer-wasix-types must resolve wasmer-wasix-types from crates.io without source selectors, found git',
    'fixture.toml dependencies.virtual-fs must resolve virtual-fs from crates.io without source selectors, found registry',
  ]);
});

test('rejects missing, ranged, optional, and source-substituted WebC pins', () => {
  const dependencies = Object.fromEntries(
    REQUIRED_WASIX_CONSUMER_PINS.map((name) => [
      name,
      name === 'webc' ? '=12.0.0' : { version: '=0.702.1', 'default-features': false },
    ]),
  );

  delete dependencies.webc;
  expect(
    validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: 'missing.toml', toolchainVersions },
    ),
  ).toContain('missing.toml must declare non-optional webc exactly once, found 0');

  dependencies.webc = {
    version: '^12.0.0',
    optional: true,
    git: 'https://example.invalid/webc',
  };
  expect(
    validateWasixConsumerDependencyPins(
      { dependencies },
      { manifestPath: 'substituted.toml', toolchainVersions },
    ),
  ).toEqual([
    'substituted.toml dependencies.webc must pin webc exactly to =12.0.0, got "^12.0.0"',
    'substituted.toml dependencies.webc must keep webc non-optional',
    'substituted.toml dependencies.webc must resolve webc from crates.io without source selectors, found git',
  ]);
});
