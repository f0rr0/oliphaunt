import { expect, test } from 'bun:test';
import { wasixSeedConsumerDeclaration } from './consumer-contract.mts';
test('completed is the sole default and same version never infers current origin', () => {
  const manifest = {
    package: {
      metadata: {
        oliphaunt: {
          'runtime-version': '0.3.2',
          'runtime-source': undefined as string | undefined,
        },
      },
    },
  };
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.2', '0.3.2')).toEqual({
    source: 'completed',
    version: '0.3.2',
  });
  manifest.package.metadata.oliphaunt['runtime-source'] = 'current';
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.2', '0.3.2')).toEqual({
    source: 'current',
    version: '0.3.2',
  });
  expect(() => wasixSeedConsumerDeclaration(manifest, '0.4.0', '0.4.0')).toThrow('conventional');
  manifest.package.metadata.oliphaunt['runtime-source'] = 'same-version';
  expect(() => wasixSeedConsumerDeclaration(manifest, '0.3.2', '0.3.2')).toThrow('runtime-source');
});

test('current intent is scoped to its conventional pinned version across repeated release cycles', () => {
  const manifest = {
    package: {
      metadata: { oliphaunt: { 'runtime-version': '0.3.2', 'runtime-source': 'current' } },
    },
  };
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.2', '0.3.2').source).toBe('current');
  // A core-only release and the next ordinary source CI both retain the old exact request.
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.2', '0.3.3')).toEqual({
    source: 'completed',
    version: '0.3.2',
  });
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.2', '0.3.4')).toEqual({
    source: 'completed',
    version: '0.3.2',
  });
  manifest.package.metadata.oliphaunt['runtime-version'] = '0.3.4';
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.4', '0.3.4').source).toBe('current');
  // Completing an explicit new adoption leaves that source intent scoped to its exact version again.
  expect(wasixSeedConsumerDeclaration(manifest, '0.3.4', '0.3.5')).toEqual({
    source: 'completed',
    version: '0.3.4',
  });
});
