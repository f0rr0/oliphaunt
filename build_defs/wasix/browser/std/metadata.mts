import { dirname, join, relative } from 'node:path';

type Target = { name: string; kind: string[]; src_path: string; edition: string };
type Package = {
  id: string;
  name: string;
  version: string;
  manifest_path: string;
  targets: Target[];
  authors: string[];
  description: string | null;
  license: string | null;
  repository: string | null;
};
type Node = {
  id: string;
  features: string[];
  deps: { name: string; pkg: string; dep_kinds: { kind: string | null }[] }[];
};
type Metadata = { packages: Package[]; resolve: { nodes: Node[] } };
type Profile = {
  'opt-level'?: number | string;
  debug?: number;
  'codegen-units'?: number;
  rustflags?: string[];
};

function releaseProfile(profile: Profile): Profile {
  if (
    Object.keys(profile).some(
      (key) => !['opt-level', 'debug', 'codegen-units', 'rustflags'].includes(key),
    )
  )
    throw new Error('Unsupported conventional standard-library package profile');
  if (
    profile['opt-level'] !== undefined &&
    !['0', '1', '2', '3', 's', 'z'].includes(String(profile['opt-level']))
  )
    throw new Error('Invalid conventional standard-library optimization profile');
  if (profile.debug !== undefined && profile.debug !== 0)
    throw new Error(
      'Standard-library debug profile requires an explicit native construction recipe',
    );
  if (
    profile['codegen-units'] !== undefined &&
    (!Number.isSafeInteger(profile['codegen-units']) || profile['codegen-units'] < 1)
  )
    throw new Error('Invalid conventional standard-library codegen units');
  if (
    profile.rustflags !== undefined &&
    (!Array.isArray(profile.rustflags) ||
      profile.rustflags.some((flag) => typeof flag !== 'string'))
  )
    throw new Error('Invalid conventional standard-library rustflags');
  return profile;
}

function localPath(root: string, path: string): string {
  const result = relative(root, path).replaceAll('\\', '/');
  if (!result || result === '..' || result.startsWith('../') || result.startsWith('/')) {
    throw new Error(`Standard-library input escapes the immutable repository: ${path}`);
  }
  return result;
}

export function standardLibraryGraph(
  metadata: Metadata,
  root: string,
  profiles: Record<string, Profile> = {},
) {
  const packages = new Map(metadata.packages.map((row) => [row.id, row]));
  const nodes = new Map(metadata.resolve.nodes.map((row) => [row.id, row]));
  const roots = ['std', 'panic_abort'].map((name) => {
    const matching = metadata.packages.filter((row) => row.name === name);
    if (matching.length !== 1) throw new Error(`Expected exactly one locked ${name} crate`);
    return matching[0].id;
  });
  const required = new Set<string>();
  const pending = [...roots];
  for (const id of pending) {
    if (required.has(id)) continue;
    required.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Missing locked standard-library resolution: ${id}`);
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some((kind) => kind.kind === 'build')) {
        throw new Error(
          'Standard-library native build dependencies require an explicit host compiler graph',
        );
      }
      if (dependency.dep_kinds.some((kind) => kind.kind === null)) pending.push(dependency.pkg);
    }
  }
  const names = new Set<string>();
  const rows = [...required].map((id) => {
    const pkg = packages.get(id);
    const node = nodes.get(id);
    if (!pkg || !node || names.has(pkg.name))
      throw new Error('Ambiguous locked standard-library crate identity');
    names.add(pkg.name);
    const libraries = pkg.targets.filter((target) =>
      target.kind.some((kind) => ['lib', 'rlib', 'dylib'].includes(kind)),
    );
    const scripts = pkg.targets.filter((target) => target.kind.includes('custom-build'));
    if (libraries.length !== 1 || scripts.length > 1)
      throw new Error(`Unsupported standard-library targets for ${pkg.name}`);
    const directory = localPath(root, dirname(pkg.manifest_path));
    const env = {
      CARGO_PKG_NAME: pkg.name,
      CARGO_PKG_VERSION: pkg.version,
      CARGO_PKG_VERSION_MAJOR: pkg.version.split('.')[0],
      CARGO_PKG_VERSION_MINOR: pkg.version.split('.')[1],
      CARGO_PKG_VERSION_PATCH: pkg.version.split('.')[2].split('-')[0],
      CARGO_PKG_VERSION_PRE: pkg.version.includes('-')
        ? pkg.version.split('-').slice(1).join('-')
        : '',
      CARGO_PKG_AUTHORS: pkg.authors.join(':'),
      CARGO_PKG_DESCRIPTION: pkg.description ?? '',
      CARGO_PKG_LICENSE: pkg.license ?? '',
      CARGO_PKG_REPOSITORY: pkg.repository ?? '',
    };
    return {
      name: pkg.name.replaceAll('-', '_'),
      crate_name: libraries[0].name,
      version: pkg.version,
      directory,
      root: localPath(root, libraries[0].src_path),
      edition: libraries[0].edition,
      build: scripts.length ? localPath(root, scripts[0].src_path) : null,
      features: [...node.features].sort(),
      profile: releaseProfile(profiles[pkg.name] ?? {}),
      deps: Object.fromEntries(
        node.deps
          .filter((dependency) => dependency.dep_kinds.some((kind) => kind.kind === null))
          .map((dependency) => {
            const dependencyPackage = packages.get(dependency.pkg);
            if (!dependencyPackage)
              throw new Error(`Missing locked standard-library package: ${dependency.pkg}`);
            return [dependency.name, dependencyPackage.name.replaceAll('-', '_')];
          }),
      ),
      env,
    };
  });
  return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

if (import.meta.main) {
  const [, , input, root, host] = process.argv;
  if (input === 'dist') {
    const dist = Bun.TOML.parse(await Bun.file(root).text()) as {
      pkg: Record<
        string,
        {
          git_commit_hash: string;
          target: Record<string, { xz_url: string; xz_hash: string; available: boolean }>;
        }
      >;
    };
    const archives = Object.fromEntries(
      ['rustc', 'cargo'].map((name) => {
        const row = dist.pkg[name].target[host];
        if (!row?.available || !row.xz_url || !row.xz_hash)
          throw new Error(`Unavailable pinned nightly metadata host ${host}`);
        return [name, { url: row.xz_url, sha256: row.xz_hash }];
      }),
    );
    process.stdout.write(JSON.stringify(archives));
  } else {
    const manifest = Bun.TOML.parse(
      await Bun.file(join(root, 'sources/lib/rustlib/src/rust/library/Cargo.toml')).text(),
    ) as { profile: { release: { package: Record<string, Profile> } } };
    if (Object.keys(manifest.profile.release).some((key) => key !== 'package'))
      throw new Error(
        'Standard-library global profile requires an explicit native construction recipe',
      );
    process.stdout.write(
      JSON.stringify(
        standardLibraryGraph(await Bun.file(input).json(), root, manifest.profile.release.package),
      ),
    );
  }
}
