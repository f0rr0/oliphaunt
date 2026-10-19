import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMoonProjects, releaseOrder } from './release-graph.mts';

test('release planning consumes resolved dependency scopes independently of published compatibility', () => {
  const graph = Object.fromEntries(
    parseMoonProjects({
      projects: [
        { id: 'runtime', source: 'packages/runtime', config: {} },
        {
          id: 'consumer-production',
          source: 'packages/consumer-production',
          dependencies: [{ id: 'runtime', scope: 'production' }],
          config: { dependsOn: [{ id: 'runtime', scope: 'build' }] },
        },
        {
          id: 'consumer-build',
          source: 'packages/consumer-build',
          dependencies: [{ id: 'runtime', scope: 'build' }],
          config: { dependsOn: [{ id: 'runtime', scope: 'production' }] },
        },
      ],
    }),
  );
  assert.equal(graph['consumer-production'].dependencies[0].scope, 'production');
  assert.equal(graph['consumer-build'].dependencies[0].scope, 'build');
  const products = {
    runtime: {},
    'consumer-production': { compatibility_versions: { runtime: { source_product: 'runtime' } } },
    'consumer-build': {},
  };
  assert.deepEqual(releaseOrder(products, graph, Object.keys(products)), [
    'consumer-build',
    'runtime',
    'consumer-production',
  ]);
});
