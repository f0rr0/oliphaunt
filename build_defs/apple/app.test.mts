import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { assertIosAutolinking } from './app.mts';

const actual = JSON.parse(
  readFileSync(new URL('./testdata/expo56-original-apple-resolve.json', import.meta.url), 'utf8'),
);
const expected = Object.fromEntries(
  actual.modules.map((row: any) => [row.packageName, row.packageVersion]),
);
describe('the original Expo Apple resolve is the compiled release closure', () => {
  test('retains all real modules including explicitly guarded debug modules', () => {
    expect(Object.keys(expected)).toHaveLength(20);
    assertIosAutolinking(actual, expected);
  });
  test('rejects duplicate native registration even when package version is unchanged', () => {
    const changed = structuredClone(actual);
    changed.modules.push(structuredClone(changed.modules[0]));
    expect(() => assertIosAutolinking(changed, expected)).toThrow(/exactly once/);
  });
  test.each([
    'expo-sqlite',
    'expo-modules-jsi',
    'expo',
    'expo-dev-launcher',
  ])('rejects missing actual native module %s', (name: string) => {
    const changed = structuredClone(actual);
    changed.modules = changed.modules.filter((row: any) => row.packageName !== name);
    expect(() => assertIosAutolinking(changed, expected)).toThrow(/declared native source closure/);
  });
  test('rejects a wrong independently held native dependency version', () => {
    const changed = structuredClone(actual);
    changed.modules.find((row: any) => row.packageName === 'expo-modules-jsi').packageVersion =
      '56.0.15';
    expect(() => assertIosAutolinking(changed, expected)).toThrow(/declared native source closure/);
  });
  test.each([
    'extraDependencies',
    'coreFeatures',
  ])('fails before compile on undeclared %s', (field: string) => {
    const changed = structuredClone(actual);
    changed[field] = ['future-native-input'];
    expect(() => assertIosAutolinking(changed, expected)).toThrow(/Declare new Expo Apple/);
  });
  test('does not omit an existing release module just because it has no registered Swift Module class', () => {
    const changed = structuredClone(actual);
    changed.modules = changed.modules.filter(
      (row: any) => row.packageName !== 'expo-updates-interface',
    );
    expect(() => assertIosAutolinking(changed, expected)).toThrow();
  });
  test('rejects changed debug-only module semantics before provider/library linking', () => {
    const changed = structuredClone(actual);
    changed.modules.find((row: any) => row.packageName === 'expo-dev-menu').debugOnly = false;
    expect(() => assertIosAutolinking(changed, expected)).toThrow(/debug module conditions/);
  });
  test('retains deterministic closure matching when original discovery order changes', () => {
    for (let seed = 0; seed < 30; seed++) {
      const changed = structuredClone(actual);
      const offset = seed % changed.modules.length;
      changed.modules = [...changed.modules.slice(offset), ...changed.modules.slice(0, offset)];
      assertIosAutolinking(changed, expected);
    }
  });
});
