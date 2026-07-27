#!/usr/bin/env bun
import { captureCommandOutput } from '../dev/capture-command-output.mjs';

const metadataResult = captureCommandOutput(
  'cargo',
  ['metadata', '--no-deps', '--format-version', '1'],
  { label: 'cargo metadata --no-deps --format-version 1' },
);
if (metadataResult.error !== undefined || metadataResult.status !== 0) {
  throw new Error(
    metadataResult.error?.message
      ?? (metadataResult.stderr.trim() || 'cargo metadata failed'),
  );
}
const metadata = JSON.parse(metadataResult.stdout);

const packages = [...metadata.packages].sort((left, right) =>
  left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
);

for (const cargoPackage of packages) {
  if (Array.isArray(cargoPackage.publish) && cargoPackage.publish.length === 0) {
    continue;
  }
  if (cargoPackage.name === 'oliphaunt-wasix') {
    continue;
  }
  console.log(cargoPackage.name);
}
