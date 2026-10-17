import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { postmasterCompileMetadata } from './compile-metadata.mts';

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: any): string =>
  JSON.stringify(value, (_key, row) =>
    row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(
          Object.keys(row)
            .sort()
            .map((key) => [key, row[key]]),
        )
      : row,
  );

function configuredFeatures(context: any, crate: any, target: string): string[] {
  const declared = crate.common_attrs?.crate_features ?? [];
  if (Array.isArray(declared)) return [...declared].sort();
  const values = [...(declared.common ?? [])];
  for (const [condition, features] of Object.entries<any>(declared.selects ?? {})) {
    assert(
      Array.isArray(context.conditions[condition]),
      `Missing standard feature condition ${condition}`,
    );
    if (context.conditions[condition].includes(target)) values.push(...features);
  }
  return [...new Set<string>(values)].sort();
}

export function nativeRuntimeAbi(input: any) {
  const facts = postmasterCompileMetadata(input.manifest, input.contexts);
  const serialized = /\bCURRENT_VERSION:\s*u32\s*=\s*(\d+)\s*;/g;
  const loader = /\bARTIFACT_ABI_VERSION:\s*u32\s*=\s*(\d+)\s*;/g;
  const upstreamVersions = [...input.serializer.matchAll(serialized)];
  const loaderVersions = [...input.loader.matchAll(loader)];
  assert.equal(upstreamVersions.length, 1, 'Expected one real Wasmer serialization ABI');
  assert.equal(loaderVersions.length, 1, 'Expected one sealed-loader serialization ABI');
  const artifactAbiVersion = Number(upstreamVersions[0][1]);
  assert.equal(artifactAbiVersion, Number(loaderVersions[0][1]), 'Wasmer/loader ABI mismatch');
  assert(input.rust.target && input.rust.version && Array.isArray(input.rust.flags));
  for (const path of [facts.library, ...Object.values<any>(facts.roles).map((role) => role.source)])
    assert(
      Object.hasOwn(input.rootSources, path),
      `Missing actual first-party compile source ${path}`,
    );
  const roles: Record<string, any> = {};
  const usedPatches = new Set<string>();
  for (const role of ['executor', 'compiler']) {
    const context = input.contexts[role];
    const configured = new Map<string, any>();
    for (const row of input.roles[role]) {
      assert(row.target && row.crate_name && row.version && Array.isArray(row.features));
      assert.equal(new Set(row.features).size, row.features.length, 'Duplicate configured feature');
      const matches = Object.entries<any>(context.crates).filter(
        ([_id, crate]) =>
          crate.library_target_name === row.crate_name && crate.version === row.version,
      );
      assert.equal(
        matches.length,
        1,
        `Unknown configured ${role} crate ${row.crate_name} ${row.version}`,
      );
      const [id] = matches[0];
      assert.deepEqual(
        [...row.features].sort(),
        configuredFeatures(context, matches[0][1], row.target),
        `Configured ${role} features disagree with standard Cargo context for ${id}`,
      );
      const key = `${id} ${row.target}`;
      const value = { id, target: row.target, features: [...row.features].sort() };
      if (configured.has(key))
        assert.deepEqual(configured.get(key), value, 'Conflicting configured crate features');
      configured.set(key, value);
    }
    assert(configured.size, `Missing actual configured ${role} dependencies`);
    const sources: Record<string, any> = {};
    for (const [id, crate] of Object.entries<any>(context.crates)) {
      const source = input.sources[id];
      if (!source) continue;
      const acquired = crate.repository?.Http;
      assert(acquired, `Selected path source ${id} lacks immutable HTTP acquisition`);
      for (const key of ['url', 'sha256', 'strip_prefix', 'patches'])
        assert.deepEqual(
          acquired[key] ?? [],
          source[key] ?? [],
          `Source acquisition mismatch ${id}/${key}`,
        );
      // The canonical source projection uses ctx.patch(strip = 1); the
      // maintained source_metadata seam renders its equivalent -p1 argument.
      assert.deepEqual(acquired.patch_args, ['-p1'], `Source patch strip differs ${id}`);
      sources[id] = {
        url: source.url,
        sha256: source.sha256,
        strip_prefix: source.strip_prefix,
        patch_args: acquired.patch_args,
        patches: (source.patches ?? []).map((label: string) => {
          const name = basename(label);
          assert(Object.hasOwn(input.patches, name), `Missing declared patch ${name}`);
          usedPatches.add(name);
          return sha256(input.patches[name]);
        }),
      };
    }
    assert(Object.keys(sources).length, `Missing selected immutable ${role} sources`);
    roles[role] = {
      features: facts.roles[role].features,
      dependencies: [...configured.values()].sort((a, b) =>
        `${a.id} ${a.target}` < `${b.id} ${b.target}`
          ? -1
          : `${a.id} ${a.target}` > `${b.id} ${b.target}`
            ? 1
            : 0,
      ),
      sources,
    };
  }
  assert.deepEqual(
    [...usedPatches].sort(),
    Object.keys(input.patches).sort(),
    'Unexpected declared source patches',
  );
  const contract = {
    schema: 'oliphaunt.wasix-postmaster.runtime-abi.native.v2',
    package: { name: facts.name, version: facts.version, edition: facts.edition },
    manifest_sha256: sha256(input.manifestBytes),
    lock_sha256: sha256(input.lock),
    source: Object.fromEntries(
      Object.entries<any>(input.sourceIdentity).filter(([_name, origin]) =>
        Object.values<any>(roles).some((role) =>
          Object.values<any>(role.sources).some(
            (source) => source.url === origin.url && source.sha256 === origin.sha256,
          ),
        ),
      ),
    ),
    root_sources: Object.fromEntries(
      Object.entries<any>(input.rootSources).map(([path, bytes]) => [path, sha256(bytes)]),
    ),
    artifact_abi_version: artifactAbiVersion,
    rust: { ...input.rust, compiler_sha256: sha256(input.rustc) },
    roles,
  };
  const id = sha256(canonical(contract));
  return { ...contract, runtime_abi_id: id };
}

if (import.meta.main) {
  const [specPath, jsonOutput, envOutput] = Bun.argv.slice(2);
  assert(specPath && jsonOutput && envOutput);
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const manifestBytes = readFileSync(spec.manifest);
  const identity = nativeRuntimeAbi({
    ...spec,
    manifest: Bun.TOML.parse(manifestBytes.toString('utf8')),
    manifestBytes,
    contexts: Object.fromEntries(
      Object.entries<string>(spec.contexts).map(([role, path]) => [
        role,
        JSON.parse(readFileSync(path, 'utf8')),
      ]),
    ),
    sources: JSON.parse(readFileSync(spec.sources, 'utf8')),
    sourceIdentity: JSON.parse(readFileSync(spec.sourceIdentity, 'utf8')),
    lock: readFileSync(spec.lock),
    serializer: readFileSync(spec.serializer, 'utf8'),
    loader: readFileSync(spec.loader, 'utf8'),
    rustc: readFileSync(spec.rustc),
    patches: Object.fromEntries(
      Object.entries<string>(spec.patches).map(([name, path]) => [name, readFileSync(path)]),
    ),
    rootSources: Object.fromEntries(
      Object.entries<string>(spec.rootSources).map(([path, source]) => [
        path,
        readFileSync(source),
      ]),
    ),
  });
  writeFileSync(jsonOutput, `${canonical(identity)}\n`);
  writeFileSync(envOutput, `OLIPHAUNT_WASIX_RUNTIME_ABI_ID=${identity.runtime_abi_id}\n`);
}
