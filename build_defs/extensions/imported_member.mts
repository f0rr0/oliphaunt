/** Normalize original public extension Files into private runtime sidecars. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isDesktopNativeTarget,
  validateExtensionArtifactArchive,
} from '../../src/extensions/artifacts/packages/tools/extension-artifact-inventory.mts';
import {
  extensionRuntimeAssetContract,
  projectNativeRuntimeAssetMember,
} from '../../src/extensions/artifacts/packages/tools/extension-runtime-asset-contract.mts';
import { assemble } from './member_payload.mts';
import { type FinalLeaf, type NativeOwnerSpec, stageDeclaredFinalLeaf } from './owner_carriers.mts';
import { inspect } from './validate_member_payload.mts';

export interface ImportedMemberSpec {
  configuration: string;
  owner: string;
  version: string;
  leaf: FinalLeaf;
  canonical: NativeOwnerSpec;
  members: { sqlName: string; archive: string; inventory: string }[];
}

export async function importMembers(spec: ImportedMemberSpec): Promise<void> {
  const { canonical, leaf, configuration } = spec;
  assert.equal(leaf.family, 'native');
  assert(isDesktopNativeTarget(configuration), 'imported runtime sidecar needs a desktop target');
  assert.equal(leaf.target, configuration, 'imported member target differs from its configuration');
  for (const name of ['owner', 'version'] as const) {
    assert.equal(leaf[name], spec[name]);
    assert.equal(canonical[name], spec[name]);
  }
  assert.equal(canonical.product, leaf.product);
  assert(canonical.profiles.some((profile) => profile.target === configuration));
  assert(spec.members.length > 0, 'imported runtime sidecar needs requested members');
  assert.equal(new Set(spec.members.map((member) => member.sqlName)).size, spec.members.length);
  const outputs = spec.members.flatMap((member) => [member.archive, member.inventory]);
  assert.equal(new Set(outputs).size, outputs.length, 'imported member outputs must not repeat');

  const root = mkdtempSync(
    path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'imported-native-members-'),
  );
  try {
    // One owner leaf stages and parses a closed contrib bundle once for all requested members.
    const staged = stageDeclaredFinalLeaf(canonical, leaf, root);
    assert(leaf.originalFiles, 'imported members need the validated original File map');
    const originalFiles = JSON.parse(readFileSync(leaf.originalFiles, 'utf8'));
    for (const request of spec.members) {
      const authored = canonical.members.filter((member) => member.sqlName === request.sqlName);
      const frozen = staged.members.filter((member: any) => member.sqlName === request.sqlName);
      assert.equal(authored.length, 1, 'requested member is absent from its canonical owner');
      assert.equal(frozen.length, 1, 'requested member is absent from the original frozen leaf');
      const assets = frozen[0].assets.filter(
        (asset: any) =>
          asset.family === 'native' && asset.kind === 'runtime' && asset.target === configuration,
      );
      assert.equal(assets.length, 1, 'requested member needs exactly one selected runtime asset');
      const asset = assets[0];
      const selected = projectNativeRuntimeAssetMember(frozen[0], asset);
      const runtime = validateExtensionArtifactArchive({
        file: path.join(root, asset.path),
        metadata: selected,
        product: leaf.product,
        target: configuration,
        nativeRuntimeVersion: canonical.runtimeVersion,
      });
      const metadata = runtime.metadata;
      const inputs = runtime.runtimeFiles.map((row: any) => {
        const source = path.join(root, 'runtime', request.sqlName, row.path);
        mkdirSync(path.dirname(source), { recursive: true });
        const entry = runtime.entries.get(`files/${row.path}`);
        assert(entry, 'validated public runtime row is absent');
        writeFileSync(source, entry.data);
        return { source, destination: row.path };
      });
      const member = authored[0];
      const descriptor = {
        schema: 'oliphaunt-extension-member-payload-v1',
        sql_name: request.sqlName,
        owner: spec.owner,
        version: spec.version,
        family: 'native',
        configuration,
        source_kind: member.descriptor['source-kind'],
        postgres_major: 18,
        default_version: member.contrib
          ? (member.contrib['default-version'] ?? null)
          : member.source['extension-control']['default-version'],
        creates_extension: metadata.createsExtension,
        dependencies: metadata.dependencies,
        module_profiles: metadata.nativeModuleStem === null ? [] : ['postgresql', 'modules'],
        module_file: runtime.properties.get('nativeModuleFile'),
        dependency_modules: metadata.nativeDependencyModules,
        data_files: metadata.dataFiles.map((file: string) => `share/postgresql/${file}`),
        sql_prefixes: metadata.extensionSqlFilePrefixes,
        sql_files: metadata.extensionSqlFileNames,
        construction_licenses: runtime.runtimeFiles
          .map((row: any) => row.path)
          .filter((file: string) => file.startsWith('share/licenses/')),
        ...(member.contrib ? { postgres_source: member.source } : { source: member.source }),
        imported: {
          schema: 'oliphaunt-imported-extension-runtime-sidecar-v1',
          scope: 'private-runtime-sidecar',
          originalFiles,
          publicAsset: extensionRuntimeAssetContract(asset),
          publicLegalFiles: runtime.legalFiles,
          licenseProfile: runtime.properties.get('licenseProfile'),
          originalFileInventory: staged.inventory,
        },
      };
      for (const output of [request.archive, request.inventory])
        mkdirSync(path.dirname(output), { recursive: true });
      await assemble({ descriptor, inputs }, request.archive, request.inventory);
      inspect(request.archive, request.sqlName, spec.owner);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: imported_member.mts SPECIFICATION');
  await importMembers(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
