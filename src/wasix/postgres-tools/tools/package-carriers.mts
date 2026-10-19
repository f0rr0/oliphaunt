#!/usr/bin/env bun
import path from 'node:path';
import { finalizeHelperAssets } from '../../../../tools/packaging/finalize-helper-assets.mts';
import {
  currentProductVersionSync,
  ROOT,
} from '../../../../tools/release/release-artifact-targets.mts';
import { packageWasixToolsCargoArtifacts } from './package-cargo-artifacts.mts';
import { packWasixToolsNpmCarrier } from './wasix-tools-npm-carrier.mts';
import { packWasixToolsAotNpmCarriers } from './wasix-tools-aot-npm.mts';

export async function packageWasixToolsCarriers() {
  const version = currentProductVersionSync('postgres-tools-wasix', 'package-carriers.mts');
  const assetDir = path.join(ROOT, 'target/postgres-tools/wasix/release-assets');
  await finalizeHelperAssets('postgres-tools-wasix', 'wasix-tools', [], { assetDir });
  packageWasixToolsCargoArtifacts([]);
  const portable = packWasixToolsNpmCarrier({
    version,
    portableReleaseArchive: path.join(assetDir, `postgres-tools-wasix-${version}-portable.tar.gz`),
  });
  return [portable.tarball, ...packWasixToolsAotNpmCarriers(version, assetDir)];
}
if (import.meta.main) await packageWasixToolsCarriers();
