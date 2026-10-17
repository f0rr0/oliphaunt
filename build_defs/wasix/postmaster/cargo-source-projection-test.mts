import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const runfiles = process.env.RUNFILES_DIR;
assert(runfiles, 'This check consumes the actual standard Cargo extension outputs');
const mapping = readFileSync(join(runfiles, '_repo_mapping'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => line.split(','));
function external(repository: string, file: string) {
  const roots = new Set(mapping.filter((row) => row[1] === repository).map((row) => row[2]));
  assert.equal(roots.size, 1, `Expected one declared ${repository} repository`);
  return join(runfiles, [...roots][0], file);
}
const original = Bun.TOML.parse(
  readFileSync(join(runfiles, '_main/src/wasix/postmaster/executor/Cargo.toml'), 'utf8'),
);
const canonicalLock = readFileSync(
  join(runfiles, '_main/src/wasix/postmaster/executor/Cargo.lock'),
);
const sources = JSON.parse(
  readFileSync(external('postmaster_cargo', 'cargo-sources.json'), 'utf8'),
);
const ownId = `${original.package.name} ${original.package.version}`;
for (const role of ['executor', 'compiler']) {
  const repository = `postmaster_${role}_crates`;
  const context = JSON.parse(readFileSync(external(repository, 'cargo-bazel.json'), 'utf8'));
  const rendered = readFileSync(external(repository, 'crates.bzl'), 'utf8');
  const manifest = Bun.TOML.parse(
    readFileSync(external('postmaster_cargo', `${role}/Cargo.toml`), 'utf8'),
  );
  assert.deepEqual(readFileSync(external('postmaster_cargo', `${role}/Cargo.lock`)), canonicalLock);
  assert.deepEqual(Object.keys(context.workspace_members), [ownId]);
  const binary = original.bin.find((row: any) => row.name.endsWith(`postmaster-${role}`));
  assert(binary, `Missing canonical ${role} binary`);
  assert.deepEqual(manifest.features.default, binary['required-features']);
  const rootFeatures = context.crates[ownId].common_attrs.crate_features;
  for (const feature of binary['required-features'])
    assert(rootFeatures.includes(feature), `${role} lost its canonical feature ${feature}`);
  let selected = 0;
  for (const [id, crate] of Object.entries(context.crates) as [string, any][]) {
    assert(!crate.repository?.Path, `${role} retained an ambient path source for ${id}`);
    const source = sources[id];
    if (!source) continue;
    selected++;
    assert.deepEqual(Object.keys(crate.repository), ['Http']);
    const actual = crate.repository.Http;
    assert.equal(actual.url, source.url);
    assert.equal(actual.sha256, source.sha256);
    assert.equal(actual.strip_prefix, source.strip_prefix);
    assert.deepEqual(actual.patches, source.patches);
    assert.deepEqual(actual.patch_args, ['-p1']);
    const marker = `        http_archive,\n        name = ${JSON.stringify(`${repository}__${crate.name}-${crate.version.replaceAll('+', '-')}`)},\n`;
    const blocks = rendered.split('\n    maybe(\n').filter((block) => block.includes(marker));
    assert.equal(blocks.length, 1, `${role} must declare ${id} exactly once`);
    const block = blocks[0];
    assert(block.includes(`        strip_prefix = ${JSON.stringify(source.strip_prefix)},\n`));
    let previous = -1;
    for (const patch of source.patches) {
      const offset = block.indexOf(JSON.stringify(patch));
      assert(offset > previous, `${role} changed the canonical patch order for ${id}`);
      previous = offset;
    }
  }
  assert(selected > 0, `${role} selected no immutable Wasmer leaf sources`);
  const compilerName = 'wasmer-compiler-llvm';
  const selectedCompiler = Object.keys(context.crates).some(
    (id) => id.split(' ')[0] === compilerName,
  );
  assert.equal(
    selectedCompiler,
    role === 'compiler',
    'Executor/compiler Cargo features were unified',
  );
  assert(!Object.keys(context.crates).some((id) => id.startsWith('wasmer-compiler-cranelift ')));
  console.log(
    `Verified ${role}: ${selected} immutable leaf sources and isolated canonical features`,
  );
}
