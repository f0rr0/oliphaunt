import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { elfFixture } from '../../../../tools/packaging/testdata/release-fixture-utils.mts';
import { validateExtensionArtifactArchive } from '../../packages/tools/extension-artifact-inventory.mts';

const [phase, root, kind] = process.argv.slice(2);
const metadata = {
  sqlName: 'pgtap',
  createsExtension: true,
  nativeModuleStem: null,
  dependencies: [],
  dataFiles: [],
  extensionSqlFileNames: ['uninstall_pgtap.sql'],
  extensionSqlFilePrefixes: ['pgtap-core', 'pgtap-schema'],
  sharedPreloadLibraries: [],
};
const dataFiles = [
  'oliphaunt-streaming/a.bin',
  'oliphaunt-streaming/b.bin',
  'oliphaunt-streaming/c.bin',
];
if (phase === 'prepare-binaries') {
  for (const [directory, requiredVersions] of [
    ['runtime/lib/postgresql', []],
    ['embedded', ['GLIBC_2.17']],
  ]) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(
      path.join(root, directory, 'auto_explain.so'),
      elfFixture({ machine: 62, requiredVersions }),
      { mode: 0o755 },
    );
  }
} else if (phase === 'prepare-stream') {
  for (const [index, file] of dataFiles.entries()) {
    const destination = path.join(root, 'runtime/share/postgresql', file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, Buffer.alloc(24 * 1024 * 1024, index + 1));
  }
} else if (phase === 'verify') {
  const selected =
    kind === 'module'
      ? {
          ...metadata,
          sqlName: 'auto_explain',
          createsExtension: false,
          nativeModuleStem: 'auto_explain',
          extensionSqlFileNames: [],
          extensionSqlFilePrefixes: [],
        }
      : { ...metadata, dataFiles: kind === 'stream' ? dataFiles : [] };
  const file = path.join(root, kind + '.tar.gz');
  const result = validateExtensionArtifactArchive({
    file,
    metadata: selected,
    target: 'linux-x64-gnu',
    nativeRuntimeVersion: '1.2.3',
    label: 'actual native producer',
  });
  if (kind === 'module') {
    const normal = result.entries.get('files/lib/postgresql/auto_explain.so');
    const embedded = result.entries.get('files/lib/modules/auto_explain.so');
    assert.ok(normal);
    assert.ok(embedded);
    assert.notEqual(normal.sha256, embedded.sha256);
  } else if (kind === 'stream') {
    assert.ok(result.runtimeFiles.reduce((sum, row) => sum + row.bytes, 0) > 64 * 1024 * 1024);
  } else if (kind === 'chain') {
    for (const name of ['pgtap--1.3.3.sql', 'pgtap--1.3.3--1.3.4.sql', 'pgtap--1.3.4--1.3.5.sql'])
      assert.ok(result.entries.has('files/share/postgresql/extension/' + name));
  } else {
    assert.equal((await fs.readFile(file)).subarray(0, 10).toString('hex'), '1f8b0800000000000003');
    for (const name of ['pgtap-core-evil.control', 'foreign.control'])
      assert.equal(result.entries.has('files/share/postgresql/extension/' + name), false);
  }
} else if (phase !== undefined) {
  throw Error('Unknown native artifact fixture phase');
}
