import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { windowsVcRuntimeProfileNames } from '../../tools/packaging/windows-vc-runtime-closure.mts';
import {
  assertMissingHostRuntime,
  extractNativePayload,
  hostRuntimeEnvironment,
  runHostBinary,
} from './host-runtime-test-helpers.mts';

assert.equal(process.platform, 'win32', 'installed Windows ABI proof requires Windows execution');
const [payloadArgument, binaryArgument, ...crtArguments] = process.argv.slice(2);
const payload = payloadArgument && resolve(payloadArgument);
const sourceBinary = binaryArgument && resolve(binaryArgument);
// Bazel's $(locations) supplies one space-separated list of normalized runfile
// paths; this repository exports the CRT files under simple crt/<name> labels.
const crtSources = crtArguments
  .flatMap((argument) => argument.split(/\s+/u))
  .map((file) => resolve(file));
assert(payload && sourceBinary, 'expected runtime payload, ABI executable and declared CRT files');
assert.deepEqual(
  crtSources.map((file) => basename(file).toLowerCase()).sort(),
  windowsVcRuntimeProfileNames('provider'),
  'ABI consumer requires the exact selected provider CRT closure',
);
const root = mkdtempSync(join(process.env.TEST_TMPDIR ?? tmpdir(), 'windows-abi-'));
try {
  const runtime = join(root, 'runtime');
  const consumer = join(root, 'consumer');
  const bin = join(consumer, 'bin');
  await extractNativePayload(payload, runtime);
  mkdirSync(bin, { recursive: true });
  const binary = join(bin, 'abi_conformance.exe');
  copyFileSync(sourceBinary, binary);
  for (const name of readdirSync(join(runtime, 'bin')).filter((name) =>
    name.toLowerCase().endsWith('.dll'),
  ))
    copyFileSync(join(runtime, 'bin', name), join(bin, name));
  for (const source of crtSources)
    assert(
      readFileSync(join(bin, basename(source))).equals(readFileSync(source)),
      `installed ${basename(source)} differs from the selected compiler CRT`,
    );
  const env = hostRuntimeEnvironment(consumer, root);
  runHostBinary(binary, [], env, consumer);
  const library = join(bin, 'oliphaunt.dll');
  renameSync(library, library + '.disabled');
  const missing = Bun.spawnSync([binary], { env, cwd: consumer, stdout: 'pipe', stderr: 'pipe' });
  assertMissingHostRuntime(missing, 'oliphaunt.dll');
  console.log('Installed Windows C ABI with declared runtime, ICU and exact CRT DLLs: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
