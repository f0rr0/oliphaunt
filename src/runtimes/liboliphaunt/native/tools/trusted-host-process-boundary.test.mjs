import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const patchPath = fileURLToPath(
  new URL(
    '../patches/postgresql-18.4/0022-liboliphaunt-preserve-host-process-boundaries.patch',
    import.meta.url,
  ),
);

const nativeInternalPath = fileURLToPath(
  new URL('../src/liboliphaunt_internal.h', import.meta.url),
);
const nativeProtocolPath = fileURLToPath(
  new URL('../src/liboliphaunt_protocol.c', import.meta.url),
);
const nativeRuntimePath = fileURLToPath(
  new URL('../src/liboliphaunt_native.c', import.meta.url),
);

function parsePatch(text) {
  const matches = Array.from(
    text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu),
  );
  assert.ok(matches.length > 0, '0022 must contain a unified diff');

  const sections = new Map();
  for (const [index, match] of matches.entries()) {
    assert.equal(match[1], match[2], `0022 unexpectedly renames ${match[1]}`);
    assert.ok(!sections.has(match[2]), `duplicate diff for ${match[2]}`);
    sections.set(
      match[2],
      text.slice(
        match.index,
        index + 1 < matches.length ? matches[index + 1].index : undefined,
      ),
    );
  }

  return {sections, text};
}

/* Read and parse the patch once for the entire test process. */
const fixturePromise = Promise.all([
  readFile(patchPath, 'utf8').then(parsePatch),
  readFile(nativeInternalPath, 'utf8'),
  readFile(nativeProtocolPath, 'utf8'),
  readFile(nativeRuntimePath, 'utf8'),
]).then(([patch, nativeInternal, nativeProtocol, nativeRuntime]) => ({
  patch,
  nativeInternal,
  nativeProtocol,
  nativeRuntime,
}));

function diffSection(patch, relativePath) {
  const section = patch.sections.get(relativePath);
  assert.ok(section, `missing diff for ${relativePath}`);
  return section;
}

function diffHunksContaining(section, fragment) {
  const starts = Array.from(section.matchAll(/^@@/gmu), match => match.index);
  return starts
    .map((start, index) =>
      section.slice(start, index + 1 < starts.length ? starts[index + 1] : undefined),
    )
    .filter(hunk => hunk.includes(fragment));
}

function diffHunkContaining(section, fragment) {
  const hunks = diffHunksContaining(section, fragment);
  assert.ok(hunks.length > 0, `missing diff hunk containing ${JSON.stringify(fragment)}`);
  return hunks[0];
}

function sourceFromDiff(section, prefixes) {
  return section
    .split('\n')
    .filter(line => {
      if (line.startsWith('+++') || line.startsWith('---'))
        return false;
      return prefixes.some(prefix => line.startsWith(prefix));
    })
    .map(line => line.slice(1))
    .join('\n');
}

function addedSource(section) {
  return sourceFromDiff(section, ['+']);
}

test('0022 keeps signal-mask types in their owning header on Windows', async () => {
  const {patch} = await fixturePromise;
  assert.doesNotMatch(
    addedSource(diffSection(patch, 'src/include/miscadmin.h')),
    /\bsigset_t\b/u,
  );
  assert.match(
    addedSource(diffSection(patch, 'src/include/libpq/pqsignal.h')),
    /extern int SetTrustedEmbeddedThreadSignalMask\(const sigset_t \*mask\);/u,
  );
});

