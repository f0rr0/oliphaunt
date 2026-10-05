import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentProductVersionSync } from '../../../../../tools/release/release-artifact-targets.mts';
import { pinnedNativeCarrierDirectory } from './pinned-native-carrier.mts';

test('current runtime requires same-run assets and never falls back to a published release', async () => {
  const version = currentProductVersionSync('liboliphaunt-native', 'pinned-native-carrier.test');
  const fetchImpl = () => {
    throw new Error('unexpected download');
  };
  assert.equal(
    await pinnedNativeCarrierDirectory({ version, assetDir: '/producer', fetchImpl }),
    '/producer',
  );
  await assert.rejects(pinnedNativeCarrierDirectory({ version, fetchImpl }), /same-run producer/);
});

test('older runtime pins stage exact published bytes, including paginated assets and cache verification', async () => {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'pinned-native-carrier-'));
  const version = '0.1.0';
  const tag = `liboliphaunt-native-v${version}`;
  const names = [
    `liboliphaunt-${version}-apple-spm-xcframework.zip`,
    `liboliphaunt-${version}-runtime-resources-ios-datum64.tar.gz`,
  ];
  const assets = names.map((name) => ({
    name,
    size: Buffer.byteLength(name),
    digest: `sha256:${createHash('sha256').update(name).digest('hex')}`,
    browser_download_url: `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${name}`,
  }));
  let corrupt = false;
  let downloads = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('/releases/tags/'))
      return Response.json({ id: 23, tag_name: tag, draft: false, prerelease: false });
    if (new URL(url).searchParams.get('page') === '1')
      return Response.json(Array.from({ length: 100 }, (_, id) => ({ name: `other-${id}` })));
    if (new URL(url).searchParams.get('page') === '2') return Response.json(assets);
    const row = assets.find((asset) => asset.browser_download_url === url);
    assert.ok(row, url);
    downloads += 1;
    const response = new Response(corrupt ? 'x'.repeat(row.size) : row.name);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try {
    const options = { version, assetDir: '/current-producer', workRoot, fetchImpl };
    const directory = await pinnedNativeCarrierDirectory(options);
    for (const name of names) assert.equal(readFileSync(path.join(directory, name), 'utf8'), name);
    assert.equal(downloads, 2);
    await pinnedNativeCarrierDirectory(options);
    assert.equal(downloads, 2);
    rmSync(path.join(workRoot, 'pinned-native-carrier-cache'), { recursive: true });
    corrupt = true;
    await assert.rejects(pinnedNativeCarrierDirectory(options), /checksum mismatch/);
    assets[0].browser_download_url = 'https://example.com/other.zip';
    await assert.rejects(pinnedNativeCarrierDirectory(options), /must publish one checksummed/);
    assets[0].browser_download_url = `https://github.com/f0rr0/oliphaunt/releases/download/${tag}/${names[0]}`;
    assets[0].digest = null;
    await assert.rejects(pinnedNativeCarrierDirectory(options), /must publish one checksummed/);
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});
