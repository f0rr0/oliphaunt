import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  assertWasixTypescriptJsrDirectory,
  assertWasixTypescriptNpmArchive,
  prepareWasixTypescriptJsrPackage,
  prepareWasixTypescriptPackage,
} from '../wasix-typescript-package.mjs';
import { packageNpmWorkspace } from './npm.mjs';
import { ROOT, requireDir } from './shared.mjs';

export function stageArtifacts(artifactRoot, workRoot) {
  const packageRoot = path.join(ROOT, 'src/bindings/wasix-ts');
  requireDir(path.join(packageRoot, 'lib/host'));
  const staging = path.join(workRoot, 'package');
  mkdirSync(staging, { recursive: true });
  for (const name of [
    'package.json',
    'jsr.json',
    'README.md',
    'ARCHITECTURE.md',
    'CHANGELOG.md',
    'lib',
  ]) {
    cpSync(path.join(packageRoot, name), path.join(staging, name), { recursive: true });
  }
  const packageManifest = prepareWasixTypescriptPackage(staging);
  prepareWasixTypescriptJsrPackage(staging);
  const archive = packageNpmWorkspace(staging, artifactRoot);
  assertWasixTypescriptNpmArchive(archive);
  const jsrSource = path.join(artifactRoot, 'jsr-source');
  mkdirSync(jsrSource, { recursive: true });
  for (const name of [
    'jsr.json',
    'README.md',
    'ARCHITECTURE.md',
    'CHANGELOG.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'lib',
  ]) {
    cpSync(path.join(staging, name), path.join(jsrSource, name), { recursive: true });
  }
  assertWasixTypescriptJsrDirectory(jsrSource, {
    version: packageManifest.version,
    runtimeVersion: packageManifest.dependencies['@oliphaunt/liboliphaunt-wasix'],
  });
}
