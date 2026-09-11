import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createDeterministicTar } from './cargo-source-package.mts';
import { validateNpmTrustedPublishingManifest } from './npm-trusted-publishing.mts';
import { canonicalGzipSync, portableMemberName } from './portable-archive.mts';

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('usage: npm-package.mts <package-directory>');
  const manifest = JSON.parse(readFileSync(path.join(process.argv[2], 'package.json'), 'utf8'));
  const filename = `${safeNpmPackageFilenamePrefix(manifest.name)}-${manifest.version}.tgz`;
  portableMemberName(filename, 'file', process.argv[2]);
  console.log(filename);
}

function safeNpmPackageFilenamePrefix(name) {
  return name.replace(/^@/u, '').replaceAll('/', '-');
}
function reject(message) {
  throw new Error(message);
}

export function packGeneratedNpmCarrier(packageDir, tarballRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  validateNpmTrustedPublishingManifest(manifest, `${packageDir}/package.json`);
  if (Object.keys(manifest.scripts ?? {}).length > 0)
    reject('staged npm carriers must not contain lifecycle scripts');
  const packDir = path.join(tarballRoot, safeNpmPackageFilenamePrefix(manifest.name));
  const filename = `${safeNpmPackageFilenamePrefix(manifest.name)}-${manifest.version}.tgz`;
  portableMemberName(filename, 'file', packageDir);
  for (const member of manifest.publishConfig?.executableFiles ?? []) {
    chmodSync(path.join(packageDir, portableMemberName(member, 'file', packageDir)), 0o755);
  }
  for (const entry of readdirSync(packageDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    chmodSync(file, statSync(file).mode & 0o100 ? 0o755 : 0o644);
  }
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const tarball = path.join(packDir, filename);
  writeFileSync(
    tarball,
    canonicalGzipSync(createDeterministicTar(packageDir, 'package', { fail: reject })),
  );
  return tarball;
}
