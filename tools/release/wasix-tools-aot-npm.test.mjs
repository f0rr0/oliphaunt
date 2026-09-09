import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createDeterministicTar } from './cargo-source-package.mjs';
import { canonicalWasixAotMetadata } from './wasix-aot-manifest.mjs';
import { stageWasixToolsAotNpmCarrier } from './wasix-tools-npm-carrier.mjs';

test('the optional tools host package contains only pg_dump and psql from the verified runtime release', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-tools-aot-'));
  try {
    const source = path.join(root, 'source');
    mkdirSync(source);
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const artifacts = ['runtime', 'tool:pg_dump', 'tool:psql'].map((name, index) => {
      const raw = Buffer.from(`fixture-${name}`);
      const bytes = zstdCompressSync(raw);
      const file = `${index}.bin.zst`;
      writeFileSync(path.join(source, file), bytes);
      return { name, path: file, compressed: true, sha256: sha(bytes), 'raw-sha256': sha(raw),
        'raw-size': raw.length, 'module-sha256': 'a'.repeat(64) };
    });
    const canonical = canonicalWasixAotMetadata();
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
      'format-version': 1, 'source-lane': canonical.sourceLane, engine: canonical.engine,
      'wasmer-version': canonical.wasmerVersion, 'wasmer-wasix-version': canonical.wasmerWasixVersion,
      'target-triple': 'x86_64-unknown-linux-gnu', artifacts,
    }));
    const archive = path.join(root, 'release.tar.zst');
    writeFileSync(archive, zstdCompressSync(createDeterministicTar(source, 'aot', {
      fail: message => { throw new Error(message); }, fixedFileMode: 0o644,
    })));
    const packageDir = path.join(root, 'package');
    const manifest = stageWasixToolsAotNpmCarrier({ version: '0.2.0', target: 'linux-x64-gnu',
      packageDir, aotReleaseArchive: archive });
    expect(manifest.name).toBe('@oliphaunt/liboliphaunt-wasix-tools-linux-x64-gnu');
    expect(existsSync(path.join(packageDir, '0.bin.zst'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(packageDir, 'aot-manifest.json'))).artifacts.map(row => row.name))
      .toEqual(['tool:pg_dump', 'tool:psql']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
