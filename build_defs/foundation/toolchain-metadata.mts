import { readFileSync } from 'node:fs';
import {
  platformCompatibilityContract,
  platformCompatibilityTargets,
} from '../../tools/release/platform-compatibility-policy.mts';
import { appleDeploymentTargets } from '../host/deployment-policy.mts';

export function mobileRustTargets(): string[] {
  const apple = platformCompatibilityContract('ios-xcframework');
  if (
    apple.architecture !== 'arm64' ||
    apple.apple.requiredPlatforms.join(',') !== 'macos,ios,iosSimulator'
  )
    throw new Error('Unsupported Apple slice contract for Rust target acquisition');
  return [
    'aarch64-apple-ios',
    'aarch64-apple-ios-sim',
    ...(['android-arm64-v8a', 'android-x86_64'] as const).map((target) => {
      const contract = platformCompatibilityContract(target);
      if (contract.format !== 'elf') throw new Error(`Unsupported ${target} format`);
      if (contract.architecture === 'arm64') return 'aarch64-linux-android';
      if (contract.architecture === 'x64') return 'x86_64-linux-android';
      throw new Error(`Unsupported ${target} architecture`);
    }),
  ];
}

type LockRecord = [string, string, { dependencies?: Record<string, string> }, string];

export function importToolchainMetadata(
  versions: Record<string, string>,
  rust: { toolchain: { channel: string } },
  root: { workspaces: { catalog?: Record<string, string> }; overrides?: Record<string, string> },
  query: { name: string; type?: string; devDependencies: Record<string, string> },
  lock: {
    lockfileVersion: number;
    configVersion: number;
    catalog?: Record<string, string>;
    workspaces: Record<string, { name: string; devDependencies?: Record<string, string> }>;
    packages: Record<string, LockRecord>;
  },
  cargo: {
    workspace: { package: { edition: string; 'rust-version': string; [key: string]: unknown } };
  },
  queryRust: {
    package: {
      name: string;
      version: string;
      edition: { workspace: boolean };
      'rust-version': { workspace: boolean };
      build?: false;
      [key: string]: unknown;
    };
    [section: string]: unknown;
  },
) {
  if (
    queryRust.package.edition?.workspace !== true ||
    queryRust.package['rust-version']?.workspace !== true
  )
    throw new Error('Native query Rust currently requires workspace edition and rust-version');
  for (const section of [
    'dependencies',
    'dev-dependencies',
    'build-dependencies',
    'target',
    'features',
    'lib',
    'bin',
    'test',
    'example',
    'bench',
    'workspace',
  ])
    if (queryRust[section] && Object.keys(queryRust[section] as object).length)
      throw new Error(`Native query Rust does not yet support Cargo [${section}]`);
  if (queryRust.package.build !== undefined && queryRust.package.build !== false)
    throw new Error('Native query Rust does not yet support a Cargo build script');
  if (queryRust.package.links !== undefined)
    throw new Error('Native query Rust does not yet support Cargo package.links');
  if (queryRust.package.autolib === false)
    throw new Error('Native query Rust requires the default Cargo library target');
  if (lock.lockfileVersion !== 2 || lock.configVersion !== 1)
    throw new Error('Unsupported Bun lockfile schema; update the bounded import before using it');
  if (lock.workspaces['src/query/ts']?.name !== query.name)
    throw new Error('bun.lock query workspace does not match its package.json');

  function record(packageName: string, parent: string, requirement: string) {
    if (root.overrides?.[packageName])
      throw new Error(`Query lock import does not support an override for ${packageName}`);
    const key =
      `${parent}/${packageName}` in lock.packages ? `${parent}/${packageName}` : packageName;
    const row = lock.packages[key];
    if (!row?.[0].startsWith(`${packageName}@`) || !row[3]?.startsWith('sha512-'))
      throw new Error(`Missing integrity-bearing lock record for ${key}`);
    const version = row[0].slice(packageName.length + 1);
    if (!Bun.semver.satisfies(version, requirement))
      throw new Error(`Locked ${key}@${version} does not satisfy ${requirement}`);
    return { key, row, package: packageName, version, integrity: row[3] };
  }

  function direct(packageName: string) {
    let requirement = query.devDependencies[packageName];
    if (lock.workspaces['src/query/ts'].devDependencies?.[packageName] !== requirement)
      throw new Error(`bun.lock has a stale query declaration for ${packageName}`);
    if (requirement === 'catalog:') {
      requirement = root.workspaces.catalog?.[packageName] ?? '';
      if (lock.catalog?.[packageName] !== requirement)
        throw new Error(`bun.lock has a stale catalog declaration for ${packageName}`);
    }
    if (!requirement) throw new Error(`Missing query requirement for ${packageName}`);
    return record(packageName, query.name, requirement);
  }

  const typescript = direct('typescript');
  const typesNode = direct('@types/node');
  const undiciRequirement = typesNode.row[2].dependencies?.['undici-types'];
  if (!undiciRequirement) throw new Error('Locked @types/node has no undici-types dependency');
  const undiciTypes = record('undici-types', typesNode.key, undiciRequirement);
  const projection = ({ package: name, version, integrity }: ReturnType<typeof record>) => ({
    package: name,
    version,
    integrity,
  });
  if (!/^\d+\.\d+\.\d+$/.test(rust.toolchain.channel) || !/^\d+\.\d+\.\d+$/.test(versions.node))
    throw new Error('Rust and Node toolchains require exact versions');
  if (!Bun.semver.satisfies(rust.toolchain.channel, `>=${cargo.workspace.package['rust-version']}`))
    throw new Error('Pinned Rust toolchain is below the Cargo workspace rust-version');
  const version = queryRust.package.version;
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([\dA-Za-z.-]+))?(?:\+[\dA-Za-z.-]+)?$/.exec(version);
  if (!semver) throw new Error('Query Cargo package requires an explicit semantic version');
  function inherited(name: string) {
    const value = queryRust.package[name];
    return value && typeof value === 'object' && 'workspace' in value && value.workspace === true
      ? cargo.workspace.package[name]
      : value;
  }
  function scalar(name: string) {
    const value = inherited(name);
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new Error(`Unsupported query Cargo package.${name}`);
    return value;
  }
  const authors = inherited('authors') ?? [];
  if (!Array.isArray(authors) || !authors.every((author) => typeof author === 'string'))
    throw new Error('Query Cargo authors must be strings');
  const cargoEnv = {
    CARGO_PKG_NAME: queryRust.package.name,
    CARGO_PKG_VERSION: version,
    CARGO_PKG_VERSION_MAJOR: semver[1],
    CARGO_PKG_VERSION_MINOR: semver[2],
    CARGO_PKG_VERSION_PATCH: semver[3],
    CARGO_PKG_VERSION_PRE: semver[4] ?? '',
    CARGO_PKG_AUTHORS: authors.join(':'),
    CARGO_PKG_DESCRIPTION: scalar('description'),
    CARGO_PKG_HOMEPAGE: scalar('homepage'),
    CARGO_PKG_REPOSITORY: scalar('repository'),
    CARGO_PKG_LICENSE: scalar('license'),
    CARGO_PKG_LICENSE_FILE: scalar('license-file'),
    CARGO_PKG_README: scalar('readme'),
    CARGO_PKG_RUST_VERSION: cargo.workspace.package['rust-version'],
  };
  return {
    apple_deployment_targets: appleDeploymentTargets(),
    android_platforms: Object.fromEntries(
      platformCompatibilityTargets()
        .filter((target) => target.startsWith('android-'))
        .map((target) => [
          target,
          { api: platformCompatibilityContract(target).elf.androidApiLevel },
        ]),
    ),
    node: versions.node,
    bun: versions.bun,
    typescript: projection(typescript),
    // Only this projection is read by the language acquisition extension.
    language_acquisition: {
      rust: rust.toolchain.channel,
      rust_targets: mobileRustTargets(),
      edition: cargo.workspace.package.edition,
      types_node: projection(typesNode),
      undici_types: projection(undiciTypes),
    },
    query_npm_name: query.name,
    query_package_type: query.type ?? 'commonjs',
    query_rust: {
      crate_name: queryRust.package.name.replaceAll('-', '_'),
      edition: cargo.workspace.package.edition,
      minimum: cargo.workspace.package['rust-version'],
      version,
      env: cargoEnv,
    },
  };
}

if (import.meta.main) {
  const [versions, rust, root, query, lockfile, cargo, queryRust] = process.argv.slice(2);
  if (!versions || !rust || !root || !query || !lockfile || !cargo || !queryRust)
    throw new Error(
      'Expected toolchain and workspace manifests, lockfile, and query Rust manifest',
    );
  const pins = Bun.TOML.parse(readFileSync(versions, 'utf8'));
  if (process.versions.bun !== pins.bun)
    throw new Error('Bun acquisition manifest does not match .prototools');
  console.log(
    JSON.stringify(
      importToolchainMetadata(
        pins,
        Bun.TOML.parse(readFileSync(rust, 'utf8')) as Parameters<typeof importToolchainMetadata>[1],
        JSON.parse(readFileSync(root, 'utf8')),
        JSON.parse(readFileSync(query, 'utf8')),
        Bun.JSONC.parse(readFileSync(lockfile, 'utf8')),
        Bun.TOML.parse(readFileSync(cargo, 'utf8')) as Parameters<
          typeof importToolchainMetadata
        >[5],
        Bun.TOML.parse(readFileSync(queryRust, 'utf8')) as Parameters<
          typeof importToolchainMetadata
        >[6],
      ),
    ),
  );
}
