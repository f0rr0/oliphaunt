import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fitCargoPayloadParts,
  packageGeneratedCargoSource,
} from '../../../../tools/packaging/cargo-source-package.mts';
import { readPortableArchiveEntries } from '../../../../tools/packaging/portable-archive.mts';
import { buildNativeExtensionPartCrates } from './package-extension-release-carriers.mts';

test('smaller native extension parts replace prior payloads and reconstruct every byte', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-extension-parts-'));
  try {
    const payload = path.join(root, 'payload');
    mkdirSync(payload);
    const original = randomBytes(12 * 1024 * 1024);
    writeFileSync(path.join(payload, 'module.so'), original);
    const parts = fitCargoPayloadParts(
      (partBytes) =>
        buildNativeExtensionPartCrates(payload, path.join(root, 'sources'), {
          product: 'oliphaunt-extension-vector',
          version: '0.2.0',
          members: ['vector'],
          target: 'linux-x64-gnu',
          partBytes,
        }),
      (directory) =>
        packageGeneratedCargoSource(
          path.join(directory, 'Cargo.toml'),
          path.join(root, 'archives'),
          {
            packageSizeLimitBytes: Number.MAX_SAFE_INTEGER,
          },
        ),
      16 * 1024 * 1024,
    );
    assert.equal(parts.length, 2);
    const chunks = [];
    for (const directory of parts) {
      const archive = path.join(root, 'archives', path.basename(directory) + '-0.2.0.crate');
      assert(statSync(archive).size <= 9 * 1024 * 1024);
      const entries = readPortableArchiveEntries(archive);
      const payloadEntries = [...entries.values()].filter(
        (entry) => entry.type !== 'directory' && entry.name.includes('/payload/'),
      );
      assert.equal(payloadEntries.length, 1);
      assert(payloadEntries[0].name.includes('/payload/chunks/module.so.part'));
      chunks.push(payloadEntries[0].data());
    }
    assert.deepEqual(Buffer.concat(chunks), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
