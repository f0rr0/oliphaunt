import { copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, filesUnder, stageSdkArtifacts } from '../../../../tools/packaging/staging.mts';
import { assertWasixToolsTypescriptNpmArchive } from './wasix-tools-typescript-package.mts';
await stageSdkArtifacts('postgres-tools-wasix', (artifactRoot) => {
  const archives = filesUnder(
    path.join(ROOT, 'target/oliphaunt-wasix-tools-ts/package/packages'),
  ).filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1)
    throw new Error(`Expected one PostgreSQL tools facade archive, found ${archives.length}`);
  assertWasixToolsTypescriptNpmArchive(archives[0]);
  copyFileSync(archives[0], path.join(artifactRoot, path.basename(archives[0])));
});
