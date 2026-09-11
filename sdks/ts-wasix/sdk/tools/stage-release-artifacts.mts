import { copyFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT, fail, filesUnder } from '../../../../tools/packaging/staging.mts';

export function stageArtifacts(artifactRoot) {
  const archives = filesUnder(path.join(ROOT, 'target/oliphaunt-wasix-ts/package/packages')).filter(
    (file) => file.endsWith('.tgz'),
  );
  if (archives.length !== 1)
    fail(`expected one WASIX TypeScript package, found ${archives.length}`);
  const archive = archives[0];
  copyFileSync(archive, path.join(artifactRoot, path.basename(archive)));
}

import { stageSdkArtifacts } from '../../../../tools/packaging/staging.mts';
if (import.meta.main) await stageSdkArtifacts('oliphaunt-wasix-ts', stageArtifacts);
