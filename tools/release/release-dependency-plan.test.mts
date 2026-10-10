import { expect, test } from 'bun:test';
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
