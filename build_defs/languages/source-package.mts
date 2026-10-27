import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  renderCargoToml as renderToml,
  resolveCargoWorkspaceInheritance,
} from '../../tools/packaging/cargo-manifest.mts';
import {
  cargoPackageRelativePathParts,
  packageGeneratedCargoSource,
} from '../../tools/packaging/cargo-source-package.mts';
import {
  assertSameNativeTargetSet,
  renderUnsupportedNativeTargetGuard,
  rustNativeTargetCfg,
} from '../../tools/packaging/rust-native-targets.mts';

type Table = Record<string, any>;
export type SourceMetadata = {
  product: string;
  version: string;
  compatibility: Record<string, string>;
  dependencyOwners: Record<string, string>;
  nativeArtifacts?: { sourceProduct: string; target: string; packageName: string }[];
  brokerArtifacts?: { sourceProduct: string; target: string; packageName: string }[];
};

const CARGO_VIRTUAL_FILES = new Set(['Cargo.lock', 'Cargo.toml.orig', '.cargo_vcs_info.json']);

export function selectedSourceEntries(listing: string, entries: Record<string, Uint8Array>) {
  const selected: Record<string, Uint8Array> = {};
  const names = listing.trim().replaceAll('\\', '/').split(/\r?\n/);
  for (const name of names) {
    if (CARGO_VIRTUAL_FILES.has(name)) continue;
    if (!Object.hasOwn(entries, name))
      throw new Error(`Cargo listed undeclared public source input ${name}`);
    if (Object.hasOwn(selected, name))
      throw new Error(`Cargo repeated public source input ${name}`);
    selected[name] = entries[name];
  }
  if (!selected['Cargo.toml']) throw new Error('Cargo source inventory omitted its manifest');
  return selected;
}

