import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySourceModes, patchNewFileModes } from './source-modes.mts';

const patch = `diff --git a/src/added.c b/src/added.c
new file mode 100644
--- /dev/null
+++ b/src/added.c
@@ -0,0 +1 @@
+new source
diff --git a/test/probe.sh b/test/probe.sh
new file mode 100755
--- /dev/null
+++ b/test/probe.sh
@@ -0,0 +1 @@
+exit 0
`;

test('new source modes come only from exact patch declarations', () => {
  expect([...patchNewFileModes(patch)]).toEqual([
    ['src/added.c', 0o644],
    ['test/probe.sh', 0o755],
  ]);
  expect(() =>
    patchNewFileModes(patch.replace('+++ b/src/added.c\n', '+++ b/../escape.c\n')),
  ).toThrow('Invalid source mode path');
  expect(() => patchNewFileModes(patch.replace('100644', '120000'))).toThrow(
    'Unsupported patch new-file mode',
  );
  expect(() => patchNewFileModes(patch + patch)).toThrow('Duplicate patch new-file identity');
});

test('mode repair touches declared regular files only and fails before writes on symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'postmaster-source-modes-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/added.c'), 'source');
    writeFileSync(join(root, 'untouched.c'), 'unchanged');
    chmodSync(join(root, 'src/added.c'), 0o664);
    chmodSync(join(root, 'untouched.c'), 0o664);
    applySourceModes(root, new Map([['src/added.c', 0o644]]));
    expect(statSync(join(root, 'src/added.c')).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, 'untouched.c')).mode & 0o777).toBe(0o664);
    symlinkSync(join(root, 'src'), join(root, 'escape'));
    expect(() =>
      applySourceModes(
        root,
        new Map([
          ['src/added.c', 0o755],
          ['escape/added.c', 0o644],
        ]),
      ),
    ).toThrow('ancestor');
    expect(statSync(join(root, 'src/added.c')).mode & 0o777).toBe(0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
