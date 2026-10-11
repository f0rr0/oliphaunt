import { readFileSync } from 'node:fs';
import path from 'node:path';
import { wasixRuntimeNpmPayloadInputs } from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { materializeArchive } from './shared.mts';

/** Consume the existing canonical core archive/manifest, never walk its tree aliases. */
export function extractWasixRuntime(source: string, work: string): string {
  const archive = path.join(source, 'oliphaunt.wasix.tar.zst');
  wasixRuntimeNpmPayloadInputs({
    manifestBytes: readFileSync(path.join(source, 'manifest.json')),
    runtimeBytes: readFileSync(archive),
    label: 'declared WASIX seed runtime',
  });
  const destination = path.join(work, 'runtime');
  extractPortableArchiveTree(materializeArchive(archive, path.join(work, 'inputs')), destination);
  return path.join(destination, 'oliphaunt');
}
