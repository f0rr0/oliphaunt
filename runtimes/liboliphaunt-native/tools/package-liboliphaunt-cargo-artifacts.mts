#!/usr/bin/env bun
import path from 'node:path';
import {
  packagePayload,
  parseCargoArtifactArgs,
  prepareCargoArtifactWorkspace,
  selectCargoArtifactTargets,
  writePackagesManifest,
} from '../../../tools/packaging/native-cargo-payload.mts';
import { inspectPlatformBinaryTree } from '../../../tools/packaging/platform-binary-contract.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import { assertReleaseNoticesInArchive } from '../../../tools/packaging/release-notices.mts';
import { validatePayload } from './native-runtime-payload.mts';

const PRODUCT = 'liboliphaunt-native';
const KIND = 'native-runtime';
async function validateNativePayload(payloadRoot, target, { toolSet }) {
  const windowsRuntime = target === 'windows-x64-msvc' && toolSet === 'runtime';
  await inspectPlatformBinaryTree(payloadRoot, {
    target,
    requireWindowsRuntimeImportLibrary: windowsRuntime,
    windowsVcRuntimeProfile: windowsRuntime ? 'provider' : undefined,
  });
  validatePayload(payloadRoot, target, { toolSet });
}

export async function packageNativeCargoArtifacts(argv) {
  const args = await parseCargoArtifactArgs(argv, {
    product: PRODUCT,
    assetDir: 'target/liboliphaunt/release-assets',
    outputDir: 'target/liboliphaunt/cargo-artifacts',
    workDir: 'target/liboliphaunt',
  });
  const { sourceRoot, cargoTargetDir } = prepareCargoArtifactWorkspace(args);
  const targets = selectCargoArtifactTargets(PRODUCT, KIND, args.targets);
  const packages = [];
  for (const target of targets) {
    const archive = path.join(args.assetDir, target.asset.replaceAll('{version}', args.version));
    assertReleaseNoticesInArchive(archive, { profile: 'native-runtime' });
    const root = path.join(sourceRoot, target.target + '-extracted');
    extractPortableArchiveTree(archive, root);
    await validateNativePayload(root, target.target, { toolSet: 'runtime' });
    packages.push(
      ...packagePayload(root, sourceRoot, args.outputDir, cargoTargetDir, {
        target,
        version: args.version,
        partBytes: args.partBytes,
        packageBase: PRODUCT,
        artifactProduct: PRODUCT,
        artifactKind: KIND,
        artifactLabel: 'liboliphaunt native runtime',
        noticeProfile: 'native-runtime',
      }),
    );
  }
  writePackagesManifest(packages, args.outputDir, PRODUCT);
  return packages;
}
if (import.meta.main) await packageNativeCargoArtifacts(Bun.argv.slice(2));
