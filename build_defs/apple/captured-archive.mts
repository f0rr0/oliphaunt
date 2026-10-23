import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPortableArchiveEntries } from '../../tools/packaging/portable-archive.mts';
import { verifyCapturedFile } from './captured-file.mts';
export function verifyAppleCapturedArchive(archive: string, row: any) {
  assert(row && (row.publication?.product ?? row.owner) === 'liboliphaunt-native');
  const version = row.publication?.version ?? row.version;
  const expected = path.basename(archive);
  if (row.publication) assert.equal(row.artifact, `github-release:${expected}`);
  else {
    assert.equal(
      row.file.member,
      undefined,
      'Current Apple archive must be its whole producer File',
    );
    assert.equal(
      row.file.producer.root,
      `//src/native/runtime:${expected.endsWith('-apple-spm-xcframework.zip') ? 'apple_swiftpm_shipping' : 'apple_resources_shipping'}`,
    );
  }
  const physical = verifyCapturedFile(archive, row.file);
  assert(/^\d+\.\d+\.\d+$/u.test(version));
  const framework = expected === 'liboliphaunt-' + version + '-apple-spm-xcframework.zip';
  const resources =
    expected === 'liboliphaunt-' + version + '-runtime-resources-ios-datum64.tar.gz';
  assert(framework || resources, 'The captured native artifact has no Apple construction role');
  const entries = readPortableArchiveEntries(physical, { format: framework ? 'zip' : 'tar.gz' });
  for (const [name, entry] of entries)
    assert(
      !entry.isSymbolicLink,
      'Native public archive must contain original regular Files: ' + name,
    );
  const required = framework
    ? [
        'liboliphaunt.xcframework/Info.plist',
        'liboliphaunt.xcframework/ios-arm64/liboliphaunt.framework/liboliphaunt',
        'liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/liboliphaunt',
        'liboliphaunt.xcframework/ios-arm64-simulator/liboliphaunt.framework/Headers/oliphaunt.h',
      ]
    : ['oliphaunt/runtime/manifest.properties'];
  for (const name of required)
    assert(entries.get(name)?.isFile, 'Captured Apple artifact lost required member ' + name);
  return { version, framework, resources };
}
if (import.meta.main) {
  const [archive, descriptor] = process.argv.slice(2);
  console.log(
    JSON.stringify(
      verifyAppleCapturedArchive(archive, JSON.parse(readFileSync(descriptor, 'utf8'))),
    ),
  );
}
