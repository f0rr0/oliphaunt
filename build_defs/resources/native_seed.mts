import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractNativePayload } from '../native/host-runtime-test-helpers.mts';
import { extractPortableArchiveTree } from '../../tools/packaging/portable-archive.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  nativeMobileAbiReceipt,
  parseNativeMobileAbiReceipt,
} from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { installNativeClusterSeed } from '../../src/database-resources/seeds/native/tools/stage-native-cluster-seed.mts';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
import {
  materializeInputs,
  materializeArchive,
  privateWork,
  readSpecification,
  run,
  seedEnvironment,
} from './shared.mts';

const specification = readSpecification();
assert.equal(
  specification.target,
  'linux-x64-gnu',
  'only the qualified Linux x64 producer is constructed here',
);
const output = path.resolve(specification.output);
const work = privateWork(output);
try {
  const runtime = path.join(work, 'runtime');
  await extractNativePayload(specification.runtime, runtime);
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
  // PostgreSQL intentionally uses clock/PID/CSPRNG; this concrete tree is frozen intact.
  run(
    path.join(runtime, 'bin/initdb'),
    [
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
      'shared_memory_type=mmap',
      '-c',
      'dynamic_shared_memory_type=mmap',
      '-c',
      'max_connections=100',
      '-c',
      'autovacuum_worker_slots=16',
      '-c',
      'shared_buffers=128MB',
    ],
    seedEnvironment(runtime, work, icuData),
    work,
  );
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
  // A File archive preserves required empty directories across Bazel action transport.
  writeFileSync(output, await createDeterministicTar(frozen));
  writeFileSync(specification.abiOutput, abi);
} finally {
  rmSync(work, { recursive: true, force: true });
}
