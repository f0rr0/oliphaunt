#!/usr/bin/env bun
import { buildMavenArtifactManifest } from '../../tools/packaging/build-maven-artifact-manifest.mts';
import { stageMavenArtifactManifest } from '../../tools/packaging/maven-artifact-staging.mts';
import { writeChecksumManifest } from '../../tools/packaging/write-checksum-manifest.mts';
import { currentProductVersionSync } from '../../tools/release/release-artifact-targets.mts';
import { packageIcuCargo } from '../icu/tools/package-cargo.mts';
import { resourceNpmTarballs } from '../icu/tools/package-npm.mts';
import { packageSeedCarriers } from '../seeds/package-carriers.mts';
import { packageMobileSeedCarriers } from '../seeds/package-mobile-carriers.mts';

export async function packageIcuCarriers() {
  packageIcuCargo([]);
  const packages = resourceNpmTarballs();
  const manifest = await buildMavenArtifactManifest(
    'target/release/maven-manifests/database-resources.tsv',
    {
      artifactProduct: 'database-resources',
      artifactIds: ['oliphaunt-icu'],
      runtimeAssetRoot: 'target/database-resources/release-assets',
    },
  );
  await stageMavenArtifactManifest(manifest, 'target/release/maven-staging/database-resources');
  return packages;
}

export async function packageDatabaseResourceCarriers() {
  const packages = await packageIcuCarriers();
  await packageSeedCarriers([]);
  await packageMobileSeedCarriers();
  const version = currentProductVersionSync('database-resources');
  await writeChecksumManifest([
    '--asset-dir',
    'target/database-resources/release-assets',
    '--output',
    `database-resources-${version}-release-assets.sha256`,
    '--pattern',
    `database-resources-${version}-*`,
  ]);
  return packages;
}

if (import.meta.main) await packageIcuCarriers();
