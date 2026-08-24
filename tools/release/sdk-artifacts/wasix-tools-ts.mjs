import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  assertWasixToolsTypescriptNpmArchive,
  prepareWasixToolsTypescriptPackage,
} from '../wasix-tools-typescript-package.mjs';
import { packageNpmWorkspace } from './npm.mjs';
import { ROOT, requireDir, run } from './shared.mjs';

export function stageWasixToolsArtifact(artifactRoot, workRoot, bindingVersion) {
  const packageRoot = path.join(ROOT, 'src/bindings/wasix-ts/tools-package');
  run('pnpm', ['--dir', packageRoot, 'build'], { label: 'build WASIX tools facade' });
  requireDir(path.join(packageRoot, 'lib'));
  const staging = path.join(workRoot, 'package');
  mkdirSync(staging, { recursive: true });
  for (const name of ['package.json', 'README.md', 'lib']) {
    cpSync(path.join(packageRoot, name), path.join(staging, name), { recursive: true });
  }
  copyFileSync(
    path.join(ROOT, 'src/bindings/wasix-ts/CHANGELOG.md'),
    path.join(staging, 'CHANGELOG.md'),
  );
  prepareWasixToolsTypescriptPackage(staging, bindingVersion);
  const archive = packageNpmWorkspace(staging, artifactRoot);
  assertWasixToolsTypescriptNpmArchive(archive);
}
