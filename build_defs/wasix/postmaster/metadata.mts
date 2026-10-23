import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
      /^[A-Za-z0-9_./+-]+$/u.test(value) &&
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

/** Import every genuine path-source row; standard Cargo selects the role's closure. */
export function postmasterCargoSources(
  lock: Table,
  ownPackage: Table,
  source: ReturnType<typeof postmasterSource>,
  canonicalPatch: string,
  readManifest: (relative: string) => Table,
) {
  assert.equal(lock.version, 4);
  const ownRows = lock.package.filter(
    (row: Table) => row.name === ownPackage.name && row.version === ownPackage.version,
  );
  assert.equal(
    ownRows.length,
    1,
    'Canonical executor package must match its Cargo lock exactly once',
  );
  assert.equal(ownRows[0].source, undefined, 'Canonical executor must retain its path source');
  const workspace = readManifest('Cargo.toml').workspace;
  assert(Array.isArray(workspace?.members), 'Expected the pinned Wasmer workspace');
  const members = workspace.members.map((directory: string) => {
    normalized(directory);
    return {
      directory,
      manifest: resolveCargoWorkspaceInheritance(
        readManifest(`${directory}/Cargo.toml`),
        workspace,
      ),
    };
  });
  const sources: Table = {};
  const patches: Record<string, string> = {};
  for (const pkg of lock.package) {
    if (
      pkg.source !== undefined ||
      (pkg.name === ownPackage.name && pkg.version === ownPackage.version)
    )
      continue;
    const id = `${pkg.name} ${pkg.version}`;
    assert(/^[A-Za-z0-9_-]+$/u.test(pkg.name), `Unsafe Cargo package name ${pkg.name}`);
    assert(!Object.hasOwn(sources, id), `Duplicate canonical path package ${id}`);
    const resolutions = lock.package.filter(
      (row: Table) => row.name === pkg.name && row.version === pkg.version,
    );
    assert.equal(resolutions.length, 1, `Ambiguous canonical source identity ${id}`);
    const matching = members.filter(
      ({ manifest }: Table) =>
        manifest.package.name === pkg.name && manifest.package.version === pkg.version,
    );
    assert.equal(matching.length, 1, `Expected one immutable workspace member ${id}`);
    const directory = matching[0].directory;
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
  assert(Object.keys(sources).length, 'Canonical Cargo lock contains no patched path sources');
  return { sources, patches };
}

/** Metadata target placeholders come from the authored manifest and existing sources. */
export function postmasterCargoTargets(manifest: Table, exists: (relative: string) => boolean) {
  const targets: string[] = [];
  for (const row of [
    ...(manifest.bin ?? []),
    ...(manifest.example ?? []),
    ...(manifest.test ?? []),
    ...(manifest.bench ?? []),
  ]) {
    const relative = normalized(row.path);
    assert(exists(relative), `Missing canonical Cargo target ${relative}`);
    targets.push(relative);
  }
  const library = manifest.lib?.path ?? 'src/lib.rs';
  if (manifest.lib || exists(library)) {
    normalized(library);
    assert(exists(library), `Missing canonical Cargo target ${library}`);
    targets.push(library);
  }
  const build = manifest.package.build;
  if (build !== false && (typeof build === 'string' || exists('build.rs'))) {
    const relative = normalized(build ?? 'build.rs');
    assert(exists(relative), `Missing canonical Cargo target ${relative}`);
    targets.push(relative);
  }
  assert(targets.length, 'Canonical Cargo package has no source targets');
  return [...new Set(targets)].sort();
}

if (import.meta.main) {
  if (Bun.argv[2] === 'source') {
    const [, sourcePin, expectedCommit, sha256] = Bun.argv.slice(2);
    const pin = Bun.TOML.parse(readFileSync(sourcePin, 'utf8'));
    assert.equal(pin.commit, expectedCommit, 'Source pin changed; verify its immutable archive');
    console.log(JSON.stringify(postmasterSource(pin, sha256)));
    process.exit(0);
  }
  const [command, workspaceFile, lockFile, wasmerFile, sourceFile, patchFile, output, rolesJson] =
    Bun.argv.slice(2);
  assert(
    command === 'cargo' &&
      workspaceFile &&
      lockFile &&
      wasmerFile &&
      sourceFile &&
      patchFile &&
      output &&
      rolesJson,
  );
  const original = Bun.TOML.parse(readFileSync(workspaceFile, 'utf8'));
  const lockBytes = readFileSync(lockFile);
  const lock = Bun.TOML.parse(lockBytes.toString('utf8'));
  const sourceRoot = path.dirname(wasmerFile);
  const readManifest = (relative: string) =>
    Bun.TOML.parse(readFileSync(path.join(sourceRoot, relative), 'utf8'));
  const workspace = readManifest('Cargo.toml').workspace;
  const projection = postmasterCargoSources(
    lock,
    original.package,
    JSON.parse(readFileSync(sourceFile, 'utf8')).wasmer,
    readFileSync(patchFile, 'utf8'),
    readManifest,
  );
  const targets = postmasterCargoTargets(original, (relative) =>
    existsSync(path.join(path.dirname(workspaceFile), relative)),
  );
  const roles = JSON.parse(rolesJson);
  assert(Object.keys(roles).length, 'Canonical binary role selections required');
  for (const [role, binary] of Object.entries(roles) as [string, string][]) {
    assert.equal(normalized(role).split('/').length, 1, 'Cargo role must name one directory');
    const directory = path.join(output, role);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'Cargo.toml'),
      postmasterCargoManifest(original, lock, workspace, readManifest, binary),
    );
    writeFileSync(path.join(directory, 'Cargo.lock'), lockBytes);
    for (const target of targets) {
      const file = path.join(directory, target);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
  }
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
      manifests: workspace.members.map((member: string) => `${member}/Cargo.toml`),
      targets,
    }),
  );
}
