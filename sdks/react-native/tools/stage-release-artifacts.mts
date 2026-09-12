import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  IOS_CARRIER_FILENAME,
  buildIosCarrierManifest,
} from '../../swift/tools/ios-carrier-manifest.mts';
import { fail, requireDir } from '../../../tools/packaging/staging.mts';

export function stageArtifacts(artifactRoot, workRoot) {
  const releasePackageDir = path.join(workRoot, 'package');
  requireDir(releasePackageDir);
  const assetDir = process.env.OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR;
  if (!assetDir) {
    fail(
      'oliphaunt-react-native package artifacts require OLIPHAUNT_REACT_NATIVE_IOS_RELEASE_ASSET_DIR',
    );
  }
  const carrier = buildIosCarrierManifest({
    baseAssetDir: assetDir,
    extensionManifests: [],
  });
  writeFileSync(
    path.join(releasePackageDir, IOS_CARRIER_FILENAME),
    `${JSON.stringify(carrier, null, 2)}\n`,
    'utf8',
  );
  const packageJsonFile = path.join(releasePackageDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonFile, 'utf8'));
  packageJson.oliphaunt = {
    ...(packageJson.oliphaunt ?? {}),
    iosCarrierManifest: `./${IOS_CARRIER_FILENAME}`,
  };
  packageJson.files = [...new Set([...(packageJson.files ?? []), IOS_CARRIER_FILENAME])];
  packageJson.exports = {
    ...(packageJson.exports ?? {}),
    './ios-carriers': `./${IOS_CARRIER_FILENAME}`,
  };
  writeFileSync(packageJsonFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  const carrierEvidence = path.join(artifactRoot, 'ios-carriers', IOS_CARRIER_FILENAME);
  mkdirSync(path.dirname(carrierEvidence), { recursive: true });
  writeFileSync(carrierEvidence, `${JSON.stringify(carrier, null, 2)}\n`, 'utf8');
}

if (import.meta.main) {
  if (process.argv.length !== 4)
    throw new Error('usage: stage-release-artifacts.mts <artifact-root> <work-root>');
  stageArtifacts(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
}
