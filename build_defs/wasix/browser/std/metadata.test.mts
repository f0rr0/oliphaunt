import { expect, test } from 'bun:test';
import { standardLibraryGraph } from './metadata.mts';

const pkg = (name: string) => ({
  id: name,
  name,
  version: '0.0.0',
  manifest_path: `/immutable/library/${name}/Cargo.toml`,
  targets: [
    { name, kind: ['lib'], src_path: `/immutable/library/${name}/src/lib.rs`, edition: '2024' },
  ],
  authors: [],
  description: null,
  license: null,
  repository: null,
});
const edge = (name: string, kind: string | null = null) => ({
  name,
  pkg: name,
  dep_kinds: [{ kind }],
});
const metadata = {
  packages: ['std', 'panic_abort', 'core', 'dev_only'].map(pkg),
  resolve: {
    nodes: [
      { id: 'std', features: ['backtrace'], deps: [edge('core'), edge('dev_only', 'dev')] },
      { id: 'panic_abort', features: [], deps: [edge('core')] },
      { id: 'core', features: [], deps: [] },
      { id: 'dev_only', features: [], deps: [] },
    ],
  },
};

test('uses the locked normal closure and preserves conventional compiler facts', () => {
  const graph = standardLibraryGraph(metadata, '/immutable');
  expect(graph.map((row) => row.name)).toEqual(['core', 'panic_abort', 'std']);
  expect(graph.find((row) => row.name === 'std')).toMatchObject({
    root: 'library/std/src/lib.rs',
    crate_name: 'std',
    features: ['backtrace'],
    deps: { core: 'core' },
    edition: '2024',
  });
});

test('rejects undeclared native build-dependency and external source inputs', () => {
  const host = structuredClone(metadata);
  host.resolve.nodes[0].deps.push(edge('dev_only', 'build'));
  expect(() => standardLibraryGraph(host, '/immutable')).toThrow('explicit host compiler graph');
  const outside = structuredClone(metadata);
  outside.packages[0].targets[0].src_path = '/ambient/src/lib.rs';
  expect(() => standardLibraryGraph(outside, '/immutable')).toThrow('escapes');
});

test('preserves upstream per-crate release overrides and rejects unsupported profile behavior', () => {
  const profiles = {
    core: { 'opt-level': 's', 'codegen-units': 10000, debug: 0 },
    panic_abort: { rustflags: ['-Cpanic=abort'] },
  };
  const graph = standardLibraryGraph(metadata, '/immutable', profiles);
  expect(graph.find((row) => row.name === 'core')?.profile).toEqual(profiles.core);
  expect(graph.find((row) => row.name === 'panic_abort')?.profile).toEqual(profiles.panic_abort);
  expect(() => standardLibraryGraph(metadata, '/immutable', { core: { debug: 2 } })).toThrow(
    'debug profile',
  );
  expect(() =>
    standardLibraryGraph(metadata, '/immutable', { core: { 'opt-level': 'fast' } }),
  ).toThrow('optimization');
  expect(() =>
    standardLibraryGraph(metadata, '/immutable', { core: { 'codegen-units': 0 } }),
  ).toThrow('codegen');
  expect(() =>
    standardLibraryGraph(metadata, '/immutable', { core: { incremental: true } } as any),
  ).toThrow('Unsupported');
});
