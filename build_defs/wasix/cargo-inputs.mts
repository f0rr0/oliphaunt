/** Captured construction inputs for the five public WASIX runtime crates. */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AOT_PACKAGES,
  AOT_TARGET_TRIPLES,
  RUNTIME_PACKAGE,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { stageCargoCarrierInputs } from '../../tools/packaging/frozen-cargo.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { projectCargoWorkspace, renderToml } from '../languages/cargo-metadata.mts';
import { extractRuntimeCargoFamily, readRuntimeCargoFamily } from './cargo.mts';

const SCHEMA = 'oliphaunt-wasix-cargo-construction-v1';
const AOT_BY_NAME = new Map(Object.entries(AOT_PACKAGES).map(([target, name]) => [name, target]));
const PACKAGE_PATHS = new Map([
  [RUNTIME_PACKAGE, 'src/wasix/runtime/crates/assets'],
  ...[...AOT_BY_NAME].map(([name, target]) => [
    name,
    `src/wasix/runtime/crates/aot/${AOT_TARGET_TRIPLES[target]}`,
  ]),
]);
const PACKAGE_NAMES = [...PACKAGE_PATHS.keys()].sort();
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

/** The current source owns these same public envelope identities. */
export function wasixHostSmokeCargoIdentities(sourceRoot: string, runtimeVersion: string) {
  const tools = Bun.TOML.parse(
    readFileSync(path.join(sourceRoot, 'src/wasix/postgres-tools/crates/tools/Cargo.toml'), 'utf8'),
  ).package;
  if (tools?.name !== TOOLS_PACKAGE || typeof tools.version !== 'string' || !tools.version)
    throw new Error('WASIX host smoke requires the canonical tools version manifest');
  const contrib = 'oliphaunt-extension-contrib-pg18';
  return [
    {
      name: wasixExtensionPackageName(contrib),
      product: 'liboliphaunt-wasix',
      version: runtimeVersion,
      target: 'wasix-portable',
    },
    ...Object.values(AOT_TARGET_TRIPLES).map((target) => ({
      name: wasixExtensionAotPackageName(contrib, target),
      product: 'liboliphaunt-wasix',
      version: runtimeVersion,
      target,
    })),
    {
      name: TOOLS_PACKAGE,
      product: 'postgres-tools-wasix',
      version: tools.version,
      target: 'portable',
    },
    ...Object.entries(TOOLS_AOT_PACKAGES).map(([target, name]) => ({
      name,
      product: 'postgres-tools-wasix',
      version: tools.version,
      target: AOT_TARGET_TRIPLES[target],
    })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** Validate/copy support envelopes without compiling their public Cargo source. */
export function wasixHostSmokeCargoRows(
  inputs: CargoInput[],
  sourceRoot: string,
  runtimeVersion: string,
) {
  const expected = wasixHostSmokeCargoIdentities(sourceRoot, runtimeVersion);
  if (
    !Array.isArray(inputs) ||
    inputs.length !== expected.length ||
    new Set(inputs.map((row) => row.name)).size !== inputs.length
  )
    throw new Error(
      'WASIX host smoke requires exactly the ten canonical contrib/tools Cargo archives',
    );
  return expected.map((identity) => {
    const input = inputs.find((row) => row.name === identity.name);
    if (!input || input.target !== identity.target || !path.isAbsolute(input.file))
      throw new Error(`WASIX host smoke Cargo target differs: ${identity.name}`);
    const stat = lstatSync(input.file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      path.basename(input.file) !== `${identity.name}-${identity.version}.crate`
    )
      throw new Error(`WASIX host smoke requires a canonical regular Cargo file: ${identity.name}`);
    readCargoManifest(input.file, identity.name, identity.version);
    const bytes = readFileSync(input.file);
    return {
      ...identity,
      path: path.basename(input.file),
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readCargoManifest(archive: string, name: string, version?: string) {
  const entries = readPortableArchiveEntries(archive);
  const roots = [...entries.values()].filter(
    (entry) => entry.isFile && /^[^/]+\/Cargo\.toml$/u.test(entry.name),
  );
  if (roots.length !== 1) throw new Error(`${name} crate must contain one root Cargo.toml`);
  const root = roots[0].name.split('/')[0];
  if (version !== undefined && root !== `${name}-${version}`)
    throw new Error(`${name} archive root differs from its declared version`);
  const manifest = Bun.TOML.parse(roots[0].data().toString('utf8'));
  if (
    manifest.package?.name !== name ||
    (version !== undefined && manifest.package.version !== version)
  )
    throw new Error(`WASIX Cargo archive identity differs: ${name}`);
  return { entries, manifest, root };
}

function expectedTarget(name: string) {
  name = wasixRuntimeCargoParent(name) ?? name;
  if (name === RUNTIME_PACKAGE) return 'portable';
  const target = AOT_BY_NAME.get(name);
  if (!target) throw new Error(`unknown WASIX Cargo carrier ${name}`);
  return target;
}

function expectedRole(name: string) {
  if (wasixRuntimeCargoParent(name) !== name) return 'payload-part';
  return name === RUNTIME_PACKAGE ? 'platform-leaf' : 'aot-leaf';
}

function expectedKind(name: string) {
  name = wasixRuntimeCargoParent(name) ?? name;
  return name === RUNTIME_PACKAGE ? 'wasix-runtime' : 'wasix-aot';
}

function expectedLinks(name: string) {
  const parent = wasixRuntimeCargoParent(name);
  if (parent !== name) {
    const triple = AOT_TARGET_TRIPLES[expectedTarget(name)];
    return `oliphaunt_artifact_part_liboliphaunt_wasix_${triple.replaceAll('-', '_')}_${name.slice(-3)}`;
  }
  if (name === RUNTIME_PACKAGE) return 'oliphaunt_artifact_liboliphaunt_wasix_runtime';
  return `oliphaunt_artifact_liboliphaunt_wasix_aot_${expectedTarget(name).replaceAll('-', '_')}`;
}

/** Parts belong to the declared AOT parent; they introduce no release owner. */
export function wasixRuntimeCargoParent(name: string): string | undefined {
  if (PACKAGE_PATHS.has(name)) return name;
  const match = /^(.*)-part-([0-9]{3})$/u.exec(name);
  return match && AOT_BY_NAME.has(match[1]) && Number(match[2]) > 0 ? match[1] : undefined;
}

function exactRows(rows: CargoInput[]) {
  if (!Array.isArray(rows) || rows.length < PACKAGE_NAMES.length)
    throw new Error('WASIX construction receipt requires exactly five Cargo parents');
  const byName = new Map<string, CargoInput>();
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || byName.has(row.name))
      throw new Error('WASIX construction receipt has duplicate or invalid package names');
    if (!wasixRuntimeCargoParent(row.name))
      throw new Error(`unknown WASIX Cargo carrier ${row.name}`);
    if (row.target !== expectedTarget(row.name))
      throw new Error(`WASIX Cargo target differs for ${row.name}`);
    if (!path.isAbsolute(row.file))
      throw new Error(`WASIX Cargo archive path must be absolute: ${row.name}`);
    byName.set(row.name, row);
  }
  if (PACKAGE_NAMES.some((name) => !byName.has(name)))
    throw new Error('WASIX construction receipt is missing a canonical Cargo archive');
  return [...byName.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function readRuntimeFamilies(rows: CargoInput[]) {
  const manifests = new Map<string, any>();
  for (const parent of PACKAGE_NAMES) {
    const target = expectedTarget(parent);
    const family = readRuntimeCargoFamily(
      rows.filter((row) => wasixRuntimeCargoParent(row.name) === parent).map((row) => row.file),
      target === 'portable' ? null : target,
    );
    manifests.set(parent, family.parent.manifest);
    for (const { name, manifest } of family.parts) {
      if (
        ['dependencies', 'dev-dependencies', 'build-dependencies', 'target'].some(
          (key) => Object.keys(manifest[key] ?? {}).length,
        )
      )
        throw new Error(`WASIX Cargo payload part must contain only data: ${name}`);
      manifests.set(name, manifest);
    }
  }
  return manifests;
}

export type CargoInput = { file: string; name: string; target: string };

/** Write a deterministic receipt over final copied .crate envelopes. */
export function writeWasixCargoConstructionReceipt(
  inputs: CargoInput[],
  {
    sourceCommit,
    sourceTree,
    releaseManifest,
    toolchainManifest,
    cargoLock,
    versionManifest,
    hostSmokeInputs,
    sourceRoot,
  }: {
    sourceCommit: string;
    sourceTree: string;
    releaseManifest: string;
    toolchainManifest: string;
    cargoLock: string;
    versionManifest: string;
    hostSmokeInputs?: CargoInput[];
    sourceRoot?: string;
  },
) {
  if (!COMMIT.test(sourceCommit) || !COMMIT.test(sourceTree))
    throw new Error('WASIX construction receipt requires exact source commit and tree SHAs');
  const release = Bun.TOML.parse(readFileSync(releaseManifest, 'utf8'));
  if (release.id !== 'liboliphaunt-wasix')
    throw new Error('WASIX construction receipt release identity is not canonical');
  const versionManifestData = Bun.TOML.parse(readFileSync(versionManifest, 'utf8'));
  const version = versionManifestData.package?.version;
  if (
    versionManifestData.package?.name !== RUNTIME_PACKAGE ||
    typeof version !== 'string' ||
    !version
  )
    throw new Error('WASIX version manifest has no canonical package version');
  const releaseCrates = (release.registry_packages ?? [])
    .filter((name: string) => name.startsWith('crates:'))
    .map((name: string) => name.slice('crates:'.length))
    .sort();
  if (JSON.stringify(releaseCrates) !== JSON.stringify(PACKAGE_NAMES))
    throw new Error('WASIX release manifest does not declare the canonical five Cargo carriers');
  const ordered = exactRows(inputs);
  const manifests = readRuntimeFamilies(ordered);
  const rows = ordered.map(({ file, name, target }) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`WASIX Cargo archive must be a regular file: ${name}`);
    const bytes = readFileSync(file);
    const manifest = manifests.get(name);
    if (
      manifest.package.version !== version ||
      manifest.package.links !== expectedLinks(name) ||
      path.basename(file) !== `${name}-${version}.crate`
    )
      throw new Error(`WASIX Cargo version differs from release manifest: ${name}`);
    return {
      name,
      version,
      target,
      kind: expectedKind(name),
      role: expectedRole(name),
      path: path.basename(file),
      size: bytes.length,
      sha256: sha256(bytes),
    };
  });
  if (hostSmokeInputs && !sourceRoot)
    throw new Error('WASIX host smoke requires its declared conventional source manifests');
  const hostSmokeCrates =
    hostSmokeInputs && sourceRoot
      ? wasixHostSmokeCargoRows(hostSmokeInputs, sourceRoot, version)
      : undefined;
  return {
    schema: SCHEMA,
    source: { commit: sourceCommit, tree: sourceTree },
    product: release.id,
    version,
    releaseManifestSha256: sha256(readFileSync(releaseManifest)),
    toolchainManifestSha256: sha256(readFileSync(toolchainManifest)),
    cargoLockSha256: sha256(readFileSync(cargoLock)),
    versionManifestSha256: sha256(readFileSync(versionManifest)),
    crates: rows,
    ...(hostSmokeCrates ? { hostSmokeCrates } : {}),
  };
}

function starlark(value: unknown): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (Array.isArray(value)) return `[${value.map(starlark).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${starlark(item)}`)
      .join(', ')}}`;
  return JSON.stringify(value);
}

/** Verify, privately extract, and project the exact packed source into a Bazel repo. */
export function extractWasixCargoConstructionInputs(
  receipt: unknown,
  inputDirectory: string,
  expectedSourceCommit: string,
  outputDirectory: string,
  {
    releaseManifest,
    toolchainManifest,
    cargoLock,
    versionManifest,
    rustDefs,
    cratesDefs,
    sourceRoot,
  }: {
    releaseManifest: string;
    toolchainManifest: string;
    cargoLock: string;
    versionManifest: string;
    rustDefs: string;
    cratesDefs: string;
    sourceRoot: string;
  },
) {
  const value = receipt as any;
  if (
    !value ||
    value.schema !== SCHEMA ||
    value.product !== 'liboliphaunt-wasix' ||
    !COMMIT.test(expectedSourceCommit) ||
    value.source?.commit !== expectedSourceCommit ||
    !COMMIT.test(value.source?.tree ?? '') ||
    value.releaseManifestSha256 !== sha256(readFileSync(releaseManifest)) ||
    value.toolchainManifestSha256 !== sha256(readFileSync(toolchainManifest)) ||
    value.cargoLockSha256 !== sha256(readFileSync(cargoLock)) ||
    value.versionManifestSha256 !== sha256(readFileSync(versionManifest))
  )
    throw new Error('WASIX construction receipt does not match the exact source inputs');
  const rows = exactRows(
    (value.crates ?? []).map((row: any) => ({
      file: path.resolve(inputDirectory, row.path ?? ''),
      name: row.name,
      target: row.target,
    })),
  );
  if (rows.some((row, index) => row.name !== value.crates[index]?.name))
    throw new Error('WASIX construction receipt crates must use canonical ordering');
  const release = Bun.TOML.parse(readFileSync(releaseManifest, 'utf8'));
  const versionPackage = Bun.TOML.parse(readFileSync(versionManifest, 'utf8')).package;
  const declaredVersion = versionPackage?.version;
  if (
    release.id !== value.product ||
    versionPackage?.name !== RUNTIME_PACKAGE ||
    declaredVersion !== value.version
  )
    throw new Error('WASIX construction receipt version differs from release manifest');
  for (const row of value.crates) {
    if (
      row.version !== value.version ||
      row.kind !== expectedKind(row.name) ||
      row.role !== expectedRole(row.name) ||
      !Number.isSafeInteger(row.size) ||
      row.size <= 0 ||
      !SHA.test(row.sha256) ||
      path.basename(row.path) !== row.path ||
      !row.path.endsWith('.crate')
    )
      throw new Error(`invalid WASIX Cargo receipt row: ${row.name}`);
    const file = path.join(inputDirectory, row.path);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`WASIX Cargo archive must be a regular file: ${row.name}`);
    if (row.path !== `${row.name}-${row.version}.crate`)
      throw new Error(`WASIX Cargo archive filename differs: ${row.name}`);
    const bytes = readFileSync(file);
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256)
      throw new Error(`WASIX Cargo archive hash differs: ${row.name}`);
  }
  const packedManifests = readRuntimeFamilies(rows);
  for (const row of value.crates) {
    const manifest = packedManifests.get(row.name);
    if (manifest.package.version !== value.version)
      throw new Error(`WASIX Cargo version differs from receipt: ${row.name}`);
    if (manifest.package.links !== expectedLinks(row.name))
      throw new Error(`WASIX Cargo links identity differs: ${row.name}`);
  }
  if (value.hostSmokeCrates !== undefined) {
    if (
      !Array.isArray(value.hostSmokeCrates) ||
      value.hostSmokeCrates.some(
        (row: any) => row?.path !== `${row?.name}-${row?.version}.crate` || /[\\/]/u.test(row.path),
      )
    )
      throw new Error('WASIX host smoke receipt requires canonical regular archive filenames');
    const support = wasixHostSmokeCargoRows(
      value.hostSmokeCrates.map((row: any) => ({
        name: row.name,
        target: row.target,
        file: path.join(inputDirectory, row.path ?? ''),
      })),
      sourceRoot,
      value.version,
    );
    if (!isDeepStrictEqual(support, value.hostSmokeCrates))
      throw new Error('WASIX host smoke Cargo identities or hashes differ from the receipt');
    const supportDirectory = path.join(outputDirectory, 'host-smoke');
    mkdirSync(supportDirectory, { recursive: true });
    for (const row of [
      ...value.crates.filter((row: any) => row.name === RUNTIME_PACKAGE),
      ...support,
    ])
      copyFileSync(path.join(inputDirectory, row.path), path.join(supportDirectory, row.path));
  }
  mkdirSync(outputDirectory, { recursive: true });
  const staged = path.join(outputDirectory, '.staged');
  stageCargoCarrierInputs(
    value.crates.map((row: any) => ({
      file: path.join(inputDirectory, row.path),
      name: row.name,
      version: row.version,
      sha256: row.sha256,
    })),
    staged,
  );
  const lock = Bun.TOML.parse(readFileSync(cargoLock, 'utf8'));
  const memberPaths = new Map(PACKAGE_PATHS);
  for (const row of rows) {
    const parent = wasixRuntimeCargoParent(row.name)!;
    if (row.name !== parent)
      memberPaths.set(row.name, `${PACKAGE_PATHS.get(parent)}/parts/${row.name}`);
  }
  const workspace = {
    workspace: { members: [...memberPaths.values()], resolver: '3' },
  };
  for (const name of PACKAGE_NAMES) {
    const target = expectedTarget(name);
    extractRuntimeCargoFamily(
      rows.filter((row) => wasixRuntimeCargoParent(row.name) === name).map((row) => row.file),
      path.join(staged, 'families', name),
      target === 'portable' ? null : target,
      sourceRoot,
    );
  }
  const manifests = new Map<string, any>();
  for (const { name } of rows) {
    const stagedPath = path.join(staged, 'crates', `${name}-${value.version}`);
    const memberPath = memberPaths.get(name)!;
    const destination = path.join(outputDirectory, memberPath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(stagedPath, destination, { recursive: true, errorOnExist: true, force: false });
    const manifest = Bun.TOML.parse(readFileSync(path.join(destination, 'Cargo.toml'), 'utf8'));
    if (manifest.workspace && Object.keys(manifest.workspace).length)
      throw new Error(`${name} packed workspace metadata is not empty`);
    delete manifest.workspace;
    manifests.set(memberPath, manifest);
  }
  const parts = rows.filter((row) => wasixRuntimeCargoParent(row.name) !== row.name);
  for (const part of parts) {
    if (lock.package.some((row: any) => row.name === part.name))
      throw new Error(`Packed WASIX Cargo part collides with the source lock: ${part.name}`);
    const parent = wasixRuntimeCargoParent(part.name)!;
    const parentPath = memberPaths.get(parent)!;
    const manifest = manifests.get(parentPath);
    manifest['build-dependencies'][part.name].path = path.posix.relative(
      parentPath,
      memberPaths.get(part.name)!,
    );
    const local = lock.package.filter((row: any) => row.name === parent && !row.source);
    if (local.length !== 1 || local[0].version !== value.version)
      throw new Error(`Packed WASIX Cargo parent differs from the source lock: ${parent}`);
    local[0].dependencies = [...(local[0].dependencies ?? []), part.name];
    lock.package.push({ name: part.name, version: value.version });
  }
  for (const parent of new Set(parts.map((row) => wasixRuntimeCargoParent(row.name)!))) {
    const member = memberPaths.get(parent)!;
    writeFileSync(
      path.join(outputDirectory, member, 'Cargo.toml'),
      renderToml(manifests.get(member)),
    );
  }
  const projection = projectCargoWorkspace(
    workspace,
    lock,
    PACKAGE_NAMES.map((name) => PACKAGE_PATHS.get(name)!),
    (relative) => {
      const member = path.posix.dirname(relative);
      if (relative.endsWith('/Cargo.toml')) return manifests.get(member);
      throw new Error(`unexpected projected Cargo manifest: ${relative}`);
    },
    (relative) => {
      const file = path.join(outputDirectory, relative);
      try {
        return readFileSync(file).length >= 0;
      } catch {
        return false;
      }
    },
  );
  for (const [relative, contents] of Object.entries(projection.files)) {
    if (relative === 'Cargo.lock' || relative !== 'Cargo.toml') continue;
    const file = path.join(outputDirectory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  if (parts.length) writeFileSync(path.join(outputDirectory, 'Cargo.lock'), renderToml(lock));
  else copyFileSync(cargoLock, path.join(outputDirectory, 'Cargo.lock'));
  writeFileSync(path.join(outputDirectory, 'cargo-facts.json'), JSON.stringify(projection.facts));
  const rootBuild = [
    'package(default_visibility = ["//visibility:public"])',
    'exports_files(["Cargo.toml", "Cargo.lock", "cargo.bzl", "cargo-facts.json"])',
    'filegroup(name = "host_smoke", srcs = glob(["host-smoke/*.crate"], allow_empty = True))',
    '',
  ].join('\n');
  writeFileSync(path.join(outputDirectory, 'BUILD.bazel'), rootBuild);
  writeFileSync(
    path.join(outputDirectory, 'cargo.bzl'),
    `CARGO = ${starlark(projection.facts)}\n\ndef packed_cargo_manifest_dir():\n    return Label("//:Cargo.toml").workspace_root + "/" + native.package_name()\n`,
  );
  for (const { name } of rows) {
    const memberPath = memberPaths.get(name)!;
    const parent = wasixRuntimeCargoParent(name)!;
    const part = name !== parent;
    const ownParts = parts.filter((row) => wasixRuntimeCargoParent(row.name) === name);
    const payload = name === RUNTIME_PACKAGE ? 'payload/**' : 'artifacts/**';
    const pathDependencies = Object.fromEntries(
      ownParts.map((row) => [row.name, `//${memberPaths.get(row.name)}:lib`]),
    );
    const payloadGroups = [
      ':packed_payload',
      ...ownParts.map((row) => `//${memberPaths.get(row.name)}:packed_payload`),
    ];
    const buildScriptEnv = {
      OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD: '1',
      OLIPHAUNT_ARTIFACT_CRATE_EMIT_CARGO_MANIFEST: '0',
      // Preserve rules_rust's execroot placeholder through Bazel's Make expansion.
      ...(ownParts.length ? { OLIPHAUNT_BAZEL_EXEC_ROOT: `$\${pwd}` } : {}),
    };
    const build = [
      `load(${JSON.stringify(rustDefs)}, "cargo_generator", "cargo_library", "cargo_package_env")`,
      `load(${JSON.stringify(cratesDefs)}, "crate_deps")`,
      `load("//:cargo.bzl", "CARGO", "packed_cargo_manifest_dir")`,
      'package(default_visibility = ["//visibility:public"])',
      'exports_files(["Cargo.toml"])',
      `filegroup(name = "packed_payload", srcs = ${ownParts.length ? '[]' : `glob([${JSON.stringify(part ? 'payload/**' : payload)}])`})`,
      'cargo_package_env(workspace_manifest = "//:Cargo.toml")',
      '# Generated includes must refer to declared package files, not pruned build-script runfiles.',
      ...(part
        ? [
            'cargo_generator(data = [":packed_payload"], build_script_env = {"CARGO_MANIFEST_DIR": packed_cargo_manifest_dir(), "OLIPHAUNT_ARTIFACT_CRATE_REQUIRE_PAYLOAD": "1"}, cargo_facts = CARGO, crate_dependencies = crate_deps)',
            'cargo_library(build_script = ":build_script", rustc_env = {"CARGO_MANIFEST_DIR": packed_cargo_manifest_dir()}, cargo_facts = CARGO, crate_dependencies = crate_deps)',
          ]
        : [
            `cargo_generator(path_dependencies = ${starlark(pathDependencies)}, srcs = ${starlark(['build-support.rs', ...(ownParts.length ? ['cargo-parts.rs'] : [])])}, data = ${starlark(payloadGroups)}, build_script_env = dict(${starlark(buildScriptEnv)}, CARGO_MANIFEST_DIR = packed_cargo_manifest_dir()), cargo_facts = CARGO, crate_dependencies = crate_deps)`,
            'cargo_library(build_script = ":build_script", compile_data = [":packed_payload"], cargo_facts = CARGO, crate_dependencies = crate_deps)',
          ]),
      '',
    ].join('\n');
    writeFileSync(path.join(outputDirectory, memberPath, 'BUILD.bazel'), build);
  }
  rmSync(staged, { recursive: true, force: true });
  return {
    packages: rows.map(({ name }) => ({
      name,
      path: memberPaths.get(name),
      target: expectedTarget(name),
    })),
  };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'receipt') {
    const [
      inputJson,
      output,
      sourceCommit,
      sourceTree,
      releaseManifest,
      toolchainManifest,
      cargoLock,
      versionManifest,
    ] = args;
    const input = JSON.parse(readFileSync(inputJson, 'utf8'));
    const receipt = writeWasixCargoConstructionReceipt(input, {
      sourceCommit,
      sourceTree,
      releaseManifest,
      toolchainManifest,
      cargoLock,
      versionManifest,
    });
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  } else if (command === 'extract') {
    const [
      receiptFile,
      inputDirectory,
      expectedCommit,
      outputDirectory,
      releaseManifest,
      toolchainManifest,
      cargoLock,
      versionManifest,
      rustDefs,
      cratesDefs,
      sourceRoot,
    ] = args;
    const result = extractWasixCargoConstructionInputs(
      JSON.parse(readFileSync(receiptFile, 'utf8')),
      inputDirectory,
      expectedCommit,
      outputDirectory,
      {
        releaseManifest,
        toolchainManifest,
        cargoLock,
        versionManifest,
        rustDefs,
        cratesDefs,
        sourceRoot,
      },
    );
    console.log(JSON.stringify(result));
  } else {
    throw new Error('usage: cargo-inputs.mts receipt|extract ...');
  }
}
