import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import { materializeArchive } from './shared.mts';
import { seedProducerIdentity, validateSeedConstructionReceipt } from './seed_construction.mts';
import { extractWasixRuntime } from './wasix_inputs.mts';

const [sdkTest, portable, icu, version, runtimeVersion, ...seeds] = process.argv.slice(2);
assert.equal(seeds.length, 4);
const root = mkdtempSync(path.join(process.env.TEST_TMPDIR ?? tmpdir(), 'wasix-sdk-seeds-'));
try {
  const runtime = extractWasixRuntime(portable, root);
  const icuRoot = path.join(root, 'icu');
  extractPortableArchiveTree(materializeArchive(icu, path.join(root, 'inputs')), icuRoot);
  const outputs: string[] = [];
  for (const [index, profile] of ['standard', 'icu'].entries()) {
    const [frozen, receiptFile] = seeds.slice(index * 2, index * 2 + 2);
    const receipt = validateSeedConstructionReceipt(JSON.parse(readFileSync(receiptFile, 'utf8')));
    const frozenFile = fileIdentity(realpathSync(frozen));
    assert.deepEqual(receipt.frozen, { size: frozenFile.size, sha256: frozenFile.sha256 });
    const pgdata = path.join(root, profile);
    await extractNativePayload(frozen, pgdata);
    // This private compatibility overlay belongs to the SDK test; it never replaces a public descriptor.
    const packaged = await packageClusterSeed({
      family: 'wasix',
      target: 'portable',
      profile,
      pgdata,
      runtime,
      version,
      runtimeVersion,
      producer: seedProducerIdentity(receipt),
      icuData: profile === 'icu' ? path.join(icuRoot, 'share/icu') : undefined,
      outputDir: path.join(root, 'assets'),
    });
    outputs.push(packaged.archive);
  }
  const result = Bun.spawnSync([sdkTest, '--include-ignored', '--test-threads=1'], {
    cwd: root,
    env: {
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
      RAYON_NUM_THREADS: '2',
      TEST_TMPDIR: root,
      XDG_CACHE_HOME: path.join(root, 'cache'),
      OLIPHAUNT_TEST_STANDARD_SEED: outputs[0],
      OLIPHAUNT_TEST_ICU_SEED: outputs[1],
      OLIPHAUNT_TEST_ICU_ROOT: icuRoot,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 0, `${result.stderr.toString()}\n${result.stdout.toString()}`);
  assert.match(result.stdout.toString(), /test result: ok\. 2 passed; 0 failed; 0 ignored;/u);
  console.log(result.stdout.toString());
} finally {
  rmSync(root, { recursive: true, force: true });
}
