import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDeterministicZip } from '../packaging/archive-directory.mts';
import { inspectSwiftpmRemoteTag } from './publish_swiftpm_source_tag.mts';
import { currentProductVersionSync } from './release-artifact-targets.mts';
import releaseBot from './release-bot.json' with { type: 'json' };

const [mode, root] = process.argv.slice(2);
if (mode === 'prepare') {
  const source = path.join(root, 'resource-package');
  mkdirSync(path.join(source, 'Sources/Resources'), { recursive: true });
  writeFileSync(
    path.join(source, 'Package.swift'),
    '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Resources", targets: [.target(name: "Resources")])\n',
  );
  writeFileSync(
    path.join(source, 'Sources/Resources/Resources.swift'),
    'public let resource = true\n',
  );
  writeFileSync(path.join(source, 'LICENSE'), 'fixture license');
  writeFileSync(path.join(root, 'source.zip'), await createDeterministicZip(source));
  writeFileSync(
    path.join(root, 'versions.json'),
    JSON.stringify({
      resources: currentProductVersionSync('database-resources'),
      swift: currentProductVersionSync('oliphaunt-swift'),
    }),
  );
  writeFileSync(path.join(root, 'release-bot.json'), JSON.stringify(releaseBot));
  process.exit(0);
}
test('SwiftPM reconciliation accepts only a complete single exact remote ref', () => {
  const version = '1.2.3',
    sha = 'a'.repeat(40),
    ref = `refs/tags/${version}`,
    exact = `${sha}\t${ref}\n`;
  assert.equal(inspectSwiftpmRemoteTag(exact, version, sha), 'exact');
  assert.equal(inspectSwiftpmRemoteTag('', version, sha, { allowMissing: true }), 'absent');
  for (const text of [
    '',
    exact.trim(),
    exact + exact,
    exact.replace(sha, 'b'.repeat(40)),
    `not-a-sha\t${ref}\n`,
  ])
    assert.throws(() => inspectSwiftpmRemoteTag(text, version, sha));
});
