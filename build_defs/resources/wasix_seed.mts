import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import {
  captureSeedConstructionIntent,
  captureSeedContentIntent,
  captureSeedProducerIdentity,
  seedConstructionFileBinding,
  seedConstructionInvocation,
  selectCompletedSeed,
  selectQualifiedSeed,
  writePromotedSeedReceipt,
  writeSeedConstructionReceipt,
} from './seed_construction.mts';
import { materializeArchive, privateWork, readSpecification, run } from './shared.mts';
import { extractWasixRuntime } from './wasix_inputs.mts';

const specification = readSpecification();
assert.equal(specification.target, 'portable');
const work = privateWork(path.resolve(specification.output));
try {
  const runtime = extractWasixRuntime(specification.runtime, work);
  let icuData: string | undefined;
  if (specification.icu) {
    const icuRoot = path.join(work, 'icu');
    extractPortableArchiveTree(
      materializeArchive(specification.icu, path.join(work, 'inputs')),
      icuRoot,
    );
    icuData = path.join(icuRoot, 'share/icu');
    validateNativeIcuDataManifest(readFileSync(path.join(icuRoot, 'manifest.properties')), icuData);
  }
  assert.equal(specification.profile === 'icu', Boolean(icuData));
  const prepared = path.join(work, 'prepared');
  const command = path.resolve(specification.runner);
  const arguments_ = [runtime, prepared, specification.profile, ...(icuData ? [icuData] : [])];
  const environment = { LC_ALL: 'C', LANG: 'C', TZ: 'UTC', RAYON_NUM_THREADS: '2' };
  const intent = specification.constructionInputs
    ? captureSeedConstructionIntent(
        { family: 'wasix', target: 'portable', profile: specification.profile },
        {
          toolFlags: process.execArgv,
          producer: captureSeedProducerIdentity(runtime, specification.target),
          invocation: seedConstructionInvocation(command, arguments_, environment, {
            runtime,
            work,
            runner: command,
            ...(icuData ? { icuData } : {}),
          }),
          contract: specification.contract,
          bindings: {
            runtime: seedConstructionFileBinding(
              specification.constructionInputs,
              specification.runtime,
            ),
            runner: seedConstructionFileBinding(
              specification.constructionInputs,
              specification.runner,
            ),
            icu: specification.icu
              ? seedConstructionFileBinding(specification.constructionInputs, specification.icu)
              : null,
          },
        },
        specification.constructionInputs,
        specification.constructionTreeMembers,
      )
    : undefined;
  const contentIntent = intent
    ? captureSeedContentIntent(
        { family: 'wasix', target: 'portable', profile: specification.profile },
        {
          contract: specification.contract,
          invocation: seedConstructionInvocation(command, arguments_, environment, {
            runtime,
            work,
            runner: command,
            ...(icuData ? { icuData } : {}),
          }),
        },
        path.join(runtime, 'share/postgresql'),
        icuData,
      )
    : undefined;
  assert.ok(!specification.reuse || intent, 'seed reuse requires declared constructor inputs');
  assert.ok(
    !specification.promotion || intent,
    'seed promotion requires declared constructor inputs',
  );
  assert.ok(
    !(specification.reuse && specification.promotion),
    'seed has more than one physical origin',
  );
  const promoted = intent
    ? selectQualifiedSeed(intent, specification.promotion, contentIntent)
    : undefined;
  if (promoted) {
    copyFileSync(promoted.frozen, specification.output);
    const pgdata = path.join(prepared, 'pgdata');
    await extractNativePayload(specification.output, pgdata);
    assert.ok(specification.constructionOutput, 'declared seed promotion requires receipt output');
    writePromotedSeedReceipt(
      specification.constructionOutput,
      promoted,
      specification.output,
      pgdata,
    );
  } else {
    const completed = intent
      ? selectCompletedSeed(intent, specification.reuse, contentIntent)
      : undefined;
    if (completed) {
      extractPortableArchiveTree(
        materializeArchive(completed.archive, path.join(work, 'completed')),
        path.join(prepared, 'pgdata'),
      );
    } else {
      run(command, arguments_, environment, work);
    }
    // The genuine WASIX initdb constructor verifies both profile and reopen.
    // Freeze its unique PGDATA intact; do not normalize clock/PID/random fields.
    writeFileSync(
      specification.output,
      await createDeterministicTar(path.join(prepared, 'pgdata')),
    );
    if (intent) {
      assert.ok(
        specification.constructionOutput,
        'declared seed intent requires its receipt output',
      );
      writeSeedConstructionReceipt(
        specification.constructionOutput,
        intent,
        specification.output,
        path.join(prepared, 'pgdata'),
        completed?.origin,
        contentIntent,
        completed?.sourceManifest,
      );
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
