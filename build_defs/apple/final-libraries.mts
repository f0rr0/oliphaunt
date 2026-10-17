/** Link the actual final carrier's static library bytes, not a source recipe. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { stageAppleStaticLeaf } from '../native/apple/static-carrier-consumer.mts';

export function finalIosLibraryBytes(archive: string, bundle: string, slice: string) {
  assert(['ios-arm64', 'ios-arm64-simulator'].includes(slice), 'Unexpected app library slice');
  assert(/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(bundle), 'Unsafe final framework identity');
  const member = `${bundle}.xcframework/${slice}/${bundle}.framework/${bundle}`;
  const entry = readPortableArchiveEntries(archive, { format: 'zip' }).get(member);
  assert(
    entry?.isFile && !entry.isSymbolicLink,
    `Final XCFramework lacks exact app slice ${member}`,
  );
  const bytes = entry.data();
  assert(
    bytes.subarray(0, 8).equals(Buffer.from('!<arch>\n')),
    'Final framework binary must be its actual static ar library',
  );
  return bytes;
}

export function extractFinalIosLibrary(spec: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-final-app-library-'));
  try {
    const staged = stageAppleStaticLeaf(spec.leaf, root, spec.runtimeVersion);
    const frozen = JSON.parse(readFileSync(staged.output, 'utf8'));
    const members = frozen.extensions ?? [frozen];
    const member = members.find((row: any) => row.sqlName === spec.sqlName);
    assert(member, 'Selected app library is absent from its actual final carrier');
    const assets = member.assets.filter(
      (row: any) => row.kind === spec.kind && row.identity === spec.identity,
    );
    assert.equal(
      assets.length,
      1,
      'Actual final carrier must declare the selected framework role once',
    );
    const bundle = `liboliphaunt_${spec.kind === 'ios-xcframework' ? 'extension' : 'dependency'}_${spec.identity}`;
    writeFileSync(spec.output, finalIosLibraryBytes(assets[0].path, bundle, spec.slice));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) extractFinalIosLibrary(JSON.parse(readFileSync(process.argv[2], 'utf8')));
