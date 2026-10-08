import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sha256File } from '../../../../third-party/tools/source-fetch-core.mts';
import { runCacheProducer } from './cache-producer.mts';

const root = path.resolve(import.meta.dir, '../../../../..');
const engine = path.join(root, 'target/oliphaunt-wasix/engine/windows-x64-msvc');
const output = path.join(engine, 'cache/sse41');
const work = path.join(root, 'target/oliphaunt-wasix/engine/cache-producer');
const source = JSON.parse(readFileSync(path.join(engine, 'source.json'), 'utf8'));
assert.equal(sha256File(path.join(engine, 'oliphaunt_wee8.dll')), source.dllSha256);
mkdirSync(output, { recursive: true });
mkdirSync(work, { recursive: true });
for (const file of ['cache-producer.exe', 'oliphaunt_wee8.dll']) {
  copyFileSync(path.join(engine, file), path.join(work, file));
}

const env = { ...process.env, WINEPREFIX: path.join(work, 'wine-prefix'), WINEDEBUG: '-all' };
function run(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: work,
    env,
    timeout: 900_000,
  });
  assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
  return result.stdout.toString();
}
const wine = '/usr/lib/wine/wine64';
run([wine, 'cmd', '/c', 'exit', '0']);
const receipts = [];
const products = Bun.argv.slice(2);
assert(
  products.length > 0 &&
    products.every((product) => ['runtime', 'tools', 'extensions'].includes(product)),
);
for (const product of products) {
  const plan = Bun.spawnSync(
    [
      'cargo',
      'run',
      '-p',
      'xtask',
      '--locked',
      '--',
      'assets',
      'prepare-aot',
      '--target-triple',
      'x86_64-pc-windows-msvc',
      '--product',
      product,
    ],
    { cwd: root },
  );
  assert.equal(plan.exitCode, 0, plan.stderr.toString());
  for (const row of plan.stdout.toString().trim().split('\n')) {
    const [input, destination] = row.split('\t');
    assert(input && destination, 'incomplete AOT producer input');
    const guest = readFileSync(input);
    copyFileSync(input, path.join(work, 'guest.wasm'));
    const log = await runCacheProducer(
      ['qemu-x86_64', '-cpu', 'Penryn', wine, 'cache-producer.exe', 'write'],
      { cwd: work, env: { ...env, WINELOADERNOEXEC: '1' } },
    );
    assert.match(log, /cpu_mask=0xe /, 'the baseline must come from a real emulated SSE4.1 CPU');
    assert.match(log, /native_deserialize=PASS/);
    const cache = readFileSync(path.join(work, 'cache.bin'));
    let wireLength = 0,
      offset = 0,
      shift = 0;
    while (offset < 10) {
      const byte = cache[offset++];
      wireLength += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) break;
      shift += 7;
    }
    assert(Number.isSafeInteger(wireLength));
    assert(cache.length - offset - wireLength >= 20, 'missing native cache');
    assert.deepEqual(
      cache.subarray(offset, offset + wireLength),
      guest,
      'native cache guest identity',
    );
    assert.equal(cache.readUInt32LE(offset + wireLength), 0xc0de0689, 'pinned native cache format');
    assert.equal(cache.readUInt32LE(offset + wireLength + 8), 0xe, 'unmodified SSE4.1 CPU profile');
    const digest = sha256File(input);
    const file = path.join(output, `${digest}.bin`);
    writeFileSync(file, cache);
    const read = await runCacheProducer(
      ['qemu-x86_64', '-cpu', 'Penryn', wine, 'cache-producer.exe', 'read'],
      { cwd: work, env: { ...env, WINELOADERNOEXEC: '1' } },
    );
    assert.match(read, /native_deserialize=PASS/, 'fresh-process native cache reader');
    receipts.push({
      product,
      moduleSha256: digest,
      cacheSha256: sha256File(file),
      bytes: cache.length,
    });
    console.log(`SSE4.1 AOT ${product}: ${path.basename(input)}`);
  }
}
writeFileSync(
  path.join(output, 'source.json'),
  JSON.stringify(
    {
      sourceSha: source.sourceSha,
      dllSha256: source.dllSha256,
      cpu: 'Penryn',
      nativeCpuMask: '0xe',
      modules: receipts,
    },
    null,
    2,
  ) + '\n',
);
