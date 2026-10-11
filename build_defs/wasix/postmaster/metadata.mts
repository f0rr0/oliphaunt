import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  renderCargoToml,
  resolveCargoWorkspaceInheritance,
} from '../../../tools/packaging/cargo-manifest.mts';

type Table = Record<string, any>;

export function postmasterSource(pin: Table, sha256: string) {
  const upstream = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)\.git$/u.exec(pin.url ?? '');
  assert(upstream && /^[a-f0-9]{40}$/u.test(pin.commit), 'Immutable GitHub source required');
  assert(/^[a-f0-9]{64}$/u.test(sha256), 'Immutable source archive digest required');
  return {
    url: `https://codeload.github.com/${upstream[1]}/${upstream[2]}/tar.gz/${pin.commit}`,
    sha256,
    strip_prefix: `${upstream[2]}-${pin.commit}`,
    commit: pin.commit,
  };
}

function normalized(value: string) {
  assert(
    typeof value === 'string' &&
      value &&
      !value.includes('\\') &&
      !path.posix.isAbsolute(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Unsafe source path: ${value}`,
  );
  return value;
}

/** Keep complete diff sections and hunk bytes, changing only the leaf path prefix. */
export function postmasterLeafPatch(original: string, directory: string): string {
  const prefix = `${normalized(directory)}/`;
  assert(original.startsWith('diff --git '), 'Expected canonical Git patch sections');
  const result: string[] = [];
  for (const section of original.split(/(?=^diff --git )/mu)) {
    if (!section) continue;
    const paths = /^diff --git a\/([^\n ]+) b\/([^\n ]+)\n/u.exec(section);
    assert(paths, 'Unsupported canonical Git patch path');
    normalized(paths[1]);
    normalized(paths[2]);
    const before = paths[1].startsWith(prefix);
    const after = paths[2].startsWith(prefix);
    assert.equal(before, after, 'Canonical patch crosses a crate source boundary');
    if (!before) continue;
    assert(!/^rename (?:from|to) /mu.test(section), 'Crate patch renames require explicit support');
    result.push(
      section
        .replace(
          paths[0],
          `diff --git a/${paths[1].slice(prefix.length)} b/${paths[2].slice(prefix.length)}\n`,
        )
        .replace(
          new RegExp(
            `^(--- a/|\\+\\+\\+ b/)${prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`,
            'gm',
          ),
          '$1',
        ),
    );
  }
  return result.join('');
}

/** Select the authored binary's features; Cargo remains the dependency/feature resolver. */
export function postmasterRoleManifest(original: Table, binary: string): string {
  assert(original.package && original.workspace, 'Expected the canonical standalone executor');
  assert.deepEqual(original.features?.default, [], 'Executor default features must remain empty');
  const binaries = original.bin?.filter((row: Table) => row.name === binary);
  assert.equal(binaries?.length, 1, `Expected one canonical binary ${binary}`);
  const features = binaries[0]['required-features'];
  assert(Array.isArray(features) && features.length, 'Canonical binary features required');
  for (const feature of features)
    assert(
      Object.hasOwn(original.features, feature),
      `Unknown canonical binary feature ${feature}`,
    );
  const result = structuredClone(original);
  delete result.workspace;
  result.features.default = [...features];
  return renderCargoToml(result);
}

/** Move only the conventional path patches into a self-contained Cargo workspace. */
export function postmasterCargoManifest(
  original: Table,
  lock: Table,
  wasmerWorkspace: Table,
  readManifest: (relative: string) => Table,
  binary: string,
): string {
  assert.equal(lock.version, 4);
  assert(!original.patch && !original.replace, 'Unexpected authored executor source override');
  assert.deepEqual(original.workspace, {}, 'Expected the conventional standalone workspace');
  const local = new Map<string, Table>();
  for (const member of wasmerWorkspace.members) {
    normalized(member);
    const manifest = resolveCargoWorkspaceInheritance(
      readManifest(`${member}/Cargo.toml`),
      wasmerWorkspace,
    );
    const pkg = manifest.package;
    assert(!local.has(pkg.name), `Duplicate pinned workspace package ${pkg.name}`);
    local.set(pkg.name, { ...pkg, member });
  }
  const patches: Table = {};
  for (const table of [original, ...Object.values(original.target ?? {})] as Table[]) {
    for (const section of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
      for (const [name, dependency] of Object.entries(table[section] ?? {}) as [string, Table][]) {
        const pkg = local.get(dependency?.package ?? name);
        if (!pkg) continue;
        const resolutions = lock.package.filter(
          (row: Table) => row.name === pkg.name && row.version === pkg.version,
        );
        assert.equal(resolutions.length, 1, `Expected canonical local resolution ${pkg.name}`);
        assert.equal(
          resolutions[0].source,
          undefined,
          `Expected canonical path source ${pkg.name}`,
        );
        assert.equal(dependency.version, `=${pkg.version}`, `Stale executor pin ${name}`);
        patches[pkg.name] = { path: `wasmer/${pkg.member}` };
      }
    }
  }
  assert(Object.keys(patches).length, 'No canonical Wasmer path dependencies');
  const result = Bun.TOML.parse(postmasterRoleManifest(original, binary));
  result.workspace = { exclude: ['wasmer'] };
  result.patch = { 'crates-io': patches };
  return renderCargoToml(result);
}

/** Export only local crates actually selected by standard locked Cargo metadata. */
export function postmasterCargoSources(
  metadata: Table,
  lock: Table,
  sourceRoot: string,
  source: ReturnType<typeof postmasterSource>,
  canonicalPatch: string,
  readManifest: (relative: string) => Table,
) {
  assert.equal(lock.version, 4);
  assert.equal(metadata.workspace_members?.length, 1, 'Expected one canonical executor member');
  const workspace = readManifest('Cargo.toml').workspace;
  assert(workspace?.members, 'Expected the pinned Wasmer workspace');
  const root = path.resolve(sourceRoot);
  const sources: Table = {};
  const patches: Record<string, string> = {};
  for (const pkg of metadata.packages) {
    if (pkg.source !== null || metadata.workspace_members.includes(pkg.id)) continue;
    const relative = normalized(path.relative(root, pkg.manifest_path).split(path.sep).join('/'));
    assert(relative.endsWith('/Cargo.toml'), 'Expected a canonical crate manifest');
    const directory = relative.slice(0, -'/Cargo.toml'.length);
    assert(
      workspace.members.includes(directory),
      `Crate is outside the pinned workspace: ${directory}`,
    );
    const manifest = resolveCargoWorkspaceInheritance(readManifest(relative), workspace);
    assert.equal(pkg.name, manifest.package.name);
    assert.equal(pkg.version, manifest.package.version);
    const id = `${pkg.name} ${pkg.version}`;
    assert(!Object.hasOwn(sources, id), `Duplicate canonical path package ${id}`);
    const resolutions = lock.package.filter(
      (row: Table) => row.name === pkg.name && row.version === pkg.version,
    );
    assert.equal(resolutions.length, 1, `Expected one canonical locked path package ${id}`);
    assert.equal(resolutions[0].source, undefined, `Expected canonical path source ${id}`);
    const patch = postmasterLeafPatch(canonicalPatch, directory);
    const patchPath = `patches/cargo/${pkg.name}.patch`;
    if (patch) patches[patchPath] = patch;
    sources[id] = {
      url: source.url,
      sha256: source.sha256,
      strip_prefix: `${source.strip_prefix}/${directory}`,
      patches: patch ? [patchPath] : [],
    };
  }
  assert(Object.keys(sources).length, 'Locked Cargo metadata selected no patched sources');
  return { sources, patches };
}

if (import.meta.main) {
  if (Bun.argv[2] === 'source') {
    const [, sourcePin, expectedCommit, sha256] = Bun.argv.slice(2);
    const pin = Bun.TOML.parse(readFileSync(sourcePin, 'utf8'));
    assert.equal(pin.commit, expectedCommit, 'Source pin changed; verify its immutable archive');
    console.log(JSON.stringify(postmasterSource(pin, sha256)));
    process.exit(0);
  }
  const [metadataFile, lockFile, sourceRoot, sourcePin, sha256, patchFile, output] =
    Bun.argv.slice(2);
  assert(metadataFile && lockFile && sourceRoot && sourcePin && sha256 && patchFile && output);
  const projection = postmasterCargoSources(
    JSON.parse(readFileSync(metadataFile, 'utf8')),
    Bun.TOML.parse(readFileSync(lockFile, 'utf8')),
    sourceRoot,
    postmasterSource(Bun.TOML.parse(readFileSync(sourcePin, 'utf8')), sha256),
    readFileSync(patchFile, 'utf8'),
    (relative) => Bun.TOML.parse(readFileSync(path.join(sourceRoot, relative), 'utf8')),
  );
  mkdirSync(output, { recursive: true });
  for (const [relative, content] of Object.entries(projection.patches)) {
    const file = path.join(output, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(
    path.join(output, 'cargo-sources.json'),
    `${JSON.stringify(projection.sources, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      packages: Object.keys(projection.sources),
      patches: Object.keys(projection.patches),
    }),
  );
}
