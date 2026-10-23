import { expect, test } from 'bun:test';
import {
  nativePreparedRegistryBuildBound,
  parseReleaseVersionCheckArgs,
} from './check_release_versions.mts';

test('native registry routing is explicit and retains the actual requested source and products', () => {
  const args = parseReleaseVersionCheckArgs([
    '--native-preparation',
    '--check-registries',
    '--products-json',
    '["oliphaunt-rust"]',
    '--head-ref',
    'a'.repeat(40),
  ]);
  expect(args.nativePreparation).toBe(true);
  expect(args.checkRegistries).toBe(true);
  expect(args.productsJson).toBe('["oliphaunt-rust"]');
  expect(args.headRef).toBe('a'.repeat(40));
  expect(parseReleaseVersionCheckArgs(['--check-registries']).nativePreparation).toBe(false);
});

test('operator records, same-version labels and complete-looking maps cannot authenticate Prepare', () => {
  const source = { commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const raw = {
    record: { preparedSource: source, selectedProducts: ['oliphaunt-rust'] },
    buildBound: new Map([['oliphaunt-rust', new Set(['liboliphaunt-native'])]]),
    origin: { runId: 1, runAttempt: 1, artifact: { id: 1 }, codeSource: source },
  };
  for (const value of [
    undefined,
    raw,
    { ...raw, authenticated: true },
    { ...raw, buildBound: new Map() },
  ])
    expect(() => nativePreparedRegistryBuildBound(value, source, ['oliphaunt-rust'])).toThrow(
      'authenticated Prepare',
    );
});
