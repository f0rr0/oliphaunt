import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

export function compilerZstdLabel(context: any, rendered: string, canonicalHub: string) {
  const rows = Object.values<any>(context.crates).filter((row) => row.name === 'zstd');
  assert.equal(rows.length, 1, 'Expected one actual selected compiler zstd crate');
  const row = rows[0];
  const source = row.repository?.Http;
  assert(
    source && row.library_target_name,
    'Selected compiler zstd must have a genuine HTTP library',
  );
  const blocks = rendered
    .split('\n    maybe(\n')
    .filter((block) =>
      [
        `        strip_prefix = ${JSON.stringify(`${row.name}-${row.version}`)},\n`,
        `        sha256 = ${JSON.stringify(source.sha256)},\n`,
        `        urls = [${JSON.stringify(source.url)}],\n`,
      ].every((field) => block.includes(field)),
    );
  assert.equal(blocks.length, 1, 'Expected one exact rendered compiler zstd repository');
  const name = /\n {8}name = "([^"]+)",\n/u.exec(blocks[0])?.[1];
  const apparentHub = /\n {8}build_file = Label\("@([^/]+)\/\//u.exec(blocks[0])?.[1];
  assert(
    name && apparentHub && canonicalHub.endsWith(apparentHub),
    'Compiler repository mapping differs',
  );
  return `@@${canonicalHub.slice(0, -apparentHub.length)}${name}//:${row.library_target_name}`;
}

export function postmasterCompileMetadata(manifest: any, contexts: Record<string, any>) {
  const pkg = manifest.package;
  assert(pkg?.name && pkg.version && pkg.edition, 'Canonical executor package facts required');
  const id = `${pkg.name} ${pkg.version}`;
  assert.deepEqual(manifest.features.default, [], 'Canonical default features must remain empty');
  const roles: Record<string, any> = {};
  const patches = new Set<string>();
  for (const [role, context] of Object.entries(contexts)) {
    assert.deepEqual(Object.keys(context.workspace_members), [id]);
    const binaries = manifest.bin.filter((row: any) => row.name.endsWith(`postmaster-${role}`));
    assert.equal(binaries.length, 1, `Expected one canonical ${role} binary`);
    const binary = binaries[0];
    const features = context.crates[id].common_attrs.crate_features;
    assert(Array.isArray(features) && new Set(features).size === features.length);
    for (const feature of binary['required-features'])
      assert(features.includes(feature), `Resolved ${role} lost canonical feature ${feature}`);
    for (const feature of features)
      assert(Object.hasOwn(manifest.features, feature), `Unknown resolved feature ${feature}`);
    roles[role] = {
      binary: binary.name,
      source: binary.path,
      // The role overlay enables Cargo metadata's default feature solely to
      // select the authored binary. Conventional construction disables it.
      features: features.filter((feature: string) => feature !== 'default'),
    };
    for (const row of Object.values<any>(context.crates)) {
      if (row.repository?.Http?.strip_prefix) {
        for (const patch of row.repository.Http.patches ?? []) patches.add(patch);
      }
    }
  }
  assert.deepEqual(Object.keys(roles).sort(), ['compiler', 'executor']);
  return {
    name: pkg.name,
    crate_name: pkg.name.replaceAll('-', '_'),
    version: pkg.version,
    edition: pkg.edition,
    library: manifest.lib?.path ?? 'src/lib.rs',
    roles,
    patches: [...patches].sort(),
  };
}

if (import.meta.main) {
  const [manifest, executor, compiler, rendered, canonicalHub, output] = Bun.argv.slice(2);
  assert(manifest && executor && compiler && rendered && canonicalHub && output);
  const compilerContext = JSON.parse(readFileSync(compiler, 'utf8'));
  const facts = postmasterCompileMetadata(Bun.TOML.parse(readFileSync(manifest, 'utf8')), {
    executor: JSON.parse(readFileSync(executor, 'utf8')),
    compiler: compilerContext,
  });
  writeFileSync(
    output,
    `POSTMASTER_CARGO = ${JSON.stringify({ ...facts, compiler_zstd: compilerZstdLabel(compilerContext, readFileSync(rendered, 'utf8'), canonicalHub) })}\n`,
  );
}
