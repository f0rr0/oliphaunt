import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hostDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(hostDirectory, '../../../..');

const readHostPatch = name =>
  readFile(resolve(hostDirectory, 'patches', name), 'utf8');

test('Wasmer JS direct host uses typed recovery behind a fail-closed guest phase', async () => {
  const [
    directPatch,
    memoryPatch,
    stderrPatch,
    streamingPatch,
    sessionPatch,
    phasePatch,
    guestBridge,
    protocolContractHeader,
    guestTransportPatch,
    guestLifecyclePatch,
  ] =
    await Promise.all([
    readHostPatch('0007-wasmer-js-run-oliphaunt-direct.patch'),
    readHostPatch('0017-wasmer-js-direct-pgwire-memory-bridge.patch'),
    readHostPatch('0018-wasmer-js-bound-direct-stderr.patch'),
    readHostPatch('0021-wasmer-js-stream-direct-pgwire.patch'),
    readHostPatch('0023-wasmer-js-prepare-trusted-embedded-session.patch'),
    readHostPatch('0025-wasmer-js-fail-closed-direct-guest-phases.patch'),
    readFile(
      resolve(
        repositoryRoot,
        'src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_bridge.c',
      ),
      'utf8',
    ),
    readFile(
      resolve(
        repositoryRoot,
        'src/runtimes/liboliphaunt/wasix/assets/build/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h',
      ),
      'utf8',
    ),
    readFile(
      resolve(
        repositoryRoot,
        'src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0034-oliphaunt-wasix-declare-hybrid-protocol-transport.patch',
      ),
      'utf8',
    ),
    readFile(
      resolve(
        repositoryRoot,
        'src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0004-oliphaunt-wasix-add-host-lifecycle-exports.patch',
      ),
      'utf8',
    ),
  ]);
  const postgresPatches = [
    directPatch,
    memoryPatch,
    stderrPatch,
    streamingPatch,
    sessionPatch,
    phasePatch,
  ].join('\n');
  const phaseAdditions = phasePatch
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');

  assert.match(directPatch, /\+enum MainLoopOutcome \{/u);
  assert.match(directPatch, /\+            0 => Some\(Self::Processed\),/u);
  assert.match(directPatch, /\+            1 => Some\(Self::Recovered\),/u);
  assert.match(directPatch, /\+            2 => Some\(Self::InputEnded\),/u);
  assert.match(directPatch, /\+    main_loop: TypedFunction<\(\), i32>,/u);
  assert.match(directPatch, /Err\(error\) => return Err\(self\.terminal_main_loop_error\(error\)\),/u);
  assert.match(directPatch, /PostgresMainLoopOnce returned invalid typed outcome \{status\}/u);
  assert.match(
    directPatch,
    /PostgresMainLoopOnce reported input end while dispatching buffered protocol input/u,
  );
  assert.match(
    directPatch,
    /Err\(error\) if runtime_exit_code\(&error\) == Some\(OLIPHAUNT_EXIT_ALIVE\) => \{\}/u,
  );
  assert.doesNotMatch(
    postgresPatches,
    /PostgresMainLongJmp|POSTGRES_MAIN_LONGJMP|force_host_error_recovery|recover_protocol_error|recover_non_trapping_protocol_error|output_contains_error/u,
  );

  assert.match(
    streamingPatch,
    /MainLoopOutcome::InputEnded if streaming => \{[\s\S]{0,120}\+                    break;/u,
  );

  assert.match(phasePatch, /\+enum DirectInstanceState \{/u);
  assert.match(phasePatch, /\+    StartupPhase,/u);
  assert.match(phasePatch, /\+    StartupRejected,/u);
  assert.match(phasePatch, /\+    GuestPhase,/u);
  assert.match(phasePatch, /\+    Poisoned,/u);
  assert.match(phasePatch, /\+    Closing,/u);
  assert.match(phasePatch, /\+    Closed,/u);
  assert.match(phasePatch, /\+    fn run_guest_phase<T>/u);
  assert.match(
    phasePatch,
    /\+        self\.state = DirectInstanceState::GuestPhase;[\s\S]*?\+                    self\.poison_guest_phase\(\);/u,
  );
  assert.match(
    phasePatch,
    /\+        let restore = if execution\.is_err\(\) \{[\s\S]*?do not re-enter/u,
  );
  assert.match(phasePatch, /\+            DirectInstanceState::Poisoned \| DirectInstanceState::Closed => return Ok\(\(\)\),/u);
  assert.match(phasePatch, /\+        self\.state = DirectInstanceState::Closing;/u);
  assert.match(phasePatch, /\+                self\.state = DirectInstanceState::Poisoned;/u);
  assert.match(phasePatch, /\+    fn ensure_protocol_started\(&self\)/u);
  assert.match(phasePatch, /\+            DirectInstanceState::StartupRejected =>/u);
  assert.match(phasePatch, /\+            status == PROCESS_STARTUP_OK \|\| status == PROCESS_STARTUP_ERROR/u);
  assert.match(phasePatch, /\+                previous == PROTOCOL_BUFFERED,/u);
  assert.match(phasePatch, /\+                        replaced == transport,/u);
  assert.match(
    phasePatch,
    /\+const PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT: i32 = 3;/u,
  );
  assert.match(
    phasePatch,
    /exec_protocol_stream_inner[\s\S]*?PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT,[\s\S]*?false,[\s\S]*?output\.length\(\) == 0/u,
  );
  assert.match(
    phasePatch,
    /exec_protocol_duplex_inner[\s\S]*?PROTOCOL_HYBRID,\s*true\)[\s\S]*?for start in \(0\.\.length\)\.step_by\(PROTOCOL_CHUNK_BYTES\)/u,
  );
  assert.match(
    phasePatch,
    /let restore = if execution\.is_err\(\)[\s\S]*?\.call\(&mut self\.store, previous\)[\s\S]*?replaced == transport/u,
  );
  assert.match(phasePatch, /\+        ensure!\(buffered >= 0, "negative buffered protocol input length"\);/u);
  assert.match(phasePatch, /\+            previous_active == 0,/u);
  assert.match(phasePatch, /\+                previous_active == expected_active,/u);
  assert.match(
    phasePatch,
    /\+            \}\)\?;\n         ensure!\(\n             self\.output_reset/u,
  );
  assert.match(phasePatch, /\+const OLIPHAUNT_EXIT_STARTUP_REJECTED: i32 = 98;/u);
  assert.match(phasePatch, /\+const STARTUP_OUTCOME_VERSION: u32 = 1;/u);
  assert.match(phasePatch, /\+const STARTUP_OUTCOME_DESCRIPTOR_BYTES: u32 = 32;/u);
  assert.match(phasePatch, /\+const STARTUP_OUTCOME_PENDING: u32 = 0;/u);
  assert.match(phasePatch, /\+const STARTUP_OUTCOME_REJECTED: u32 = 1;/u);
  assert.match(phasePatch, /\+    startup_outcome: TypedFunction<\(\), i32>,/u);
  assert.match(
    phasePatch,
    /typed_export\(&mut store, &instance, "oliphaunt_wasix_startup_outcome_v1"\)/u,
  );
  assert.match(
    phasePatch,
    /pending\.kind == STARTUP_OUTCOME_PENDING[\s\S]{0,180}pending\.data_pointer == 0 && pending\.data_length == 0/u,
  );
  assert.match(
    phasePatch,
    /version == STARTUP_OUTCOME_VERSION[\s\S]{0,220}size == STARTUP_OUTCOME_DESCRIPTOR_BYTES[\s\S]{0,180}reserved == 0/u,
  );
  assert.match(phasePatch, /data_pointer: read_u64_le\(&bytes, 16\)/u);
  assert.match(phasePatch, /data_length: read_u64_le\(&bytes, 24\)/u);
  assert.match(phasePatch, /descriptor_pointer != 0/u);
  assert.match(phasePatch, /descriptor_pointer as u32/u);
  assert.doesNotMatch(phaseAdditions, /descriptor_pointer > 0/u);
  assert.match(
    phasePatch,
    /\(1\.\.=1_048_576\)\.contains\(&descriptor\.data_length\) && descriptor\.data_pointer > 0/u,
  );
  assert.match(phasePatch, /validate_startup_rejection_protocol\(&protocol\)\?;/u);
  assert.match(phasePatch, /if tag == b'E' \{/u);
  assert.match(phasePatch, /found_sqlstate/u);
  assert.match(phasePatch, /Uint8Array::from\(protocol\.as_slice\(\)\)/u);

  const getterCall = phasePatch.indexOf('+        let startup_outcome_pointer = self');
  const startCall = phasePatch.indexOf('         match self.wasi_start.call(&mut self.store) {');
  assert.ok(getterCall >= 0 && startCall > getterCall, 'startup outcome getter must run before _start');
  const exit98Start = phasePatch.indexOf(
    '+            Err(error) if runtime_exit_code(&error) == Some(OLIPHAUNT_EXIT_STARTUP_REJECTED) => {',
  );
  const exit98End = phasePatch.indexOf('+            Ok(()) =>', exit98Start);
  assert.ok(exit98Start >= 0 && exit98End > exit98Start, 'Exit98 arm must be explicit');
  const exit98Arm = phasePatch.slice(exit98Start, exit98End);
  assert.match(exit98Arm, /read_startup_rejection\(startup_outcome_pointer\)/u);
  assert.doesNotMatch(exit98Arm, /\.call\(/u);
  assert.match(
    phasePatch,
    /^             Err\(error\) => return Err\(error\)\.context\("_start Oliphaunt single-user backend"\),$/mu,
  );
  assert.match(
    phasePatch,
    /\+            Err\(error\) if self\.state == DirectInstanceState::StartupPhase => \{[\s\S]{0,120}self\.poison_guest_phase\(\);/u,
  );
  assert.doesNotMatch(
    phaseAdditions,
    /legacy_captured_startup_error|captured_startup_error|startup_outcome_reset/u,
  );
  assert.doesNotMatch(
    phaseAdditions,
    /pq_flush\.call\(&mut self\.store\)\.ok|take_output_js\(\)\s*\.unwrap_or_else/u,
  );
  assert.doesNotMatch(phasePatch, /^\+.*poison_main_loop/mu);
  assert.doesNotMatch(phasePatch, /^\+.*pq_flush\.call\(&mut self\.store\)\.ok/mu);
  assert.match(phasePatch, /\+    pq_flush: TypedFunction<\(\), i32>,/u);
  assert.match(
    phasePatch,
    /let flush_status = self[\s\S]*?pq_flush[\s\S]*?flush_status == 0[\s\S]*?output: self\.take_output_js\(\)\?/u,
  );
  assert.match(
    phasePatch,
    /fn flush_after_main_loop[\s\S]*?let status = self[\s\S]*?pq_flush[\s\S]*?status == 0[\s\S]*?Ok\(\(\)\)/u,
  );
  assert.match(
    phasePatch,
    /protocol output flush returned \{status\} after a typed main-loop outcome; buffered protocol output has a \{PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES\}-byte limit/u,
  );
  assert.match(
    phasePatch,
    /\+const PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES: i32 = 64 \* 1024 \* 1024;/u,
  );
  const bufferedBoundary = phasePatch.slice(
    phasePatch.indexOf('     #[wasm_bindgen(js_name = execProtocolRaw)]'),
    phasePatch.indexOf('     #[wasm_bindgen(js_name = execProtocolStream)]'),
  );
  assert.equal(
    bufferedBoundary.match(/self\.buffered_protocol_error\(error\)/gu)?.length,
    2,
    'every exported buffered-exchange error path must add the public limit context',
  );
  assert.match(
    phasePatch,
    /fn buffered_protocol_error[\s\S]*?buffered protocol exchange contract: buffered protocol output has a \{PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES\}-byte limit[\s\S]*?self\.stderr\.attach\(error\)/u,
  );
  assert.doesNotMatch(
    phasePatch,
    /buffered protocol exchange (?:failed because|exceeded)|output limit caused/u,
  );
  const outputLimit = phasePatch.indexOf('+            len <= PROTOCOL_BUFFERED_OUTPUT_LIMIT_BYTES');
  const outputLength = phasePatch.lastIndexOf(
    '             .context("oliphaunt_wasix_output_len")?;',
    outputLimit,
  );
  const outputCopy = phasePatch.indexOf('         let output = oliphaunt_copy_from_guest');
  assert.ok(
    outputLength >= 0 && outputLimit > outputLength && outputCopy > outputLimit,
    'buffered output must be bounded before the guest-memory copy',
  );

  assert.match(phasePatch, /\+enum ProtocolStdoutFailure \{/u);
  assert.match(phasePatch, /\+    LockPoisoned,/u);
  assert.match(phasePatch, /\+struct ProtocolStdoutState \{/u);
  assert.match(
    phasePatch,
    /fn with_state<T>[\s\S]*?match self\.state\.lock\(\)[\s\S]*?Err\(poisoned\)[\s\S]*?poisoned\.into_inner\(\)[\s\S]*?Err\(state\.poison_lock\(\)\)/u,
  );
  assert.doesNotMatch(
    phaseAdditions,
    /protocol stdout lock poisoned|protocol callback failure must be recorded/u,
  );
  const callbackDelivery = phasePatch.indexOf('     fn deliver(&self, input: &[u8])');
  const callbackGuard = phasePatch.indexOf(
    '+        let failure = match self.with_state(|state| state.failure.clone())',
    callbackDelivery,
  );
  const callbackInvoke = phasePatch.indexOf(
    '             if let Err(error) = callback.call1(&JsValue::UNDEFINED, &chunk)',
    callbackGuard,
  );
  const stickyRecord = phasePatch.indexOf('state.record_callback_failure', callbackInvoke);
  assert.ok(
    callbackDelivery >= 0 &&
      callbackGuard > callbackDelivery &&
      callbackInvoke > callbackGuard &&
      stickyRecord > callbackInvoke,
    'callback failure must suppress retries and preserve the first callback error',
  );
  const callbackHelper = phasePatch.slice(
    phasePatch.indexOf('+    fn exec_protocol_callback_inner('),
    phasePatch.indexOf(
      '+    fn startup_inner(',
      phasePatch.indexOf('+    fn exec_protocol_callback_inner('),
    ),
  );
  assert.match(
    callbackHelper,
    /-        let output = execution\?;\n-        restore\?;\n         callback\?;\n\+        let output = execution\?;\n\+        restore\?;[\s\S]*?\+        Ok\(output\)/u,
    'the causal callback failure must take precedence over derived execution and restore errors',
  );

  assert.match(
    protocolContractHeader,
    /#define OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT 67108864U/u,
  );
  assert.match(
    guestBridge,
    /#include "oliphaunt_wasix_protocol_contract\.generated\.h"/u,
  );
  assert.match(guestBridge, /OLIPHAUNT_WASIX_BUFFERED_PROTOCOL_OUTPUT_LIMIT/u);
  assert.match(
    protocolContractHeader,
    /#define OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT 3/u,
  );
  assert.match(
    guestTransportPatch,
    /\+ \* These declarations consume the generated mode numbers included above\./u,
  );
  assert.doesNotMatch(
    guestTransportPatch,
    /^\+\s*#define OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT/mu,
  );
  assert.match(
    guestLifecyclePatch,
    /\+OLIPHAUNT_WASM_HOST_EXPORT\("oliphaunt_wasix_pq_flush"\) int\s*\+oliphaunt_wasix_pq_flush\(void\)[\s\S]*?\+\s*int\s+status = pq_flush\(\);[\s\S]*?\+\s*int\s+bridge_status = oliphaunt_wasix_output_status\(\);[\s\S]*?\+\s*return status != 0 \? status : bridge_status;/u,
  );
  assert.match(
    guestLifecyclePatch,
    /\+extern int oliphaunt_wasix_output_status\(void\);/u,
  );
  assert.match(
    guestBridge,
    /static int oliphaunt_wasix_output_failure_status;/u,
  );
  assert.match(
    guestBridge,
    /oliphaunt_wasix_record_output_failure\(int status\)[\s\S]*?status <= 0[\s\S]*?status = EIO;[\s\S]*?oliphaunt_wasix_output_failure_status == 0[\s\S]*?oliphaunt_wasix_output_failure_status = status;[\s\S]*?errno = oliphaunt_wasix_output_failure_status;/u,
  );
  assert.match(
    guestBridge,
    /oliphaunt_wasix_output_status\(void\)[\s\S]*?return oliphaunt_wasix_output_failure_status;/u,
  );
  assert.equal(
    guestBridge.match(/oliphaunt_wasix_output_failure_status = 0;/gu)?.length,
    1,
    'only output_reset may clear the sticky buffered-output failure',
  );
  assert.match(
    guestBridge,
    /oliphaunt_wasix_output_reset\(void\)[\s\S]*?oliphaunt_wasix_output_failure_status = 0;/u,
  );
  assert.match(
    guestBridge,
    /oliphaunt_wasix_buffer_write\(const void \*buffer, size_t length\)[\s\S]*?oliphaunt_wasix_output_failure_status != 0[\s\S]*?oliphaunt_wasix_record_output_failure\([\s\S]*?oliphaunt_wasix_output_failure_status\)/u,
  );
  assert.match(
    guestBridge,
    /OLIPHAUNT_WASIX_PROTOCOL_BUFFERED_INPUT_STREAMED_OUTPUT\)[\s\S]{0,160}return oliphaunt_wasix_stream_write\(STDOUT_FILENO, buf, n\);/u,
  );
});

test('Rust WASIX binding mirrors the typed terminal-state contract', async () => {
  const source = await readFile(
    resolve(
      repositoryRoot,
      'src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs',
    ),
    'utf8',
  );

  assert.doesNotMatch(
    source,
    /PostgresMainLongJmp|POSTGRES_MAIN_LONGJMP|force_host_error_recovery|recover_protocol_error|recover_non_trapping_protocol_error|is_wasm_uncaught_exception|contains\("uncaught exception"\)/u,
  );
  assert.match(source, /main_loop: TypedFunction<\(\), i32>/u);
  assert.match(source, /0 => Some\(Self::Processed\),/u);
  assert.match(source, /1 => Some\(Self::Recovered\),/u);
  assert.match(source, /2 => Some\(Self::InputEnded\),/u);
  assert.match(
    source,
    /MainLoopOutcome::InputEnded => \{[\s\S]{0,180}terminal_main_loop_outcome/u,
  );
  assert.match(source, /MainLoopOutcome::InputEnded => break,/u);
  assert.match(source, /PostgresMainLoopOnce returned invalid typed outcome \{status\}/u);
  assert.match(source, /PostgresMainLoopOnce trapped instead of returning a typed outcome/u);
  assert.match(
    source,
    /Ok\(\(\)\) => \{[\s\S]{0,300}_start returned without an Oliphaunt lifecycle exit[\s\S]{0,300}poison_main_loop[\s\S]{0,180}return Err/u,
  );
  assert.match(source, /STARTUP_OUTCOME_MAX_PROTOCOL_BYTES: u64 = 1024 \* 1024/u);
  assert.match(source, /try_reserve_exact\(protocol_len\)/u);
  assert.match(source, /error_response_has_valid_sqlstate/u);
  assert.match(source, /fn terminal_post_step_export_error/u);
  assert.match(source, /terminal_failure: Option<String>/u);
  assert.match(source, /if self\.terminal_failure\.is_some\(\) \{/u);
  assert.match(source, /Err\(err\) => return Err\(self\.terminal_main_loop_error\(err\)\),/u);
});
