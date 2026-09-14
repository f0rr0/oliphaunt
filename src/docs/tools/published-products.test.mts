import { expect, test } from 'bun:test';
import { selectProducts } from './published-products.mts';

test('installation versions use completed stable releases of the requested product', () => {
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
