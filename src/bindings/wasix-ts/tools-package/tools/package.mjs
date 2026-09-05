#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const SOURCE = path.join(ROOT, 'src/bindings/wasix-ts/tools-package');
const CARRIER = '@oliphaunt/liboliphaunt-wasix-tools';
const BINDING = '@oliphaunt/wasix-ts';

export function prepareWasixToolsTypescriptPackage(packageDir, bindingVersion) {
  if (!/^\d+\.\d+\.\d+$/u.test(bindingVersion)) throw new Error('binding version must be exact');
  const manifestFile = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const runtimeVersion = manifest.oliphaunt?.runtimeVersion;
  if (!/^\d+\.\d+\.\d+$/u.test(runtimeVersion)) throw new Error('runtime version must be exact');
  manifest.version = bindingVersion;
  manifest.dependencies = { [CARRIER]: runtimeVersion };
  manifest.peerDependencies = { [BINDING]: bindingVersion };
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(packageDir, 'LICENSE'));
  copyFileSync(
    path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
    path.join(packageDir, 'THIRD_PARTY_NOTICES.md'),
  );
  return manifest;
}

export function stageWasixToolsTypescriptPackage(outputDir, bindingVersion) {
  const destination = path.resolve(ROOT, outputDir);
  const relative = path.relative(ROOT, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`WASIX tools package stage must stay inside the repository: ${outputDir}`);
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
  copyFileSync(path.join(SOURCE, 'package.json'), path.join(destination, 'package.json'));
  for (const name of manifest.files ?? []) {
    const source = path.join(SOURCE, name);
    if (existsSync(source)) cpSync(source, path.join(destination, name), { recursive: true });
  }
  copyFileSync(
    path.join(ROOT, 'src/bindings/wasix-ts/CHANGELOG.md'),
    path.join(destination, 'CHANGELOG.md'),
  );
  return prepareWasixToolsTypescriptPackage(destination, bindingVersion);
}

if (import.meta.main) {
  const output = process.argv[2] ?? 'target/oliphaunt-wasix-tools-ts/package';
  const binding = JSON.parse(
    readFileSync(path.join(ROOT, 'src/bindings/wasix-ts/package.json'), 'utf8'),
  );
  stageWasixToolsTypescriptPackage(output, binding.version);
  const packages = path.resolve(ROOT, output, 'packages');
  mkdirSync(packages);
  const result = spawnSync('pnpm', ['--silent', 'pack', '--pack-destination', packages], {
    cwd: path.resolve(ROOT, output),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
