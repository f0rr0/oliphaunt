import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
  parseNativeMobileAbiReceipt,
} from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import {
  bindNativeClusterSeedManifest,
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  parseProperties,
  validateNativeClusterSeedDirectory,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { materializeArchive, privateWork, readSpecification } from './shared.mts';

/** Bind a physically unchanged host seed only after every real target ABI agrees. */
export function bindSeedDomain({ seed, producerTarget, domain, profile, receipts, icuData }) {
  const targets = NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN[domain];
  assert.ok(targets, 'the native seed domain must be declared');
  assert.equal(producerTarget, targets.at(-1), 'the declared domain uses its actual host producer');
  compareNativeMobileAbiReceipts(domain, receipts);
  const producerReceipt = receipts.find(
    ({ text, label }) => parseNativeMobileAbiReceipt(text, label).get('target') === producerTarget,
  );
  assert.equal(
    readFileSync(path.join(seed, 'abi.properties'), 'utf8'),
    producerReceipt.text,
    'domain admission must consume the original bootstrap ABI receipt',
  );
  validateNativeClusterSeedDirectory(seed, profile, { target: producerTarget, icuData });
  const pgdata = path.join(seed, 'files');
  const digest = logicalTreeSha256(filesystemTreeRows(pgdata));
  const emptyDirectories = emptyDirectoryPaths(pgdata);
  const values = parseProperties(
    readFileSync(path.join(seed, 'manifest.properties')),
    'native seed host manifest',
  );
  values.delete('target');
  values.delete('compatibilityKey');
  const unbound = Buffer.from(
    `${[...values].map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
  );
  writeFileSync(
    path.join(seed, 'manifest.properties'),
    bindNativeClusterSeedManifest(unbound, domain, profile),
  );
  // Preserve exact genuine receipts for inspection; these do not modify PostgreSQL files.
  const evidence = path.join(seed, 'abi-receipts');
  mkdirSync(evidence);
  for (const { text, label } of receipts) {
    const target = parseNativeMobileAbiReceipt(text, label).get('target');
    writeFileSync(path.join(evidence, `${target}.properties`), text);
  }
  validateNativeClusterSeedDirectory(seed, profile, { target: domain, icuData });
  assert.equal(logicalTreeSha256(filesystemTreeRows(pgdata)), digest);
  assert.deepEqual(emptyDirectoryPaths(pgdata), emptyDirectories);
}

if (import.meta.main) {
  const specification = readSpecification();
  const work = privateWork(path.resolve(specification.output));
  try {
    const seed = path.join(work, 'seed');
    await extractNativePayload(specification.seed, seed);
    let icuData: string | undefined;
    if (specification.icu) {
      const icu = path.join(work, 'icu');
      extractPortableArchiveTree(
        materializeArchive(specification.icu, path.join(work, 'inputs')),
        icu,
      );
      icuData = path.join(icu, 'share/icu');
    }
    bindSeedDomain({
      seed,
      producerTarget: specification.producerTarget,
      domain: specification.domain,
      profile: specification.profile,
      receipts: specification.receipts.map((file) => ({
        text: readFileSync(file, 'utf8'),
        label: file,
      })),
      icuData,
    });
    writeFileSync(specification.output, await createDeterministicTar(seed));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
