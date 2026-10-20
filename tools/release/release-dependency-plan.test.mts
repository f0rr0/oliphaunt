import { expect, test } from 'bun:test';
import { requireCompatibilityVersionBinding } from './compatibility-version-policy.mts';
import {
  releaseDependencyPlan,
  requirePublicSupportTransition,
} from './release-dependency-plan.mts';

test('selected source consumers retain declarations while compiled payloads name their real inputs', () => {
  const products = {
    sdk: { version: '1.2.0' },
    binary: { version: '1.0.1' },
    runtime: { version: '2.0.0' },
  };
  const entries = ['sdk', 'binary'].map((product) => ({
    id: product,
    product,
    sourceProduct: 'runtime',
    publicSupport: false,
  }));
  const plan = releaseDependencyPlan(products, ['sdk', 'binary'], {
    entries,
    buildBound: new Map([['binary', new Set(['runtime'])]]),
    readValue: () => '1.0.0',
  });
  expect(plan.map(({ version, binding }) => ({ version, binding }))).toEqual([
    { version: '1.0.0', binding: 'declared-requirement' },
    { version: '2.0.0', binding: 'compiled-input' },
  ]);
  expect(
    releaseDependencyPlan(products, [], {
      entries,
      buildBound: new Map([['binary', new Set(['runtime'])]]),
      readValue: () => '1.0.0',
    }).every(({ version }) => version === '1.0.0'),
  ).toBe(true);
});

test('new SQL-only extensions retain declared hosts until their own release is selected', () => {
  const runtime = 'liboliphaunt-wasix';
  for (const extension of ['pgmq', 'pg_partman']) {
    const product = `oliphaunt-extension-${extension.replaceAll('_', '-')}`;
    const products = {
      [runtime]: { path: 'src/wasix/runtime', version: '0.3.3' },
      [product]: {
        path: `src/extensions/external/${extension}`,
        version: '0.0.0',
        kind: 'exact-extension-artifact',
        extension: { class: 'external' },
      },
    };
    const entry = { id: `${product}-host`, product, sourceProduct: runtime, publicSupport: true };
    const options = { entries: [entry], readValue: () => '0.3.2' };
    const [unchanged] = releaseDependencyPlan(products, [runtime], options);
    expect(unchanged.version).toBe('0.3.2');
    expect(unchanged.binding).toBe('declared-requirement');

    products[product].version = '0.1.0';
    const [selected] = releaseDependencyPlan(products, [runtime, product], options);
    expect(selected.version).toBe('0.3.3');
    expect(selected.binding).toBe('compiled-input');
    const validate = (value) =>
      requireCompatibilityVersionBinding({
        id: entry.id,
        value,
        expected: selected.version,
        sourceProduct: runtime,
        sourceVersion: products[runtime].version,
        provenance: `planned ${runtime} binding ${selected.version}`,
      });
    expect(() => validate('0.3.2')).toThrow('must match planned');
    expect(() => validate('0.3.3')).not.toThrow();
  }
});

test('support removal requires the configured pre-1.0 or stable breaking boundary', () => {
  const base = {
    product: 'extension',
    previousSupport: 'runtime@1.0.0',
    nextSupport: 'runtime@2.0.0',
  };
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '0.2.3', after: '0.2.4' }),
  ).toThrow('breaking-version policy');
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '0.2.3', after: '0.3.0' }),
  ).not.toThrow();
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '1.2.3', after: '1.3.0' }),
  ).toThrow('breaking-version policy');
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '1.2.3', after: '2.0.0' }),
  ).not.toThrow();
  expect(() =>
    requirePublicSupportTransition({ ...base, before: '0.0.0', after: '0.1.0' }),
  ).not.toThrow();
  expect(() =>
    requirePublicSupportTransition({
      ...base,
      nextSupport: base.previousSupport,
      before: '1.2.3',
      after: '1.2.4',
    }),
  ).not.toThrow();
});
