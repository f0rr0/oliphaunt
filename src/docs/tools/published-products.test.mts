import { expect, test } from 'bun:test';
import { selectDocumentedProducts, selectProducts } from './published-products.mts';

test('published versions use completed stable releases of the requested product', () => {
  const release = (tag_name: string, extra = {}) => ({
    tag_name,
    published_at: '2026-09-11T00:00:00Z',
    html_url: `https://github.com/f0rr0/oliphaunt/releases/tag/${tag_name}`,
    draft: false,
    prerelease: false,
    ...extra,
  });
  const products = selectProducts(
    [
      release('oliphaunt-kotlin-v0.2.0'),
      release('oliphaunt-kotlin-v0.10.0'),
      release('oliphaunt-kotlin-v9.0.0', { prerelease: true }),
      release('oliphaunt-kotlin-v8.0.0', { draft: true }),
      release('oliphaunt-kotlin-v7.0.0', { published_at: null }),
      release('oliphaunt-swift-v0.0.0'),
      release('unrelated-v99.0.0'),
    ],
    ['oliphaunt-kotlin', 'oliphaunt-swift'],
  );
  expect(products['oliphaunt-kotlin']?.version).toBe('0.10.0');
  expect(products['oliphaunt-swift']).toBeNull();
});

test('documented versions stay paired with checkout APIs independently of publication', () => {
  const config = {
    packages: { 'sdk/rust': { component: 'rust' }, 'sdk/swift': { component: 'swift' } },
  };
  expect(selectDocumentedProducts(config, { 'sdk/rust': '0.3.0', 'sdk/swift': '0.8.0' })).toEqual({
    rust: { version: '0.3.0' },
    swift: { version: '0.8.0' },
  });
  expect(() => selectDocumentedProducts(config, { 'sdk/rust': '0.3.0' })).toThrow(/swift/);
});
