import assert from 'node:assert/strict';
import path from 'node:path';

/** Only replace the already verified SDK requirement in a private consumer
 * copy. Public fixture bytes and their exact dependency remain untouched. */
export function localizeSwiftExtensionFixturePackage(manifest, products, version, sdk) {
  assert.equal(products.basePackage?.url, 'https://github.com/f0rr0/oliphaunt.git');
  assert.equal(products.basePackage?.version, version, 'fixture adopts a different Swift source');
  const pattern = /\.package\(\s*url:\s*"([^"]+)"\s*,\s*exact:\s*"([^"]+)"\s*\)/gu;
  const rows = [...manifest.matchAll(pattern)];
  assert.equal(rows.length, 1, 'fixture needs exactly one conventional SDK dependency');
  assert.equal(rows[0][1], products.basePackage.url);
  assert.equal(rows[0][2], version);
  return manifest.replace(
    pattern,
    `.package(name: "oliphaunt", path: ${JSON.stringify(path.resolve(sdk))})`,
  );
}
