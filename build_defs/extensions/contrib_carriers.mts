/** Runtime-owned native contrib envelopes from all canonical typed members. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundleCarrierAssets } from '../../src/extensions/artifacts/packages/tools/bundle-carrier-assets.mts';
import { extensionRuntimeAssetContract } from '../../src/extensions/artifacts/packages/tools/extension-runtime-asset-contract.mts';
import {
  assemblePublicNativeMember,
  type NativeCarrierSpec,
  nativeCarrierCompatibility,
  nativeCarrierLeaves,
  stageNativeRegistryCarriers,
  writeJson,
} from './native_carriers.mts';

export interface NativeContribCarrierSpec extends NativeCarrierSpec {
  owner: string;
  expectedMembers: string[];
  members: NativeCarrierSpec[];
  sourceIdentity: Record<string, string>;
}

export function validateNativeContribInputs(spec: NativeContribCarrierSpec) {
  assert.deepEqual(spec.members.map((member) => member.sqlName).sort(), spec.expectedMembers);
  assert.equal(new Set(spec.expectedMembers).size, spec.expectedMembers.length);
  assert.equal(
    spec.version,
    spec.runtimeVersion,
    'contrib package version must follow its runtime owner',
  );
  assert.equal(spec.owner, spec.compatibility.native_runtime_product);
  for (const member of spec.members) {
    assert.equal(member.owner, spec.owner);
    assert.equal(member.product, spec.product);
    assert.equal(member.version, spec.version);
    assert.equal(member.target, spec.target);
    assert.equal(member.runtimeVersion, spec.runtimeVersion);
    assert.deepEqual(member.compatibility, spec.compatibility);
    assert.equal(member.descriptor['source-kind'], 'postgres-contrib');
    assert.equal(member.contrib?.['sql-name'], member.sqlName);
    assert.deepEqual(member.source, spec.source);
  }
  nativeCarrierLeaves(spec);
  assert.equal(
    path.basename(spec.outputs.github),
    `${spec.product}-${spec.version}-native-${spec.target}-bundle.tar.gz`,
  );
}

export function packageNativeContribCarriers(spec: NativeContribCarrierSpec) {
  validateNativeContribInputs(spec);
  const root = mkdtempSync(path.join(tmpdir(), 'native-contrib-envelopes-'));
  for (const output of Object.values(spec.outputs))
    mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  try {
    const productRoot = path.join(root, 'product');
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    const members = spec.members.map((member) => {
      const archive = path.join(
        productRoot,
        'member-assets',
        member.sqlName,
        `${spec.product}-${spec.version}-native-${spec.target}-runtime.tar.gz`,
      );
      const { metadata, asset } = assemblePublicNativeMember(member, archive);
      return {
        ...metadata,
        assets: [{ ...asset, path: path.relative(root, archive).split(path.sep).join('/') }],
      };
    });
    const compatibility = nativeCarrierCompatibility(spec);
    const assets = bundleCarrierAssets(
      spec.product,
      spec.version,
      productRoot,
      members,
      compatibility,
      { root },
    );
    assert.equal(assets.length, 1, 'selected contrib target must produce one complete bundle');
    const asset = assets[0];
    assert.equal(asset.memberCount, spec.expectedMembers.length);
    assert.equal(asset.name, path.basename(spec.outputs.github));
    copyFileSync(path.join(root, asset.path), spec.outputs.github);
    const ownership = { releaseProduct: spec.owner, family: 'native' };
    const manifestPath = path.join(
      productRoot,
      'release-assets',
      `${spec.product}-${spec.version}-manifest.json`,
    );
    writeJson(path.join(productRoot, 'extension-artifacts.json'), {
      schema: 'oliphaunt-extension-ci-artifacts-v2',
      product: spec.product,
      ...ownership,
      version: spec.version,
      compatibility,
      extensions: members,
      carrierAssets: assets,
    });
    writeJson(manifestPath, {
      schema: 'oliphaunt-extension-release-manifest-v2',
      product: spec.product,
      ...ownership,
      version: spec.version,
      extensionClass: 'contrib',
      versioning: 'runtime-bound',
      sourceIdentity: spec.sourceIdentity,
      compatibility,
      extensions: members.map((member) => ({
        ...member,
        assets: member.assets.map(extensionRuntimeAssetContract),
      })),
      assets: assets.map(extensionRuntimeAssetContract),
    });
    copyFileSync(path.join(productRoot, 'extension-artifacts.json'), spec.outputs.frozen);
    copyFileSync(manifestPath, spec.outputs.manifest);
    stageNativeRegistryCarriers(spec, productRoot, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: contrib_carriers.mts <declared-inputs.json>');
  packageNativeContribCarriers(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
