/** Compose the real app resource/registration closure with the original SDK policy. */
import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateNativeClusterSeedDirectory } from '../../src/database-resources/contracts/native-manifest.mts';
import { stageIosApp } from '../../src/native/sdks/react-native/tools/stage-ios-app.mts';
import { buildIosCarrierManifest } from '../../src/native/sdks/swift/tools/ios-carrier-manifest.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { stageAppleStaticLeaf } from '../native/apple/static-carrier-consumer.mts';

export function iosResourceBaseFiles(spec: any) {
  return {
    baseCarrierManifest: realpathSync(spec.baseManifest),
    baseArchiveInputs: Object.fromEntries(
      ['base-xcframework', 'runtime-resources'].map((role) => [
        role,
        { ...spec.archives[role], path: realpathSync(spec.archives[role].path) },
      ]),
    ),
  };
}

export async function composeIosResources(spec: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-apple-resources-'));
  try {
    assert(
      spec.version && spec.extensions.length,
      'App resources require an exact host and nonempty selection',
    );
    const base = iosResourceBaseFiles(spec);
    const staged = spec.leaves.map((leaf: any, index: number) =>
      stageAppleStaticLeaf(leaf, path.join(root, `leaf-${index}`), spec.version),
    );
    const products = Object.fromEntries(
      spec.leaves.map((leaf: any) => [
        leaf.product,
        {
          product: leaf.product,
          releaseProduct: leaf.owner,
          version: leaf.version,
          sqlNames: [...leaf.sqlNames].sort(),
          tag: `${leaf.owner}-v${leaf.version}`,
        },
      ]),
    );
    assert.equal(Object.keys(products).length, spec.leaves.length, 'Repeated app carrier owner');
    const carrier = buildIosCarrierManifest({
      baseRuntimeVersion: spec.version,
      baseTag: `liboliphaunt-native-v${spec.version}`,
      ...base,
      declaredProducts: products,
      extensionManifests: staged.map((leaf: any) => leaf.output),
    });
    const cache = path.join(root, 'cache');
    mkdirSync(path.join(cache, 'objects'), { recursive: true });
    for (const row of carrier.base.assets) {
      const source = base.baseArchiveInputs[row.role];
      assert.equal(row.bytes, source.size);
      assert.equal(row.sha256, source.sha256);
      copyFileSync(source.path, path.join(cache, 'objects', `${row.sha256}-${row.name}`));
    }
    for (const row of staged.flatMap((leaf: any) => leaf.archives))
      copyFileSync(row.path, path.join(cache, 'objects', `${row.sha256}-${row.name}`));
    const document = path.join(root, 'ios.json');
    writeFileSync(document, JSON.stringify(carrier));
    const output = path.join(root, 'app');
    const selection = await stageIosApp({
      carriers: [document],
      extensions: spec.extensions,
      cacheDir: cache,
      outputDir: output,
      seedProfile: 'standard',
    });
    assert.deepEqual(
      [...selection.selected].sort(),
      [...spec.extensions].sort(),
      'App resource selection differs from its linked registration cohort',
    );
    mkdirSync(path.dirname(spec.resources), { recursive: true });
    cpSync(
      path.join(output, 'resources/OliphauntReactNativeResources.bundle/oliphaunt'),
      spec.resources,
      { recursive: true },
    );
    mkdirSync(path.dirname(spec.registry), { recursive: true });
    copyFileSync(
      path.join(output, 'generated/static-registry/oliphaunt_static_registry.c'),
      spec.registry,
    );
    mkdirSync(path.dirname(spec.selection), { recursive: true });
    copyFileSync(path.join(output, 'selection.json'), spec.selection);
    // The original Podspec dependency selects this separate carrier. Bazel
    // declares its real Files directly; a profile string carries no seed bytes.
    extractPortableArchiveTree(
      realpathSync(spec.seed),
      spec.seedResources,
      'package/OliphauntSeedNativeIOSStandard.bundle/cluster-seed',
      { format: 'tar.gz' },
    );
    validateNativeClusterSeedDirectory(spec.seedResources, 'standard', { target: 'ios-datum64' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await composeIosResources(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
