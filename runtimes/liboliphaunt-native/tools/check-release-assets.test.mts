#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageReleaseNotices } from '../../../tools/packaging/release-notices.mts';
import { archiveDirectory } from '../../../tools/packaging/archive-directory.mts';
import { assertLiboliphauntArtifactReleaseNotices } from './check-release-assets.mts';

test('aggregate validation reads Apple notices from the canonical XCFramework member root', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'oliphaunt-apple-notice-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = path.join(root, 'liboliphaunt.xcframework');
  mkdirSync(framework);
  writeFileSync(path.join(framework, 'Info.plist'), 'fixture\n');
  stageReleaseNotices(framework, { profile: 'native-runtime' });
  const archive = path.join(root, 'liboliphaunt-0.0.0-apple-spm-xcframework.zip');
  await archiveDirectory(framework, archive, { keepParent: true });
  assert.equal(assertLiboliphauntArtifactReleaseNotices(archive, 'apple-swiftpm-binary'), true);

  rmSync(path.join(framework, 'LICENSE'));
  const missingNoticeArchive = path.join(root, 'missing-notice.zip');
  await archiveDirectory(framework, missingNoticeArchive, { keepParent: true });
  assert.throws(
    () => assertLiboliphauntArtifactReleaseNotices(missingNoticeArchive, 'apple-swiftpm-binary'),
    /liboliphaunt[.]xcframework\/LICENSE/u,
  );
});
