import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { buildInventory } from './check-build-inputs.mjs';
import { canonicalWasixAotMetadata } from '../../../../tools/release/wasix-aot-manifest.mjs';
import {
  contribCarrierDescriptor, extensionArtifactProductRoot,
  extensionSqlNames, extensionWasixAotMemberSqlNames,
} from '../../../../tools/release/release-artifact-targets.mjs';

const root = path.resolve(import.meta.dirname, '../../../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function write(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}
function json(file, value) { write(file, JSON.stringify(value)); }

test('base addon inputs require core, standard seed, and contrib without optional package payloads', () => {
  mkdirSync(path.join(root, 'target'), { recursive: true });
  const scratch = mkdtempSync(path.join(root, 'target/napi-inputs-'));
  try {
    const portable = path.join(scratch, 'portable');
    const aot = path.join(scratch, 'aot');
    const extensions = path.join(scratch, 'extensions');
    const target = 'linux-x64-gnu';
    const triple = 'x86_64-unknown-linux-gnu';
    const bytes = Buffer.from('qualified fixture bytes');
    const fingerprint = 'fixture-source';
    write(path.join(portable, 'runtime.tar.zst'), bytes);
    write(path.join(portable, 'bin/initdb.wasix.wasm'), bytes);
    write(path.join(portable, 'cluster-seeds/standard.tar.zst'), bytes);
    json(path.join(portable, 'cluster-seeds/standard.json'), { fixture: true });
    json(path.join(portable, 'manifest.json'), {
      'format-version': 2, 'source-fingerprint': fingerprint,
      runtime: { archive: 'runtime.tar.zst', sha256: digest(bytes) },
      'cluster-seeds': { standard: {
        archive: 'cluster-seeds/standard.tar.zst', manifest: 'cluster-seeds/standard.json', sha256: digest(bytes),
      } },
    });
    const canonical = canonicalWasixAotMetadata();
    const stageAot = (directory, name) => {
      write(path.join(directory, 'module.bin.zst'), bytes);
      json(path.join(directory, 'manifest.json'), {
        'format-version': 1, 'source-lane': canonical.sourceLane,
        engine: canonical.engine, 'wasmer-version': canonical.wasmerVersion,
        'wasmer-wasix-version': canonical.wasmerWasixVersion,
        'target-triple': triple, 'source-fingerprint': fingerprint,
        artifacts: [{ name, path: 'module.bin.zst', sha256: digest(bytes) }],
      });
    };
    stageAot(path.join(aot, triple), 'runtime:oliphaunt');
    const product = contribCarrierDescriptor('napi inputs test').artifactProduct;
    const productRoot = extensionArtifactProductRoot(product, 'wasix', extensions, 'napi inputs test');
    const members = extensionSqlNames(product).map(sqlName => {
      write(path.join(productRoot, 'member-assets', sqlName, 'extension.tar.zst'), bytes);
      return { sqlName, assets: [{ family: 'wasix', target: 'wasix-portable', kind: 'wasix-runtime',
        name: 'extension.tar.zst', sha256: digest(bytes), bytes: bytes.length }] };
    });
    json(path.join(productRoot, 'extension-artifacts.json'), {
      schema: 'oliphaunt-extension-ci-artifacts-v2', product, extensions: members,
    });
    for (const sqlName of extensionWasixAotMemberSqlNames(product)) {
      stageAot(path.join(productRoot, 'wasix-aot', target, sqlName), `extension:${sqlName}`);
    }
    const options = { target, 'target-triple': triple, 'portable-root': portable, 'aot-root': aot, 'extension-root': extensions };
    const inventory = buildInventory(options);
    expect(inventory.inputs.extensionArtifacts.map(row => row.product)).toEqual([product]);
    expect(Object.keys(inventory.inputs).sort()).toEqual(['extensionArtifacts', 'portableManifest', 'runtimeAotManifest']);
    write(path.join(portable, 'cluster-seeds/standard.tar.zst'), 'tampered');
    expect(() => buildInventory(options)).toThrow('digest mismatch');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
