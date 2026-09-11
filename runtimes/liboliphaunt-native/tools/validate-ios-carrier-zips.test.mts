import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';
import { validateIosCarrierZipRoot } from './validate-ios-carrier-zips.mts';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oliphaunt-ios-carriers-'));
  roots.push(root);
  mkdirSync(path.join(root, 'carriers'));
  return root;
}
async function makeCarrier(root, relativeArchive, frameworkName) {
  const framework = path.join(root, 'source', relativeArchive.replaceAll('/', '-'), frameworkName);
  mkdirSync(path.join(framework, 'ios-arm64', 'libFixture.framework'), { recursive: true });
  writeFileSync(path.join(framework, 'Info.plist'), '<plist><dict/></plist>\n');
  writeFileSync(
    path.join(framework, 'ios-arm64', 'libFixture.framework', 'libFixture'),
    'fixture-binary\n',
  );
  const archive = path.join(root, 'carriers', relativeArchive);
  mkdirSync(path.dirname(archive), { recursive: true });
  await archiveDirectory(framework, archive, { keepParent: true });
}

test('validates recursively produced XCFramework ZIP carriers', async () => {
  const root = fixture();
  await makeCarrier(root, 'nested/base.zip', 'liboliphaunt.xcframework');
  await makeCarrier(root, 'extensions/vector.zip', 'liboliphaunt_extension_vector.xcframework');
  const rows = await validateIosCarrierZipRoot(path.join(root, 'carriers'));
  assert.deepEqual(rows.map(({ framework }) => framework).sort(), [
    'liboliphaunt.xcframework',
    'liboliphaunt_extension_vector.xcframework',
  ]);
});
test('rejects an empty producer output', async () => {
  await assert.rejects(
    validateIosCarrierZipRoot(path.join(fixture(), 'carriers')),
    /found no ZIP carriers/u,
  );
});
test('rejects a non-XCFramework member in an otherwise valid producer set', async () => {
  const root = fixture();
  await makeCarrier(root, 'a-valid.zip', 'liboliphaunt.xcframework');
  await makeCarrier(root, 'z-invalid.zip', 'not-a-framework');
  await assert.rejects(
    validateIosCarrierZipRoot(path.join(root, 'carriers')),
    /z-invalid[.]zip has unsafe or non-XCFramework top-level root/u,
  );
});
test('rejects carrier-root symlinks', async () => {
  const root = fixture();
  await makeCarrier(root, 'valid.zip', 'liboliphaunt.xcframework');
  const outside = path.join(root, 'outside.zip');
  writeFileSync(outside, 'not a carrier\n');
  symlinkSync(outside, path.join(root, 'carriers', 'linked.zip'));
  await assert.rejects(
    validateIosCarrierZipRoot(path.join(root, 'carriers')),
    /carrier root contains a symbolic link: linked[.]zip/u,
  );
});
