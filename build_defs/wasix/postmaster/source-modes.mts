import assert from 'node:assert/strict';
import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function safePath(path: string) {
  assert(
    /^[A-Za-z0-9_./-]+$/.test(path) &&
      !path.startsWith('/') &&
      !path.split('/').some((part) => !part || part === '.' || part === '..'),
    'Invalid source mode path',
  );
}

export function patchNewFileModes(patch: string): Map<string, number> {
  const modes = new Map<string, number>();
  let pending: number | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git '))
      assert.equal(pending, undefined, 'Unconsumed patch new-file mode');
    if (line.startsWith('new file mode ')) {
      assert.equal(pending, undefined, 'Duplicate patch new-file mode');
      const mode = line.slice('new file mode '.length);
      assert(mode === '100644' || mode === '100755', 'Unsupported patch new-file mode');
      pending = Number.parseInt(mode.slice(3), 8);
    } else if (pending !== undefined && line.startsWith('+++ ')) {
      assert(line.startsWith('+++ b/'), 'Unexpected patch new-file path');
      const path = line.slice('+++ b/'.length);
      safePath(path);
      assert(!modes.has(path), 'Duplicate patch new-file identity');
      modes.set(path, pending);
      pending = undefined;
    }
  }
  assert.equal(pending, undefined, 'Unconsumed patch new-file mode');
  return modes;
}

export function applySourceModes(root: string, modes: Map<string, number>) {
  assert(lstatSync(root).isDirectory(), 'Source repository root is not a regular directory');
  // Validate every destination before changing any permission.
  for (const [path, mode] of modes) {
    safePath(path);
    assert(mode === 0o644 || mode === 0o755, 'Unsupported declared source mode');
    const components = path.split('/');
    for (let index = 1; index < components.length; index++)
      assert(
        lstatSync(join(root, ...components.slice(0, index))).isDirectory(),
        'Source mode ancestor is not a regular directory',
      );
    assert(lstatSync(join(root, path)).isFile(), 'Source mode member is not a regular file');
  }
  for (const [path, mode] of modes) chmodSync(join(root, path), mode);
}

if (import.meta.main) {
  const [kind, root, input] = process.argv.slice(2);
  assert(
    kind && root && input && process.argv.length === 5,
    'Expected source mode kind, root and declared input',
  );
  let modes: Map<string, number>;
  if (kind === 'patch') modes = patchNewFileModes(readFileSync(input, 'utf8'));
  else {
    assert.equal(kind, 'overlay', 'Unknown source mode kind');
    const paths = JSON.parse(input) as string[];
    assert(new Set(paths).size === paths.length, 'Duplicate overlay mode identity');
    modes = new Map(paths.map((path) => [path, 0o644]));
  }
  applySourceModes(root, modes);
}
