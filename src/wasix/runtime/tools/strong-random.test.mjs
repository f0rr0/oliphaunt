import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('actual patched entropy loop handles interruptions, short reads and failures', {
  skip: process.platform === 'win32',
}, () => {
  const patch = readFileSync(
    new URL(
      '../../../third-party/postgres/patches/wasix/0037-oliphaunt-wasix-use-checked-getrandom.patch',
      import.meta.url,
    ),
    'utf8',
  );
  // Compile the exact added C implementation, not a second model of its loop.
  const added = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  const implementation = added.slice(added.indexOf('void\npg_strong_random_init'));
  assert.ok(implementation.includes('bool\npg_strong_random('));
  const fixture = mkdtempSync(path.join(tmpdir(), 'oliphaunt-entropy-'));
  try {
    const source = path.join(fixture, 'entropy.c');
    const binary = path.join(fixture, 'entropy');
    writeFileSync(
      source,
      `
#include <assert.h>
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <sys/types.h>
static int step, mode;
static ssize_t getrandom(void *buffer, size_t length, unsigned int flags) {
  assert(flags == 0);
  ++step;
  if (mode == 1) { errno = EIO; return -1; }
  if (mode == 2) return 0;
  if (step == 1) { errno = EINTR; return -1; }
  size_t count = length > 2 ? 2 : length;
  memset(buffer, 0xa5, count);
  return (ssize_t) count;
}
${implementation}
int main(void) {
  unsigned char output[5] = {0};
  pg_strong_random_init();
  assert(pg_strong_random(output, sizeof(output)));
  assert(step == 4);
  for (size_t i = 0; i < sizeof(output); ++i) assert(output[i] == 0xa5);
  mode = 1; step = 0;
  assert(!pg_strong_random(output, sizeof(output)) && step == 1);
  mode = 2; step = 0;
  assert(!pg_strong_random(output, sizeof(output)) && step == 1);
  step = 0;
  assert(pg_strong_random(NULL, 0) && step == 0);
  return 0;
}
`,
    );
    const compiled = spawnSync(
      process.env.CC ?? 'cc',
      ['-std=c11', '-Wall', '-Wextra', '-Werror', source, '-o', binary],
      { encoding: 'utf8' },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
