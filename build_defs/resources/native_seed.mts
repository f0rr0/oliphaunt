import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import {
  emptyDirectoryPaths,
  filesystemTreeRows,
  logicalTreeSha256,
  validateNativeClusterSeedDirectory,
} from '../../src/database-resources/contracts/native-manifest.mts';
import { installNativeClusterSeed } from '../../src/database-resources/seeds/native/tools/stage-native-cluster-seed.mts';
import {
  nativeMobileAbiReceipt,
  parseNativeMobileAbiReceipt,
} from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import { inspectPlatformBinaryBuffer } from '../../tools/packaging/platform-binary-contract.mts';
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
import {
  materializeArchive,
  materializeInputs,
  nativeSeedHost,
  privateWork,
  readSpecification,
  run,
  seedEnvironment,
} from './shared.mts';

const specification = readSpecification();
const host = nativeSeedHost(specification.runtimeArtifact);
assert.equal(specification.target, host.target);
const output = path.resolve(specification.output);
const work = privateWork(output);
try {
  const runtime = path.join(work, 'runtime');
  await extractNativePayload(specification.runtime, runtime);
  for (const binary of [
    `bin/postgres${host.executableSuffix}`,
    `bin/initdb${host.executableSuffix}`,
    host.libraryRelativePath,
  ]) {
    inspectPlatformBinaryBuffer(readFileSync(path.join(runtime, binary)), {
      target: specification.target,
      label: binary,
    });
  }
  const abiRoot = materializeInputs(specification.headers, path.join(work, 'headers'));
  const abi = nativeMobileAbiReceipt(abiRoot, specification.target);
  parseNativeMobileAbiReceipt(abi);
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
  const frozen = path.join(work, 'frozen');
  mkdirSync(prepared);
  const command = path.join(runtime, `bin/initdb${host.executableSuffix}`);
  const arguments_ = [
    '-D',
    path.join(prepared, 'files'),
    '-U',
    'postgres',
    '--auth=trust',
    '--locale-provider=libc',
    '--locale=C',
    '--encoding=UTF8',
    '-L',
    path.join(runtime, 'share/postgresql'),
    '-c',
    `shared_memory_type=${host.memoryType}`,
    '-c',
    `dynamic_shared_memory_type=${host.memoryType}`,
    '-c',
    'max_connections=100',
    '-c',
    'autovacuum_worker_slots=16',
    '-c',
    'shared_buffers=128MB',
  ];
  const environment = seedEnvironment(runtime, work, icuData);
  const intent = specification.constructionInputs
    ? captureSeedConstructionIntent(
        { family: 'native', target: specification.target, profile: specification.profile },
        {
          toolFlags: process.execArgv,
          producer: captureSeedProducerIdentity(runtime, specification.target),
          invocation: seedConstructionInvocation(command, arguments_, environment, {
            runtime,
            work,
            ...(icuData ? { icuData } : {}),
          }),
          contract: specification.contract,
          runtimeArtifact: specification.runtimeArtifact,
          abi,
          bindings: {
            runtime: seedConstructionFileBinding(
              specification.constructionInputs,
              specification.runtime,
            ),
            headers: Object.fromEntries(
              Object.entries(specification.headers).map(([role, file]) => [
                role,
                seedConstructionFileBinding(specification.constructionInputs, file as string),
              ]),
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
        { family: 'native', target: specification.target, profile: specification.profile },
        {
          contract: specification.contract,
          abi,
          invocation: seedConstructionInvocation(
            command,
            arguments_,
            {
              LANG: environment.LANG,
              LC_ALL: environment.LC_ALL,
              TZ: environment.TZ,
              PGTZ: environment.PGTZ,
              OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY:
                environment.OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY,
              OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY:
                environment.OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY,
              OLIPHAUNT_INTERNAL_ICU_READY: environment.OLIPHAUNT_INTERNAL_ICU_READY,
            },
            { runtime, work, ...(icuData ? { icuData } : {}) },
          ),
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
    copyFileSync(promoted.frozen, output);
    await extractNativePayload(output, frozen);
    validateNativeClusterSeedDirectory(frozen, specification.profile, {
      target: specification.target,
      icuData,
    });
    assert.equal(
      readFileSync(path.join(frozen, 'abi.properties'), 'utf8'),
      abi,
      'promoted seed must retain the current physical ABI contract',
    );
    writeFileSync(specification.abiOutput, abi);
    assert.ok(specification.constructionOutput, 'declared seed promotion requires receipt output');
    writePromotedSeedReceipt(
      specification.constructionOutput,
      promoted,
      output,
      path.join(frozen, 'files'),
    );
  } else {
    const completed = intent
      ? selectCompletedSeed(intent, specification.reuse, contentIntent)
      : undefined;
    if (completed) {
      extractPortableArchiveTree(
        materializeArchive(completed.archive, path.join(work, 'completed')),
        path.join(prepared, 'files'),
      );
    } else {
      // PostgreSQL intentionally uses clock/PID/CSPRNG; freeze this one construction intact.
      run(command, arguments_, environment, work);
    }
    const retained = completed
      ? {
          tree: logicalTreeSha256(filesystemTreeRows(path.join(prepared, 'files'))),
          emptyDirectories: emptyDirectoryPaths(path.join(prepared, 'files')),
        }
      : undefined;
    installNativeClusterSeed(
      prepared,
      {
        runtime,
        destination: frozen,
        target: specification.target,
        profile: specification.profile,
        icuData,
      },
      specification.contract,
    );
    writeFileSync(path.join(frozen, 'abi.properties'), abi);
    if (retained) {
      assert.equal(
        logicalTreeSha256(filesystemTreeRows(path.join(frozen, 'files'))),
        retained.tree,
        'seed reuse must preserve all PGDATA bytes',
      );
      assert.deepEqual(
        emptyDirectoryPaths(path.join(frozen, 'files')),
        retained.emptyDirectories,
        'seed reuse must preserve empty PGDATA directories',
      );
    }
    // A File archive preserves required empty directories across Bazel action transport.
    writeFileSync(output, await createDeterministicTar(frozen));
    writeFileSync(specification.abiOutput, abi);
    if (intent) {
      assert.ok(
        specification.constructionOutput,
        'declared seed intent requires its receipt output',
      );
      writeSeedConstructionReceipt(
        specification.constructionOutput,
        intent,
        output,
        path.join(frozen, 'files'),
        completed?.origin,
        contentIntent,
        completed?.sourceManifest,
      );
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
