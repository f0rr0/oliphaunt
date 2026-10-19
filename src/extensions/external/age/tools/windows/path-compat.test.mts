import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test.skipIf(process.platform !== 'win32')(
  'AGE CSV paths reject traversal and junction escapes',
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'age-windows-path-'));
    const run = (program: string, args: string[]) => {
      const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout.trim();
    };
    try {
      const source = path.join(root, 'test.c');
      const executable = path.join(root, 'test.exe');
      writeFileSync(
        source,
        `#include <stdio.h>
#include "path-compat.h"
int main(int argc, char **argv) {
    char *resolved;
    if (argc != 3) return 2;
    resolved = oliphaunt_age_windows_realpath(argv[1]);
    printf("%d\\n", resolved != NULL && oliphaunt_age_windows_path_below(resolved, argv[2]));
    free(resolved);
    return 0;
}
`,
      );
      run('cl.exe', ['/nologo', '/W4', `/I${import.meta.dir}`, source, `/Fe${executable}`]);
      const base = path.join(root, 'age');
      const sibling = path.join(root, 'age-other');
      mkdirSync(path.join(base, 'nested'), { recursive: true });
      mkdirSync(sibling);
      writeFileSync(path.join(base, 'nested/data.csv'), 'id\n1\n');
      writeFileSync(path.join(sibling, 'outside.csv'), 'id\n2\n');
      symlinkSync(sibling, path.join(base, 'escape'), 'junction');
      symlinkSync(path.join(base, 'nested'), path.join(base, 'inside'), 'junction');
      for (const file of ['nested/data.csv', 'inside/data.csv']) {
        assert.equal(run(executable, [path.join(base, file), base]), '1', file);
      }
      for (const file of ['../age-other/outside.csv', 'escape/outside.csv', 'missing.csv']) {
        assert.equal(run(executable, [path.join(base, file), base]), '0', file);
      }
      assert.equal(run(executable, [base, base]), '0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
