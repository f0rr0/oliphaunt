#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDeterministicTar } from '../../../tools/packaging/cargo-source-package.mts';
import {
  extractPortableArchiveTree,
  releaseZstdCompressSync,
} from '../../../tools/packaging/portable-archive.mts';
import { packageSpec } from '../../../tools/packaging/wasix-cargo-payload.mts';
import { currentProductVersionSync } from '../../../tools/release/release-artifact-targets.mts';
import { validateNativeIcuDataManifest } from '../../contracts/icu-data.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function fail(message) {
  throw new Error(message);
}

export function packageIcuCargo(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      version: { type: 'string', default: currentProductVersionSync('database-resources') },
      asset: { type: 'string' },
      'output-dir': { type: 'string', default: 'target/database-resources/cargo-artifacts' },
      'work-dir': { type: 'string', default: 'target/database-resources' },
    },
  });
  const prefix = `database-resources-${values.version}-icu-data`;
  const archive = path.resolve(
    ROOT,
    values.asset ?? `target/database-resources/release-assets/${prefix}.tar.gz`,
  );
  const work = path.resolve(ROOT, values['work-dir']);
  const extracted = path.join(work, 'icu-cargo-extracted');
  const sourceRoot = path.join(work, 'cargo-package-sources');
  const outputDir = path.resolve(ROOT, values['output-dir']);
  // Own only this crate's scratch: future resource carriers share the output directory.
  for (const directory of [extracted, path.join(sourceRoot, 'oliphaunt-icu')])
    rmSync(directory, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  extractPortableArchiveTree(archive, extracted);
  const dataRoot = path.join(extracted, 'share/icu');
  validateNativeIcuDataManifest(
    readFileSync(path.join(extracted, 'manifest.properties')),
    dataRoot,
  );
  const payloadRoot = path.join(extracted, 'cargo-payload');
  mkdirSync(payloadRoot);
  writeFileSync(
    path.join(payloadRoot, 'icu-data.tar.zst'),
    releaseZstdCompressSync(
      createDeterministicTar(dataRoot, 'share/icu', { fail, fixedFileMode: 0o644 }),
    ),
  );
  const packaged = packageSpec(
    {
      name: 'oliphaunt-icu',
      target: 'portable',
      kind: 'icu-data',
      templateDir: path.join(ROOT, 'database-resources/icu/cargo'),
      payloadRoot,
      payloadDirName: 'payload',
    },
    {
      version: values.version,
      sourceRoot,
      outputDir,
      cargoTargetDir: path.join(work, 'cargo-package-target'),
    },
  );
  const relative = (value) => path.relative(ROOT, value).split(path.sep).join('/');
  writeFileSync(
    path.join(outputDir, 'packages.json'),
    `${JSON.stringify(
      {
        schema: 'oliphaunt-liboliphaunt-wasix-cargo-artifacts-v2',
        product: 'database-resources',
        packages: [
          {
            ...packaged,
            role: 'artifact',
            manifestPath: relative(packaged.manifestPath),
            cratePath: relative(packaged.cratePath),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return packaged;
}

if (import.meta.main) packageIcuCargo(Bun.argv.slice(2));
