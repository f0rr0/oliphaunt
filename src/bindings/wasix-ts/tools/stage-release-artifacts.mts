import { copyFileSync } from 'node:fs';
import path from 'node:path';

import { assertWasixTypescriptNpmArchive } from './wasix-typescript-package.mts';
import { ROOT, fail, filesUnder } from '../../../shared/artifact-packaging/staging.mts';
import { stageWasixToolsArtifact } from '../tools-package/tools/stage-release-artifacts.mts';

export function stageArtifacts(artifactRoot) {
  const archives = filesUnder(path.join(ROOT, 'target/oliphaunt-wasix-ts/package/packages')).filter(
    (file) => file.endsWith('.tgz'),
  );
  if (archives.length !== 1)
    fail(`expected one WASIX TypeScript package, found ${archives.length}`);
  const archive = archives[0];
  assertWasixTypescriptNpmArchive(archive);
  copyFileSync(archive, path.join(artifactRoot, path.basename(archive)));
  stageWasixToolsArtifact(artifactRoot);
}

import { stageSdkArtifacts } from '../../../shared/artifact-packaging/staging.mts';
if (import.meta.main) await stageSdkArtifacts('oliphaunt-wasix-ts', stageArtifacts);
