import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadHostBuildContract } from './build-provenance.mjs';

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, '../../../..');
const sharedContractPath = 'src/shared/postgres-tool-output-contract/contract.json';

function additions(patch) {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

test('direct WASIX tools implement the shared exact aggregate output bound', async () => {
  const [patch, buildScript, contractText, hostContract] = await Promise.all([
    readFile(resolve(hostDirectory, 'patches/0021-wasmer-js-stream-direct-pgwire.patch'), 'utf8'),
    readFile(resolve(hostDirectory, 'build-sdk.sh'), 'utf8'),
    readFile(resolve(repositoryRoot, sharedContractPath), 'utf8'),
    loadHostBuildContract(),
  ]);
  const contract = JSON.parse(contractText);
  const source = additions(patch);
  const captureStart = source.indexOf('enum CaptureStream');
  const captureEnd = source.indexOf('/// Run an Oliphaunt frontend tool');
  assert.ok(captureStart >= 0 && captureEnd > captureStart, 'capture implementation was not found');
  const capture = source.slice(captureStart, captureEnd);

  assert.equal(contract.schema, 'oliphaunt-postgres-tool-output-contract-v1');
  assert.equal(contract.capturedOutputLimitBytes, 67_108_864);
  assert.equal(contract.scope, 'stdout-and-stderr-aggregate-per-process');
  assert.equal(contract.belowLimit, 'preserve-exact-bytes');
  assert.equal(contract.overflow, 'fail-closed-without-returning-partial-output');
  assert.equal(contract.streamingEscapeHatch, 'required-for-larger-valid-output');
  assert.ok(hostContract.inputs.includes(sharedContractPath));
  assert.deepEqual(hostContract.provenance.toolOutputCapture, {
    schema: contract.schema,
    limitBytes: contract.capturedOutputLimitBytes,
    scope: contract.scope,
    belowLimit: contract.belowLimit,
    overflow: contract.overflow,
    streamingEscapeHatch: contract.streamingEscapeHatch,
  });

  assert.match(
    source,
    new RegExp(
      `const TOOL_OUTPUT_LIMIT_BYTES: usize = ${contract.capturedOutputLimitBytes};`,
      'u',
    ),
  );
  assert.match(
    capture,
    /struct CaptureState \{[\s\S]*stdout: Vec<u8>,[\s\S]*stderr: Vec<u8>,[\s\S]*total_bytes: usize,[\s\S]*failure: Option<CaptureFailure>/u,
  );
  assert.match(capture, /fn pair\(\) -> \(Self, Self, CaptureHandle\)/u);
  assert.match(capture, /stream: CaptureStream::Stdout/u);
  assert.match(capture, /stream: CaptureStream::Stderr/u);
  assert.match(capture, /self\.total_bytes\.checked_add\(input\.len\(\)\)/u);
  assert.match(capture, /if total_bytes > TOOL_OUTPUT_LIMIT_BYTES/u);
  assert.match(capture, /self\.failure\.get_or_insert\(failure\)/u);
  assert.match(capture, /LockPoisoned/u);
  assert.match(
    capture,
    /fn discard_output\(&mut self\) \{[\s\S]*self\.stdout\.clear\(\);[\s\S]*self\.stderr\.clear\(\);[\s\S]*self\.total_bytes = 0;/u,
  );
  assert.match(
    capture,
    /fn poison_lock\(&mut self\) -> CaptureFailure \{[\s\S]*self\.failure = Some\(CaptureFailure::LockPoisoned\);[\s\S]*self\.discard_output\(\);/u,
  );
  assert.match(capture, /\.try_reserve\(input\.len\(\)\)/u);
  assert.match(capture, /\.extend_from_slice\(input\)/u);
  assert.match(capture, /self\.total_bytes = total_bytes;/u);
  assert.match(capture, /Ok\(input\.len\(\)\)/u);

  const checkedAdd = capture.indexOf('checked_add(input.len())');
  const limitCheck = capture.indexOf('total_bytes > TOOL_OUTPUT_LIMIT_BYTES');
  const reserve = capture.indexOf('.try_reserve(input.len())');
  const append = capture.indexOf('.extend_from_slice(input)');
  const commit = capture.indexOf('self.total_bytes = total_bytes;');
  assert.ok(
    checkedAdd < limitCheck && limitCheck < reserve && reserve < append && append < commit,
    'a write must validate and reserve the whole input before committing exact bytes',
  );

  const finishStart = capture.indexOf('fn finish(&self)');
  const finish = capture.slice(finishStart);
  assert.match(
    finish,
    /if let Some\(failure\) = state\.failure \{[\s\S]*return Err\(anyhow::Error::new\(failure\)\);/u,
  );
  assert.ok(
    finish.indexOf('state.failure') < finish.indexOf('std::mem::take(&mut state.stdout)'),
    'sticky capture failure must be checked before either partial stream can be taken',
  );
  assert.match(
    capture,
    /fn set_len\(&mut self, _new_size: u64\) -> virtual_fs::Result<\(\)> \{\s*Err\(virtual_fs::FsError::PermissionDenied\)\s*\}/u,
  );
  assert.doesNotMatch(capture, /\.resize\(|\.expect\(|\.unwrap\(\)/u);
  assert.doesNotMatch(
    capture,
    /\.unwrap_or_else\(\|error\| error\.into_inner\(\)\)/u,
    'poisoned locks must become a capture failure, not silently recover',
  );
  assert.ok(
    (capture.match(/Err\(error\) => \{[\s\S]{0,180}error\.into_inner\(\);[\s\S]{0,180}poison_lock\(\)/gu) ?? [])
      .length >= 3,
    'every poisoned-lock access must record the sticky lock failure and discard output',
  );
  assert.match(
    finish,
    /Err\(error\) => \{[\s\S]*let failure = state\.poison_lock\(\);[\s\S]*return Err\(anyhow::Error::new\(failure\)\);/u,
  );

  const startCall = source.indexOf('match start.call(&mut store)');
  const finishCall = source.indexOf('capture.finish().map_err(Error::from)?');
  const publishCall = source.indexOf('Ok(tool_output(code, stdout, stderr))');
  assert.ok(
    startCall >= 0 && startCall < finishCall && finishCall < publishCall,
    'capture failure must be checked after every guest exit, including exit zero, before publication',
  );
  assert.match(
    buildScript,
    /--tool-output-limit-bytes[\s\S]*const TOOL_OUTPUT_LIMIT_BYTES: usize = \$tool_output_limit_bytes;/u,
  );
  assert.match(buildScript, /if total_bytes > TOOL_OUTPUT_LIMIT_BYTES \{/u);
  assert.match(
    buildScript,
    /tool output capture can resize arbitrarily, panic, or silently recover a poisoned lock/u,
  );
});
