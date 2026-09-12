import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { test } from 'bun:test';
import { createDeterministicTar } from '../../../../tools/packaging/cargo-source-package.mts';
import { extensionSqlNames } from '../../../../tools/release/release-artifact-targets.mts';
import {
  loadNativeComponentContract,
  resolveNativeComponentClosure,
} from '../../../tools/native-component-contract.mts';

const CONTRIB_PRODUCT = 'oliphaunt-extension-contrib-pg18';
if (process.argv[2] === 'prepare') {
  const fixture = process.argv[3];
  const nativeComponentContract = loadNativeComponentContract();
  const assetRoot = path.join(fixture, 'assets');
  const extensionRoot = path.join(assetRoot, 'extensions');
  const metadataPath = path.join(fixture, 'extensions.json');
  const manifestPath = path.join(fixture, 'manifest.json');
  const outDir = path.join(fixture, 'out');
  mkdirSync(extensionRoot, { recursive: true });

  const sqlNames = extensionSqlNames(CONTRIB_PRODUCT, 'extension-package-assembly.test');
  const builtExtensions = [];
  const extensions = sqlNames.map((sqlName) => {
    const componentClosure = resolveNativeComponentClosure(nativeComponentContract, {
      extension: sqlName,
      family: 'wasix',
      kind: 'wasix-runtime',
      target: 'wasix-portable',
    });
    const archive = `extensions/${sqlName}.tar.zst`;
    const archiveRoot = path.join(fixture, 'archive-input', sqlName);
    const controlPath = `share/postgresql/extension/${sqlName}.control`;
    const controlFile = path.join(archiveRoot, ...controlPath.split('/'));
    mkdirSync(path.dirname(controlFile), { recursive: true });
    writeFileSync(controlFile, `default_version = '1.0'\n`);
    const archiveBytes = zstdCompressSync(
      createDeterministicTar(archiveRoot, '.', {
        fail(message) {
          throw new Error(message);
        },
        fixedFileMode: 0o644,
      }),
    );
    writeFileSync(path.join(assetRoot, archive), archiveBytes);
    const lifecycle = {
      'create-extension': true,
      'create-schema': null,
      'load-sql': [],
      'post-create-sql': [],
      'startup-config': [],
      'preload-required': false,
      'restart-required': false,
      'shared-memory-required': false,
    };
    builtExtensions.push({
      name: sqlName,
      'sql-name': sqlName,
      archive,
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
      size: archiveBytes.length,
      'native-module': null,
      'native-modules': [],
      'core-exports-required': [],
      dependencies: [],
      'load-order': [],
      lifecycle,
      'installed-files': [controlPath],
      'unresolved-imports': [],
    });
    return {
      'sql-name': sqlName,
      archive,
      dependencies: [],
      'load-order': [],
      lifecycle,
      'native-module-file': null,
      'native-support-modules': [],
      'native-components': componentClosure.components,
      'native-link-units': componentClosure.linkUnits,
      'native-runtime-files': componentClosure.runtimeFiles,
    };
  });
  writeFileSync(metadataPath, `${JSON.stringify({ extensions }, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify({ extensions: builtExtensions }, null, 2)}\n`);

  process.exit(0);
}
test('WASIX staging packages every selected contrib member under its artifact owner', () => {
  const fixture = process.env.OLIPHAUNT_EXTENSION_ASSEMBLY_TEST_ROOT;
  if (!fixture)
    throw new Error('Run bash extensions/artifacts/packages/tools/package-assembly.test.sh');
  const outDir = path.join(fixture, 'out');
  const sqlNames = extensionSqlNames(CONTRIB_PRODUCT, 'package-assembly.test');
  const staged = readdirSync(outDir).sort();
  assert.equal(staged.length, sqlNames.length * 2 + 1);
  const index = staged.find((entry) => entry.endsWith('-wasix-extension-assets.tsv'));
  assert.ok(index);
  const indexedSqlNames = readFileSync(path.join(outDir, index), 'utf8')
    .trimEnd()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t', 1)[0])
    .sort();
  assert.deepEqual(indexedSqlNames, sqlNames);
});
