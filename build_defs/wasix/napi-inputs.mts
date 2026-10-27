import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertCanonicalWasixAotManifest } from '../../src/wasix/runtime/tools/wasix-aot-manifest.mts';
import {
  AOT_PACKAGES,
  AOT_TARGET_CFGS,
  AOT_TARGET_TRIPLES,
  CORE_AOT_ARTIFACTS,
  wasixExtensionAotPackageName,
  wasixExtensionPackageName,
} from '../../src/wasix/runtime/tools/wasix-cargo-artifact-contract.mts';
import { cargoSatisfies } from '../../tools/packaging/cargo-manifest.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import {
  readWasixCargoCarrierPayload,
  readWasixCargoCarrierSet,
} from '../../tools/packaging/wasix-extension-cargo-family.mts';
import { copyNativeInputFile, safeRelative } from '../../tools/release/native-file-identity.mts';
import { ROOT } from '../../tools/release/release-graph.mts';
import { extractRuntimeCargoFamily } from './cargo.mts';

export type WasixNapiInputsSpec = {
  target: string;
  targetTriple: string;
  sdkManifest: string;
  runtimeVersion: string;
  sdkVersion: string;
  sqlNames: string[];
  portableArchive: string | string[];
  coreAotArchive: string | string[];
  contribFrozen: string;
  contribPortable: string | string[];
  contribAot: string | string[];
  archiveFiles?: string[];
  output: string;
};
type FileIdentity = { path: string; sha256: string; size: number };
const PRODUCT = 'oliphaunt-extension-contrib-pg18';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const comparePath = (a: FileIdentity, b: FileIdentity) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Stage current source Cargo inputs and the exact qualified payloads its build scripts consume. */
export function stageWasixNapiInputs(spec: WasixNapiInputsSpec) {
  assert.equal(
    AOT_TARGET_TRIPLES[spec.target],
    spec.targetTriple,
    'unsupported WASIX addon target',
  );
  assert(AOT_PACKAGES[spec.target], 'unsupported WASIX addon target');
  for (const version of [spec.runtimeVersion, spec.sdkVersion])
    assert.match(
      version,
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
      'source version must be exact',
    );
  const names = [...spec.sqlNames].sort();
  assert(names.length > 0, 'WASIX release requires its declared contrib members');
  assert.equal(new Set(names).size, names.length, 'duplicate release contrib member');
  assert(
    names.every((name) => /^[a-z0-9][a-z0-9_-]*$/u.test(name)),
    'invalid contrib SQL name',
  );
  const files = new Map<string, FileIdentity>();
  const remember = (member: string, identity: { sha256: string; size: number }) => {
    safeRelative(member);
    assert(!files.has(member), `duplicate WASIX construction file ${member}`);
    assert(identity.size > 0, `empty WASIX construction file ${member}`);
    const record = { path: member, sha256: identity.sha256, size: identity.size };
    files.set(member, record);
    return record;
  };
  const copy = (input: string, member: string) => {
    safeRelative(member);
    const absolute = path.resolve(input);
    const root = path.parse(absolute).root;
    return remember(
      member,
      copyNativeInputFile(
        root,
        path.relative(root, absolute).split(path.sep).join('/'),
        path.join(spec.output, member),
      ),
    );
  };
  const write = (member: string, bytes: Uint8Array) => {
    safeRelative(member);
    assert(!files.has(member), `duplicate WASIX construction file ${member}`);
    mkdirSync(path.dirname(path.join(spec.output, member)), { recursive: true });
    writeFileSync(path.join(spec.output, member), bytes, { flag: 'wx', mode: 0o644 });
    return remember(member, { sha256: sha256(bytes), size: bytes.length });
  };
  const json = (record: FileIdentity) =>
    JSON.parse(readFileSync(path.join(spec.output, record.path), 'utf8'));
  const sdk = Bun.TOML.parse(readFileSync(spec.sdkManifest, 'utf8'));
  assert.equal(sdk.package?.name, 'oliphaunt-wasix', 'source SDK package name differs');
  assert.equal(sdk.package.version, spec.sdkVersion, 'source SDK version differs');
  for (const [dependency, relative] of [
    [sdk.dependencies?.['liboliphaunt-wasix-portable'], '../../runtime/crates/assets'],
    [
      sdk.target?.[AOT_TARGET_CFGS[spec.targetTriple]]?.dependencies?.[AOT_PACKAGES[spec.target]],
      `../../runtime/crates/aot/${spec.targetTriple}`,
    ],
  ] as const) {
    assert.equal(typeof dependency?.path, 'string', 'source SDK requires its local runtime path');
    assert.equal(
      path.resolve(path.dirname(spec.sdkManifest), dependency.path),
      path.resolve(path.dirname(spec.sdkManifest), relative),
      'source SDK runtime path differs',
    );
    assert(
      typeof dependency.version === 'string' &&
        cargoSatisfies(spec.runtimeVersion, dependency.version),
      'source SDK runtime requirement excludes the constructed core',
    );
  }
  const archiveFiles = (value: string | string[], partsParent?: string) => {
    const roots = typeof value === 'string' ? [value] : value;
    assert(Array.isArray(roots) && roots.length, 'Cargo family has no declared inputs');
    const declared = spec.archiveFiles;
    const files = declared
      ? roots.flatMap((root) => {
          const leaves = declared.filter((file) => file === root || file.startsWith(`${root}/`));
          assert(
            leaves.length || path.basename(root) === partsParent,
            `Cargo family has no declared leaves: ${root}`,
          );
          return leaves;
        })
      : roots;
    assert.equal(new Set(files).size, files.length, 'Cargo family repeats a declared archive');
    return files;
  };
  const crate = (archive: string | string[], name: string) => {
    const family = archiveFiles(archive);
    assert.equal(family.length, 1, `${name} requires its one declared Cargo archive`);
    const entries = readPortableArchiveEntries(realpathSync(family[0]), { format: 'tar.gz' });
    const root = `${name}-${spec.runtimeVersion}`;
    const member = (relative: string) => {
      safeRelative(relative);
      const entry = entries.get(`${root}/${relative}`);
      assert(
        entry?.isFile && !entry.isSymbolicLink && entry.size > 0,
        `missing regular Cargo payload ${name}/${relative}`,
      );
      return Buffer.from(entry.data());
    };
    const manifests = [...entries.values()].filter((entry) =>
      /^[^/]+\/Cargo\.toml$/u.test(entry.name),
    );
    assert.equal(manifests.length, 1, 'Cargo input must contain one canonical root manifest');
    const manifest = Bun.TOML.parse(member('Cargo.toml').toString('utf8'));
    assert.equal(manifest.package?.name, name, 'constructed Cargo package name differs');
    assert.equal(
      manifest.package.version,
      spec.runtimeVersion,
      'constructed Cargo version differs',
    );
    assert(
      !Object.hasOwn(manifest.package.metadata?.oliphaunt ?? {}, 'qualificationOnly'),
      'WASIX payload is a qualification package',
    );
    return member;
  };
  const extensionCrate = (archive: string | string[], name: string, target: string) => {
    const records = readWasixCargoCarrierSet(
      [
        {
          product: 'liboliphaunt-wasix',
          ecosystem: 'cargo',
          name,
          version: spec.runtimeVersion,
          target,
          role: target === 'wasix-portable' ? 'portable-leaf' : 'aot-leaf',
        },
      ],
      archiveFiles(archive, name).map((file) => realpathSync(file)),
    );
    const parent = records.find((record) => record.declared);
    assert(parent, 'Contrib Cargo family has no canonical parent');
    const payload = readWasixCargoCarrierPayload(records, parent);
    return (relative: string) => {
      safeRelative(relative);
      const entry = parent.entries.get(`${parent.prefix}/${relative}`);
      const bytes = relative.startsWith('payload/files/')
        ? payload.get(relative.slice('payload/files/'.length))
        : entry?.isFile && !entry.isSymbolicLink
          ? Buffer.from(entry.data())
          : undefined;
      assert(bytes?.length, `missing regular Cargo payload ${name}/${relative}`);
      return bytes;
    };
  };
  const portable = crate(spec.portableArchive, 'liboliphaunt-wasix-portable');
  const portableManifest = write('portable/manifest.json', portable('payload/manifest.json'));
  const portableValue = json(portableManifest);
  assert.equal(portableValue['format-version'], 2, 'portable manifest format differs');
  assert.equal(typeof portableValue['source-fingerprint'], 'string');
  assert(portableValue['source-fingerprint'].length > 0, 'portable source fingerprint is empty');
  assert.equal(portableValue.runtime.archive, 'oliphaunt.wasix.tar.zst');
  const runtimeArchive = write(
    'portable/oliphaunt.wasix.tar.zst',
    portable('payload/oliphaunt.wasix.tar.zst'),
  );
  assert.equal(
    runtimeArchive.sha256,
    portableValue.runtime.sha256,
    'portable runtime hash differs',
  );
  if (portableValue.runtime.size !== undefined)
    assert.equal(runtimeArchive.size, portableValue.runtime.size, 'portable runtime size differs');
  write('portable/bin/initdb.wasix.wasm', portable('payload/bin/initdb.wasix.wasm'));
  const aot = (
    manifest: FileIdentity,
    member: (relative: string) => Buffer,
    expectedModules: Map<string, string | undefined>,
    payloadRoot: string,
    archiveRoot: string,
  ) => {
    const value = json(manifest);
    assertCanonicalWasixAotManifest(value, {
      context: manifest.path,
      expectedTarget: spec.targetTriple,
    });
    assert.equal(
      value['source-fingerprint'],
      portableValue['source-fingerprint'],
      'AOT and portable source fingerprints differ',
    );
    assert(Array.isArray(value.artifacts) && value.artifacts.length > 0, 'AOT manifest is empty');
    const actualNames = value.artifacts.map((artifact: any) => {
      assert(expectedModules.has(artifact.name), 'AOT manifest includes a foreign artifact');
      const relative = safeRelative(artifact.path);
      const payload = write(`${payloadRoot}/${relative}`, member(`${archiveRoot}/${relative}`));
      assert.equal(payload.sha256, artifact.sha256, 'AOT payload hash differs from manifest');
      const moduleSha = expectedModules.get(artifact.name);
      if (moduleSha !== undefined)
        assert.equal(artifact['module-sha256'], moduleSha, 'AOT portable module identity differs');
      return artifact.name;
    });
    assert.deepEqual(
      [...actualNames].sort(),
      [...expectedModules.keys()].sort(),
      'AOT inventory differs',
    );
  };
  const aotRoot = `aot/${spec.targetTriple}`;
  const scratch = mkdtempSync(path.join(path.dirname(spec.output), '.wasix-napi-core-'));
  let runtimeAotManifest: FileIdentity;
  try {
    const directory = extractRuntimeCargoFamily(
      archiveFiles(spec.coreAotArchive),
      path.join(scratch, 'family'),
      spec.target,
      ROOT,
    );
    const manifest = Bun.TOML.parse(readFileSync(path.join(directory, 'Cargo.toml'), 'utf8'));
    assert.equal(manifest.package.name, AOT_PACKAGES[spec.target]);
    assert.equal(
      manifest.package.version,
      spec.runtimeVersion,
      'constructed Cargo version differs',
    );
    const core = (relative: string) => {
      safeRelative(relative);
      return readFileSync(path.join(directory, relative));
    };
    runtimeAotManifest = write(`${aotRoot}/manifest.json`, core('artifacts/manifest.json'));
    aot(
      runtimeAotManifest,
      core,
      new Map(CORE_AOT_ARTIFACTS.map((name) => [name, undefined])),
      aotRoot,
      'artifacts',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const productRoot = `extensions/${PRODUCT}`;
  const frozen = json(copy(spec.contribFrozen, `${productRoot}/extension-artifacts.json`));
  assert.equal(
    frozen.schema,
    'oliphaunt-extension-ci-artifacts-v2',
    'contrib metadata must be a bundle',
  );
  assert.equal(frozen.product, PRODUCT, 'contrib metadata product differs');
  assert.equal(frozen.version, spec.runtimeVersion, 'contrib version differs from runtime owner');
  assert.equal(frozen.compatibility?.wasixRuntimeProduct, 'liboliphaunt-wasix');
  assert.equal(frozen.compatibility.wasixRuntimeVersion, spec.runtimeVersion);
  assert(Array.isArray(frozen.extensions), 'contrib metadata has no member inventory');
  const members = new Map<string, any>();
  for (const member of frozen.extensions) {
    assert(!members.has(member.sqlName), 'contrib metadata repeats a member');
    members.set(member.sqlName, member);
  }
  const contribPortable = extensionCrate(
    spec.contribPortable,
    wasixExtensionPackageName(PRODUCT),
    'wasix-portable',
  );
  const contribAot = extensionCrate(
    spec.contribAot,
    wasixExtensionAotPackageName(PRODUCT, spec.targetTriple),
    spec.targetTriple,
  );
  const portableArchives = [];
  const aotManifests = [];
  for (const sqlName of names) {
    const member = members.get(sqlName);
    assert(member, `contrib metadata is missing ${sqlName}`);
    const assets = member.assets.filter((asset: any) => asset.target === 'wasix-portable');
    assert.equal(assets.length, 1, 'contrib member requires one portable asset');
    const archive = write(
      `${productRoot}/member-assets/${sqlName}/${PRODUCT}-${spec.runtimeVersion}-wasix-portable.tar.zst`,
      contribPortable(`payload/files/extensions/${sqlName}/extension.tar.zst`),
    );
    assert.equal(archive.sha256, assets[0].sha256, 'contrib portable payload hash differs');
    assert.equal(archive.size, assets[0].bytes, 'contrib portable payload size differs');
    portableArchives.push({ sqlName, ...archive });
    const root = `${productRoot}/wasix-aot/${spec.target}/${sqlName}`;
    const manifest = write(`${root}/manifest.json`, contribAot(`manifests/${sqlName}.json`));
    const modules = member.wasixInstall?.nativeModules;
    assert(Array.isArray(modules) && modules.length > 0, 'selected contrib member has no modules');
    const expected = new Map<string, string>(
      modules.map((module: any) => {
        assert.match(module.moduleSha256, /^[0-9a-f]{64}$/u, 'contrib module has no SHA-256');
        return [
          `extension:${sqlName}${module.name === sqlName ? '' : `:${module.name}`}`,
          module.moduleSha256,
        ];
      }),
    );
    assert.equal(expected.size, modules.length, 'contrib metadata repeats a native module');
    aot(manifest, contribAot, expected, root, `payload/files/extensions/${sqlName}`);
    aotManifests.push({ sqlName, targetTriple: spec.targetTriple, ...manifest });
  }
  const layout = {
    runtimeVersion: spec.runtimeVersion,
    portableRoot: 'portable',
    aotRoot,
    extensionRoot: 'extensions',
  };
  write('layout.json', Buffer.from(`${JSON.stringify(layout, null, 2)}\n`));
  const inventory = {
    schema: 'oliphaunt-wasix-napi-build-inputs-v3',
    target: spec.target,
    targetTriple: spec.targetTriple,
    runtimeVersion: spec.runtimeVersion,
    sdk: { name: 'oliphaunt-wasix', version: spec.sdkVersion },
    files: [...files.values()].sort(comparePath),
    inputs: {
      portableManifest,
      runtimeArchive,
      runtimeAotManifest: { targetTriple: spec.targetTriple, ...runtimeAotManifest },
      extensionArtifacts: [{ product: PRODUCT, portableArchives, aotManifests }],
    },
  };
  writeFileSync(
    path.join(spec.output, 'build-inputs.json'),
    `${JSON.stringify(inventory, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  return { inventory, ...layout };
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    options: { 'archive-files': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  assert.equal(
    positionals.length,
    1,
    'usage: napi-inputs.mts <spec> --archive-files <declared-leaves>',
  );
  assert(values['archive-files'], 'WASIX addon requires declared Cargo family leaves');
  stageWasixNapiInputs({
    ...JSON.parse(readFileSync(positionals[0], 'utf8')),
    archiveFiles: readFileSync(values['archive-files'], 'utf8').trimEnd().split(/\r?\n/u),
  });
}
