import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { wasixRuntimeNpmPayloadInputs } from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import { WASIX_PORTABLE_RELEASE_MEMBERS } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import {
  extractPortableArchiveTree,
  readPortableArchiveEntries,
} from '../../tools/packaging/portable-archive.mts';
import { materializeArchive } from './shared.mts';

/** Project the actual completed archive; current payload directories remain unchanged. */
export function wasixRuntimeInputs(source: string, work: string): string {
  if (!statSync(source).isFile()) return source;
  const entries = readPortableArchiveEntries(source);
  const output = path.join(work, 'admitted-runtime');
  mkdirSync(output, { recursive: true });
  for (const [name, member] of Object.entries(WASIX_PORTABLE_RELEASE_MEMBERS)) {
    const file = entries.get(member);
    assert.ok(file?.isFile, `admitted WASIX runtime needs regular ${member}`);
    writeFileSync(
      path.join(output, name === 'manifest' ? 'manifest.json' : 'oliphaunt.wasix.tar.zst'),
      file.data(),
    );
  }
  return output;
}

/** Consume the existing canonical core archive/manifest, never walk its tree aliases. */
export function extractWasixRuntime(source: string, work: string): string {
  source = wasixRuntimeInputs(source, work);
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
