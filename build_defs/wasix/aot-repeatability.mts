import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const [serializer, module, target] = process.argv.slice(2);
assert(serializer && module && target && process.argv.length === 5 && process.env.TEST_TMPDIR);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = readFileSync(module);
assert(source.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR, 'aot-repeatability-'));
try {
  const results = [0, 1].map((index) => {
    const output = path.join(root, String(index), 'plpgsql.bin.zst');
    const result = spawnSync(
      serializer,
      [
        'aot-serializer',
        'serialize',
        '--input',
        module,
        '--output',
        output,
        '--target',
        target,
        '--threads',
        '2',
      ],
      { cwd: root, env: { LC_ALL: 'C' }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `fresh serializer failed:\n${result.stderr.toString()}`);
    const compressed = readFileSync(output);
    const raw = Buffer.from(Bun.zstdDecompressSync(compressed));
    assert(raw.length > 0 && compressed.length > 0);
    return { compressed, raw };
  });
  assert(
    results[0].raw.equals(results[1].raw),
    `fresh serialized bytes differ: ${results.map(({ raw }) => sha256(raw)).join(', ')}`,
  );
  assert(
    results[0].compressed.equals(results[1].compressed),
    `fresh compressed bytes differ: ${results.map(({ compressed }) => sha256(compressed)).join(', ')}`,
  );
  assert(
    readFileSync(module).equals(source),
    'serialization changed its actual shipping WASM input',
  );
  console.log(
    JSON.stringify({
      target,
      serializerSha256: sha256(readFileSync(serializer)),
      wasmSha256: sha256(source),
      rawSha256: sha256(results[0].raw),
      compressedSha256: sha256(results[0].compressed),
      rawBytes: results[0].raw.length,
      compressedBytes: results[0].compressed.length,
      freshProcesses: results.length,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
