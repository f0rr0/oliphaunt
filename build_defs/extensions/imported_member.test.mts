/** Production formatters over parsing fixtures; these tests grant no artifact admission. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeExtensionReleaseDocuments } from '../../src/extensions/artifacts/packages/tools/build-extension-ci-artifacts.mts';
import { bundleCarrierAssets } from '../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { elfFixture } from '../../tools/packaging/testdata/release-fixture-utils.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import { stageNativeRustExtensions } from '../native/rust-runtime-test.mts';
import { validateDeclaredExtensionFinalInput } from './declared_final_inputs.mts';
import { type ImportedMemberSpec, importMembers } from './imported_member.mts';
import { assemble } from './member_payload.mts';
import {
  assemblePublicNativeMember,
  type NativeCarrierSpec,
  nativeCarrierCompatibility,
} from './native_carriers.mts';
import type { NativeOwnerSpec } from './owner_carriers.mts';
import { inspect } from './validate_member_payload.mts';

const roots = new Set<string>();
const repository = path.resolve(import.meta.dir, '../..');
const catalog = JSON.parse(
  readFileSync(path.join(repository, 'src/extensions/catalog/extensions.source.json'), 'utf8'),
).extensions;
const contrib = Bun.TOML.parse(
  readFileSync(path.join(repository, 'src/extensions/contrib/postgres18.toml'), 'utf8'),
).extensions;
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture(sqlNames: string[]): Promise<ImportedMemberSpec> {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'imported-member-test-'));
  roots.add(root);
  const external = sqlNames[0] === 'vector';
  const product = external ? 'oliphaunt-extension-vector' : 'oliphaunt-extension-contrib-pg18';
  const owner = external ? product : 'liboliphaunt-native';
  const configuration = external ? 'linux-arm64-gnu' : 'linux-x64-gnu';
  const version = '1.2.3';
  const members: NativeCarrierSpec[] = [];
  const frozen: any[] = [];
  for (const sqlName of sqlNames) {
    const descriptor = catalog.find((row: any) => row['sql-name'] === sqlName);
    const contributed = contrib.find((row: any) => row['sql-name'] === sqlName);
    const source = external
      ? {
          ...Bun.TOML.parse(
            readFileSync(
              path.join(repository, 'src/extensions/external/vector/source.toml'),
              'utf8',
            ),
          ),
          product,
        }
      : { parsingFixture: 'postgres-contrib' };
    const member = {
      product,
      owner,
      version,
      sqlName,
      target: configuration,
      runtimeVersion: '3.4.5',
      descriptor,
      source,
      contrib: external ? undefined : contributed,
      recipe: {},
      selectedDependencies: descriptor.dependencies,
      compatibility: {
        extension_runtime_contract: 'src/extensions/contracts/contract.toml',
        native_runtime_product: 'liboliphaunt-native',
        native_runtime_version: '3.4.5',
        postgres_major: '18',
        wasix_runtime_product: 'liboliphaunt-wasix',
        wasix_runtime_version: '3.4.5',
      },
      carriers: [],
      archive: path.join(root, `${sqlName}-original-internal.tar.gz`),
    } as NativeCarrierSpec;
    const inputs: { source: string; destination: string }[] = [];
    const add = (destination: string, bytes: Buffer | string) => {
      const source = path.join(root, 'fixture', sqlName, destination);
      mkdirSync(path.dirname(source), { recursive: true });
      writeFileSync(source, bytes);
      inputs.push({ source, destination });
    };
    const defaultVersion = external
      ? source['extension-control']['default-version']
      : contributed['default-version'];
    add(`share/postgresql/extension/${sqlName}.control`, `default_version = '${defaultVersion}'\n`);
    add(`share/postgresql/extension/${sqlName}--${defaultVersion}.sql`, 'SELECT 1;\n');
    const moduleFile = descriptor['native-module-file'];
    for (const profile of ['postgresql', 'modules'])
      add(`lib/${profile}/${moduleFile}`, elfFixture({ machine: external ? 183 : 62 }));
    for (const resource of contributed?.['data-files'] ?? [])
      add(resource, 'original auxiliary data\n');
    await assemble(
      {
        descriptor: {
          schema: 'oliphaunt-extension-member-payload-v1',
          owner,
          version,
          sql_name: sqlName,
          family: 'native',
          configuration,
          source_kind: descriptor['source-kind'],
          default_version: defaultVersion,
          creates_extension: true,
          dependencies: descriptor.dependencies,
          module_profiles: ['postgresql', 'modules'],
          module_file: moduleFile,
          dependency_modules: [],
          data_files: contributed?.['data-files'] ?? [],
          sql_files: [],
          sql_prefixes: [],
          ...(external ? { source } : { postgres_source: source }),
        },
        inputs,
      },
      member.archive,
      path.join(root, `${sqlName}-original-internal.json`),
    );
    const publicFile = path.join(
      root,
      sqlName,
      `${product}-${version}-native-${configuration}-runtime.tar.gz`,
    );
    const result = assemblePublicNativeMember(member, publicFile);
    members.push(member);
    frozen.push({
      ...result.metadata,
      assets: [{ ...result.asset, path: path.relative(root, publicFile) }],
    });
  }
  const productRoot = path.join(root, 'product');
  mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
  const compatibility = nativeCarrierCompatibility(members[0]);
  const directAssets = external
    ? frozen[0].assets
    : bundleCarrierAssets(product, version, productRoot, frozen, compatibility, { root });
  const releaseMetadata = {
    class: external ? 'external' : 'contrib',
    versioning: external ? 'upstream-bound' : 'runtime-bound',
    sourceIdentity: { parsingFixture: product },
    compatibility,
  };
  const documents = composeExtensionReleaseDocuments({
    product,
    releaseProduct: owner,
    family: 'native',
    version,
    members: frozen,
    directAssets,
    releaseMetadata,
  });
  const file = (name: string, bytes: string) => {
    const value = path.join(root, name);
    writeFileSync(value, bytes);
    return { path: value, ...fileIdentity(value) };
  };
  const original = {
    product,
    owner,
    version,
    family: 'native' as const,
    target: configuration,
    github: directAssets.map((asset: any) => {
      const file = path.join(root, asset.path);
      return { path: file, ...fileIdentity(file) };
    }),
    npm: [file('npm-document-fixture.tgz', 'not registry admission')],
    cargo: [file('cargo-document-fixture.crate', 'not registry admission')],
    manifest: file('public-manifest.json', JSON.stringify(documents.releaseData)),
    frozen: file('frozen.json', JSON.stringify(documents.manifest)),
  };
  validateDeclaredExtensionFinalInput(original as any, {
    owner,
    version,
    sqlNames,
    sourceIdentity: releaseMetadata.sourceIdentity,
    compatibility,
    extensionClass: releaseMetadata.class,
    versioning: releaseMetadata.versioning,
    targets: [configuration],
  });
  const originalFiles = file('original-files.json', JSON.stringify(original)).path;
  return {
    configuration,
    owner,
    version,
    leaf: {
      ...original,
      github: original.github.map((value) => value.path),
      npm: original.npm.map((value) => value.path),
      cargo: original.cargo.map((value) => value.path),
      manifest: original.manifest.path,
      frozen: original.frozen.path,
      originalFiles,
    },
    canonical: {
      product,
      owner,
      version,
      runtimeVersion: members[0].runtimeVersion,
      members,
      profiles: [{ target: configuration }],
    } as NativeOwnerSpec,
    members: sqlNames.map((sqlName) => ({
      sqlName,
      archive: path.join(root, 'normalized', `${sqlName}.tar.gz`),
      inventory: path.join(root, 'normalized', `${sqlName}.json`),
    })),
  };
}

test('imports the public vector formatter and preserves both ABI profiles and original attribution', async () => {
  const spec = await fixture(['vector']);
  await importMembers(spec);
  const request = spec.members[0];
  const descriptor = inspect(request.archive, 'vector', spec.owner) as any;
  expect(descriptor.module_profiles).toEqual(['postgresql', 'modules']);
  expect(descriptor.imported.scope).toBe('private-runtime-sidecar');
  expect(descriptor.imported.publicAsset.sha256).toBe(fileIdentity(spec.leaf.github[0]).sha256);
  const publicFiles = readPortableArchiveEntries(spec.leaf.github[0]);
  const sidecar = readPortableArchiveEntries(request.archive);
  for (const [name, row] of publicFiles)
    if (name.startsWith('files/')) expect(sidecar.get(name.slice(6))?.data()).toEqual(row.data());
  expect(sidecar.has('manifest.properties')).toBe(false);
  expect(descriptor.imported.publicLegalFiles.length).toBeGreaterThan(0);
});

test('imports requested contrib nested originals once and the unchanged wrapper stages their data', async () => {
  const spec = await fixture(['dict_xsyn', 'unaccent']);
  await importMembers(spec);
  const root = path.dirname(spec.leaf.frozen);
  mkdirSync(path.join(root, 'wrapper'));
  const resources = stageNativeRustExtensions(
    path.join(root, 'wrapper'),
    spec.members.map((member) => member.sqlName),
    spec.members.map((member) => member.archive),
  );
  if (!resources) throw new Error('wrapper did not stage requested extensions');
  for (const request of spec.members) {
    const descriptor = inspect(request.archive, request.sqlName, spec.owner) as any;
    expect(descriptor.imported.publicAsset.carrierAsset).toBe(path.basename(spec.leaf.github[0]));
    expect(descriptor.imported.publicAsset.memberPath).toContain(`extensions/${request.sqlName}/`);
    for (const file of descriptor.data_files)
      expect(readFileSync(path.join(resources, 'extension', request.sqlName, file), 'utf8')).toBe(
        'original auxiliary data\n',
      );
  }
});

test('rejects wrong configurations, absent members and changed original or nested hashes', async () => {
  const spec = await fixture(['dict_xsyn', 'unaccent']);
  await expect(importMembers({ ...spec, configuration: 'linux-arm64-gnu' })).rejects.toThrow(
    'target differs',
  );
  await expect(
    importMembers({ ...spec, members: [{ ...spec.members[0], sqlName: 'absent_member' }] }),
  ).rejects.toThrow('canonical owner');
  const frozen = JSON.parse(readFileSync(spec.leaf.frozen, 'utf8'));
  const original = readFileSync(spec.leaf.frozen);
  for (const mutation of [
    (asset: any) => {
      asset.memberPath = 'extensions/missing/member.tar.gz';
    },
    (asset: any) => {
      asset.sha256 = '0'.repeat(64);
    },
  ]) {
    const modified = structuredClone(frozen);
    mutation(modified.extensions[0].assets[0]);
    writeFileSync(spec.leaf.frozen, JSON.stringify(modified));
    await expect(importMembers(spec)).rejects.toThrow();
  }
  writeFileSync(spec.leaf.frozen, original);
  writeFileSync(spec.leaf.github[0], 'altered public archive');
  await expect(importMembers(spec)).rejects.toThrow();
});
