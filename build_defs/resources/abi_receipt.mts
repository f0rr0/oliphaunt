import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeMobileAbiReceipt } from '../../src/native/runtime/tools/native-mobile-abi-contract.mts';
import { inspectPlatformBinaryBuffer } from '../../tools/packaging/platform-binary-contract.mts';
import { materializeInputs, privateWork, readSpecification } from './shared.mts';

const specification = readSpecification();
const work = privateWork(path.resolve(specification.output));
try {
  // The producing runtime and headers come from the same target configuration.
  inspectPlatformBinaryBuffer(readFileSync(specification.runtime), {
    target: specification.target,
    label: specification.runtime,
  });
  const headers = materializeInputs(specification.headers, path.join(work, 'headers'));
  writeFileSync(specification.output, nativeMobileAbiReceipt(headers, specification.target));
} finally {
  rmSync(work, { recursive: true, force: true });
}
