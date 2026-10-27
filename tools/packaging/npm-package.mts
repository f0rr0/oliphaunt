import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateNpmTrustedPublishingManifest } from './npm-trusted-publishing.mts';
import { createDeterministicTar, listArchiveEntries } from './package-archive.mts';
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

export function npmArchiveFileMode(mode, declaredExecutable = false, platform = process.platform) {
  // Windows stat bits do not describe Unix executability; declarations do.
  return declaredExecutable || (platform !== 'win32' && (mode & 0o100) !== 0) ? 0o755 : 0o644;
}

export function packGeneratedNpmCarrier(packageDir, tarballRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  validateNpmTrustedPublishingManifest(manifest, `${packageDir}/package.json`);
  if (Object.keys(manifest.scripts ?? {}).length > 0)
    reject('staged npm carriers must not contain lifecycle scripts');
  const packDir = path.join(tarballRoot, safeNpmPackageFilenamePrefix(manifest.name));
  const filename = `${safeNpmPackageFilenamePrefix(manifest.name)}-${manifest.version}.tgz`;
  portableMemberName(filename, 'file', packageDir);
  const executableFiles = new Set(
    (manifest.publishConfig?.executableFiles ?? []).map((member) =>
      portableMemberName(member, 'file', packageDir),
    ),
  );
  const files = new Set(listArchiveEntries(packageDir).filter((file) => statSync(file).isFile()));
  for (const member of executableFiles) {
    if (!files.has(path.join(packageDir, member)))
      reject(`declared npm executable must be a regular package file: ${member}`);
  }
  for (const file of files) {
    const member = path.relative(packageDir, file).split(path.sep).join('/');
    if (npmArchiveFileMode(statSync(file).mode, executableFiles.has(member)) === 0o755)
      executableFiles.add(member);
  }
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  const tarball = path.join(packDir, filename);
  writeFileSync(
    tarball,
    canonicalGzipSync(
      createDeterministicTar(packageDir, 'package', {
        fail: reject,
        fixedFileMode: 0o644,
        executableFiles,
      }),
    ),
  );
  return tarball;
}
