#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AOT_TARGET_TRIPLES,
  TOOLS_AOT_PACKAGES,
  TOOLS_PACKAGE,
  WASIX_CARGO_ARTIFACT_SCHEMA,
} from '../../../runtimes/liboliphaunt-wasix/tools/wasix-cargo-artifact-contract.mts';
import { extractPortableArchiveTree } from '../../../tools/packaging/portable-archive.mts';
import { packageSpec } from '../../../tools/packaging/wasix-cargo-payload.mts';
import { currentProductVersionSync } from '../../../tools/release/release-artifact-targets.mts';
import {
  fail,
  ROOT,
  validatePortableToolsPayload,
  validateToolsAotPayload,
} from './package-assets.mts';

export function packageWasixToolsCargoArtifacts(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: 'string', multiple: true },
      version: { type: 'string', default: currentProductVersionSync('postgres-tools-wasix') },
      'asset-dir': { type: 'string', default: 'target/postgres-tools/wasix/release-assets' },
      'output-dir': { type: 'string', default: 'target/postgres-tools/wasix/cargo-artifacts' },
      'work-dir': { type: 'string', default: 'target/postgres-tools/wasix' },
    },
  });
  const outputDir = path.resolve(ROOT, values['output-dir']);
  const work = path.resolve(ROOT, values['work-dir']);
  const sourceRoot = path.join(work, 'cargo-package-sources');
  const extracted = path.join(work, 'cargo-package-extracted');
  for (const directory of [outputDir, sourceRoot, extracted]) {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
  }
  const targets = values.target ?? ['portable', ...Object.keys(AOT_TARGET_TRIPLES)];
  const packages = targets.map((target) => {
    const triple = AOT_TARGET_TRIPLES[target];
    if (target !== 'portable' && !triple) fail(`unsupported WASIX tools target ${target}`);
    const payloadRoot = path.join(extracted, target);
    const archive = path.resolve(
      ROOT,
      values['asset-dir'],
      `postgres-tools-wasix-${values.version}-${triple ? `aot-${target}` : 'portable'}.tar.gz`,
    );
    extractPortableArchiveTree(archive, payloadRoot);
    if (triple) validateToolsAotPayload(payloadRoot, triple);
    else validatePortableToolsPayload(payloadRoot, values.version);
    return packageSpec(
      {
        name: triple ? TOOLS_AOT_PACKAGES[target] : TOOLS_PACKAGE,
        target: triple ?? 'portable',
        kind: triple ? 'wasix-tools-aot' : 'wasix-tools',
        templateDir: path.join(
          ROOT,
          'postgres-tools/wasix/crates',
          triple ? `aot/${triple}` : 'tools',
        ),
        payloadRoot,
        payloadDirName: triple ? 'artifacts' : 'payload',
      },
      {
        version: values.version,
        sourceRoot,
        outputDir,
        cargoTargetDir: path.join(work, 'cargo-package-target'),
      },
    );
  });
  const relative = (value) => path.relative(ROOT, value).split(path.sep).join('/');
  writeFileSync(
    path.join(outputDir, 'packages.json'),
    `${JSON.stringify(
      {
        schema: WASIX_CARGO_ARTIFACT_SCHEMA,
        product: 'postgres-tools-wasix',
        packages: packages.map((row) => ({
          ...row,
          role: 'artifact',
          manifestPath: relative(row.manifestPath),
          cratePath: relative(row.cratePath),
        })),
      },
      null,
      2,
    )}\n`,
  );
  return packages;
}

if (import.meta.main) packageWasixToolsCargoArtifacts(Bun.argv.slice(2));
