import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { WASIX_RUNTIME_NPM_PACKAGE } from '../../src/wasix/runtime/tools/wasix-runtime-npm-contract.mts';
import {
  assertWasixRuntimeNpmArchive,
  stageWasixRuntimeNpmPayload,
  wasixRuntimeNpmPayloadInputs,
} from '../../src/wasix/runtime/tools/wasix-runtime-npm-payload.mts';
import { createDeterministicTar } from '../../tools/packaging/package-archive.mts';
import { canonicalGzipSync } from '../../tools/packaging/portable-archive.mts';

export interface RuntimeNpmSpec {
  version: string;
  packageName: string;
  portableAssets: string;
  notices: Record<string, string>;
}

export function packageRuntimeNpm(spec: RuntimeNpmSpec, output: string): void {
  output = path.resolve(output);
  if (spec.packageName !== WASIX_RUNTIME_NPM_PACKAGE) {
    throw new Error('Canonical release package name disagrees with the WASIX runtime contract');
  }
  const inputs = wasixRuntimeNpmPayloadInputs({
    manifestBytes: readFileSync(path.join(spec.portableAssets, 'manifest.json')),
    runtimeBytes: readFileSync(path.join(spec.portableAssets, 'oliphaunt.wasix.tar.zst')),
    label: 'declared portable runtime',
  });
  mkdirSync(path.dirname(output), { recursive: true });
  const scratch = mkdtempSync(path.join(path.dirname(output), '.wasix-npm-'));
  try {
    const sourceRoot = path.join(scratch, 'notices');
    for (const [destination, source] of Object.entries(spec.notices)) {
      if (
        !destination ||
        destination.includes('\\') ||
        destination.split('/').some((part) => !part || part === '.' || part === '..') ||
        path.isAbsolute(destination)
      ) {
        throw new Error(`Unsafe declared notice destination: ${destination}`);
      }
      const file = path.join(sourceRoot, destination);
      mkdirSync(path.dirname(file), { recursive: true });
      copyFileSync(source, file);
    }
    // Canonical notice readers intentionally reject symbolic links. Copy only
    // these declared file projections into a real temporary source root.
    const noticeOptions = { profile: 'wasix-runtime', sourceRoot };
    const staged = stageWasixRuntimeNpmPayload({
      version: spec.version,
      inputs,
      packageDir: path.join(scratch, 'package'),
      noticeOptions,
    });
    writeFileSync(
      output,
      canonicalGzipSync(
        createDeterministicTar(staged.packageDir, 'package', { fixedFileMode: 0o644 }),
      ),
    );
    assertWasixRuntimeNpmArchive(output, {
      version: spec.version,
      descriptor: staged.descriptor,
      noticeOptions,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { spec: { type: 'string' }, output: { type: 'string' } },
    strict: true,
  });
  if (!values.spec || !values.output)
    throw new Error('usage: npm.mts --spec <json> --output <tgz>');
  packageRuntimeNpm(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(values.spec))),
    values.output,
  );
}
