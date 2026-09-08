import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const patchUrl = new URL(
  '../assets/build/postgres/patches/0037-oliphaunt-wasix-use-checked-getrandom.patch',
  import.meta.url,
);
const seriesUrl = new URL('../assets/build/postgres/patches/series', import.meta.url);
const sourceManifestUrl = new URL('../assets/build/postgres/source.toml', import.meta.url);

function assertOrdered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker ${JSON.stringify(marker)}`);
    assert.ok(next > cursor, `${JSON.stringify(marker)} is out of order`);
    cursor = next;
  }
}

class ScriptedEntropy {
  constructor(steps) {
    this.steps = [...steps];
    this.calls = 0;
  }

  read(maximum) {
    this.calls += 1;
    const step = this.steps.shift();
    assert.notEqual(step, undefined, 'entropy script was exhausted');
    if (step === 'eintr' || step === 'error' || step === 'zero') return step;
    assert.ok(step instanceof Uint8Array);
    assert.ok(step.length > 0 && step.length <= maximum);
    return step;
  }
}

function directFill(target, entropy) {
  let offset = 0;
  while (offset < target.length) {
    const result = entropy.read(target.length - offset);
    if (result === 'eintr') continue;
    if (result === 'error' || result === 'zero') return false;
    target.set(result, offset);
    offset += result.length;
  }
  return true;
}

test('0037 is a direct, stateless WASI entropy source', async () => {
  const [patch, series, sourceManifest] = await Promise.all([
    readFile(patchUrl, 'utf8'),
    readFile(seriesUrl, 'utf8'),
    readFile(sourceManifestUrl, 'utf8'),
  ]);

  assert.ok(series.split('\n').includes('0037-oliphaunt-wasix-use-checked-getrandom.patch'));
  assert.ok(sourceManifest.includes('"0037-oliphaunt-wasix-use-checked-getrandom.patch"'));
  assertOrdered(patch, [
    '#elif defined(__wasi__)',
    '#include <sys/random.h>',
    'pg_strong_random_init(void)',
    'No guest-side state to initialize or duplicate.',
    'pg_strong_random(void *buf, size_t len)',
    'res = getrandom(p, len, 0);',
  ]);
  assert.doesNotMatch(patch, /^\+.*\/dev\/urandom/mu);
  assert.doesNotMatch(patch, /OLIPHAUNT_WASM_SINGLE_USER|WASIX_STRONG_RANDOM_POOL_SIZE|wasix_strong_random_pool/u);
});

test('0037 preserves retry, short-read, zero-read, and failure semantics', async () => {
  const patch = await readFile(patchUrl, 'utf8');

  assertOrdered(patch, [
    'res = getrandom(p, len, 0);',
    'if (res < 0)',
    'if (errno == EINTR)',
    'continue;',
    'return false;',
    'if (res == 0)',
    'return false;',
    'p += res;',
    'len -= res;',
  ]);

  const output = new Uint8Array(4);
  const successful = new ScriptedEntropy([
    'eintr',
    Uint8Array.of(1),
    Uint8Array.of(2, 3, 4),
  ]);
  assert.equal(directFill(output, successful), true);
  assert.deepEqual(output, Uint8Array.of(1, 2, 3, 4));
  assert.equal(successful.calls, 3);

  for (const terminal of ['zero', 'error']) {
    const failedOutput = new Uint8Array(1);
    assert.equal(directFill(failedOutput, new ScriptedEntropy([terminal])), false);
    assert.deepEqual(failedOutput, Uint8Array.of(0));
  }
});
