import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateNativeIcuDataManifest } from '../../src/database-resources/contracts/icu-data.mts';
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
  // PostgreSQL intentionally uses clock/PID/CSPRNG; this concrete tree is frozen intact.
  run(
    path.join(runtime, `bin/initdb${host.executableSuffix}`),
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
      `shared_memory_type=${host.memoryType}`,
      '-c',
      `dynamic_shared_memory_type=${host.memoryType}`,
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