test('0022 preserves in-process ICU import without spawning locale enumeration', async () => {
  const {patch} = await fixturePromise;
  const section = diffSection(patch, 'src/backend/commands/collationcmds.c');
  assert.match(section, /#ifdef READ_LOCALE_A_OUTPUT\n\+#ifdef OLIPHAUNT_EMBEDDED/u);
  assert.match(section, /!oliphaunt_skip_system_collation_discovery && IsTrustedEmbeddedProcess\(\)/u);
  assert.match(section, /ereport\(NOTICE,/u);
  assert.match(section, /oliphaunt_skip_system_collation_discovery = true;/u);
  assert.doesNotMatch(addedSource(section), /oliphaunt_skip_icu_collation_discovery/u);
});

function destinationSource(section) {
  return sourceFromDiff(section, [' ', '+']);
}

function region(source, start, ends = []) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing region start ${JSON.stringify(start)}`);
  const endIndexes = ends
    .map(end => source.indexOf(end, startIndex + start.length))
    .filter(index => index !== -1);
  const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : source.length;
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert.ok(
      next > cursor,
      `${label}: missing or unordered ${JSON.stringify(fragment)}`,
    );
    cursor = next;
  }
}

test('0022 makes PostgreSQL signal wrappers inert or fail closed in Direct mode', async () => {
  const {patch} = await fixturePromise;
  const pqsignalSection = diffSection(patch, 'src/port/pqsignal.c');
  const pqsignal = destinationSource(pqsignalSection);

  const install = destinationSource(
    diffHunkContaining(pqsignalSection, 'pqsignal(int signo, pqsigfunc func)'),
  );
  assertOrdered(install, [
    '#if defined(OLIPHAUNT_EMBEDDED) && !defined(FRONTEND)',
    'if (IsTrustedEmbeddedProcess())',
    'return;',
  ], 'embedded pqsignal no-op');
  assert.doesNotMatch(install, /#else\s+return;|#ifndef\s+OLIPHAUNT_EMBEDDED/u);

  const kill = region(
    pqsignal,
    'oliphaunt_embedded_kill(pid_t pid, int signo)',
    ['oliphaunt_embedded_raise(int signo)'],
  );
  assertOrdered(kill, [
    'if (IsTrustedEmbeddedProcess() && signo != 0)',
    'errno = EPERM;',
    'return -1;',
  ], 'nonzero kill rejection');

  const raise = region(
    pqsignal,
    'oliphaunt_embedded_raise(int signo)',
    ['/*\n * Except when called'],
  );
  assertOrdered(raise, [
    'if (IsTrustedEmbeddedProcess())',
    'errno = EPERM;',
    'return -1;',
  ], 'raise wrapper');
});

test('0022 uses one atomic cancel/timeout mailbox and a signal-free wake primitive', async () => {
  const {patch, nativeRuntime} = await fixturePromise;
  const sessionSection = diffSection(
    patch,
    'src/backend/utils/init/embedded_session.c',
  );
  const session = destinationSource(sessionSection);
  const sessionAdded = addedSource(sessionSection);
  const wait = destinationSource(
    diffSection(patch, 'src/backend/storage/ipc/waiteventset.c'),
  );
  const miscadmin = destinationSource(
    diffSection(patch, 'src/include/miscadmin.h'),
  );
  const waitHeader = destinationSource(
    diffSection(patch, 'src/include/storage/waiteventset.h'),
  );

  assert.match(
    session,
    /pg_atomic_uint32\s+TrustedEmbeddedInterruptRequests\s*=\s*\{0\};/u,
  );
  assert.doesNotMatch(
    session,
    /static\s+pg_atomic_uint32\s+TrustedEmbeddedInterruptRequests/u,
  );
  assert.match(
    miscadmin,
    /extern PGDLLIMPORT pg_atomic_uint32 TrustedEmbeddedInterruptRequests;/u,
  );
  assertOrdered(miscadmin, [
    '#define TRUSTED_EMBEDDED_INTERRUPT_CANCEL',
    '#define TRUSTED_EMBEDDED_INTERRUPT_TIMEOUT_RECHECK',
    'TrustedEmbeddedInterruptRequests;',
  ], 'combined mailbox declaration');

  const cancelRequest = region(
    session,
    'RequestTrustedEmbeddedQueryCancel(void)',
    ['RequestTrustedEmbeddedTimeoutCheck(void)'],
  );
  assertOrdered(cancelRequest, [
    'pg_atomic_fetch_or_u32(&TrustedEmbeddedInterruptRequests,',
    'TRUSTED_EMBEDDED_INTERRUPT_CANCEL',
  ], 'host-thread cancel producer');
  assert.doesNotMatch(
    cancelRequest,
    /pg_atomic_exchange_u32|QueryCancelPending|InterruptPending|SetLatch|MyLatch|WakeupTrustedEmbeddedBackend/u,
  );

  const timeoutRequest = region(
    session,
    'RequestTrustedEmbeddedTimeoutCheck(void)',
    ['TrustedEmbeddedInterruptPending(void)'],
  );
  assertOrdered(timeoutRequest, [
    'pg_atomic_fetch_or_u32(&TrustedEmbeddedInterruptRequests,',
    'TRUSTED_EMBEDDED_INTERRUPT_TIMEOUT_RECHECK',
  ], 'host-thread timeout producer');
  assert.doesNotMatch(
    timeoutRequest,
    /pg_atomic_exchange_u32|(?:QueryCancelPending|InterruptPending)\s*=|SetLatch|MyLatch|WakeupTrustedEmbeddedBackend/u,
  );

  const consume = region(
    session,
    'ProcessTrustedEmbeddedInterrupts(void)',
    ['IsTrustedEmbeddedSession(void)'],
  );
  assertOrdered(consume, [
    'pg_atomic_exchange_u32(',
    '&TrustedEmbeddedInterruptRequests, 0',
    'TRUSTED_EMBEDDED_INTERRUPT_CANCEL',
    'StatementCancelHandler(SIGINT);',
    'TRUSTED_EMBEDDED_INTERRUPT_TIMEOUT_RECHECK',
    'ProcessEmbeddedTimeouts();',
  ], 'backend-thread mailbox consumption');
  assert.equal(
    (sessionAdded.match(/pg_atomic_fetch_or_u32/gu) ?? []).length,
    2,
    'cancel and timeout must each be a coalescing fetch_or producer',
  );
  assert.equal(
    (sessionAdded.match(/pg_atomic_exchange_u32/gu) ?? []).length,
    1,
    'only the backend slow path may exchange and clear the mailbox',
  );
  assert.equal(
    (patch.text.match(/pg_atomic_exchange_u32/gu) ?? []).length,
    1,
    '0022 must not exchange the mailbox anywhere outside its backend consumer',
  );

  for (const declaration of [
    'RequestTrustedEmbeddedQueryCancel(void);',
    'RequestTrustedEmbeddedTimeoutCheck(void);',
    'ProcessTrustedEmbeddedInterrupts(void);',
  ])
    assert.match(miscadmin, new RegExp(declaration.replace(/[()]/gu, '\\$&'), 'u'));
  assertOrdered(waitHeader, [
    'PublishTrustedEmbeddedWakeup(struct OliphauntEmbeddedIO *io);',
    'UnpublishTrustedEmbeddedWakeup(struct OliphauntEmbeddedIO *io);',
    'ShutdownTrustedEmbeddedWakeup(void);',
  ], 'PostgreSQL-owned wake endpoint lifecycle');

  const waitAdded = addedSource(
    diffSection(patch, 'src/backend/storage/ipc/waiteventset.c'),
  );
  assertOrdered(waitAdded, [
    'InitializeTrustedEmbeddedWakeup(void)',
    'pipe(pipefd)',
    'trusted_embedded_wakeup_readfd = pipefd[0];',
    'trusted_embedded_wakeup_writefd = pipefd[1];',
    'PublishTrustedEmbeddedWakeup(OliphauntEmbeddedIO *io)',
    'io->set_interrupt_wakeup(io->context, kind, token)',
    'UnpublishTrustedEmbeddedWakeup(OliphauntEmbeddedIO *io)',
    'OLIPHAUNT_EMBEDDED_WAKE_NONE, 0',
    'ShutdownTrustedEmbeddedWakeup(void)',
  ], 'raw wake endpoint ownership and publication');
  assert.match(wait, /if \(!IsTrustedEmbeddedProcess\(\)\)[\s\S]*pqsignal\(SIGURG, latch_sigurg_handler\);/u);
  assert.doesNotMatch(patch.text, /WakeupTrustedEmbeddedBackend/u);
  assert.doesNotMatch(nativeRuntime, /WakeupTrustedEmbeddedBackend|MyLatch/u);
});

test('0022 keeps the CHECK hot hint backend-only, load-only, and conditional', async () => {
  const {patch} = await fixturePromise;
  const miscadmin = destinationSource(
    diffSection(patch, 'src/include/miscadmin.h'),
  );

  assert.match(
    miscadmin,
    /#if defined\(OLIPHAUNT_EMBEDDED\) && !defined\(FRONTEND\)\s+#include "port\/atomics\.h"\s+#endif/u,
  );
  const pendingPredicate = region(
    miscadmin,
    '#if defined(OLIPHAUNT_EMBEDDED) && !defined(FRONTEND)\n#define TRUSTED_EMBEDDED_INTERRUPT_CANCEL',
    ['#elif !defined(WIN32)'],
  );
  assertOrdered(pendingPredicate, [
    '#define TRUSTED_EMBEDDED_INTERRUPT_PENDING()',
    'pg_atomic_read_u32(',
    '&TrustedEmbeddedInterruptRequests',
    '#define INTERRUPTS_PENDING_CONDITION()',
    'unlikely(InterruptPending)',
    'TRUSTED_EMBEDDED_INTERRUPT_PENDING()',
  ], 'cheap common-path mailbox predicate');
  assert.doesNotMatch(
    pendingPredicate,
    /pg_atomic_read_membarrier_u32|ProcessTrustedEmbeddedInterrupts|pg_atomic_exchange_u32/u,
  );

  const embeddedCheck = region(
    miscadmin,
    '#if defined(OLIPHAUNT_EMBEDDED) && !defined(FRONTEND)\n#define CHECK_FOR_INTERRUPTS()',
    ['#else\n#define CHECK_FOR_INTERRUPTS()'],
  );
  assertOrdered(embeddedCheck, [
    'if (INTERRUPTS_PENDING_CONDITION())',
    '{',
    'ProcessTrustedEmbeddedInterrupts();',
    'if (unlikely(InterruptPending))',
    'ProcessInterrupts();',
  ], 'conditional interrupt slow path');
  assert.equal(
    (embeddedCheck.match(/ProcessTrustedEmbeddedInterrupts\(\);/gu) ?? []).length,
    1,
  );
  assert.ok(
    embeddedCheck.indexOf('if (INTERRUPTS_PENDING_CONDITION())') <
      embeddedCheck.indexOf('ProcessTrustedEmbeddedInterrupts();'),
    'CHECK_FOR_INTERRUPTS must predicate the mailbox exchange instead of calling it unconditionally',
  );
});

test('0022 preserves the embedding thread signal mask only for Direct', async () => {
  const {patch} = await fixturePromise;
  const miscinit = destinationSource(
    diffSection(patch, 'src/backend/utils/init/miscinit.c'),
  );
  const initializeMask = region(
    miscinit,
    'InitializeTrustedEmbeddedSignalMasks(void)',
    ['/* ----------------------------------------------------------------'],
  );
  assertOrdered(initializeMask, [
    'pthread_sigmask(SIG_SETMASK, NULL, &UnBlockSig);',
    'memcpy(&BlockSig, &UnBlockSig, sizeof(sigset_t));',
    'memcpy(&StartupBlockSig, &UnBlockSig, sizeof(sigset_t));',
  ], 'inherited Direct thread mask');

  assertOrdered(miscinit, [
    'if (IsTrustedEmbeddedProcess())',
    'InitializeTrustedEmbeddedSignalMasks();',
    'else',
    'pqinitmask();',
    'sigprocmask(SIG_SETMASK, &BlockSig, NULL);',
  ], 'runtime mask ownership split');
});

test('0022 interrupts incomplete COPY only at a validated frontend-frame boundary', async () => {
  const {patch, nativeProtocol} = await fixturePromise;
  const copy = destinationSource(
    diffSection(patch, 'src/backend/commands/copyfromparse.c'),
  );
  const pqcomm = destinationSource(
    diffSection(patch, 'src/backend/libpq/pqcomm.c'),
  );

  assertOrdered(pqcomm, [
    'pq_recvbuf_internal(bool allow_trusted_interrupt)',
    'allow_trusted_interrupt &&',
    'TrustedEmbeddedInterruptPending()',
    'return PQ_READ_INTERRUPTED;',
    'pq_recvbuf(void)',
    'return pq_recvbuf_internal(false);',
    'pq_getbyte_interruptible(void)',
    'pq_recvbuf_internal(true);',
  ], 'ordinary and interruptible receive contracts');
  assertOrdered(copy, [
    'if (IsTrustedEmbeddedProcess())',
    'mtype = pq_getbyte_interruptible();',
    'else',
    'mtype = pq_getbyte();',
    'if (mtype == PQ_READ_INTERRUPTED)',
    'pq_endmsgread();',
    'RESUME_CANCEL_INTERRUPTS();',
    'CHECK_FOR_INTERRUPTS();',
    'goto readmessage;',
  ], 'COPY message-boundary unwind');
  const execute = region(
    nativeProtocol,
    'oliphaunt_exec_protocol(',
    ['oliphaunt_exec_protocol_stream('],
  );
  assertOrdered(execute, [
    'validate_frontend_protocol_frames(handle, request, request_len)',
    'pthread_mutex_lock(&handle->mutex);',
    'oliphaunt_set_input_locked(handle, request, request_len)',
  ], 'native complete-frame validation before publication');
});

test('0022 replaces SIGALRM and ITIMER_REAL with cooperative deadlines', async () => {
  const {patch} = await fixturePromise;
  const timeout = destinationSource(
    diffSection(patch, 'src/backend/utils/misc/timeout.c'),
  );
  const timeoutHeader = destinationSource(
    diffSection(patch, 'src/include/utils/timeout.h'),
  );
  const wait = destinationSource(
    diffSection(patch, 'src/backend/storage/ipc/waiteventset.c'),
  );

  assert.match(timeoutHeader, /extern void\s+ProcessEmbeddedTimeouts\(void\);/u);
  assert.match(
    timeoutHeader,
    /extern long\s+GetEmbeddedTimeoutDelayMilliseconds\(void\);/u,
  );
  assert.match(timeout, /ProcessEmbeddedTimeouts\(void\)/u);
  assert.match(timeout, /GetEmbeddedTimeoutDelayMilliseconds\(void\)/u);
  assert.match(timeout, /TimestampDifferenceMilliseconds/u);
  assert.match(
    timeout,
    /if \(!IsTrustedEmbeddedProcess\(\)\)\s+#endif\s+pqsignal\(SIGALRM, handle_sig_alarm\);/u,
  );
  assert.match(timeout, /#endif\s+if \(num_active_timeouts > 0\)\s+\{\s+struct itimerval timeval;/u);
  const scheduleHunks = diffHunksContaining(
    diffSection(patch, 'src/backend/utils/misc/timeout.c'),
    'schedule_alarm(TimestampTz now)',
  );
  assert.ok(scheduleHunks.length >= 2, 'schedule_alarm guard must span its existing body');
  const embeddedSchedule = addedSource(scheduleHunks[0]);
  assertOrdered(embeddedSchedule, [
    '#ifdef OLIPHAUNT_EMBEDDED',
    'if (IsTrustedEmbeddedProcess())',
    'long\t\ttimeout_ms = -1;',
    'if (num_active_timeouts > 0)',
    'enable_alarm();',
    'if (signal_pending && nearest_timeout >= signal_due_at)',
    'return;',
    'timeout_ms = TimestampDifferenceMilliseconds(',
    'io->set_timeout(io->context, timeout_ms) != 0',
    'signal_due_at = nearest_timeout;',
    'signal_pending = true;',
    'else',
    'disable_alarm();',
    'if (signal_pending)',
    'return;',
    'io->set_timeout(io->context, -1) != 0',
    'return;',
    '#endif',
  ], 'lazy host-timeout publication');
  assert.match(
    timeout,
    /#endif\s+if \(num_active_timeouts > 0\)\s+\{\s+struct itimerval timeval;/u,
    'ordinary PostgreSQL setitimer scheduling remains after the Direct fast return',
  );

  assert.match(wait, /GetEmbeddedTimeoutDelayMilliseconds\(\)/u);
  const waitLoop = region(wait, 'embedded_timeout_selected = false;', []);
  assertOrdered(waitLoop, [
    'ProcessTrustedEmbeddedInterrupts();',
    'GetEmbeddedTimeoutDelayMilliseconds()',
    'embedded_timeout_selected = true;',
    'WaitEventSetWaitBlock(',
    'if (embedded_timeout_selected)',
    'ProcessEmbeddedTimeouts();',
    'continue;',
  ], 'deadline-aware wait loop');
  assert.doesNotMatch(
    waitLoop,
    /TRUSTED_EMBEDDED_INTERRUPT_PENDING\(\)/u,
  );
  assert.equal(
    (waitLoop.match(/ProcessTrustedEmbeddedInterrupts\(\);/gu) ?? []).length,
    1,
    'the wait loop must consume the mailbox exactly once at its blocking boundary',
  );
  assert.equal(
    (waitLoop.match(/ProcessEmbeddedTimeouts\(\);/gu) ?? []).length,
    1,
    'a selected bounded deadline must run the timeout processor directly',
  );
  const boundedDeadline = region(
    waitLoop,
    'if (embedded_timeout_selected)',
    ['continue;'],
  );
  assert.match(boundedDeadline, /ProcessEmbeddedTimeouts\(\);/u);
  assert.doesNotMatch(boundedDeadline, /ProcessTrustedEmbeddedInterrupts/u);
});

test('0022 routes Direct timeout callbacks through backend-thread handlers', async () => {
  const {patch} = await fixturePromise;
  const postinit = destinationSource(
    diffSection(patch, 'src/backend/utils/init/postinit.c'),
  );
  const added = addedSource(diffSection(patch, 'src/backend/utils/init/postinit.c'));

  const statement = region(
    postinit,
    'StatementTimeoutHandler(void)',
    ['LockTimeoutHandler(void)'],
  );
  assertOrdered(statement, [
    '#ifdef OLIPHAUNT_EMBEDDED',
    'if (IsTrustedEmbeddedProcess())',
    'ClientAuthInProgress',
    'die(SIGTERM);',
    'StatementCancelHandler(SIGINT);',
    'return;',
  ], 'statement timeout callback');

  const lock = region(postinit, 'LockTimeoutHandler(void)', ['IdleInTransactionSessionTimeoutHandler(void)']);
  assertOrdered(lock, [
    '#ifdef OLIPHAUNT_EMBEDDED',
    'if (IsTrustedEmbeddedProcess())',
    'StatementCancelHandler(SIGINT);',
    'return;',
  ], 'lock timeout callback');
  assert.doesNotMatch(added, /QueryCancelPending|InterruptPending|SetLatch|MyLatch|\bkill\s*\(/u);
});

test('0022 explicitly rejects backend signals and subprocess pipes', async () => {
  const {patch} = await fixturePromise;
  const signalSection = diffSection(
    patch,
    'src/backend/storage/ipc/signalfuncs.c',
  );
  const fdSection = diffSection(patch, 'src/backend/storage/file/fd.c');

  for (const [functionName, diagnostic] of [
    [
      'pg_cancel_backend(PG_FUNCTION_ARGS)',
      /backend cancellation by process ID is not supported in a trusted embedded session/u,
    ],
    [
      'pg_terminate_backend(PG_FUNCTION_ARGS)',
      /backend termination by process ID is not supported in a trusted embedded session/u,
    ],
  ]) {
    const functionSource = destinationSource(
      diffHunkContaining(signalSection, functionName),
    );
    assertOrdered(functionSource, [
      'IsTrustedEmbeddedSession()',
      'ERRCODE_FEATURE_NOT_SUPPORTED',
    ], functionName);
    const diagnosticMatch = functionSource.match(diagnostic);
    assert.ok(diagnosticMatch, `${functionName}: missing embedded diagnostic`);
    assert.ok(
      diagnosticMatch.index > functionSource.indexOf('ERRCODE_FEATURE_NOT_SUPPORTED'),
      `${functionName}: diagnostic must belong to the fail-closed gate`,
    );
  }

  const openPipe = destinationSource(
    diffHunkContaining(
      fdSection,
      'OpenPipeStream(const char *command, const char *mode)',
    ),
  );
  assertOrdered(openPipe, [
    '#ifdef OLIPHAUNT_EMBEDDED',
    'if (IsTrustedEmbeddedProcess())',
    'ERRCODE_FEATURE_NOT_SUPPORTED',
  ], 'OpenPipeStream gate');
  assert.match(
    openPipe,
    /external (?:programs|command execution) (?:are|is) not supported in a trusted embedded (?:backend|session)/u,
  );
  assert.doesNotMatch(openPipe, /#else\s+ereport/u);
});

test('0022 carries a versioned private IO contract and wakes only through its raw endpoint', async () => {
  const {patch, nativeInternal, nativeProtocol, nativeRuntime} = await fixturePromise;
  const libpqBe = destinationSource(
    diffSection(patch, 'src/include/libpq/libpq-be.h'),
  );
  const secure = destinationSource(
    diffSection(patch, 'src/backend/libpq/be-secure.c'),
  );
  const postgres = destinationSource(
    diffSection(patch, 'src/backend/tcop/postgres.c'),
  );

  const readSignature = /ssize_t\s+\(\*read\)\s*\(void \*context, void \*ptr, size_t len,\s*long timeout_ms\);/u;
  const setTimeoutSignature =
    /int\s+\(\*set_timeout\)\s*\(void \*context, long timeout_ms\);/u;
  const setWakeSignature =
    /int\s+\(\*set_interrupt_wakeup\)\s*\(void \*context, (?:uint32|uint32_t) kind,\s*(?:uintptr|uintptr_t) token\);/u;
  assert.match(libpqBe, /#define OLIPHAUNT_EMBEDDED_IO_ABI_VERSION 1U/u);
  assert.match(nativeInternal, /#define OLIPHAUNT_EMBEDDED_IO_ABI_VERSION 1U/u);
  assertOrdered(libpqBe, ['uint32\t\tabi_version;', 'uint32\t\tstruct_size;'], 'PostgreSQL IO ABI header');
  assertOrdered(nativeInternal, ['uint32_t abi_version;', 'uint32_t struct_size;'], 'native IO ABI header');
  assert.match(libpqBe, readSignature);
  assert.match(nativeInternal, readSignature);
  assert.match(libpqBe, setTimeoutSignature);
  assert.match(nativeInternal, setTimeoutSignature);
  assert.match(libpqBe, setWakeSignature);
  assert.match(nativeInternal, setWakeSignature);
  assertOrdered(postgres, [
    'io->abi_version != OLIPHAUNT_EMBEDDED_IO_ABI_VERSION',
    'io->struct_size < sizeof(*io)',
    'InitStandaloneProcess(argv[0]);',
    'PublishTrustedEmbeddedWakeup(io)',
    'lifecycle->wakeup_published = true;',
    'embedded_cleanup:',
    'UnpublishTrustedEmbeddedWakeup(lifecycle->io)',
    'lifecycle->wakeup_published = false;',
    'ShutdownTrustedEmbeddedWakeup();',
  ], 'validated IO and wake endpoint lifetime');
  assert.match(
    nativeInternal,
    /ssize_t\s+oliphaunt_embedded_read\(void \*context, void \*ptr, size_t len,\s*long timeout_ms\);/u,
  );
  assert.match(
    nativeInternal,
    /int\s+oliphaunt_embedded_set_timeout\(void \*context, long timeout_ms\);/u,
  );
  assertOrdered(secure, [
    'port->oliphaunt_io->read(',
    'GetEmbeddedTimeoutDelayMilliseconds()',
  ], 'secure_raw_read deadline');

  const hostRead = region(
    nativeProtocol,
    'oliphaunt_embedded_read(void *context, void *ptr, size_t len, long timeout_ms)',
    ['oliphaunt_embedded_write(void *context'],
  );
  assert.match(
    hostRead,
    /pthread_cond_timedwait\(\s*&handle->input_cond,\s*&handle->mutex,\s*&deadline\)/u,
  );
  assert.match(
    hostRead,
    /while \(handle->input_off >= handle->input_len &&\s*!handle->closing &&\s*!TrustedEmbeddedInterruptPending\(\)\)/u,
  );
  assertOrdered(hostRead, [
    'pthread_mutex_lock(&handle->mutex);',
    'if (TrustedEmbeddedInterruptPending())',
    'const bool has_timeout = timeout_ms >= 0;',
    'while (handle->input_off >= handle->input_len &&',
    'pthread_cond_timedwait(',
    'if (wait_rc == 0)',
    'continue;',
    'if (wait_rc == ETIMEDOUT)',
  ], 'protocol read predicate loop');
  assert.match(hostRead, /ETIMEDOUT/u);
  assertOrdered(hostRead, [
    'if (wait_rc == ETIMEDOUT)',
    'embedded_timeout_notified_generation',
    'embedded_timeout_generation',
    'RequestTrustedEmbeddedTimeoutCheck();',
  ], 'timed protocol-read notification');
  assert.match(hostRead, /errno = EINTR;/u);

  const timeoutProvider = region(
    nativeProtocol,
    'oliphaunt_embedded_set_timeout(void *context, long timeout_ms)',
    ['oliphaunt_embedded_read(void *context'],
  );
  assertOrdered(timeoutProvider, [
    'if (timeout_ms >= 0',
    'clock_gettime(CLOCK_REALTIME, &deadline)',
    'pthread_mutex_lock(&handle->mutex);',
    'handle->interrupt_wakeup_kind == OLIPHAUNT_EMBEDDED_WAKE_NONE',
    'handle->embedded_timeout_generation++;',
    'handle->embedded_timeout_armed = timeout_ms >= 0;',
    'handle->embedded_timeout_deadline = deadline;',
    'pthread_cond_broadcast(&handle->output_cond);',
    'pthread_mutex_unlock(&handle->mutex);',
    'return 0;',
  ], 'host timeout-provider publication');

  const timeoutNotification = region(
    nativeProtocol,
    'notify_embedded_timeout_locked(OliphauntHandle *handle)',
    ['notify_due_embedded_timeout_locked('],
  );
  assertOrdered(timeoutNotification, [
    'embedded_timeout_notified_generation == handle->embedded_timeout_generation',
    'embedded_timeout_notified_generation = handle->embedded_timeout_generation;',
    'RequestTrustedEmbeddedTimeoutCheck();',
    'oliphaunt_wake_backend_locked(handle)',
  ], 'one-shot timeout generation notification');

  assert.match(nativeRuntime, /extern void RequestTrustedEmbeddedQueryCancel\(void\);/u);
  assert.match(
    nativeProtocol,
    /extern void RequestTrustedEmbeddedTimeoutCheck\(void\);/u,
  );
  assert.match(
    nativeProtocol,
    /extern bool TrustedEmbeddedInterruptPending\(void\);/u,
  );
  assert.match(
    nativeRuntime,
    /handle->io\.set_timeout = oliphaunt_embedded_set_timeout;/u,
  );
  assertOrdered(nativeRuntime, [
    'handle->io.abi_version = OLIPHAUNT_EMBEDDED_IO_ABI_VERSION;',
    'handle->io.struct_size = (uint32_t)sizeof(handle->io);',
    'handle->io.set_timeout = oliphaunt_embedded_set_timeout;',
    'handle->io.set_interrupt_wakeup = oliphaunt_embedded_set_interrupt_wakeup;',
  ], 'native IO provider initialization');
  const cancel = region(nativeRuntime, 'oliphaunt_cancel_impl(OliphauntHandle *handle)', ['int32_t oliphaunt_cancel(']);
  assertOrdered(cancel, [
    'pthread_mutex_lock(&handle->mutex);',
    'RequestTrustedEmbeddedQueryCancel();',
    'oliphaunt_wake_backend_locked(handle);',
    'pthread_cond_broadcast(&handle->input_cond);',
    'pthread_cond_broadcast(&handle->output_cond);',
    'pthread_mutex_unlock(&handle->mutex);',
  ], 'public cancel mailbox and protocol wake');
  assert.doesNotMatch(cancel, /InterruptPending|QueryCancelPending|SetLatch|MyLatch|WakeupTrustedEmbeddedBackend/u);
});
