#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import path from 'node:path';
import {
  parseNativeIcuDataIdentity,
  validateNativeIcuDataManifestRows,
} from '../cluster-seed-contract/icu-data.mts';
import { logicalTreeSha256 } from '../cluster-seed-contract/native-manifest.mts';
import { archiveLogicalTreeRows, readPortableArchiveEntries } from './portable-archive.mts';

function onlyAsset(directory, pattern) {
  const matches = readdirSync(directory, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && pattern.test(entry.name),
  );
  if (matches.length !== 1)
    throw new Error(`${directory}: expected exactly one ICU data archive, found ${matches.length}`);
  return path.join(directory, matches[0].name);
}

export function checkCrossFamilyIcuData(nativeReleaseAssets, wasixReleaseAssets) {
  const native = onlyAsset(
    nativeReleaseAssets,
    /^liboliphaunt-[0-9][0-9A-Za-z.+-]*-icu-data[.]tar[.]gz$/u,
  );
  const wasix = onlyAsset(
    wasixReleaseAssets,
    /^liboliphaunt-wasix-[0-9][0-9A-Za-z.+-]*-icu-data[.]tar[.]zst$/u,
  );
  const nativeEntries = readPortableArchiveEntries(native);
  const manifest = nativeEntries.get('manifest.properties');
  if (!manifest?.isFile) throw new Error(`${native}: missing ICU data manifest`);
  const identity = parseNativeIcuDataIdentity(manifest.data(), native);
  validateNativeIcuDataManifestRows(
    manifest.data(),
    archiveLogicalTreeRows(nativeEntries, native, 'share/icu/'),
    native,
  );
  const wasixDigest = logicalTreeSha256(
    archiveLogicalTreeRows(
      readPortableArchiveEntries(wasix),
      wasix,
      'target/oliphaunt-wasix/icu/share/icu/',
    ),
  );
  if (identity.dataTreeSha256 !== wasixDigest)
    throw new Error('native and WASIX ICU data trees differ');
  return identity;
}

if (import.meta.main) {
  const [native, wasix] = process.argv.slice(2);
  if (!native || !wasix || process.argv.length !== 4)
    throw new Error(
      'usage: check-cross-family-icu-data.mts NATIVE_RELEASE_ASSET_DIR WASIX_RELEASE_ASSET_DIR',
    );
  const identity = checkCrossFamilyIcuData(native, wasix);
  console.log(
    `ICU data identity matches across native and WASIX: ${identity.dataVersion}/${identity.dataForm}/${identity.dataTreeSha256}`,
  );
}
