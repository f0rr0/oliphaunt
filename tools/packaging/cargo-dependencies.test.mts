import { expect, test } from 'bun:test';
import { assertPackagedCargoDependencies } from './cargo-dependencies.mts';

const source = {
  dependencies: {
    runtime: { version: '=0.2.0' },
    data: { package: 'icu-data', version: '=0.2.1', optional: true },
    query: '0.1.0',
  },
  target: {
    'cfg(unix)': {
      dependencies: {
        tools: {
          version: '=0.3.0',
          optional: true,
          'default-features': false,
          features: ['portable', 'aot'],
        },
      },
    },
  },
};
const packaged = () => ({
  ...structuredClone(source),
  dependencies: {
    ...structuredClone(source.dependencies),
    query: { version: '0.1.0' },
  },
});

test('Cargo normalization preserves independent versions, aliases and optional target dependencies', () => {
  const actual = packaged();
  actual.target['cfg(unix)'].dependencies.tools.features.reverse();
  expect(() => assertPackagedCargoDependencies(actual, source, 'consumer.crate')).not.toThrow();
  actual.dependencies.data.version = '=0.2.0';
  expect(() => assertPackagedCargoDependencies(actual, source, 'consumer.crate')).toThrow(
    'resolved source manifest',
  );
});

test('a packed crate cannot substitute local sources or silently enable optional resource payloads', () => {
  const local = packaged();
  local.dependencies.runtime.path = '../runtime';
  expect(() => assertPackagedCargoDependencies(local, source, 'consumer.crate')).toThrow(
    'crates.io',
  );
  const required = packaged();
  required.dependencies.data.optional = false;
  expect(() => assertPackagedCargoDependencies(required, source, 'consumer.crate')).toThrow(
    'resolved source manifest',
  );
  const missing = packaged();
  delete missing.target['cfg(unix)'].dependencies.tools;
  expect(() => assertPackagedCargoDependencies(missing, source, 'consumer.crate')).toThrow(
    'missing or unexpected',
  );
});
