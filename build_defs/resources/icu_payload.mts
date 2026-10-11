import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { archiveDirectory } from '../../tools/packaging/archive-directory.mts';
import {
  stageReleaseNotices,
  assertReleaseNoticesInArchive,
} from '../../tools/packaging/release-notices.mts';
import {
  nativeIcuDataManifest,
  validateNativeIcuDataManifest,
} from '../../src/database-resources/contracts/icu-data.mts';
import { icuPackageSizeReport } from '../../src/database-resources/icu/tools/write-icu-package-size-report.mts';
import { materializeInputs, privateWork, readSpecification } from './shared.mts';

const specification = readSpecification();
const output = path.resolve(specification.output);
const work = privateWork(output);
try {
  const legalRoot = materializeInputs(specification.notices, path.join(work, 'legal'));
  const payload = path.join(work, 'payload');
  const data = path.join(payload, 'share/icu');
  mkdirSync(data, { recursive: true });
  assert.equal(
    path.basename(specification.data),
    'icudt76l.dat',
    'expected pinned ICU76 little-endian data',
  );
  copyFileSync(specification.data, path.join(data, 'icudt76l.dat'));
  const manifest = nativeIcuDataManifest(data);
  validateNativeIcuDataManifest(manifest, data);
  writeFileSync(path.join(payload, 'manifest.properties'), manifest);
  writeFileSync(path.join(payload, 'package-size.tsv'), icuPackageSizeReport(data));
  stageReleaseNotices(payload, { profile: 'native-icu-data', sourceRoot: legalRoot });
  await archiveDirectory(payload, output);
  assertReleaseNoticesInArchive(output, { profile: 'native-icu-data', sourceRoot: legalRoot });
} finally {
  rmSync(work, { recursive: true, force: true });
}
