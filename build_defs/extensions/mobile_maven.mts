/** Two genuine Android final leaves feed the existing Maven writers. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMavenArtifactManifest } from '../../tools/packaging/build-maven-artifact-manifest.mts';
import { stageMavenArtifactManifest } from '../../tools/packaging/maven-artifact-staging.mts';
import { type NativeOwnerSpec, validateNativeFinalLeaf } from './owner_carriers.mts';

export async function packageMobileMaven(
  spec: NativeOwnerSpec & { mavenCoordinates: string[]; outputs: Record<string, string> },
) {
  assert.deepEqual(
    spec.leaves.map((leaf) => leaf.target).sort(),
    ['android-arm64-v8a', 'android-x86_64'],
    'Maven requires both actual Android final leaves once',
  );
  const root = mkdtempSync(path.join(tmpdir(), 'mobile-extension-maven-'));
  try {
    const productRoot = path.join(root, 'product');
    mkdirSync(path.join(productRoot, 'release-assets'), { recursive: true });
    const memberContracts = {};
    for (const leaf of spec.leaves) {
      const stagedRoot = path.join(root, leaf.target);
      const validated = validateNativeFinalLeaf(spec, leaf, stagedRoot);
      memberContracts[leaf.target] = validated.members;
      for (const asset of validated.directAssets)
        copyFileSync(
          path.join(stagedRoot, asset.path),
          path.join(productRoot, 'release-assets', asset.name),
        );
    }
    const manifest = path.join(root, 'maven.tsv');
    await buildMavenArtifactManifest(manifest, {
      extensions: true,
      extensionProducts: [spec.product],
      context: {
        extensions: {
          [spec.product]: {
            productRoot,
            releaseProduct: spec.owner,
            version: spec.version,
            sqlNames: spec.members.map((member) => member.sqlName),
            compatibility: spec.releaseMetadata.compatibility,
            runtimeSourceVersion: spec.runtimeVersion,
            targets: spec.profiles.filter(
              (profile) =>
                profile.kind === 'native-static-registry' && profile.target.startsWith('android-'),
            ),
            registryPackages: spec.mavenCoordinates,
            memberContracts,
          },
        },
      },
    });
    const staged = await stageMavenArtifactManifest(manifest, path.join(root, 'staged'));
    assert.deepEqual(
      staged.map((row) => `${row.groupId}:${row.artifactId}`).sort(),
      spec.mavenCoordinates.slice().sort(),
    );
    assert.deepEqual(Object.keys(spec.outputs).sort(), spec.mavenCoordinates.slice().sort());
    for (const row of staged) {
      const output = spec.outputs[`${row.groupId}:${row.artifactId}`];
      mkdirSync(output, { recursive: true });
      for (const file of row.files)
        copyFileSync(path.join(row.directory, file), path.join(output, file));
    }
    return staged.map((row) => ({
      ...row,
      directory: spec.outputs[`${row.groupId}:${row.artifactId}`],
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: mobile_maven.mts <declared-inputs.json>');
  await packageMobileMaven(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
