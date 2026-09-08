import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bindingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(bindingRoot, '../../..');
const guestPatchPath = resolve(
  repositoryRoot,
  'src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0004-oliphaunt-wasix-add-host-lifecycle-exports.patch',
);
const rustConsumerPath = resolve(
  bindingRoot,
  'crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs',
);

test('WASIX Rust and PostgreSQL agree on the fallible pq_flush ABI', async () => {
  const [guestPatch, rustConsumer] = await Promise.all([
    readFile(guestPatchPath, 'utf8'),
    readFile(rustConsumerPath, 'utf8'),
  ]);

  const flushExport = guestPatch.match(
    /\+OLIPHAUNT_WASM_HOST_EXPORT\("oliphaunt_wasix_pq_flush"\) int\s*\+oliphaunt_wasix_pq_flush\(void\)\s*\+\{(?<body>[\s\S]*?)\n\+\}/u,
  );
  assert.ok(flushExport, 'the guest must export pq_flush with an i32 result');
  const flushBody = flushExport.groups.body.replace(/^\+/gmu, '');
  const postgresStatus = flushBody.match(
    /\bint\s+(?<name>[A-Za-z_]\w*)\s*=\s*pq_flush\(\)\s*;/u,
  );
  const bridgeStatus = flushBody.match(
    /\bint\s+(?<name>[A-Za-z_]\w*)\s*=\s*oliphaunt_wasix_output_status\(\)\s*;/u,
  );
  assert.ok(postgresStatus, 'the guest flush wrapper must retain pq_flush status');
  assert.ok(
    bridgeStatus,
    'the guest flush wrapper must read sticky buffered-output status',
  );
  assert.ok(
    flushBody.indexOf(postgresStatus[0]) < flushBody.indexOf(bridgeStatus[0]),
    'the sticky bridge status must be observed after PostgreSQL flushes',
  );
  const combinedReturn = new RegExp(
    `return\\s+${postgresStatus.groups.name}\\s*!=\\s*0\\s*\\?\\s*${postgresStatus.groups.name}\\s*:\\s*${bridgeStatus.groups.name}\\s*;`,
    'u',
  );
  assert.match(
    flushBody,
    combinedReturn,
    'the guest wrapper must prefer pq_flush failure and otherwise return sticky bridge failure',
  );
  assert.match(
    rustConsumer,
    /pq_flush: TypedFunction<\(\), i32>/u,
    'the Rust consumer must import the guest status result',
  );

  const directCalls = rustConsumer.match(/self\.protocol\.pq_flush\.call/g) ?? [];
  assert.equal(
    directCalls.length,
    1,
    'every flush must pass through the single checked helper',
  );
  assert.match(
    rustConsumer,
    /fn flush_protocol_output[\s\S]*?if status != 0 \{[\s\S]*?terminal_guest_failure[\s\S]*?\n    \}/u,
    'a nonzero flush result must poison the backend',
  );
  assert.match(
    rustConsumer,
    /if status != 0 \{[\s\S]*?flush_protocol_output\("after rejected startup"\)\?;[\s\S]*?take_output/u,
    'rejected startup output must not be returned before a successful flush',
  );
  assert.match(
    rustConsumer,
    /send_conn_data[\s\S]*?flush_protocol_output\("after accepted startup"\)\?;[\s\S]*?take_output/u,
    'accepted startup output must not be returned before a successful flush',
  );
  assert.match(
    rustConsumer,
    /fn finish_main_loop_output[\s\S]*?self\.flush_protocol_output\(phase\)/u,
    'main-loop completion must use the checked flush helper',
  );

  assert.match(
    rustConsumer,
    /use super::protocol_limits_generated::BUFFERED_PROTOCOL_OUTPUT_LIMIT_BYTES/u,
    'the Rust consumer must enforce the generated buffered-output contract limit',
  );
  assert.match(
    rustConsumer,
    /fn take_output[\s\S]*?checked_buffered_protocol_output_len\(guest_len\)[\s\S]*?try_reserve_exact\(len\)/u,
    'the Rust consumer must validate the guest length before fallible allocation',
  );
  const rawOutputReads = rustConsumer.match(/self\.io\.take_output/g) ?? [];
  assert.equal(
    rawOutputReads.length,
    1,
    'every buffered output read must pass through the terminal failure wrapper',
  );
  assert.match(
    rustConsumer,
    /fn take_buffered_protocol_output[\s\S]*?self\.io\.take_output[\s\S]*?Err\(error\)[\s\S]*?self\.poison_main_loop/u,
    'invalid or unallocatable buffered output must poison the backend without publication',
  );
});

test('WASIX Rust separates one-way output streaming from hybrid COPY pumping', async () => {
  const [postgresConsumer, backend, client] = await Promise.all([
    readFile(rustConsumerPath, 'utf8'),
    readFile(
      resolve(bindingRoot, 'crates/oliphaunt-wasix/src/oliphaunt/backend.rs'),
      'utf8',
    ),
    readFile(
      resolve(bindingRoot, 'crates/oliphaunt-wasix/src/oliphaunt/client.rs'),
      'utf8',
    ),
  ]);

  assert.match(
    postgresConsumer,
    /enum ProtocolTransportMode \{\s*Buffered = 0,\s*Stream = 1,\s*Hybrid = 2,\s*BufferedInputStreamedOutput = 3,\s*\}/u,
    'the Rust guest ABI must bind all four transport modes exactly',
  );
  assert.match(
    postgresConsumer,
    /Self::OutputStream => ProtocolTransportMode::BufferedInputStreamedOutput,\s*Self::Copy \| Self::Connection => ProtocolTransportMode::Hybrid,/u,
    'one-way output and COPY/full-duplex pumps must select distinct guest modes',
  );
  const outputStreamBranch = postgresConsumer.indexOf(
    'if scope == ProtocolPumpScope::OutputStream',
  );
  const copyActivationCheck = postgresConsumer.indexOf(
    'let active = self.protocol_stream_active()',
    outputStreamBranch,
  );
  const streamedReturn = postgresConsumer.indexOf(
    'return Ok(ProtocolPumpOutcome::Streamed);',
    outputStreamBranch,
  );
  assert.ok(
    outputStreamBranch >= 0 &&
      streamedReturn > outputStreamBranch &&
      copyActivationCheck > streamedReturn,
    'one-way mode 3 must finish as streamed before COPY activation is consulted',
  );
  assert.match(
    backend,
    /fn send_with_output_stream[\s\S]*?ProtocolPumpScope::OutputStream/u,
    'the backend must expose an explicit one-way output-stream intent',
  );
  assert.match(
    backend,
    /fn send_with_protocol_pump[\s\S]*?ProtocolPumpScope::Copy/u,
    'the existing COPY pump must retain hybrid transport intent',
  );

  const publicStream = client.slice(
    client.indexOf('fn exec_protocol_raw_stream_inner'),
    client.indexOf('fn ensure_protocol_stream_attached'),
  );
  assert.match(
    publicStream,
    /send_with_output_stream\(request\)/u,
    'public one-way exec_protocol_stream must not depend on COPY activation',
  );
  assert.match(
    client,
    /send_with_protocol_pump\(&message\)/u,
    'direct tool protocol traffic must retain the hybrid COPY pump',
  );
  assert.equal(
    client.match(/protocol_callback_chunks\(/gu)?.length,
    4,
    'both callback delivery paths and their boundary test must share one chunk helper',
  );
});
