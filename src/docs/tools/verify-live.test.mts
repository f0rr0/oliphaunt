import { expect, test } from 'bun:test';
import { missingPublishedProducts, verifyLive } from './verify-live.mts';

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
