import assert from 'node:assert/strict';

export const SWIFT_SOURCE_FIXTURE_PREFIX = 'package/Tests/Fixtures/swiftpm-extension-resources/';

/** Only the declared, byte-identical test fixtures may contain runtime payloads. */
export function validateSwiftSourceFixtureEntries(
  artifact: string,
  entries: Map<string, { isFile: boolean; data(): Uint8Array }>,
  expected: Map<string, Uint8Array>,
): Set<string> {
  assert(entries instanceof Map, `${artifact} Swift source fixture entries must be a Map`);
  const expectedNames = [...expected.keys()].sort();
  const actualNames = [...entries]
    .filter(([name, entry]) => name.startsWith(SWIFT_SOURCE_FIXTURE_PREFIX) && entry.isFile)
    .map(([name]) => name)
    .sort();
  const expectedSet = new Set(expectedNames);
  const actualSet = new Set(actualNames);
  assert.deepEqual(
    actualNames,
    expectedNames,
    `${artifact} Swift source fixture file set must exactly match declared inputs; missing=${JSON.stringify(expectedNames.filter((name) => !actualSet.has(name)))}, extra=${JSON.stringify(actualNames.filter((name) => !expectedSet.has(name)))}`,
  );
  for (const name of expectedNames) {
    assert(name.startsWith(SWIFT_SOURCE_FIXTURE_PREFIX), 'unexpected declared Swift fixture');
    const entry = entries.get(name);
    const bytes = expected.get(name);
    assert(entry?.isFile && bytes, `${artifact} is missing declared Swift fixture ${name}`);
    assert(
      Buffer.from(entry.data()).equals(Buffer.from(bytes)),
      `${artifact} Swift source fixture ${name} must byte-for-byte match declared input`,
    );
  }
  return expectedSet;
}
