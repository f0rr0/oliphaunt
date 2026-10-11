import assert from 'node:assert/strict';
import { copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { validateNativeClusterSeedDirectory } from '../../src/database-resources/contracts/native-manifest.mts';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { materializeArchive, privateWork, readSpecification } from './shared.mts';

const specification = readSpecification();
const work = privateWork(path.resolve(specification.archive));
try {
  const runtime = path.join(work, 'runtime');
  await extractNativePayload(specification.runtime, runtime);
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
  validateNativeClusterSeedDirectory(seed, specification.profile, {
    target: specification.target,
    icuData,
  });
  const result = await packageClusterSeed({
    family: 'native',
    target: specification.target,
    profile: specification.profile,
    pgdata: path.join(seed, 'files'),
    runtime,
    icuData,
    version: specification.version,
    runtimeVersion: specification.runtimeVersion,
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
