import { copyFileSync } from 'node:fs';
import path from 'node:path';

import { assertWasixToolsTypescriptNpmArchive } from '../wasix-tools-typescript-package.mjs';
import { ROOT, fail, filesUnder } from './shared.mjs';

export function stageWasixToolsArtifact(artifactRoot) {
  const archives = filesUnder(path.join(ROOT, 'target/oliphaunt-wasix-tools-ts/package/packages'))
    .filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1) fail(`expected one WASIX TypeScript tools package, found ${archives.length}`);
  const archive = archives[0];
  assertWasixToolsTypescriptNpmArchive(archive);
  copyFileSync(archive, path.join(artifactRoot, path.basename(archive)));
}
