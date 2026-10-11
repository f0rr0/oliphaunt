import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserCargoSources } from './metadata.mts';

const runfiles = process.env.RUNFILES_DIR;
assert(runfiles, 'This regression consumes the actual Bazel crate_universe output');
const mapping = readFileSync(join(runfiles, '_repo_mapping'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(','));
function external(repository: string, path: string) {
  const roots = new Set(mapping.filter((row) => row[1] === repository).map((row) => row[2]));
  assert.equal(roots.size, 1, `Expected one declared ${repository} repository`);
  return join(runfiles, [...roots][0], path);
}
const sources = JSON.parse(readFileSync(external('browser_sources', 'cargo-sources.json'), 'utf8'));
const context = JSON.parse(readFileSync(external('browser_cargo', 'cargo-bazel.json'), 'utf8'));
const acquisitionMacro = readFileSync(external('browser_cargo', 'crates.bzl'), 'utf8');
const source = Bun.TOML.parse(
  readFileSync(join(runfiles, '_main/src/wasix/browser-host/source.toml'), 'utf8'),
);
const canonical = browserCargoSources(source);
assert.deepEqual(Object.keys(sources).sort(), Object.keys(canonical).sort());
for (const [id, expected] of Object.entries(canonical)) {
  const row = sources[id];
  const actual = context.crates[id].repository;
  assert.deepEqual(Object.keys(actual), ['Http'], `${id} must use immutable HTTP acquisition`);
  assert.equal(actual.Http.url, expected.url);
  assert.equal(actual.Http.sha256, expected.sha256);
  assert.equal(row.strip_prefix, expected.strip_prefix);
  assert.deepEqual(actual.Http.patch_args, ['-p1']);
  assert.deepEqual(actual.Http.patches, row.patches);
  let previous = -1;
  for (const patch of row.patches) {
    const offset = acquisitionMacro.indexOf(JSON.stringify(patch));
    assert(offset > previous, `${id} acquisition macro changed canonical patch order`);
    previous = offset;
  }
  assert.deepEqual(
    row.patches.map((label: string) => label.split(':').at(-1)),
    expected.patches,
  );
}
for (const [id, row] of Object.entries(context.crates) as [string, any][])
  assert(!row.repository?.Path, `${id} unexpectedly acquired an ambient path source`);
assert.deepEqual(Object.keys(context.workspace_members), ['wasmer-js 0.0.0']);

function crate(name: string) {
  const matches = Object.entries(context.crates).filter(([id]) => id.split(' ')[0] === name);
  assert.equal(matches.length, 1, `Expected one resolved ${name} crate`);
  return matches[0][1] as any;
}
function dependencyTriples(parent: string, dependency: string) {
  const deps = crate(parent).common_attrs.deps ?? [];
  const common = Array.isArray(deps) ? deps : (deps.common ?? []);
  const matches = (rows: any[]) => rows.some((row) => row.id.split(' ')[0] === dependency);
  const triples = new Set<string>();
  if (matches(common))
    for (const triple of ['wasm32-unknown-unknown', 'x86_64-unknown-linux-gnu'])
      triples.add(triple);
  for (const [condition, rows] of Object.entries(deps.selects ?? {}) as [string, any[]][])
    if (matches(rows)) {
      assert(context.conditions[condition], `Missing generated condition ${condition}`);
      for (const triple of context.conditions[condition]) triples.add(triple);
    }
  return [...triples].sort();
}
// The exact pinned nightly's Cargo tree selects this edge only with WASM
// atomics; the three optional web-time edges remain disabled.
assert.deepEqual(dependencyTriples('wasm-bindgen-futures', 'web-sys'), ['wasm32-unknown-unknown']);
for (const dependency of ['futures-channel', 'futures-util', 'web-sys'])
  assert.deepEqual(dependencyTriples('web-time', dependency), []);
console.log(
  `Verified four pinned browser sources and configured atomics dependencies across ${Object.keys(context.crates).length} resolved crates`,
);
