import { copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function stageLocalNpmTarball(file, consumer) {
  // Bun on Windows cannot reliably extract file:///D:/ tarball dependencies.
  // Keep the archive beside the manifest, including when scratch is on another drive.
  const name = basename(file);
  copyFileSync(file, join(consumer, name));
  return `file:./${name}`;
}
