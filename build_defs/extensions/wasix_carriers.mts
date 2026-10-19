/** Canonical WASIX extension envelopes from explicitly declared producer outputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stageExtensionWasixNpmPackages } from '../../src/extensions/artifacts/packages/tools/package-extension-release-carriers.mts';
import {
  assertWasixExtensionArchiveInstall,
  WASIX_EXTENSION_INSTALL_SCHEMA,
  WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
} from '../../src/extensions/contracts/wasix-extension-install.mts';
import { assertWasixAotArtifactPayloads } from '../../src/wasix/runtime/tools/check-release-assets.mts';
import {
  packageDeclaredWasixExtensionCargo,
  packageSqlOnlyWasixExtensionCargo,
} from '../../src/wasix/runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import {
  assertCanonicalWasixAotManifest,
  canonicalWasixAotMetadata,
} from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import { AOT_TARGET_TRIPLES } from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { createDeterministicTar as payloadTar } from '../../tools/packaging/archive-directory.mts';
import { createDeterministicTar } from '../../tools/packaging/package-archive.mts';
import {
  decompressSingleZstdFrame,
  readPortableArchiveEntries,
  readPortableTarZstdBufferEntries,
  releaseZstdCompressSync,
} from '../../tools/packaging/portable-archive.mts';
import { validateCrateSize } from '../../tools/packaging/wasix-cargo-payload.mts';
import { validateCargoPayloadPartSets } from '../../tools/release/cargo-payload-part-contract.mts';
import {
  extensionCompatibilityMetadata,
  extensionSourceMetadata,
} from '../../tools/release/extension-release-metadata.mts';
import { resolveActualCarrier } from '../../tools/release/publication-catalog.mts';
import { expandDeclaredTrees } from '../wasix/package.mts';

interface Carrier {
  product: string;
  ecosystem: string;
  name: string;
  version: string;
  target: string | null;
  role: string;
}
export interface WasixSqlCarrierSpec {
  product: string;
  version: string;
  sqlName: string;
  target: string;
  descriptor: Record<string, any>;
  recipe: Record<string, any>;
  source: Record<string, any>;
  selectedDependencies: string[];
  compatibility: Record<string, string>;
  releaseMetadata: Record<string, any>;
  carriers: Carrier[];
  sqlRoot: string;
  outputs: {
    github: string;
    npm: string;
    cargo: string;
    manifest: string;
    frozen: string;
    cargoParts?: Record<string, string>;
  };
}

/** Authenticate complete canonical parents and their dynamic Cargo parts together. */
export function readWasixCargoCarrierSet(
  carriers: Carrier[],
  inputs: string[],
  produced?: { name: string; target: string; size: number; sha256: string }[],
) {
  const declared = carriers.filter((row) => row.ecosystem === 'cargo');
  const catalog = {
    carriers: declared.map((row) => ({ ...row, id: `cargo:${row.name}`, declared: true })),
  };
  const parents = new Set(declared.map((row) => row.name));
  const files = inputs.flatMap((input) => {
    const entry = lstatSync(input, { throwIfNoEntry: false });
    if (entry?.isFile()) return [input];
    const parent = path.basename(input);
    assert(parents.has(parent), 'Cargo parts directory has no canonical parent');
    // Bazel runfiles omit empty TreeArtifact directories. Required parts still
    // come from the packed parent manifest and must pass the complete-set check.
    if (!entry) return [];
    const directory = realpathSync(input);
    assert(lstatSync(directory).isDirectory(), 'Cargo parts input must be a directory');
    return readdirSync(directory, { withFileTypes: true }).map((part) => {
      assert(
        (part.isFile() || part.isSymbolicLink()) && part.name.endsWith('.crate'),
        'Cargo parts output must contain only regular part archives',
      );
      assert(
        part.name.startsWith(`${parent}-part-`),
        'Cargo part output belongs to a different parent',
      );
      // Sandboxed runfiles can materialize a Tree as individual file symlinks.
      // Bind each resolved regular file to the same canonical parent and name.
      const file = realpathSync(path.join(directory, part.name));
      assert(lstatSync(file).isFile(), 'Cargo part must resolve to a regular archive');
      assert.equal(path.basename(file), part.name, 'Cargo part changed its archive filename');
      assert.equal(
        path.basename(path.dirname(file)),
        parent,
        'Cargo part resolved outside its canonical parent',
      );
      return file;
    });
  });
  const records = files.map((file) => {
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    validateCrateSize(file);
    const bytes = readFileSync(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entries = readPortableArchiveEntries(file);
    const prefix = path.basename(file, '.crate');
    const entry = entries.get(`${prefix}/Cargo.toml`);
    assert(
      entry?.isFile && !entry.isSymbolicLink,
      'Cargo carrier requires its exact packed manifest',
    );
    const manifest = Bun.TOML.parse(entry.data().toString());
    assert.equal(prefix, `${manifest.package.name}-${manifest.package.version}`);
    const carrier = resolveActualCarrier(catalog, 'cargo', manifest.package.name);
    assert.equal(manifest.package.version, carrier.version);
    const packageDependencies = Object.entries({
      ...manifest.dependencies,
      ...manifest['build-dependencies'],
    }).map(([name, declaration]) => {
      const requirement =
        typeof declaration === 'string'
          ? declaration
          : (declaration as { version: string }).version;
      if (name.startsWith(`${carrier.name}-part-`))
        assert.equal(requirement, `=${carrier.version}`);
      return { ecosystem: 'cargo', name, requirement };
    });
    if (produced) {
      const row = produced.find((row) => row.name === carrier.name);
      assert(row, 'Cargo archive has no produced inventory row');
      assert.equal(
        row.target,
        carrier.target,
        'Cargo inventory target differs from its canonical parent',
      );
      assert.equal(row.size, bytes.length);
      assert.equal(row.sha256, sha256);
    }
    return { ...carrier, packageDependencies, entries, prefix, file, size: bytes.length, sha256 };
  });
  assert.equal(
    new Set(records.map((row) => row.id)).size,
    records.length,
    'repeated Cargo carrier',
  );
  if (produced)
    assert.deepEqual(records.map((row) => row.name).sort(), produced.map((row) => row.name).sort());
  assert.deepEqual(
    records
      .filter((row) => row.declared)
      .map((row) => row.name)
      .sort(),
    declared.map((row) => row.name).sort(),
    'Cargo leaves differ from canonical carrier identities',
  );
  validateCargoPayloadPartSets(records);
  return records;
}

/** Read the same complete files/chunks that the canonical Cargo build script consumes. */
export function readWasixCargoCarrierPayload(
  records: ReturnType<typeof readWasixCargoCarrierSet>,
  parent: ReturnType<typeof readWasixCargoCarrierSet>[number],
) {
  const roots = parent.packageDependencies.some((row) =>
    row.name.startsWith(`${parent.name}-part-`),
  )
    ? records.filter((row) => row.parentCarrier === parent.id)
    : [parent];
  const files = new Map<string, Buffer>();
  const chunks = new Map<string, { index: number; bytes: Buffer }[]>();
  for (const owner of roots)
    for (const [name, entry] of owner.entries) {
      const prefix = `${owner.prefix}/payload/`;
      if (!name.startsWith(prefix)) continue;
      assert(entry.isDirectory || (entry.isFile && !entry.isSymbolicLink));
      if (entry.isDirectory) continue;
      const relative = name.slice(prefix.length);
      if (relative.startsWith('files/')) {
        const destination = relative.slice('files/'.length);
        assert(!files.has(destination) && !chunks.has(destination), 'repeated Cargo payload file');
        files.set(destination, Buffer.from(entry.data()));
      } else {
        const match = /^chunks\/(.+)\.part([0-9]{6})$/u.exec(relative);
        assert(match && !files.has(match[1]), 'unexpected Cargo payload member');
        const rows = chunks.get(match[1]) ?? [];
        rows.push({ index: Number(match[2]), bytes: Buffer.from(entry.data()) });
        chunks.set(match[1], rows);
      }
    }
  for (const [name, rows] of chunks) {
    rows.sort((left, right) => left.index - right.index);
    assert.deepEqual(
      rows.map((row) => row.index),
      rows.map((_, index) => index),
      'non-contiguous Cargo payload chunks',
    );
    files.set(name, Buffer.concat(rows.map((row) => row.bytes)));
  }
  return files;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function wasixSqlCarrierLeaves(spec: WasixSqlCarrierSpec) {
  assert.equal(spec.sqlName, 'pgtap', 'only the qualified pgTAP SQL producer is admitted');
  assert.equal(spec.product, `oliphaunt-extension-${spec.sqlName.replaceAll('_', '-')}`);
  assert.equal(spec.target, 'wasix-portable');
  assert.equal(spec.releaseMetadata.class, 'external');
  assert.equal(spec.releaseMetadata.versioning, 'upstream-bound');
  assert.equal(spec.releaseMetadata.product, spec.product);
  assert.equal(spec.releaseMetadata.sqlName, spec.sqlName);
  assert.equal(
    spec.descriptor['native-module-file'] ?? null,
    null,
    'compiled WASIX members require their complete AOT closure',
  );
  const artifacts = spec.recipe.artifacts;
  for (const key of ['native_modules', 'native_dependency_modules', 'data_files', 'headers'])
    assert.deepEqual(artifacts[key] ?? [], [], `SQL-only member cannot carry ${key}`);
  const compatibility = extensionCompatibilityMetadata(spec.compatibility);
  assert.equal(compatibility.wasixRuntimeProduct, 'liboliphaunt-wasix');
  assert.deepEqual(
    spec.releaseMetadata.compatibility,
    compatibility,
    'release compatibility differs from its declared package metadata',
  );
  assert.deepEqual(
    spec.releaseMetadata.sourceIdentity,
    extensionSourceMetadata(spec.product, spec.releaseMetadata, spec.source, spec.version),
    'release source identity differs from its pinned SQL producer',
  );
  const leaves = ['npm', 'cargo'].map((ecosystem) => {
    const rows = spec.carriers.filter(
      (row) =>
        row.ecosystem === ecosystem && row.target === spec.target && row.role === 'portable-leaf',
    );
    assert.equal(rows.length, 1, `portable ${ecosystem} leaf must have one canonical identity`);
    const row = rows[0];
    assert.equal(row.product, spec.product);
    assert.equal(row.version, spec.version);
    assert.equal(
      row.name,
      ecosystem === 'npm' ? `@oliphaunt/extension-${spec.sqlName}-wasix` : `${spec.product}-wasix`,
    );
    return row;
  });
  assert.equal(
    path.basename(spec.outputs.github),
    `${spec.product}-${spec.version}-${spec.target}.tar.zst`,
  );
  assert.equal(path.basename(spec.outputs.cargo), `${leaves[1].name}-${spec.version}.crate`);
  return { npm: leaves[0], cargo: leaves[1], compatibility };
}

/** Read exactly the TreeArtifact leaves passed by Bazel's directory expansion. */
export function declaredSqlFiles(spec: WasixSqlCarrierSpec, files: string[]) {
  const root = path.resolve(spec.sqlRoot);
  assert(
    lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),
    'SQL root must be a real declared directory',
  );
  const names = files
    .map((file) => {
      const absolute = path.resolve(file);
      assert.equal(
        path.dirname(absolute),
        root,
        'SQL leaf must belong directly to the declared producer tree',
      );
      // Bazel sandboxes materialize declared TreeArtifact files as input links.
      // Their copied archive destinations are always regular files.
      const stat = statSync(absolute);
      assert(stat.isFile(), 'SQL leaf must resolve to a regular declared file');
      const name = path.basename(file);
      const artifacts = spec.recipe.artifacts;
      const allowed =
        name === `${spec.sqlName}.control` ||
        (name.startsWith(`${spec.sqlName}--`) && name.endsWith('.sql')) ||
        (artifacts.extension_sql_file_names ?? []).includes(name) ||
        (artifacts.extension_sql_file_prefixes ?? []).some(
          (prefix: string) => name.startsWith(`${prefix}--`) && name.endsWith('.sql'),
        );
      assert(allowed, `unexpected SQL producer leaf: ${name}`);
      assert(stat.size > 0, `empty SQL producer leaf: ${name}`);
      return name;
    })
    .sort();
  assert.equal(new Set(names).size, names.length, 'SQL producer leaves must be unique');
  const version = spec.source['extension-control']['default-version'];
  const required = [
    `${spec.sqlName}.control`,
    `${spec.sqlName}--${version}.sql`,
    ...(spec.recipe.artifacts.extension_sql_file_names ?? []),
    ...(spec.recipe.artifacts.extension_sql_file_prefixes ?? []).map(
      (prefix: string) => `${prefix}--${version}.sql`,
    ),
  ];
  for (const name of required)
    assert(names.includes(name), `missing canonical SQL producer leaf: ${name}`);
  const control = readFileSync(path.join(root, `${spec.sqlName}.control`), 'utf8');
  assert.equal(
    /^default_version\s*=\s*'([^']+)'\s*$/mu.exec(control)?.[1],
    version,
    'control default version differs from its pinned producer',
  );
  const requires = /^requires\s*=\s*'([^']*)'\s*$/mu.exec(control)?.[1] ?? '';
  assert.deepEqual(
    requires
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort(),
    [...spec.descriptor.dependencies].sort(),
    'control dependencies differ from the install descriptor',
  );
  return names;
}

