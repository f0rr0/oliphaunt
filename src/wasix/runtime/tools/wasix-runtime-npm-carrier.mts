#!/usr/bin/env bun
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDeterministicTar } from '../../../../tools/packaging/package-archive.mts';
import {
  canonicalGzipSync,
  readPortableArchiveEntries,
} from '../../../../tools/packaging/portable-archive.mts';
import { validatePortableReleaseAsset } from './check-release-assets.mts';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from './wasix-runtime-npm-contract.mts';
import {
  assertWasixRuntimeNpmArchive,
  stageWasixRuntimeNpmPayload,
  wasixRuntimeNpmPayloadInputs,
} from './wasix-runtime-npm-payload.mts';

export {
  assertWasixRuntimeNpmArchive,
  renderWasixRuntimeDescriptorModule,
  renderWasixRuntimeDescriptorTypes,
} from './wasix-runtime-npm-payload.mts';

const ROOT = path.resolve(import.meta.dirname, '../../../..');
const TOOL = 'wasix-runtime-npm-carrier.mts';
function fail(message) {
  throw new Error(`${TOOL}: ${message}`);
}
function rel(file) {
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  return relative && !relative.startsWith('../') ? relative : String(file);
}
function regularFile(file, label) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (cause) {
    fail(`${label} cannot be inspected: ${cause.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0)
    fail(`${label} must be a non-empty regular non-symlink file: ${rel(file)}`);
  return metadata;
}
function requireArchiveEntry(entries, member, archive) {
  const entry = entries.get(member);
  if (entry === undefined || !entry.isFile || entry.isSymbolicLink || entry.size <= 0)
    fail(`${rel(archive)} must contain ${member} as one non-empty regular file`);
  return Buffer.from(entry.data());
}
export function wasixRuntimeNpmInputs({ portableReleaseArchive }) {
  const releaseArchive = path.resolve(portableReleaseArchive);
  regularFile(releaseArchive, 'portable WASIX release archive');
  validatePortableReleaseAsset(releaseArchive);
  const releaseEntries = readPortableArchiveEntries(releaseArchive);
  const manifestBytes = requireArchiveEntry(
    releaseEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.manifest,
    releaseArchive,
  );
  const runtimeBytes = requireArchiveEntry(
    releaseEntries,
    WASIX_PORTABLE_RELEASE_MEMBERS.runtimeArchive,
    releaseArchive,
  );
  return wasixRuntimeNpmPayloadInputs({ manifestBytes, runtimeBytes, label: rel(releaseArchive) });
}
export function stageWasixRuntimeNpmCarrier({ version, portableReleaseArchive, packageDir }) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version))
    throw new TypeError(`${TOOL}: version must be an exact stable semantic version`);
  return stageWasixRuntimeNpmPayload({
    version,
    inputs: wasixRuntimeNpmInputs({ portableReleaseArchive }),
    packageDir,
  });
}
export function packWasixRuntimeNpmCarrier({
  version,
  portableReleaseArchive,
  packageDir = path.join(ROOT, 'target/release/npm-package-sources/liboliphaunt-wasix'),
  tarballRoot = path.join(ROOT, 'target/release/npm-packages/liboliphaunt-wasix'),
}) {
  const staged = stageWasixRuntimeNpmCarrier({
    version,
    portableReleaseArchive,
    packageDir,
  });
  const outputRoot = path.resolve(tarballRoot);
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const tarball = path.join(outputRoot, `oliphaunt-liboliphaunt-wasix-${version}.tgz`);
  writeFileSync(
    tarball,
    canonicalGzipSync(
      createDeterministicTar(staged.packageDir, 'package', { fail, fixedFileMode: 0o644 }),
    ),
  );
  assertWasixRuntimeNpmArchive(tarball, { version, descriptor: staged.descriptor });
  return Object.freeze({ ...staged, tarball });
}
