import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  bindNativeClusterSeedManifest,
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  parseProperties,
  validateNativeClusterSeedDirectory,
} from '../../src/database-resources/contracts/native-manifest.mts';
import {
  compareNativeMobileAbiReceipts,
  NATIVE_MOBILE_ABI_TARGETS_BY_DOMAIN,
  parseNativeMobileAbiReceipt,
} from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { fileIdentity } from '../../tools/release/native-file-identity.mts';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import {
  captureSeedConstructionIntent,
  seedProducerIdentity,
  seedConstructionFileBinding,
  selectCompletedSeed,
  selectQualifiedSeed,
  validateSeedConstructionReceipt,
  writePromotedSeedReceipt,
  writeSeedConstructionReceipt,
} from './seed_construction.mts';
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

/** A domain owns its immutable seed, while every real target still supplies its ABI. */
export async function constructSeedDomain(specification) {
  const work = privateWork(path.resolve(specification.output));
  try {
    let icuData: string | undefined;
    if (specification.icu) {
      const icu = path.join(work, 'icu');
      extractPortableArchiveTree(
        materializeArchive(specification.icu, path.join(work, 'inputs')),
        icu,
      );
      icuData = path.join(icu, 'share/icu');
    }
    const receipts = specification.receipts.map((file) => ({
      text: readFileSync(file, 'utf8'),
      label: file,
    }));
    compareNativeMobileAbiReceipts(specification.domain, receipts);
    const producer = receipts.find(
      ({ text, label }) =>
        parseNativeMobileAbiReceipt(text, label).get('target') === specification.producerTarget,
    );
    assert.ok(producer, 'domain requires its actual host ABI receipt');
    const host = path.join(work, 'host');
    await extractNativePayload(specification.seed, host);
    validateNativeClusterSeedDirectory(host, specification.profile, {
      target: specification.producerTarget,
      icuData,
    });
    assert.equal(readFileSync(path.join(host, 'abi.properties'), 'utf8'), producer.text);
    let producerReceipt;
    if (specification.producerConstruction) {
      const receipt = validateSeedConstructionReceipt(
        JSON.parse(readFileSync(specification.producerConstruction, 'utf8')),
      );
      assert.equal(receipt.intent.family, 'native');
      assert.equal(receipt.intent.target, specification.producerTarget);
      assert.equal(receipt.intent.profile, specification.profile);
      const frozen = fileIdentity(realpathSync(specification.seed));
      assert.deepEqual(
        receipt.frozen,
        { size: frozen.size, sha256: frozen.sha256 },
        'domain host receipt must bind its genuine frozen TAR',
      );
      producerReceipt = receipt;
    }
    assert.ok(
      !specification.constructionInputs || producerReceipt,
      'domain intent requires its actual bound host constructor receipt',
    );
    const intent = specification.constructionInputs
      ? captureSeedConstructionIntent(
          { family: 'native', target: specification.domain, profile: specification.profile },
          {
            toolFlags: process.execArgv,
            producerTarget: specification.producerTarget,
            producer: seedProducerIdentity(producerReceipt),
            contract: specification.contract,
            bindings: {
              seed: seedConstructionFileBinding(
                specification.constructionInputs,
                specification.seed,
              ),
              receipts: Object.fromEntries(
                receipts.map(({ text, label }) => [
                  parseNativeMobileAbiReceipt(text, label).get('target'),
                  seedConstructionFileBinding(specification.constructionInputs, label),
                ]),
              ),
              icu: specification.icu
                ? seedConstructionFileBinding(specification.constructionInputs, specification.icu)
                : null,
            },
          },
          specification.constructionInputs,
        )
      : undefined;
    const producerContent =
      producerReceipt?.qualificationContentIntent ?? producerReceipt?.contentIntent;
    assert.ok(
      !intent || producerContent,
      'domain content must bind the actual producer content receipt',
    );
    const contentIntent = intent
      ? captureSeedConstructionIntent(
          { family: 'native', target: specification.domain, profile: specification.profile },
          { contract: specification.contract, producerContent, producerAbi: producer.text },
          {
            ...Object.fromEntries(
              receipts.map(({ text, label }) => [
                `abi/${parseNativeMobileAbiReceipt(text, label).get('target')}`,
                label,
              ]),
            ),
            ...(icuData ? { 'icu/data': icuData } : {}),
          },
        )
      : undefined;
    assert.ok(!specification.reuse || intent, 'domain reuse requires declared constructor inputs');
    assert.ok(
      !specification.promotion || intent,
      'domain promotion requires declared constructor inputs',
    );
    assert.ok(
      !(specification.reuse && specification.promotion),
      'domain has more than one physical origin',
    );
    const promoted = intent
      ? selectQualifiedSeed(intent, specification.promotion, contentIntent)
      : undefined;
    if (promoted) {
      const seed = path.join(work, 'promoted');
      copyFileSync(promoted.frozen, specification.output);
      await extractNativePayload(specification.output, seed);
      validateNativeClusterSeedDirectory(seed, specification.profile, {
        target: specification.domain,
        icuData,
      });
      assert.equal(readFileSync(path.join(seed, 'abi.properties'), 'utf8'), producer.text);
      for (const { text, label } of receipts) {
        const target = parseNativeMobileAbiReceipt(text, label).get('target');
        assert.equal(
          readFileSync(path.join(seed, 'abi-receipts', `${target}.properties`), 'utf8'),
          text,
        );
      }
      assert.ok(specification.constructionOutput, 'domain promotion requires its receipt output');
      writePromotedSeedReceipt(
        specification.constructionOutput,
        promoted,
        specification.output,
        path.join(seed, 'files'),
      );
    } else {
      const completed = intent
        ? selectCompletedSeed(intent, specification.reuse, contentIntent)
        : undefined;
      let seed = host;
      if (completed) {
        seed = path.join(work, 'completed');
        const pgdata = path.join(seed, 'files');
        extractPortableArchiveTree(
          materializeArchive(completed.archive, path.join(work, 'inputs')),
          pgdata,
        );
        // Reuse the current host envelope with the domain's exact public PGDATA.
        // The admission action never invokes initdb or rewrites PostgreSQL files.
        const manifest = parseProperties(
          readFileSync(path.join(host, 'manifest.properties')),
          'domain host manifest',
        );
        manifest.set('cacheKey', logicalTreeSha256(filesystemTreeRows(pgdata)));
        writeFileSync(
          path.join(seed, 'manifest.properties'),
          `${[...manifest].map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
        );
        writeFileSync(path.join(seed, 'abi.properties'), producer.text);
      }
      bindSeedDomain({
        seed,
        producerTarget: specification.producerTarget,
        domain: specification.domain,
        profile: specification.profile,
        receipts,
        icuData,
      });
      writeFileSync(specification.output, await createDeterministicTar(seed));
      if (intent) {
        assert.ok(specification.constructionOutput, 'domain intent requires its receipt output');
        writeSeedConstructionReceipt(
          specification.constructionOutput,
          intent,
          specification.output,
          path.join(seed, 'files'),
          completed?.origin,
          contentIntent,
          completed?.sourceManifest,
        );
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) await constructSeedDomain(readSpecification());
