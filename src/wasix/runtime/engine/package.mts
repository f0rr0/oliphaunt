import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { renderCargoToml } from '../../../../tools/packaging/cargo-manifest.mts';
import {
  packagedCargoManifestText,
  packageGeneratedCargoSource,
  readCargoPackageNameVersion,
} from '../../../../tools/packaging/cargo-source-package.mts';
import { listArchiveEntries } from '../../../../tools/packaging/package-archive.mts';
import { canonicalGzipSync } from '../../../../tools/packaging/portable-archive.mts';

export const ENGINE_SOURCE_PACKAGES = {
  wasmer: 'oliphaunt-wasmer',
  'wasmer-wasix': 'oliphaunt-wasmer-wasix',
  'wasmer-wasix-types': 'oliphaunt-wasmer-wasix-types',
  'wasmer-journal': 'oliphaunt-wasmer-journal',
} as const;
export const ENGINE_DLL_PACKAGE = 'oliphaunt-wasmer-v8-windows-x64-msvc';
const PART_PACKAGES = [1, 2].map(
  (part) => `${ENGINE_DLL_PACKAGE}-part-${String(part).padStart(3, '0')}`,
);
type Manifest = Record<string, any>;

function requireVersion(version: string) {
  if (!Bun.semver.satisfies(version, `=${version}`))
    throw new Error(`Invalid engine package version: ${version}`);
}

/** Conventional metadata is available before the platform DLL has been built. */
export function engineDeliveryManifests(version: string): Record<string, Manifest> {
  requireVersion(version);
  return Object.fromEntries(
    [...PART_PACKAGES, ENGINE_DLL_PACKAGE].map((name) => [
      name,
      {
        package: {
          name,
          version,
          edition: '2024',
          'rust-version': '1.96',
          description:
            name === ENGINE_DLL_PACKAGE
              ? 'Embedded Windows V8 engine payload'
              : 'Compressed Windows V8 engine payload part',
          'license-file': 'THIRD_PARTY_NOTICES.md',
          repository: 'https://github.com/f0rr0/oliphaunt',
        },
        lib: { path: 'src/lib.rs' },
        dependencies:
          name === ENGINE_DLL_PACKAGE
            ? {
                flate2: '1.0.34',
                ...Object.fromEntries(PART_PACKAGES.map((part) => [part, `=${version}`])),
              }
            : {},
        workspace: {},
      },
    ]),
  );
}

/** Keep Rust dependency aliases intact while giving the maintained family its own registry identity. */
export function normalizeEngineManifest(
  source: string,
  { version, facadeVersion = version }: { version: string; facadeVersion?: string },
): string {
  requireVersion(version);
  requireVersion(facadeVersion);
  const manifest = Bun.TOML.parse(source) as Manifest;
  const upstreamName = manifest.package?.name;
  const name = ENGINE_SOURCE_PACKAGES[upstreamName as keyof typeof ENGINE_SOURCE_PACKAGES];
  if (!name || typeof manifest.package.version !== 'string')
    throw new Error('Engine source must declare an official Wasmer family package and version');
  const upstreamVersion = manifest.package.version;
  manifest.package.name = name;
  manifest.package.version = version;
  delete manifest.package.publish;
  delete manifest.package.workspace;
  // Inputs are already the upstream registry's selected files; generated additions must also publish.
  delete manifest.package.include;
  delete manifest.package.exclude;
  manifest.package.metadata ??= {};
  manifest.package.metadata.oliphaunt ??= {};
  manifest.package.metadata.oliphaunt.upstream = {
    package: upstreamName,
    version: upstreamVersion,
  };
  manifest.lib ??= {};
  manifest.lib.name ??= upstreamName.replaceAll('-', '_');
  delete manifest.patch;
  delete manifest.replace;
  manifest.workspace = {};
  for (const table of [manifest, ...Object.values(manifest.target ?? {})] as Manifest[]) {
    for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
      for (const [alias, value] of Object.entries(table[section] ?? {})) {
        const dependency = typeof value === 'string' ? { version: value } : (value as Manifest);
        const identity = dependency.package ?? alias;
        const renamed = ENGINE_SOURCE_PACKAGES[identity as keyof typeof ENGINE_SOURCE_PACKAGES];
        if (renamed) {
          dependency.package = renamed;
          dependency.version = `=${version}`;
        }
        if (dependency.git) {
          if (typeof dependency.version !== 'string')
            throw new Error(`Unversioned public Cargo dependency ${alias}`);
          for (const field of ['git', 'rev', 'tag', 'branch']) delete dependency[field];
        }
        table[section][alias] = dependency;
      }
    }
  }
  if (upstreamName === 'wasmer') {
    const removed = new Set<string>();
    for (const table of [manifest, ...Object.values(manifest.target ?? {})] as Manifest[]) {
      for (const name of Object.keys(table['build-dependencies'] ?? {})) removed.add(name);
      delete table['build-dependencies'];
    }
    for (const [name, members] of Object.entries(manifest.features ?? {}) as [string, string[]][]) {
      manifest.features[name] = members.filter(
        (member) => !removed.has(member.replace(/^dep:/u, '').split(/[/?]/u, 1)[0]),
      );
    }
    manifest.features ??= {};
    manifest.features.v8 ??= [];
    manifest.features.v8.push(`dep:${ENGINE_DLL_PACKAGE}`);
    manifest['build-dependencies'] = {
      [ENGINE_DLL_PACKAGE]: { version: `=${facadeVersion}`, optional: true },
    };
    manifest.package.build = 'build.rs';
  }
  return packagedCargoManifestText(renderCargoToml(manifest), '[workspace]\n');
}

