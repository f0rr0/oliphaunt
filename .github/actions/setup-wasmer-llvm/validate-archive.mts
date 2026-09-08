import assert from 'node:assert/strict';
import { posix } from 'node:path';
import {
  portableMemberName,
  validateSourceTarStream,
} from '../../../src/shared/artifact-packaging/portable-archive.mts';

// Shell verifies the compressed pin and feeds xz's output; no file contents are buffered here.
const bytes = Number(process.argv[2]);
assert(
  Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 2 * 1024 ** 3,
  'expected archive bytes must be between 1 and 2 GiB',
);
const members = await validateSourceTarStream(process.stdin, 'Wasmer LLVM', {
  maxEntries: 500_000,
  maxEntryBytes: 4 * 1024 ** 3,
  maxExpandedBytes: Math.min(12 * 1024 ** 3, Math.max(1024 ** 3, bytes * 20)),
});
const portable = new Map<string, string>();
const links = new Map<string, string>();
for (const entry of members.values()) {
  const parts = entry.name.split('/');
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join('/');
    const key = prefix.normalize('NFC').toUpperCase().toLowerCase();
    const prior = portable.get(key);
    assert(
      prior === undefined || prior === prefix,
      `case/Unicode-colliding paths: ${prior}, ${prefix}`,
    );
    portable.set(key, prefix);
  }
  if (!['symlink', 'hardlink'].includes(entry.type)) continue;
  const link = entry.linkTarget;
  assert(
    link && !/[\\\u0000-\u001f\u007f:]/.test(link) && !posix.isAbsolute(link),
    `unsafe link: ${entry.name}`,
  );
  const target = posix.normalize(
    entry.type === 'symlink' ? posix.join(posix.dirname(entry.name), link) : link,
  );
  portableMemberName(target, 'file', 'Wasmer LLVM');
  assert(members.has(target), `missing link target: ${entry.name}`);
  if (entry.type === 'hardlink')
    assert(members.get(target).isFile, `hard link must target a regular file: ${entry.name}`);
  links.set(entry.name, target);
}
for (const name of links.keys()) {
  const seen = new Set<string>();
  let current = name;
  while (links.has(current)) {
    assert(!seen.has(current), `link cycle: ${name}`);
    seen.add(current);
    current = links.get(current)!;
  }
  assert(['file', 'directory'].includes(members.get(current).type), `invalid link target: ${name}`);
}
