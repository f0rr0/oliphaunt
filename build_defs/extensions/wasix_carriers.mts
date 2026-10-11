/** Final SQL-only WASIX envelopes from one declared production SQL tree. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { packageSqlOnlyWasixExtensionCargo } from '../../src/wasix/runtime/tools/package_liboliphaunt_wasix_cargo_artifacts.mts';
import { createDeterministicTar } from '../../tools/packaging/package-archive.mts';
import {
  readPortableArchiveEntries,
  releaseZstdCompressSync,
} from '../../tools/packaging/portable-archive.mts';
import {
  extensionCompatibilityMetadata,
  extensionSourceMetadata,
} from '../../tools/release/extension-release-metadata.mts';

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
  outputs: { github: string; npm: string; cargo: string; manifest: string; frozen: string };
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function wasixSqlCarrierLeaves(spec: WasixSqlCarrierSpec) {
  assert.equal(spec.sqlName, 'pgtap', 'only the qualified pgTAP SQL producer is admitted');
  assert.equal(spec.product, `oliphaunt-extension-${spec.sqlName}`);
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
      createSchema: lifecycle['create-schema'],
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

if (import.meta.main) {
  const [input, leaves] = process.argv.slice(2);
  assert(
    input && leaves?.startsWith('--sql-files='),
    'usage: wasix_carriers.mts <spec.json> --sql-files=<expanded-leaves.params>',
  );
  packageSqlOnlyWasixCarriers(
    JSON.parse(readFileSync(input, 'utf8')),
    readFileSync(leaves.slice('--sql-files='.length), 'utf8').trimEnd().split('\n'),
  );
}
