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

export const ROOT = path.resolve(import.meta.dirname, '../../../..');
const SOURCE = path.join(ROOT, 'src/bindings/wasix-ts');
const RUNTIME = '@oliphaunt/liboliphaunt-wasix';
const NATIVE = [
  '@oliphaunt/wasix-napi-darwin-arm64',
  '@oliphaunt/wasix-napi-linux-arm64-gnu',
  '@oliphaunt/wasix-napi-linux-x64-gnu',
  '@oliphaunt/wasix-napi-win32-x64-msvc',
];

export function prepareWasixTypescriptPackage(packageDir) {
  const manifestFile = path.join(packageDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const runtimeVersion = manifest.oliphaunt?.runtimeVersion;
  const nativeVersion = manifest.oliphaunt?.wasixNapiVersion;
  if (![runtimeVersion, nativeVersion].every((version) => /^\d+\.\d+\.\d+$/u.test(version))) {
    throw new Error('WASIX TypeScript package requires exact runtime and Node-API versions');
  }
  manifest.dependencies = Object.fromEntries(
    Object.entries({ ...(manifest.dependencies ?? {}), [RUNTIME]: runtimeVersion }).sort(),
  );
  manifest.optionalDependencies = Object.fromEntries(NATIVE.map((name) => [name, nativeVersion]));
  delete manifest.devDependencies;
  delete manifest.scripts;
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(packageDir, 'LICENSE'));
  copyFileSync(
    path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
    path.join(packageDir, 'THIRD_PARTY_NOTICES.md'),
  );
  return manifest;
}

export function stageWasixTypescriptPackage(outputDir) {
  const destination = path.resolve(ROOT, outputDir);
  const relative = path.relative(ROOT, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`WASIX TypeScript package stage must stay inside the repository: ${outputDir}`);
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
  copyFileSync(path.join(SOURCE, 'package.json'), path.join(destination, 'package.json'));
  for (const name of manifest.files ?? []) {
    const source = path.join(SOURCE, name);
    if (existsSync(source)) cpSync(source, path.join(destination, name), { recursive: true });
  }
  return prepareWasixTypescriptPackage(destination);
}

if (import.meta.main) {
  const output = process.argv[2] ?? 'target/oliphaunt-wasix-ts/package';
  stageWasixTypescriptPackage(output);
  const packages = path.resolve(ROOT, output, 'packages');
  mkdirSync(packages);
  const result = spawnSync('pnpm', ['--silent', 'pack', '--pack-destination', packages], {
    cwd: path.resolve(ROOT, output),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
