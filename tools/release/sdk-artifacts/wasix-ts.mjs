import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  assertWasixTypescriptNpmArchive,
  prepareWasixTypescriptPackage,
} from '../wasix-typescript-package.mjs';
import { packageNpmWorkspace } from './npm.mjs';
import { ROOT, requireDir } from './shared.mjs';
import { stageWasixToolsArtifact } from './wasix-tools-ts.mjs';

export function stageArtifacts(artifactRoot, workRoot) {
  const packageRoot = path.join(ROOT, 'src/bindings/wasix-ts');
  requireDir(path.join(packageRoot, 'lib/host'));
  const staging = path.join(workRoot, 'package');
  mkdirSync(staging, { recursive: true });
  for (const name of [
    'package.json',
    'README.md',
    'ARCHITECTURE.md',
    'CHANGELOG.md',
    'lib',
  ]) {
    cpSync(path.join(packageRoot, name), path.join(staging, name), { recursive: true });
  }
  const manifest = prepareWasixTypescriptPackage(staging);
  const archive = packageNpmWorkspace(staging, artifactRoot);
  assertWasixTypescriptNpmArchive(archive);
  stageWasixToolsArtifact(artifactRoot, path.join(workRoot, 'tools'), manifest.version);
}
