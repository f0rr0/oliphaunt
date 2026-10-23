import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { validateNativeClusterSeedDirectory } from '../../src/database-resources/contracts/native-manifest.mts';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import { seedProducerIdentity, validateSeedConstructionReceipt } from './seed_construction.mts';
import { materializeArchive, privateWork, readSpecification } from './shared.mts';
import { extractWasixRuntime } from './wasix_inputs.mts';

const specification = readSpecification();
const work = privateWork(path.resolve(specification.archive));
try {
  const family = specification.family;
  assert.ok(['native', 'wasix'].includes(family));
  const runtime = family === 'wasix' ? extractWasixRuntime(specification.runtime, work) : undefined;
  const receipt = validateSeedConstructionReceipt(
    JSON.parse(readFileSync(specification.construction, 'utf8')),
  );
  const actualFrozen = fileIdentity(realpathSync(specification.seed));
  assert.deepEqual(
    receipt.frozen,
    { size: actualFrozen.size, sha256: actualFrozen.sha256 },
    'seed archive must bind its original frozen constructor',
  );
  assert.equal(receipt.intent.family, family);
  assert.equal(receipt.intent.target, specification.target);
  assert.equal(receipt.intent.profile, specification.profile);
  const seed = path.join(work, 'seed');
  await extractNativePayload(specification.seed, seed);
  let icuData: string | undefined;
  if (specification.icu) {
    const icuRoot = path.join(work, 'icu');
    extractPortableArchiveTree(
      materializeArchive(specification.icu, path.join(work, 'inputs')),
      icuRoot,
    );
    icuData = path.join(icuRoot, 'share/icu');
  }
  if (family === 'native')
    validateNativeClusterSeedDirectory(seed, specification.profile, {
      target: specification.target,
      icuData,
    });
  const result = await packageClusterSeed({
    family,
    target: specification.target,
    profile: specification.profile,
    pgdata: family === 'native' ? path.join(seed, 'files') : seed,
    runtime,
    icuData,
    version: specification.version,
    runtimeVersion: specification.runtimeVersion,
    producer: seedProducerIdentity(receipt),
    nativeSourceManifest: family === 'native' ? receipt.sourceManifest?.contents : undefined,
    contract: specification.contract,
    outputDir: path.join(work, 'assets'),
  });
  assert.equal(path.basename(result.archive), path.basename(specification.archive));
  assert.equal(path.basename(result.manifest), path.basename(specification.manifest));
  copyFileSync(result.archive, specification.archive);
  copyFileSync(result.manifest, specification.manifest);
} finally {
  rmSync(work, { recursive: true, force: true });
}
