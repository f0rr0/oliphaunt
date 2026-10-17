import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { missingPublishedProducts, verifyLive, writeNativeDocsInputs } from './verify-live.mts';

test('native build inputs retain the acquired release bytes and explicit source diagnostic', async () => {
  const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'docs-input-snapshot-'));
  try {
    const acquired = path.join(root, 'acquired.json');
    const raw = '[{"tag_name":"sdk-v1.0.0","draft":false,"prerelease":false}]\n';
    writeFileSync(acquired, raw);
    const output = path.join(root, 'native');
    const source = { sourceRevision: 'a'.repeat(40), dirty: true };
    await writeNativeDocsInputs(output, acquired, source);
    expect(readFileSync(path.join(output, 'completed-releases.json'), 'utf8')).toBe(raw);
    expect(JSON.parse(readFileSync(path.join(output, 'provenance.json'), 'utf8'))).toEqual(source);
    expect(readFileSync(path.join(output, 'BUILD.bazel'), 'utf8')).toContain(
      '"completed-releases.json", "provenance.json"',
    );
    await expect(
      writeNativeDocsInputs(output, acquired, { ...source, sourceRevision: 'main' }),
    ).rejects.toThrow('actual Git revision');
    expect(readFileSync(path.join(output, 'completed-releases.json'), 'utf8')).toBe(raw);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live docs must link the released version, not merely mention it or expose an old release', async () => {
  const url = 'https://github.com/f0rr0/oliphaunt/releases/tag/sdk-v2.0.0';
  const products = { sdk: { version: '2.0.0', url }, unpublished: null };
  expect(
    missingPublishedProducts(
      `<p>${url}</p><a href="${url.replace('2.0.0', '1.0.0')}">old</a>`,
      products,
    ),
  ).toEqual(['sdk@2.0.0']);
  await verifyLive(products, {
    timeoutMs: 1,
    fetchPage: async () => new Response(`<a href="${url}">2.0.0</a>`),
  });
  expect(
    missingPublishedProducts(`<a href="${url.replace('2.0.0', '2.1.0')}">newer</a>`, products),
  ).toEqual([]);
  await expect(
    verifyLive(products, { timeoutMs: 1, fetchPage: async () => new Response('stale') }),
  ).rejects.toThrow('sdk@2.0.0');
  await expect(
    verifyLive(products, {
      timeoutMs: 1,
      fetchPage: async () => new Response('unavailable', { status: 503 }),
    }),
  ).rejects.toThrow('HTTP 503');
});
