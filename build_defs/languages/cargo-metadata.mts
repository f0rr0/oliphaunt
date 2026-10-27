import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  cargoSatisfies,
  renderCargoToml as renderToml,
  resolveCargoWorkspaceInheritance,
} from '../../tools/packaging/cargo-manifest.mts';

export {
  cargoSatisfies,
  renderCargoToml as renderToml,
} from '../../tools/packaging/cargo-manifest.mts';

type Table = Record<string, any>;
const dependencySections = ['dependencies', 'dev-dependencies', 'build-dependencies'];

function dependencyTables(manifest: Table): Table[] {
  return [manifest, ...Object.values(manifest.target ?? {})].flatMap((table) =>
    dependencySections.flatMap((section) => (table[section] ? [table[section]] : [])),
  );
}

function inheritedPackage(manifest: Table, workspace: Table): Table {
  return Object.fromEntries(
    Object.entries(manifest.package).map(([key, value]) => [
      key,
      value && typeof value === 'object' && (value as Table).workspace === true
        ? workspace.package?.[key]
        : value,
    ]),
  );
}

export function projectCargoWorkspace(
  workspace: Table,
  lock: Table,
  roots: string[],
  readManifest: (relative: string) => Table,
  sourceExists: (relative: string) => boolean,
  activations: Record<string, string[]> = {},
  workspacePrefix = '',
  acquisitionPatches: Record<string, { path: string; version: string }> = {},
) {
  if (lock.version !== 4) throw new Error('Native Cargo import requires lockfile schema 4');
  if (!workspace.workspace || (workspace.package && !workspacePrefix))
    throw new Error('Native Cargo import requires a conventional workspace');
  if (workspace.patch || workspace.replace)
    throw new Error('Native Cargo import does not yet represent workspace patch/replace sources');
  const releaseKeys = Object.keys(workspace.profile?.release ?? {});
  if (releaseKeys.some((key) => key !== 'strip'))
    throw new Error(
      `Unrepresented authored Cargo release profile fields: ${releaseKeys.join(', ')}`,
    );
  const releaseStrip = workspace.profile?.release?.strip ?? null;
  if (releaseStrip !== null && releaseStrip !== 'symbols')
    throw new Error(`Unsupported conventional Cargo release strip setting: ${releaseStrip}`);
  const members = new Map<string, Table>();
  const declaredMembers = workspace.workspace.members.map((member: string) =>
    path.posix.normalize(path.posix.join(workspacePrefix, member)),
  );
  for (const [name, patch] of Object.entries(acquisitionPatches)) {
    if (
      !/^[A-Za-z0-9_-]+$/u.test(name) ||
      typeof patch.path !== 'string' ||
      !/^[A-Za-z0-9_./+-]+$/u.test(patch.path) ||
      path.posix.isAbsolute(patch.path) ||
      patch.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      typeof patch.version !== 'string' ||
      !Bun.semver.satisfies(patch.version, `=${patch.version}`)
    )
      throw new Error(`Invalid Cargo acquisition patch: ${name}`);
  }
  const candidates = new Map<string, Table[]>();
  for (const item of lock.package)
    candidates.set(item.name, [...(candidates.get(item.name) ?? []), item]);
  function lockedDependency(text: string): Table {
    const identity = /^([^ ]+)(?: ([^ ]+)(?: \(([^)]+)\))?)?$/u.exec(text);
    if (!identity) throw new Error(`Invalid canonical Cargo lock dependency: ${text}`);
    const [, name, version, source] = identity;
    let matches = (candidates.get(name) ?? []).filter(
      (item) => (!version || item.version === version) && (!source || item.source === source),
    );
    // Cargo includes a source qualifier for registry identities when a local
    // package has the same name and version; the unqualified identity is local.
    if (!source && version && matches.length > 1) matches = matches.filter((item) => !item.source);
    if (matches.length !== 1)
      throw new Error(`Missing or ambiguous canonical Cargo lock dependency: ${text}`);
    return matches[0];
  }
  const included = new Set<Table>();
  const pending = roots.length ? [...roots] : [...declaredMembers];
  for (const candidate of pending) {
    const relative = path.posix.normalize(candidate);
    if (relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative))
      throw new Error(`Cargo path dependency escapes the workspace: ${relative}`);
    if (members.has(relative)) continue;
    if (!declaredMembers.includes(relative))
      throw new Error(`Cargo package is not a declared workspace member: ${relative}`);
    const manifest = readManifest(`${relative}/Cargo.toml`);
    if (
      !manifest.package ||
      (manifest.workspace && relative !== workspacePrefix) ||
      manifest.patch ||
      manifest.replace
    )
      throw new Error(`Unsupported Cargo member shape: ${relative}`);
    const copy = resolveCargoWorkspaceInheritance(manifest, workspace.workspace);
    delete copy.workspace;
    const originalDependencyTables = dependencyTables(manifest);
    for (const [index, table] of dependencyTables(copy).entries()) {
      for (const [name, declaration] of Object.entries(table)) {
        const dependency = declaration as Table;
        if (dependency?.path && originalDependencyTables[index]?.[name]?.workspace === true)
          dependency.path = path.posix.relative(
            relative,
            path.posix.join(workspacePrefix, dependency.path),
          );
        const resolved = table[name];
        if (resolved?.path) pending.push(path.posix.join(relative, resolved.path));
      }
    }
    members.set(relative, copy);
    const local = (candidates.get(copy.package.name) ?? []).filter((item) => !item.source);
    if (local.length !== 1)
      throw new Error(`Missing canonical Cargo lock member: ${copy.package.name}`);
    const frontier = [local[0]];
    for (const item of frontier) {
      if (included.has(item)) continue;
      included.add(item);
      const patch = !item.source && acquisitionPatches[item.name];
      if (patch && declaredMembers.includes(patch.path)) pending.push(patch.path);
      for (const dependency of item.dependencies ?? []) frontier.push(lockedDependency(dependency));
    }
  }
  const byName = new Map<string, string>();
  for (const [relative, manifest] of members) {
    if (byName.has(manifest.package.name))
      throw new Error(`Duplicate Cargo package ${manifest.package.name}`);
    byName.set(manifest.package.name, relative);
  }
  const selectedPatches: Record<string, { path: string }> = {};
  for (const item of included) {
    if (item.source) continue;
    const member = byName.get(item.name);
    const patch = acquisitionPatches[item.name];
    if (member) {
      if (
        patch &&
        (patch.path !== member ||
          patch.version !== item.version ||
          patch.version !== members.get(member)?.package.version)
      )
        throw new Error(`Cargo acquisition patch differs from workspace member: ${item.name}`);
    } else if (!patch || patch.version !== item.version || declaredMembers.includes(patch.path))
      throw new Error(`Unrepresented nonworkspace Cargo source: ${item.name} ${item.version}`);
    if (patch) selectedPatches[item.name] = { path: patch.path };
  }
  const facts: Table = {};
  const files: Record<string, string> = {};
  const watched = new Set<string>();
  for (const [relative, sourceManifest] of members) {
    const manifest = structuredClone(sourceManifest);
    const actual = inheritedPackage(manifest, workspace.workspace);
    if (
      typeof actual.version !== 'string' ||
      typeof actual.edition !== 'string' ||
      typeof actual['rust-version'] !== 'string'
    )
      throw new Error(`Missing conventional Cargo version/edition/MSRV: ${relative}`);
    const localLock = (candidates.get(actual.name) ?? []).filter((item) => !item.source);
    if (localLock.length !== 1)
      throw new Error(`Missing canonical Cargo lock member: ${actual.name}`);
    for (const table of dependencyTables(manifest)) {
      for (const [name, declaration] of Object.entries(table)) {
        const dependency = declaration as Table;
        if (!dependency?.path) {
          if (dependency?.git || dependency?.registry)
            throw new Error(
              `Native Cargo import does not yet represent git/custom-registry dependency ${name}`,
            );
          const packageName = dependency?.package ?? name;
          const locked = (localLock[0].dependencies ?? [])
            .map(lockedDependency)
            .filter((item: Table) => item.name === packageName);
          const requirement = typeof declaration === 'string' ? declaration : dependency.version;
          if (
            !requirement ||
            !locked.some((item: Table) => cargoSatisfies(item.version, requirement))
          )
            throw new Error(`Stale canonical Cargo lock dependency: ${actual.name} -> ${name}`);
          continue;
        }
        const dependencyPath = path.posix.normalize(path.posix.join(relative, dependency.path));
        const dependencyManifest = members.get(dependencyPath);
        if (!dependencyManifest) throw new Error(`Missing Cargo path member: ${dependencyPath}`);
        const target = inheritedPackage(dependencyManifest, workspace.workspace);
        if (
          (dependency.package && dependency.package !== target.name) ||
          (!dependency.package && name !== target.name)
        )
          throw new Error(`Cargo path/name mismatch: ${relative} -> ${name}`);
        if (dependency.version && !cargoSatisfies(target.version, dependency.version))
          throw new Error(`Cargo path/version mismatch: ${relative} -> ${name}`);
        dependency.version = '=0.0.0';
      }
    }
    const targetPaths = new Set<string>();
    for (const target of [
      manifest.lib,
      ...(manifest.bin ?? []),
      ...(manifest.test ?? []),
      ...(manifest.example ?? []),
      ...(manifest.bench ?? []),
    ])
      if (target?.path) targetPaths.add(target.path);
    for (const candidate of ['src/lib.rs', 'src/main.rs', 'build.rs']) {
      const file = `${relative}/${candidate}`;
      watched.add(file);
      if (sourceExists(file)) targetPaths.add(candidate);
    }
    // Automatic source discovery must be preserved as a graph input, not discarded.
    for (const directory of ['src/bin', 'tests', 'examples', 'benches'])
      watched.add(`${relative}/${directory}`);
    watched.add(`${relative}/README.md`);
    if (typeof actual.build === 'string') targetPaths.add(actual.build);
    const library =
      manifest.lib?.path ?? (sourceExists(`${relative}/src/lib.rs`) ? 'src/lib.rs' : null);
    facts[relative] = {
      name: actual.name,
      crate_name: (manifest.lib?.name ?? actual.name).replaceAll('-', '_'),
      version: actual.version,
      edition: actual.edition,
      minimum: actual['rust-version'],
      library,
      crate_types: manifest.lib?.['crate-type'] ?? ['rlib'],
      binaries: (manifest.bin ?? []).map((target: Table) => ({
        ...target,
        path: target.path ? path.posix.normalize(target.path) : `src/bin/${target.name}.rs`,
      })),
      readme:
        actual.readme === false
          ? null
          : (actual.readme ?? (sourceExists(`${relative}/README.md`) ? 'README.md' : null)),
      features: structuredClone(manifest.features ?? {}),
      dependencies: structuredClone(manifest.dependencies ?? {}),
      dev_dependencies: structuredClone(manifest['dev-dependencies'] ?? {}),
      build_dependencies: structuredClone(manifest['build-dependencies'] ?? {}),
      target_dependencies: structuredClone(manifest.target ?? {}),
      metadata: actual.metadata ?? {},
      build: actual.build ?? (sourceExists(`${relative}/build.rs`) ? 'build.rs' : false),
      links: actual.links ?? null,
      release_strip: releaseStrip,
    };
    const projectedPackage: Table = {
      name: actual.name,
      version: '0.0.0',
      edition: actual.edition,
      'rust-version': actual['rust-version'],
    };
    for (const key of [
      'build',
      'links',
      'autolib',
      'autobins',
      'autotests',
      'autoexamples',
      'autobenches',
    ])
      if (actual[key] !== undefined) projectedPackage[key] = actual[key];
    manifest.package = projectedPackage;
    for (const feature of activations[relative] ?? []) {
      if (!Object.hasOwn(manifest.features ?? {}, feature))
        throw new Error(`Unknown Cargo tool feature: ${relative}/${feature}`);
      manifest.features.default = [...new Set([...(manifest.features.default ?? []), feature])];
    }
    files[`${relative}/Cargo.toml`] = renderToml(manifest);
    for (const source of [...targetPaths].sort()) {
      if (source.startsWith('../') || path.posix.isAbsolute(source))
        throw new Error(`Cargo target escapes its member: ${relative}/${source}`);
      files[`${relative}/${source}`] = source === 'src/lib.rs' ? '' : 'fn main() {}\n';
    }
  }
  const isMember = (item: Table) => !item.source && byName.has(item.name);
  const projectedLock = {
    version: lock.version,
    package: [...included]
      .map((item) => ({
        ...item,
        ...(isMember(item) ? { version: '0.0.0' } : {}),
        ...(item.dependencies
          ? {
              dependencies: item.dependencies.map((text: string) => {
                const dependency = lockedDependency(text);
                return isMember(dependency) && text.includes(' ')
                  ? `${dependency.name} 0.0.0`
                  : text;
              }),
            }
          : {}),
      }))
      .sort((a, b) => {
        const left = `${a.name}@${a.version}`;
        const right = `${b.name}@${b.version}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  };
  files['Cargo.toml'] = renderToml({
    workspace: {
      members: [...members.keys()].sort(),
      resolver: workspace.workspace.resolver ?? '3',
    },
    ...(Object.keys(selectedPatches).length ? { patch: { 'crates-io': selectedPatches } } : {}),
  });
  files['Cargo.lock'] = renderToml(projectedLock);
  for (const member of Object.keys(activations))
    if (!members.has(member)) throw new Error(`Unknown Cargo tool member: ${member}`);
  return {
    files,
    facts,
    watched: [...watched].sort(),
    manifests: [...members.keys()].map((member) => `${member}/Cargo.toml`).sort(),
  };
}

if (import.meta.main) {
  const [workspaceFile, lockFile, output, ...options] = process.argv.slice(2);
  if (!workspaceFile || !lockFile || !output)
    throw new Error('Expected canonical workspace, lockfile, and output directory');
  const prefixIndex = options.indexOf('--workspace-prefix');
  const workspacePrefix = prefixIndex < 0 ? '' : options.splice(prefixIndex, 2)[1];
  const root = workspacePrefix
    ? path.resolve(path.dirname(workspaceFile), path.relative(workspacePrefix, '.'))
    : path.dirname(workspaceFile);
  const acquisitionIndex = options.indexOf('--acquisition');
  const acquisition =
    acquisitionIndex < 0
      ? { files: {}, members: [], patch: {}, sources: {} }
      : JSON.parse(readFileSync(options.splice(acquisitionIndex, 2)[1], 'utf8'));
  const activationIndex = options.indexOf('--activate');
  const activations = activationIndex < 0 ? {} : JSON.parse(options[activationIndex + 1]);
  const roots = activationIndex < 0 ? options : options.slice(0, activationIndex);
  if (activationIndex >= 0 && activationIndex !== options.length - 2)
    throw new Error('Expected --activate followed by one feature-map JSON argument');
  const workspace = Bun.TOML.parse(readFileSync(workspaceFile, 'utf8'));
  workspace.workspace.members.push(...acquisition.members);
  const result = projectCargoWorkspace(
    workspace,
    Bun.TOML.parse(readFileSync(lockFile, 'utf8')),
    roots,
    (relative) =>
      Bun.TOML.parse(
        acquisition.files[relative] ?? readFileSync(path.join(root, relative), 'utf8'),
      ),
    (relative) =>
      Object.hasOwn(acquisition.files, relative) || existsSync(path.join(root, relative)),
    activations,
    workspacePrefix,
    acquisition.patch,
  );
  // Generated acquisition stubs precede the ordinary workspace projection: its
  // zeroed delivery-member manifests must be the ones Cargo actually resolves.
  for (const [relative, text] of Object.entries({ ...acquisition.files, ...result.files })) {
    const destination = path.join(output, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text as string);
  }
  const selected = new Set(
    Bun.TOML.parse(result.files['Cargo.lock'])
      .package.filter((item: Table) => !item.source)
      .map((item: Table) => `${item.name} ${item.version}`),
  );
  const sources = Object.fromEntries(
    Object.entries(acquisition.sources).filter(([identity]) => selected.has(identity)),
  );
  console.log(
    JSON.stringify({
      facts: result.facts,
      watched: [...new Set([...result.manifests, ...result.watched])].filter(
        (relative) =>
          !Object.hasOwn(acquisition.files, relative) &&
          !acquisition.members.some((member: string) => relative.startsWith(`${member}/`)),
      ),
      manifests: result.manifests,
      sources,
    }),
  );
}
