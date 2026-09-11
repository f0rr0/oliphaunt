import { expect, test } from 'bun:test';
import { exampleCargoPolicy } from './example-cargo-versions.mts';

test('release bindings follow renamed packages and target scopes without controlling local dependencies', () => {
  const policy = exampleCargoPolicy('examples/new-app/Cargo.toml', {
    dependencies: {
      database: { package: 'oliphaunt', version: '=0.2.0' },
      'oliphaunt-local': { path: '../local', version: '*' },
      'oliphaunt-shared': { workspace: true },
      'oliphaunt-fork': { git: 'https://example.invalid/fork' },
      'oliphaunt-private': { registry: 'private', version: '1' },
      serde: '1',
    },
    target: { 'cfg(unix)': { 'dev-dependencies': { oliphaunt: '=0.2.0' } } },
  });
  expect(policy.dependencyBindings).toEqual([
    { name: 'database', packageName: 'oliphaunt', entryParts: ['dependencies', 'database'] },
    {
      name: 'oliphaunt',
      packageName: 'oliphaunt',
      entryParts: ['target', 'cfg(unix)', 'dev-dependencies', 'oliphaunt'],
    },
  ]);
});