async function conventionalSourceEntries(cargo: string, entries: Record<string, Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-cargo-inventory-'));
  try {
    const source = join(directory, 'source');
    for (const [name, bytes] of Object.entries(entries)) {
      const destination = join(source, name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const home = join(directory, 'home');
    await mkdir(home);
    const child = Bun.spawn(
      [
        resolve(cargo),
        'package',
        '--offline',
        '--no-verify',
        '--list',
        '--manifest-path',
        join(source, 'Cargo.toml'),
      ],
      {
        env: { PATH: '', HOME: home, CARGO_HOME: home, CARGO_NET_OFFLINE: 'true' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`Conventional Cargo source inventory failed: ${stderr}`);
    return selectedSourceEntries(stdout, entries);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function sourceManifest(
  original: string,
  workspaceText: string,
  metadata: SourceMetadata,
): Table {
  const manifest: Table = resolveCargoWorkspaceInheritance(
    Bun.TOML.parse(original),
    Bun.TOML.parse(workspaceText).workspace ?? {},
  );
  if (!manifest.package || manifest.package.version !== metadata.version)
    throw new Error(`Source package version disagrees with ${metadata.product} owner`);
  for (const table of [manifest, ...Object.values(manifest.target ?? {})] as Table[]) {
    for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      if (!table[section]) continue;
      for (const [name, dependency] of Object.entries(table[section]) as [
        string,
        Table | string,
      ][]) {
        if (typeof dependency === 'string' || !dependency.path) continue;
        delete dependency.path;
        if (typeof dependency.version !== 'string')
          throw new Error(`Unversioned public Cargo dependency ${name}`);
        if (dependency.version === '*') {
          const owner = metadata.dependencyOwners[dependency.package ?? name];
          const version = metadata.compatibility[owner];
          if (!version) throw new Error(`Missing installed compatibility pin for ${name}`);
          dependency.version = `=${version}`;
        }
      }
    }
  }
  // Isolate the conventional consumer from a surrounding checkout workspace.
  delete manifest.package.workspace;
  manifest.workspace = {};
  if (metadata.nativeArtifacts || metadata.brokerArtifacts) {
    const native = metadata.nativeArtifacts ?? [];
    const broker = metadata.brokerArtifacts ?? [];
    assertSameNativeTargetSet(
      'Rust SDK native runtime/broker',
      native.map((row) => row.target),
      broker.map((row) => row.target),
    );
    manifest.target ??= {};
    for (const row of [...native, ...broker]) {
      const version = metadata.compatibility[row.sourceProduct];
      if (!version) throw new Error(`Missing installed compatibility pin for ${row.sourceProduct}`);
      const condition = `cfg(${rustNativeTargetCfg(row.target)})`;
      manifest.target[condition] ??= {};
      manifest.target[condition].dependencies ??= {};
      if (manifest.target[condition].dependencies[row.packageName])
        throw new Error(`Duplicate generated Cargo dependency ${row.packageName}`);
      manifest.target[condition].dependencies[row.packageName] = { version: `=${version}` };
    }
  }
  return manifest;
}

export async function sourceEnvelope(
  manifestPath: string,
  workspacePath: string,
  mapping: Record<string, string>,
  metadata: SourceMetadata,
  cargo?: string,
): Promise<Buffer> {
  const original = await readFile(manifestPath, 'utf8');
  const manifest = sourceManifest(original, await readFile(workspacePath, 'utf8'), metadata);
  const prefix = `${manifest.package.name}-${manifest.package.version}`;
  if (!/^[\w.-]+$/.test(prefix)) throw new Error('Invalid Cargo source package identity');
  let sources: Record<string, Uint8Array> = {};
  for (const [destination, source] of Object.entries(mapping)) {
    try {
      cargoPackageRelativePathParts(destination);
    } catch {
      throw new Error(`Unsafe Cargo source entry ${destination}`);
    }
    sources[destination] = await readFile(source);
  }
  if (!sources['Cargo.toml']) throw new Error('Missing public Cargo source entry Cargo.toml');
  sources['Cargo.toml'] = Buffer.from(renderToml(manifest));
  if (cargo) sources = await conventionalSourceEntries(cargo, sources);
  for (const required of ['Cargo.toml', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md'])
    if (!sources[required]) throw new Error(`Missing public Cargo source entry ${required}`);
  sources['Cargo.toml.orig'] = Buffer.from(original);
  if (metadata.nativeArtifacts) {
    if (!sources['src/lib.rs']) throw new Error('Rust SDK source package is missing its library');
    sources['src/lib.rs'] = Buffer.from(
      `${Buffer.from(sources['src/lib.rs']).toString('utf8')}\n${renderUnsupportedNativeTargetGuard({ product: manifest.package.name, nativeTargets: metadata.nativeArtifacts.map((row) => row.target), nativeCfgs: metadata.nativeArtifacts.map((row) => rustNativeTargetCfg(row.target)), guidance: 'use the separately versioned oliphaunt-wasix crate for WASIX environments.' })}\n`,
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'oliphaunt-source-envelope-'));
  try {
    const source = join(directory, 'source');
    for (const [member, bytes] of Object.entries(sources)) {
      const destination = join(source, member);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o644 });
    }
    const crate = packageGeneratedCargoSource(join(source, 'Cargo.toml'), directory, {
      noticeProfile: 'source-sdk',
      noticeSourceRoot: source,
      fixedFileMode: 0o644,
    });
    return await readFile(crate);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [output, manifest, workspace, specification, metadataFile, cargo] = process.argv.slice(2);
  if (!output || !manifest || !workspace || !specification || !metadataFile || !cargo)
    throw new Error(
      'Expected source archive, manifest, workspace, entry mapping, metadata and pinned Cargo',
    );
  await writeFile(
    output,
    await sourceEnvelope(
      manifest,
      workspace,
      JSON.parse(await readFile(specification, 'utf8')),
      JSON.parse(await readFile(metadataFile, 'utf8')),
      cargo,
    ),
  );
}