export function assembleSqlOnlyWasixMember(
  spec: WasixSqlCarrierSpec,
  files: string[],
  staging: string,
) {
  const { compatibility } = wasixSqlCarrierLeaves(spec);
  const names = declaredSqlFiles(spec, files);
  const destination = path.join(staging, 'share/postgresql/extension');
  mkdirSync(destination, { recursive: true });
  for (const name of names)
    copyFileSync(path.join(spec.sqlRoot, name), path.join(destination, name));
  const bytes = releaseZstdCompressSync(
    createDeterministicTar(path.join(staging, 'share'), 'share', { fixedFileMode: 0o644 }),
  );
  mkdirSync(path.dirname(spec.outputs.github), { recursive: true });
  writeFileSync(spec.outputs.github, bytes);
  const lifecycle = spec.descriptor.lifecycle;
  const wasixInstall = {
    schema: WASIX_EXTENSION_INSTALL_SCHEMA,
    name: spec.sqlName,
    nativeModule: null,
    nativeModules: [],
    coreExportsRequired: [],
    dependencies: [...spec.descriptor.dependencies].sort(),
    loadOrder: spec.descriptor['load-order'] ?? [],
    lifecycle: {
      createExtension: lifecycle['create-extension'],
      createSchema: lifecycle['create-schema'] ?? null,
      loadSql: lifecycle['load-sql'],
      postCreateSql: lifecycle['post-create-sql'],
      startupConfig: lifecycle['startup-config'],
      preloadRequired: lifecycle['preload-required'],
      restartRequired: lifecycle['restart-required'],
      sharedMemoryRequired: lifecycle['shared-memory-required'],
    },
    installedFiles: names.map((name) => `share/postgresql/extension/${name}`),
    unresolvedImports: [],
  };
  const asset = {
    name: path.basename(spec.outputs.github),
    family: 'wasix',
    target: spec.target,
    kind: 'wasix-runtime',
    identity: null,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  assertWasixExtensionArchiveInstall(bytes, {
    schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
    sqlName: spec.sqlName,
    archive: `extensions/${spec.sqlName}.tar.zst`,
    sha256: asset.sha256,
    size: asset.bytes,
    install: wasixInstall,
  });
  return {
    compatibility,
    sqlName: spec.sqlName,
    createsExtension: lifecycle['create-extension'],
    nativeModuleStem: null,
    dependencies: spec.selectedDependencies,
    dataFiles: [],
    extensionSqlFileNames: [...(spec.recipe.artifacts.extension_sql_file_names ?? [])].sort(),
    extensionSqlFilePrefixes: [...(spec.recipe.artifacts.extension_sql_file_prefixes ?? [])].sort(),
    sharedPreloadLibraries: [],
    wasixInstall,
    assets: [asset],
  };
}

export function packageSqlOnlyWasixCarriers(spec: WasixSqlCarrierSpec, files: string[]) {
  const leaves = wasixSqlCarrierLeaves(spec);
  for (const output of Object.values(spec.outputs))
    mkdirSync(path.dirname(output), { recursive: true });
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-sql-envelopes-'));
  try {
    const member = assembleSqlOnlyWasixMember(spec, files, path.join(root, 'payload'));
    const productRoot = path.join(root, 'product');
    const assets = path.join(productRoot, 'release-assets');
    mkdirSync(assets, { recursive: true });
    copyFileSync(spec.outputs.github, path.join(assets, path.basename(spec.outputs.github)));
    const frozen = {
      schema: 'oliphaunt-extension-ci-artifacts-v1',
      product: spec.product,
      version: spec.version,
      ...member,
    };
    const manifest = {
      schema: 'oliphaunt-extension-release-manifest-v1',
      product: spec.product,
      version: spec.version,
      extensionClass: 'external',
      versioning: 'upstream-bound',
      sourceIdentity: spec.releaseMetadata.sourceIdentity,
      ...member,
    };
    writeJson(path.join(productRoot, 'extension-artifacts.json'), frozen);
    writeJson(path.join(assets, path.basename(spec.outputs.manifest)), manifest);
    const result = { staged: [] as string[], skipped: [] as string[] };
    assert(
      stageExtensionWasixNpmPackages([productRoot], path.join(root, 'npm'), result),
      'canonical WASIX npm writer must produce the declared portable leaf',
    );
    assert.equal(
      result.staged.length,
      1,
      'SQL-only npm writer must not invent AOT or other leaves',
    );
    const npm = result.staged[0];
    const packageJson = JSON.parse(
      readPortableArchiveEntries(npm).get('package/package.json')!.data().toString(),
    );
    assert.equal(packageJson.name, leaves.npm.name);
    assert.equal(packageJson.version, spec.version);
    copyFileSync(npm, spec.outputs.npm);
    const asset = member.assets[0];
    const cargo = packageSqlOnlyWasixExtensionCargo(
      {
        product: spec.product,
        version: spec.version,
        runtimeProduct: leaves.compatibility.wasixRuntimeProduct,
        runtimeVersion: leaves.compatibility.wasixRuntimeVersion,
        member: {
          sqlName: spec.sqlName,
          dependencies: spec.selectedDependencies,
          archive: spec.outputs.github,
          sha256: asset.sha256,
          size: asset.bytes,
          install: member.wasixInstall,
        },
      },
      { outputDir: path.join(root, 'cargo'), workDir: path.join(root, 'cargo-work') },
    );
    assert.equal(cargo.length, 1, 'SQL-only Cargo writer must produce exactly its declared leaf');
    assert.equal(cargo[0].name, leaves.cargo.name);
    copyFileSync(cargo[0].cratePath, spec.outputs.cargo);
    writeJson(spec.outputs.frozen, frozen);
    writeJson(spec.outputs.manifest, manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface WasixCompiledCarrierSpec extends Omit<WasixSqlCarrierSpec, 'sqlRoot'> {
  operation: 'compiled';
  modules: { name: string; path: string; runtime_path: string }[];
  resources: { source: string; destination: string; tree?: boolean }[];
  link: string;
  toolchain: string;
  aot: { name: string; target: string; module: string; image: string }[];
}

export function stageDeclaredWasixExtensionHost(spec: {
  version: string;
  archive: string;
  module: string;
  manifest: string;
}) {
  const entries = readPortableArchiveEntries(realpathSync(spec.archive), { format: 'tar.gz' });
  const prefix = `liboliphaunt-wasix-portable-${spec.version}`;
  const cargo = Bun.TOML.parse(hostArchiveMember(entries, `${prefix}/Cargo.toml`).toString('utf8'));
  assert.equal(cargo.package.name, 'liboliphaunt-wasix-portable');
  assert.equal(cargo.package.version, spec.version);
  stageWasixExtensionHostBytes(
    spec,
    hostArchiveMember(entries, `${prefix}/payload/manifest.json`),
    hostArchiveMember(entries, `${prefix}/payload/oliphaunt.wasix.tar.zst`),
  );
}

export function stageCurrentWasixExtensionHost(spec: {
  archive: string;
  module: string;
  manifest: string;
}) {
  const entries = readPortableArchiveEntries(realpathSync(spec.archive), { format: 'tar.zst' });
  const member = (name: string) =>
    hostArchiveMember(entries, `target/oliphaunt-wasix/assets/${name}`);
  stageWasixExtensionHostBytes(spec, member('manifest.json'), member('oliphaunt.wasix.tar.zst'));
}

function hostArchiveMember(entries: ReturnType<typeof readPortableArchiveEntries>, name: string) {
  const entry = entries.get(name);
  assert(entry?.isFile && !entry.isSymbolicLink, 'host requires original regular archive members');
  return Buffer.from(entry.data());
}

function stageWasixExtensionHostBytes(
  spec: { module: string; manifest: string },
  manifestBytes: Buffer,
  bytes: Buffer,
) {
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(manifest['format-version'], 2);
  assert.equal(manifest['source-lane'], 'stable');
  assert.equal(manifest.runtime['runtime-kind'], 'wasix-dynamic-main');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.runtime.sha256);
  const entry = readPortableTarZstdBufferEntries(bytes).get('oliphaunt/bin/postgres');
  assert(entry?.isFile && !entry.isSymbolicLink, 'declared host has no physical core module');
  const module = Buffer.from(entry.data());
  assert.equal(
    createHash('sha256').update(module).digest('hex'),
    manifest.runtime['module-sha256'],
  );
  assert.deepEqual(module.subarray(0, 8), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  mkdirSync(path.dirname(spec.module), { recursive: true });
  writeFileSync(spec.module, module);
  writeJson(spec.manifest, manifest);
}

/** Package only the declared compiled member; the canonical writers own registry bytes. */
export function assertDeclaredWasixResource(entry: { source: string; destination: string }) {
  assert(
    /^(?:lib\/postgresql\/|share\/postgresql\/)/u.test(entry.destination) &&
      !entry.destination.split('/').some((part) => !part || part === '.' || part === '..'),
    'unsafe member destination',
  );
  const file = statSync(entry.source);
  assert(file.isFile(), 'member input must be a declared regular file');
  // PostgreSQL delivers empty upgrade scripts when a version needs no SQL changes.
  // Keep those exact files; compiled modules, control files and data remain nonempty.
  assert(
    file.size > 0 ||
      (entry.destination.startsWith('share/postgresql/extension/') &&
        entry.destination.endsWith('.sql')),
    'member input must be nonempty',
  );
}

export async function stageCompiledWasixMember(
  spec: WasixCompiledCarrierSpec,
  files: string[],
  productRoot: string,
  releaseAssets: string,
) {
  assert.equal(spec.target, 'wasix-portable');
  const compatibility = extensionCompatibilityMetadata(spec.compatibility);
  const link = JSON.parse(readFileSync(spec.link, 'utf8'));
  assert.equal(link.schema, 'oliphaunt-declared-wasix-extension-link-v1');
  assert.equal(link.sqlName, spec.sqlName);
  assert.deepEqual(link.unresolvedImports, [], 'compiled member has unresolved core imports');
  assert.equal(link.nativeModules.length, spec.modules.length);
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-compiled-envelopes-'),
  );
  try {
    const stage = path.join(root, 'member');
    mkdirSync(releaseAssets, { recursive: true });
    const destinations = new Set<string>();
    const entries = [
      ...expandDeclaredTrees(spec.resources, files),
      ...spec.modules.map((row) => ({ source: row.path, destination: row.runtime_path })),
    ];
    for (const entry of entries) {
      assertDeclaredWasixResource(entry);
      assert(!destinations.has(entry.destination), 'duplicate member destination');
      destinations.add(entry.destination);
      const destination = path.join(stage, entry.destination);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(entry.source, destination);
      chmodSync(destination, 0o644);
    }
    const lifecycle = spec.descriptor.lifecycle;
    if (lifecycle['create-extension']) {
      const version = spec.source['extension-control']['default-version'];
      const controlName = `share/postgresql/extension/${spec.sqlName}.control`;
      assert(destinations.has(controlName), 'missing canonical compiled control resource');
      const control = readFileSync(path.join(stage, controlName), 'utf8');
      assert.equal(/^default_version\s*=\s*'([^']+)'\s*$/mu.exec(control)?.[1], version);
      const modulePath = /^module_pathname\s*=\s*'([^']+)'\s*$/mu.exec(control)?.[1];
      if (modulePath !== undefined)
        assert.equal(modulePath, `$libdir/${spec.descriptor['native-module-file'].slice(0, -3)}`);
      // PostgreSQL may reach default_version through delivered upgrade scripts.
      assert(
        entries.some((entry) => {
          const name = path.posix.basename(entry.destination);
          return (
            name.startsWith(`${spec.sqlName}--`) &&
            name.endsWith('.sql') &&
            name.slice(spec.sqlName.length + 2, -4).split('--').length === 1 &&
            statSync(entry.source).size > 0
          );
        }),
        'missing nonempty compiled base installation SQL',
      );
    }
    const archiveName = `${spec.product}-${spec.version}-${spec.product === 'oliphaunt-extension-contrib-pg18' ? `${spec.sqlName}-` : ''}wasix-portable.tar.zst`;
    const archive = path.join(releaseAssets, archiveName);
    const bytes = releaseZstdCompressSync(await payloadTar(stage));
    writeFileSync(archive, bytes);
    const asset = {
      name: archiveName,
      family: 'wasix',
      target: 'wasix-portable',
      kind: 'wasix-runtime',
      identity: null,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const wasixInstall = {
      schema: WASIX_EXTENSION_INSTALL_SCHEMA,
      name: spec.sqlName,
      nativeModule: spec.descriptor['native-module-file'],
      nativeModules: link.nativeModules,
      coreExportsRequired: link.coreExportsRequired,
      dependencies: [...spec.descriptor.dependencies].sort(),
      loadOrder: spec.descriptor['load-order'] ?? [],
      lifecycle: {
        createExtension: lifecycle['create-extension'],
        createSchema: lifecycle['create-schema'] ?? null,
        loadSql: lifecycle['load-sql'],
        postCreateSql: lifecycle['post-create-sql'],
        startupConfig: lifecycle['startup-config'],
        preloadRequired: lifecycle['preload-required'],
        restartRequired: lifecycle['restart-required'],
        sharedMemoryRequired: lifecycle['shared-memory-required'],
      },
      installedFiles: [...destinations].sort(),
      unresolvedImports: link.unresolvedImports,
    };
    assertWasixExtensionArchiveInstall(bytes, {
      schema: WASIX_EXTENSION_INSTALL_SIDECAR_SCHEMA,
      sqlName: spec.sqlName,
      archive: `extensions/${spec.sqlName}.tar.zst`,
      sha256: asset.sha256,
      size: asset.bytes,
      install: wasixInstall,
    });
    const member = {
      compatibility,
      sqlName: spec.sqlName,
      createsExtension: lifecycle['create-extension'],
      nativeModuleStem: spec.descriptor['native-module-file'].slice(0, -3),
      dependencies: spec.selectedDependencies,
      dataFiles: (spec.recipe.artifacts?.data_files ?? [])
        .map((file: string) => {
          assert(file.startsWith('share/postgresql/'), 'data resource must use PostgreSQL share');
          return file.slice('share/postgresql/'.length);
        })
        .sort(),
      extensionSqlFileNames: spec.recipe.artifacts?.extension_sql_file_names ?? [],
      extensionSqlFilePrefixes: spec.recipe.artifacts?.extension_sql_file_prefixes ?? [],
      sharedPreloadLibraries: lifecycle['startup-config']
        .flatMap((value: string) =>
          value.startsWith('shared_preload_libraries=')
            ? value.slice('shared_preload_libraries='.length).split(',')
            : [],
        )
        .sort(),
      wasixInstall,
      assets: [asset],
    };
    const canonical = canonicalWasixAotMetadata();
    const targets = Object.entries(AOT_TARGET_TRIPLES);
    const bundle = spec.product === 'oliphaunt-extension-contrib-pg18';
    assert.equal(
      spec.aot.length,
      targets.length * spec.modules.length,
      'compiled member requires every canonical AOT image',
    );
    for (const [targetId, triple] of targets) {
      const images = spec.aot.filter((row) => row.target === triple);
      assert.equal(images.length, spec.modules.length, `incomplete AOT closure for ${targetId}`);
      assert.equal(new Set(images.map((row) => row.name)).size, images.length);
      const sourceDir = path.join(
        productRoot,
        'wasix-aot',
        targetId,
        ...(bundle ? [spec.sqlName] : []),
      );
      mkdirSync(sourceDir, { recursive: true });
      const artifacts = images
        .map((row) => {
          const module = spec.modules.find((module) => module.path === row.module);
          assert(module, 'AOT image has no exact portable member input');
          const name = `extension:${spec.sqlName}${module.name === spec.sqlName ? '' : `:${module.name}`}`;
          assert.equal(row.name, name);
          const filename = `${module.name}-llvm-opta.bin.zst`;
          const compressed = readFileSync(row.image);
          const raw = decompressSingleZstdFrame(compressed);
          copyFileSync(row.image, path.join(sourceDir, filename));
          return {
            name,
            path: filename,
            sha256: createHash('sha256').update(compressed).digest('hex'),
            'raw-sha256': createHash('sha256').update(raw).digest('hex'),
            'raw-size': raw.length,
            'module-sha256': createHash('sha256').update(readFileSync(row.module)).digest('hex'),
            compressed: true,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
      const aotManifest = {
        'format-version': 1,
        'source-lane': canonical.sourceLane,
        'source-fingerprint': link.sourceFingerprint,
        'postgres-version': link.postgresVersion,
        'target-triple': triple,
        engine: canonical.engine,
        'wasmer-version': canonical.wasmerVersion,
        'wasmer-wasix-version': canonical.wasmerWasixVersion,
        artifacts,
      };
      assertCanonicalWasixAotManifest(aotManifest, { expectedTarget: triple });
      assertWasixAotArtifactPayloads(aotManifest, {
        readArtifact: (relative: string) => readFileSync(path.join(sourceDir, relative)),
      });
      writeJson(path.join(sourceDir, 'manifest.json'), aotManifest);
    }
    return { member, archive, archiveName, asset, wasixInstall };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export async function packageCompiledWasixCarriers(
  spec: WasixCompiledCarrierSpec,
  files: string[],
) {
  assert.equal(spec.product, `oliphaunt-extension-${spec.sqlName.replaceAll('_', '-')}`);
  assert.equal(spec.releaseMetadata.versioning, 'upstream-bound');
  assert.equal(spec.releaseMetadata.sqlName, spec.sqlName);
  const compatibility = extensionCompatibilityMetadata(spec.compatibility);
  assert.deepEqual(spec.releaseMetadata.compatibility, compatibility);
  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-final-envelopes-'),
  );
  try {
    const productRoot = path.join(root, 'product');
    const { member, archive, archiveName, asset, wasixInstall } = await stageCompiledWasixMember(
      spec,
      files,
      productRoot,
      path.join(productRoot, 'release-assets'),
    );
    const frozen = {
      schema: 'oliphaunt-extension-ci-artifacts-v1',
      product: spec.product,
      version: spec.version,
      ...member,
    };
    const manifest = {
      schema: 'oliphaunt-extension-release-manifest-v1',
      product: spec.product,
      version: spec.version,
      extensionClass: 'external',
      versioning: 'upstream-bound',
      sourceIdentity: spec.releaseMetadata.sourceIdentity,
      ...member,
    };
    writeJson(path.join(productRoot, 'extension-artifacts.json'), frozen);
    writeJson(
      path.join(productRoot, 'release-assets', path.basename(spec.outputs.manifest)),
      manifest,
    );
    const targets = Object.entries(AOT_TARGET_TRIPLES);
    const result = { staged: [] as string[], skipped: [] as string[] };
    assert(stageExtensionWasixNpmPackages([productRoot], path.join(root, 'npm-stage'), result));
    assert.equal(
      result.staged.length,
      targets.length + 1,
      'canonical npm writer must produce portable and all AOT leaves',
    );
    mkdirSync(spec.outputs.npm, { recursive: true });
    const npmNames = [];
    for (const file of result.staged) {
      const metadata = JSON.parse(
        readPortableArchiveEntries(file).get('package/package.json')!.data().toString(),
      );
      assert.equal(metadata.version, spec.version);
      npmNames.push(metadata.name);
      copyFileSync(file, path.join(spec.outputs.npm, path.basename(file)));
    }
    assert.deepEqual(
      npmNames.sort(),
      spec.carriers
        .filter((row) => row.ecosystem === 'npm')
        .map((row) => row.name)
        .sort(),
      'npm leaves differ from canonical carrier identities',
    );
    const cargoPackages = packageDeclaredWasixExtensionCargo(
      {
        product: spec.product,
        version: spec.version,
        runtimeProduct: compatibility.wasixRuntimeProduct,
        runtimeVersion: compatibility.wasixRuntimeVersion,
        versioning: 'upstream-bound',
        extensionRoot: productRoot,
        members: [
          {
            sqlName: spec.sqlName,
            dependencies: spec.selectedDependencies,
            nativeModuleStem: member.nativeModuleStem,
            archive,
            sha256: asset.sha256,
            size: asset.bytes,
            install: wasixInstall,
          },
        ],
      },
      { outputDir: path.join(root, 'cargo-packages'), workDir: path.join(root, 'cargo-work') },
    );
    const cargo = readWasixCargoCarrierSet(
      spec.carriers,
      cargoPackages.map((row) => row.cratePath),
      cargoPackages,
    );
    const parts = cargo.filter((row) => !row.declared);
    const partRoots = spec.outputs.cargoParts ?? {};
    if (Object.keys(partRoots).length)
      assert.deepEqual(
        Object.keys(partRoots).sort(),
        cargo
          .filter((row) => row.declared)
          .map((row) => row.name)
          .sort(),
      );
    else
      assert.equal(parts.length, 0, 'generated Cargo parts require their declared parent outputs');
    for (const directory of Object.values(partRoots)) mkdirSync(directory, { recursive: true });
    mkdirSync(spec.outputs.cargo, { recursive: true });
    for (const carrier of cargo)
      copyFileSync(
        carrier.file,
        path.join(
          carrier.declared
            ? spec.outputs.cargo
            : partRoots[carrier.parentCarrier.slice('cargo:'.length)],
          path.basename(carrier.file),
        ),
      );
    mkdirSync(spec.outputs.github, { recursive: true });
    copyFileSync(archive, path.join(spec.outputs.github, archiveName));
    writeJson(spec.outputs.frozen, frozen);
    writeJson(spec.outputs.manifest, manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [input, leaves] = process.argv.slice(2);
  const spec = JSON.parse(readFileSync(input, 'utf8'));
  if (spec.operation === 'host') stageDeclaredWasixExtensionHost(spec);
  else if (spec.operation === 'current-host') stageCurrentWasixExtensionHost(spec);
  else if (spec.operation === 'compiled') {
    assert(leaves?.startsWith('--resource-files='));
    const inventory = readFileSync(leaves.slice('--resource-files='.length), 'utf8').trim();
    await packageCompiledWasixCarriers(spec, inventory ? inventory.split('\n') : []);
  } else {
    assert(
      input && leaves?.startsWith('--sql-files='),
      'usage: wasix_carriers.mts <spec.json> --sql-files=<expanded-leaves.params>',
    );
    packageSqlOnlyWasixCarriers(
      spec,
      readFileSync(leaves.slice('--sql-files='.length), 'utf8').trimEnd().split('\n'),
    );
  }
}