export interface EnginePackageInputs {
  version: string;
  sdkManifestFile: string;
  sources: Record<keyof typeof ENGINE_SOURCE_PACKAGES, string>;
  dllFile: string;
  embeddedBindingsFile: string;
  buildScriptTemplate: string;
  /** Complete applicable license texts, including V8 and its linked components. */
  noticesFile: string;
  outputDirectory: string;
}

function copyTree(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const file of listArchiveEntries(source)) {
    const relative = path.relative(source, file);
    const target = path.join(destination, relative);
    if (statSync(file).isDirectory()) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
  }
}

export function assembleWindowsEnginePackages(inputs: EnginePackageInputs) {
  const { version, outputDirectory } = inputs;
  const deliveryManifests = engineDeliveryManifests(version);
  const sdk = readCargoPackageNameVersion(inputs.sdkManifestFile);
  if (sdk.name !== 'oliphaunt-wasix' || sdk.version !== version)
    throw new Error('Engine package version must match its actual oliphaunt-wasix SDK manifest');
  const notices = readFileSync(inputs.noticesFile);
  if (!notices.length) throw new Error('Engine packages require complete applicable license texts');
  mkdirSync(outputDirectory, { recursive: true });
  const stage = mkdtempSync(path.join(outputDirectory, '.engine-package-'));
  const packages: { name: string; version: string; archive: string }[] = [];
  function write(directory: string, file: string, bytes: string | Uint8Array) {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
  function finish(name: string, directory: string) {
    write(directory, 'THIRD_PARTY_NOTICES.md', notices);
    const archive = packageGeneratedCargoSource(
      path.join(directory, 'Cargo.toml'),
      path.join(stage, 'archives'),
      { fixedFileMode: 0o644 },
    );
    const destination = path.resolve(outputDirectory, `${name}-${version}.crate`);
    renameSync(archive, destination);
    packages.push({ name, version, archive: destination });
    if (Object.hasOwn(deliveryManifests, name)) {
      for (const relative of [
        'src/lib.rs',
        ...(PART_PACKAGES.includes(name) ? ['payload/dll.gz.part'] : []),
      ]) {
        const retained = path.join(outputDirectory, 'delivery', name, relative);
        mkdirSync(path.dirname(retained), { recursive: true });
        copyFileSync(path.join(directory, relative), retained);
        chmodSync(retained, 0o644);
      }
    }
  }
  function generated(name: string, rust: string) {
    const directory = path.join(stage, name);
    write(directory, 'Cargo.toml', renderCargoToml(deliveryManifests[name]));
    write(directory, 'src/lib.rs', rust);
    return directory;
  }
  try {
    for (const [original, name] of Object.entries(ENGINE_SOURCE_PACKAGES)) {
      const directory = path.join(stage, name);
      copyTree(inputs.sources[original as keyof typeof ENGINE_SOURCE_PACKAGES], directory);
      const source = readFileSync(path.join(directory, 'Cargo.toml'), 'utf8');
      if (Bun.TOML.parse(source).package?.name !== original)
        throw new Error(`Engine source directory for ${original} contains a different package`);
      write(directory, 'Cargo.toml', normalizeEngineManifest(source, { version }));
      for (const file of ['Cargo.lock', 'Cargo.toml.orig', '.cargo_vcs_info.json'])
        rmSync(path.join(directory, file), { force: true });
      if (original === 'wasmer') {
        if (listArchiveEntries(directory).some((file) => /\.dll$/iu.test(file)))
          throw new Error('The public API crate must not contain raw engine DLL bytes');
        write(directory, 'build.rs', readFileSync(inputs.buildScriptTemplate));
        write(
          directory,
          'prebuilt/embedded_bindings.rs',
          readFileSync(inputs.embeddedBindingsFile),
        );
      }
      finish(name, directory);
    }
    const compressed = canonicalGzipSync(readFileSync(inputs.dllFile));
    const midpoint = Math.ceil(compressed.length / 2);
    for (const [index, name] of PART_PACKAGES.entries()) {
      const directory = generated(
        name,
        'pub const DATA: &[u8] = include_bytes!("../payload/dll.gz.part");\n',
      );
      write(
        directory,
        'payload/dll.gz.part',
        compressed.subarray(index * midpoint, (index + 1) * midpoint),
      );
      finish(name, directory);
    }
    const directory = generated(
      ENGINE_DLL_PACKAGE,
      `use std::io::Read;

pub fn write_dll(path: &std::path::Path) -> std::io::Result<()> {
    let parts = ${PART_PACKAGES[0].replaceAll('-', '_')}::DATA.chain(${PART_PACKAGES[1].replaceAll('-', '_')}::DATA);
    let mut reader = flate2::read::GzDecoder::new(parts);
    let mut writer = std::fs::File::create(path)?;
    std::io::copy(&mut reader, &mut writer)?;
    Ok(())
}
`,
    );
    finish(ENGINE_DLL_PACKAGE, directory);
    return packages;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [specFile] = process.argv.slice(2);
  if (!specFile) throw new Error('usage: package.mts SPEC.json');
  assembleWindowsEnginePackages(JSON.parse(readFileSync(specFile, 'utf8')));
}
