/** The source ZIP's installed compile also covers the source tag's shared members. */
import { deepStrictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  archiveLogicalTreeRows,
  readPortableArchiveEntries,
} from '../../../tools/packaging/portable-archive.mts';
import { fileIdentity } from '../../../tools/release/native-file-identity.mts';

type Member =
  | { path: string; type: 'directory'; mode: number }
  | { path: string; type: 'file'; mode: number; size: number; sha256: string };

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const common = (name: string) =>
  /^(Sources|Templates)(\/|$)/u.test(name) ||
  ['VERSION', 'LIBOLIPHAUNT_VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(name);

/** The native requirement's separate resource archive contains the iOS domain. */
export function assertSwiftIosResourceParity(framework: string, resources: string) {
  const rows = (
    entries: ReturnType<typeof readPortableArchiveEntries>,
    archive: string,
    prefix: string,
  ) =>
    archiveLogicalTreeRows(entries, archive, prefix).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  const expected = rows(
    readPortableArchiveEntries(realpathSync(resources)),
    resources,
    'oliphaunt/',
  );
  const entries = readPortableArchiveEntries(realpathSync(framework));
  for (const slice of ['ios-arm64', 'ios-arm64-simulator'])
    deepStrictEqual(
      rows(
        entries,
        framework,
        `liboliphaunt.xcframework/${slice}/liboliphaunt.framework/Resources/oliphaunt/`,
      ),
      expected,
      `Swift native ${slice} bundled resources differ from its iOS resource archive`,
    );
}

/** A declared runfiles tree may have a root link; nested links remain prohibited. */
export function readSwiftSourceTagMembers(tree: string): Member[] {
  const root = realpathSync(tree);
  const rows: Member[] = [];
  const visit = (name: string) => {
    const absolute = path.join(root, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      rows.push({ path: name, type: 'directory', mode: stat.mode & 0o777 });
      for (const child of readdirSync(absolute).sort()) visit(name ? `${name}/${child}` : child);
    } else if (stat.isFile()) rows.push({ path: name, ...fileIdentity(absolute) });
    else throw new Error(`Swift source tag requires regular members: ${name}`);
  };
  if (!lstatSync(root).isDirectory()) throw new Error('Swift source tag must be a directory');
  visit('');
  return rows;
}

/** Carriers are source-tag-only; ZIP tests/docs are intentionally outside its manifest. */
export function assertSwiftSourceDeliveryParity(
  archive: string,
  tree: readonly Member[],
  manifest: Uint8Array,
) {
  const entries = readPortableArchiveEntries(archive);
  const archiveRows = [];
  for (const [name, entry] of entries) {
    const member = name.startsWith('package/') ? name.slice('package/'.length) : '';
    if (!common(member)) continue;
    archiveRows.push(
      entry.isDirectory
        ? { path: member, type: 'directory' }
        : {
            path: member,
            type: 'file',
            mode: entry.mode & 0o777,
            size: entry.size,
            sha256: sha256(entry.data()),
          },
    );
  }
  const treeRows = [];
  for (const row of tree) {
    const member = row.path.startsWith('src/sdks/swift/')
      ? row.path.slice('src/sdks/swift/'.length)
      : row.path;
    if (!common(member)) continue;
    // Git source tags do not record directory modes. File modes stay exact.
    const { mode: _directoryMode, ...directory } = row;
    treeRows.push(
      row.type === 'directory' ? { ...directory, path: member } : { ...row, path: member },
    );
  }
  for (const required of ['VERSION', 'LIBOLIPHAUNT_VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
    if (!archiveRows.some(({ path, type }) => path === required && type === 'file'))
      throw new Error(`Swift source ZIP lacks required shared member ${required}`);
  const ordered = (rows) => rows.sort((left, right) => left.path.localeCompare(right.path));
  deepStrictEqual(
    ordered(treeRows),
    ordered(archiveRows),
    'Swift source tag shared delivered members differ from the installed source ZIP',
  );
  const packageManifest = entries.get('package/Package.swift');
  if (!packageManifest?.isFile) throw new Error('Swift source ZIP lacks Package.swift');
  const sourceManifest = tree.find(({ path }) => path === 'Package.swift');
  if (sourceManifest?.type !== 'file' || sourceManifest.mode !== (packageManifest.mode & 0o777))
    throw new Error('Swift source tag manifest mode differs from the installed source ZIP');
  const canonical = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(manifest)
    .replaceAll('"src/sdks/swift/Sources/', '"Sources/');
  deepStrictEqual(
    Buffer.from(packageManifest.data()),
    Buffer.from(canonical),
    'Swift source ZIP manifest differs beyond the canonical source path rewrite',
  );
}
