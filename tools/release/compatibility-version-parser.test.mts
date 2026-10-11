import { expect, test } from 'bun:test';
import { compatibilityVersionFromText } from './compatibility-version-parser.mts';

const entry = (parser: string) => ({ id: 'sdk.runtime', path: 'sdk/manifest', parser });

test('parses the existing raw, structured, and Rust compatibility source contracts', () => {
  for (const [parser, source] of [
    ['raw', ' 0.3.2\n'],
    ['json:oliphaunt.runtime', '{"oliphaunt":{"runtime":"0.3.2"}}'],
    ['toml:runtime.version', '[runtime]\nversion = "0.3.2"\n'],
    ['rust-const:RUNTIME_VERSION', 'pub const RUNTIME_VERSION: &str = "0.3.2";'],
  ])
    expect(compatibilityVersionFromText(entry(parser), source)).toBe('0.3.2');
  // Stable-version admission belongs to the caller, including raw empty text.
  expect(compatibilityVersionFromText(entry('raw'), '\n')).toBe('');
  expect(compatibilityVersionFromText(entry('json:version'), '{"version":"^1.0.0"}')).toBe(
    '^1.0.0',
  );
});

test('missingValue applies only to absent structured paths and absent Rust constants', () => {
  expect(
    compatibilityVersionFromText(entry('json:runtime.version'), '{}', { missingValue: null }),
  ).toBeNull();
  expect(
    compatibilityVersionFromText(entry('toml:runtime.version'), 'runtime = false', {
      missingValue: 'absent',
    }),
  ).toBe('absent');
  expect(
    compatibilityVersionFromText(entry('rust-const:RUNTIME_VERSION'), '', {
      missingValue: 'absent',
    }),
  ).toBe('absent');
  for (const source of ['{"version":""}', '{"version":null}', '{"version":123}'])
    expect(() =>
      compatibilityVersionFromText(entry('json:version'), source, { missingValue: 'absent' }),
    ).toThrow('must resolve to a non-empty string');
});

test('exact Cargo dependency requirements expose their version without accepting ranges or changing metadata', () => {
  for (const table of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
    const parser = entry(`toml:${table}.oliphaunt-query.version`);
    for (const exact of ['=0.1.1', '= 0.1.1'])
      expect(
        compatibilityVersionFromText(
          parser,
          `[${table}]\noliphaunt-query = { version = "${exact}" }`,
        ),
      ).toBe('0.1.1');
    for (const range of ['^0.1.1', '>=0.1.1', '=0.1.1, <0.2', '0.1.*'])
      expect(
        compatibilityVersionFromText(
          parser,
          `[${table}]\noliphaunt-query = { version = "${range}" }`,
        ),
      ).toBe(range);
  }
  expect(
    compatibilityVersionFromText(
      entry('toml:package.metadata.runtime-version'),
      '[package.metadata]\nruntime-version = "=0.1.1"',
    ),
  ).toBe('=0.1.1');
  expect(
    compatibilityVersionFromText(
      entry('json:dependencies.query.version'),
      '{"dependencies":{"query":{"version":"=0.1.1"}}}',
    ),
  ).toBe('=0.1.1');
});

test('invalid sources preserve diagnostics and the injectable failure boundary', () => {
  for (const [parser, source, message] of [
    ['rust-const:invalid', '', 'has an invalid Rust constant parser'],
    ['rust-const:RUNTIME_VERSION', '', 'must name exactly one Rust string constant'],
    [
      'rust-const:RUNTIME_VERSION',
      'const RUNTIME_VERSION: &str = "1"; const RUNTIME_VERSION: &str = "2";',
      'must name exactly one Rust string constant',
    ],
    ['json:version', '{', 'is not valid JSON'],
    ['toml:version', 'version = [', 'is not valid TOML'],
    ['yaml:version', 'version: "1"', 'uses unsupported compatibility parser'],
  ])
    expect(() =>
      compatibilityVersionFromText(entry(parser), source, { prefix: 'native-import' }),
    ).toThrow(message);
  expect(() => compatibilityVersionFromText(entry('json:version'), '{}')).toThrow(
    'release-graph: sdk.runtime parser json:version must resolve to a non-empty string',
  );
  const calls: string[][] = [];
  const sentinel = new Error('original failure boundary');
  expect(() =>
    compatibilityVersionFromText(entry('json:version'), '{}', {
      prefix: 'existing-cli',
      fail(prefix, message) {
        calls.push([prefix, message]);
        throw sentinel;
      },
    }),
  ).toThrow(sentinel);
  expect(calls).toEqual([
    ['existing-cli', 'sdk.runtime parser json:version must resolve to a non-empty string'],
  ]);
});
