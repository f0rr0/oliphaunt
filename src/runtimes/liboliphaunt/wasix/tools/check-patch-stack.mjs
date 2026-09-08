#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const mode = process.argv[2] ?? '--check';
const outputPath = path.join(root, 'docs/internal/WASIX_PATCH_STACK.md');
const postgresSourceManifestPath = path.join(root, 'src/postgres/versions/18/source.toml');
const patchSeriesManifestPath = path.join(
  root,
  'src/runtimes/liboliphaunt/wasix/assets/build/postgres/source.toml',
);
const patchDir = path.join(root, 'src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches');
const dispositionPath = path.join(
  root,
  'src/runtimes/liboliphaunt/wasix/assets/build/postgres/experiment-patch-disposition.toml',
);

const EXPECTED_AUTHOR = 'Oliphaunt Maintainers <dev@oliphaunt.dev>';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const EXPECTED_TOUCHPOINTS = new Map([
  ['src/test/regress/sql/jsonb.sql', 'Covers fixed, VARIADIC, Param, null, error, and mutable user-cast JSONB constructor semantics.'],
  ['src/test/regress/expected/jsonb.out', 'Records fixed, VARIADIC, Param, null, error, and mutable user-cast JSONB constructor semantics.'],
  ['src/backend/utils/adt/jsonb.c', 'Caches immutable jsonb_build_object expression metadata while preserving PostgreSQL cast and VARIADIC semantics.'],
  ['src/Makefile.shlib', 'Defines the WASIX dynamic-link shared-library shape.'],
  ['src/backend/Makefile', 'Builds the dynamic-main backend module without changing other ports.'],
  ['src/backend/access/transam/multixact.c', 'Retains normal-session MultiXact wraparound stops without signaling an absent postmaster.'],
  ['src/backend/access/transam/varsup.c', 'Retains normal-session XID stops and OID allocation semantics.'],
  ['src/backend/access/transam/xlog.c', 'Defers XLog-size checkpoint requests to an embedded idle boundary.'],
  ['src/backend/access/transam/xlogfuncs.c', 'Rejects standby promotion before signaling an absent postmaster.'],
  ['src/backend/commands/event_trigger.c', 'Runs DDL and login event triggers for an explicitly initialized normal user session.'],
  ['src/backend/commands/copyfromparse.c', 'Reports COPY protocol state to the host.'],
  ['src/backend/commands/copyto.c', 'Reports COPY protocol state to the host.'],
  ['src/backend/commands/collationcmds.c', 'Controls deterministic collation discovery for the existing seed producer.'],
  ['src/backend/commands/tsearchcmds.c', 'Validates text-search dictionary options outside bootstrap and recovery modes.'],
  ['src/backend/libpq/be-secure.c', 'Routes embedded protocol reads and writes through host-owned callbacks.'],
  ['src/backend/libpq/pqcomm.c', 'Skips unavailable postmaster-death wait handles in embedded WASIX.'],
  ['src/backend/main/main.c', 'Exposes the one-way pre-start embedded-session selection.'],
  ['src/backend/optimizer/plan/createplan.c', 'Prevents async Append execution in the host-pumped session.'],
  ['src/backend/postmaster/fork_process.c', 'Declares the WASIX fork boundary without enabling postmaster concurrency.'],
  ['src/backend/replication/walsender.c', 'Suppresses activity identifier reporting in embedded WASIX.'],
  ['src/backend/storage/file/fd.c', 'Keeps real fsync while narrowing unsupported WASIX directory and writeback-hint behavior.'],
  ['src/backend/storage/ipc/signalfuncs.c', 'Rejects unsupported postmaster signals and reports unavailable log rotation truthfully.'],
  ['src/backend/tcop/backend_startup.c', 'Exports the startup packet parser for host-driven startup.'],
  ['src/backend/tcop/postgres.c', 'Owns embedded lifecycle, protocol loop, error recovery, and the prepared-session attach check.'],
  ['src/backend/utils/init/miscinit.c', 'Routes OS identity through the port and enforces catalog login and role connection limits for trusted sessions.'],
  ['src/backend/utils/init/postinit.c', 'Initializes the host-selected catalog principal, database admission and role defaults without pretending HBA authentication ran; checks startup options against actual privileges.'],
  ['src/backend/utils/misc/guc_tables.c', 'Keeps attached parallel-worker limits observably pinned to zero.'],
  ['src/backend/utils/misc/superuser.c', 'Uses catalog-backed superuser semantics in the attached user session.'],
  ['src/bin/initdb/initdb.c', 'Keeps the existing standard/ICU initdb discovery contract.'],
  ['src/bin/pg_dump/connectdb.c', 'Avoids pg_dump LTO symbol collisions.'],
  ['src/bin/pg_dump/connectdb.h', 'Avoids pg_dump LTO symbol collisions.'],
  ['src/bin/pg_dump/parallel.c', 'Stubs unavailable pg_dump parallel fork behavior under WASIX.'],
  ['src/bin/pg_dump/pg_dumpall.c', 'Avoids pg_dump LTO symbol collisions.'],
  ['src/common/file_utils.c', 'Keeps real fsync while narrowing unsupported WASIX directory and writeback-hint behavior.'],
  ['src/port/pg_strong_random.c', 'Uses checked direct WASI entropy reads without guest-side buffered state.'],
  ['src/include/libpq/libpq-be.h', 'Adds the host I/O callback table to Port only for embedded WASIX.'],
  ['src/include/miscadmin.h', 'Defines a positive normal-user-session capability without falsifying process topology.'],
  ['src/include/access/xlog.h', 'Exposes the embedded idle-boundary checkpoint handoff within PostgreSQL.'],
  ['src/include/port/wasix-dl.h', 'Defines the embedded WASIX port header, ABI redirects, and call-site SJLJ contract.'],
  ['src/include/port/wasix-dl/sys/ipc.h', 'Provides the WASIX SysV IPC shim surface.'],
  ['src/include/port/wasix-dl/sys/shm.h', 'Provides the WASIX SysV shared-memory shim surface.'],
  ['src/bin/psql/startup.c', 'Keeps captured Oliphaunt psql invocations noninteractive despite WASIX virtual descriptor types.'],
  ['src/interfaces/libpq/fe-connect.c', 'Makes libpq socket nonblocking state explicit where WASIX socket creation ignores type flags.'],
  ['src/makefiles/Makefile.wasix-dl', 'Builds side modules and PGXS artifacts for WASIX dynamic linking.'],
  ['src/makefiles/pgxs.mk', 'Installs PGXS extension artifacts for WASIX packaging.'],
  ['src/template/wasix-dl', 'Keeps the WASIX template and atomics invariants source-controlled.'],
]);

const REQUIRED_AUDIT_CHECKS = [
  {
    requirement: 'Prepared host identity is initialized before normal-session admission',
    patches: ['0044-oliphaunt-wasix-initialize-trusted-session-identity.patch'],
    evidence: [
      'INIT_PG_TRUSTED_CLIENT',
      'InitializeSessionUserId(username, useroid, false)',
      'MyBackendType = B_BACKEND',
      'MyProcPort->user_name = MemoryContextStrdup',
      'IsNormalUserSession()',
      'EventTriggerOnLogin();',
    ],
    posture: 'Consume the prepared capability in InitPostgres, not after bootstrap-superuser initialization. Enforce catalog login/database policy, role defaults and login triggers without pretending HBA authentication occurred; unprepared recovery remains standalone.',
  },
  {
    requirement: 'Fixed JSONB constructor metadata preserves PostgreSQL semantics',
    patches: ['0043-oliphaunt-wasix-cache-jsonb-build-object-metadata.patch'],
    evidence: [
      'JsonbBuildObjectState',
      'get_fn_expr_variadic',
      'FirstNormalObjectId',
      'jsonb_build_object_cache_drop_cast',
    ],
    posture: 'Ordinary calls reuse immutable expression metadata; explicit VARIADIC arrays keep the generic path and user-defined types are recategorized so cast DDL remains visible.',
  },

  {
    requirement: 'WASIX WAL durability exposes only explicit sync operations',
    patches: ['0042-oliphaunt-wasix-use-explicit-wal-sync-operations.patch'],
    evidence: [
      'PLATFORM_DEFAULT_WAL_SYNC_METHOD',
      'WAL_SYNC_METHOD_FDATASYNC',
      'OLIPHAUNT_WASM_EXPLICIT_WAL_SYNC_ONLY',
      'explicit fd_datasync operation',
    ],
    posture: 'The shared PostgreSQL port selects fdatasync and removes open_sync/open_datasync from the WASIX GUC choices because Wasmer does not honor their open flags.',
  },

  {
    requirement: 'WASIX dynamic-main build spine is isolated',
    patches: ['0001-oliphaunt-wasix-add-wasix-dl-build-spine.patch'],
    evidence: ['PORTNAME), wasix-dl', 'oliphaunt: $(OBJS)'],
    posture: 'Build plumbing lands before lifecycle behavior, so linker changes are reviewable alone.',
  },
  {
    requirement: 'Backend protocol I/O is host-owned without touching normal sockets',
    patches: ['0002-oliphaunt-wasix-add-backend-host-io-hooks.patch'],
    evidence: ['OliphauntWasmHostIO', 'secure_raw_read', 'secure_raw_write'],
    posture: 'Only OLIPHAUNT_WASM_SINGLE_USER installs the callback table.',
  },
  {
    requirement: 'Startup packet parsing remains PostgreSQL-owned',
    patches: ['0003-oliphaunt-wasix-export-startup-packet-parser.patch'],
    evidence: ['ProcessStartupPacket', 'OLIPHAUNT_WASM_HOST_EXPORT("ProcessStartupPacket")'],
    posture: 'The host can call the parser, but PostgreSQL still validates the startup packet.',
  },
  {
    requirement: 'Host lifecycle exports stay explicit',
    patches: ['0004-oliphaunt-wasix-add-host-lifecycle-exports.patch'],
    evidence: ['oliphaunt_wasix_start', 'oliphaunt_wasix_pq_flush', 'oliphaunt_wasix_get_proc_port'],
    posture: 'Host-visible entry points are named exports instead of broad syscall remaps.',
  },
  {
    requirement: 'Protocol loop recovery remains inside a live PostgreSQL boundary',
    patches: [
      '0005-oliphaunt-wasix-add-loop-pumped-protocol-exports.patch',
      '0019-oliphaunt-wasix-schedule-ready-after-loop-step-recovery.patch',
    ],
    evidence: [
      'PostgresMainLoopOnce',
      'OLIPHAUNT_WASM_MAIN_LOOP_RECOVERED',
      'OLIPHAUNT_WASM_MAIN_LOOP_INPUT_ENDED',
      'PG_exception_stack = NULL',
      'send_ready_for_query = true',
    ],
    posture: 'Each host-pumped step owns a live call-site exception boundary, returns a typed outcome, and clears the boundary before returning.',
  },
  {
    requirement: 'COPY protocol state is host-observable',
    patches: [
      '0006-oliphaunt-wasix-report-copy-protocol-state.patch',
      '0008-oliphaunt-wasix-reset-copy-state-on-error-recovery.patch',
    ],
    evidence: ['oliphaunt_wasix_protocol_report_copy_response', 'OLIPHAUNT_WASIX_PROTOCOL_COPY_NONE'],
    posture: 'COPY state is reported and cleared around PostgreSQL error recovery.',
  },
  {
    requirement: 'PGXS side modules and backend ThinLTO use the WASIX dynamic-link contract',
    patches: [
      '0007-oliphaunt-wasix-add-wasix-pgxs-side-module-support.patch',
      '0022-oliphaunt-wasix-use-wasm-ld-for-backend-core.patch',
    ],
    evidence: [
      'PGXS',
      'WASM_LD ?= $(shell $(CC) -print-prog-name=wasm-ld)',
      'WASM_LTO_SJLJ_FLAGS',
      '-mllvm --wasm-enable-eh',
      '-mllvm --wasm-enable-sjlj',
      '-mllvm --wasm-use-legacy-eh=false',
      '-mllvm --exception-model=wasm',
    ],
    posture: 'Extension modules use the dynamic-link contract, and the backend relocatable ThinLTO boundary performs the same complete EH/SJLJ lowering as the sealed final link.',
  },
  {
    requirement: 'Process identity and shared memory stay behind the port header',
    patches: [
      '0009-oliphaunt-wasix-route-process-identity-through-port.patch',
      '0010-oliphaunt-wasix-route-sysv-shmem-through-port.patch',
      '0011-oliphaunt-wasix-prefer-posix-semaphores.patch',
    ],
    evidence: ['oliphaunt_wasix_geteuid', 'oliphaunt_wasix_shmget', 'PREFERRED_SEMAPHORES=UNNAMED_POSIX'],
    posture: 'WASIX platform gaps are explicit port-layer dependencies, not scattered runtime guesses.',
  },
  {
    requirement: 'Tool/runtime platform stubs fail closed',
    patches: [
      '0021-oliphaunt-wasix-declare-wasix-fork.patch',
      '0025-oliphaunt-wasix-stub-pg-dump-parallel-fork.patch',
      '0032-oliphaunt-wasix-treat-directory-fsync-eisdir-as-unsupported.patch',
    ],
    evidence: ['fork_process', 'oliphaunt_wasix_pgdump_fork', 'errno == EISDIR'],
    posture: 'Unavailable WASIX behavior is explicit and narrow instead of silently emulated.',
  },
  {
    requirement: 'XLog-size checkpoint pressure is deferred to a transaction-free safe point',
    patches: ['0027-oliphaunt-wasix-defer-xlog-size-checkpoint-requests.patch'],
    evidence: [
      'oliphaunt_wasix_checkpoint_deferred = true;',
      'OliphauntWasixPerformDeferredCheckpoint(void)',
      'RequestCheckpoint(CHECKPOINT_CAUSE_XLOG);',
      'oliphaunt_wasix_checkpoint_deferred = false;',
      'upstream\nRequestCheckpoint already performs the requested checkpoint locally',
    ],
    forbidden: ['diff --git a/src/backend/postmaster/checkpointer.c'],
    posture: 'XLogWrite records pressure but cannot recurse into checkpointing. ReadyForQuery services it after the transaction boundary, failures retain the pending flag, and truthful standalone topology selects PostgreSQL\'s local RequestCheckpoint path.',
  },
  {
    requirement: 'Controlled initdb collation discovery',
    patches: ['0033-oliphaunt-wasix-control-initdb-collation-discovery.patch'],
    evidence: ['OLIPHAUNT_INTERNAL_ICU_READY', 'OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY', 'OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY', 'strcmp', 'pg_collation_actual_version', 'pg_import_system_collations'],
    posture: 'Public collation import retains PostgreSQL semantics. Distributed standard seeds suppress OS and ICU discovery; ICU seeds suppress only OS discovery and verify ICU readiness for initdb\'s unicode-version probe.',
  },
  {
    requirement: 'Ordinary and COPY streaming keep explicit mode-separated transport ABI',
    patches: ['0034-oliphaunt-wasix-declare-hybrid-protocol-transport.patch'],
    evidence: [
      'oliphaunt_wasix_set_protocol_transport(int mode)',
      'oliphaunt_wasix_protocol_stream_active(void)',
    ],
    posture: 'Finite ordinary requests use buffered input with streamed output, while interactive COPY keeps a separate hybrid duplex transition; Rust and TypeScript provide bounded adapters over the same guest ABI.',
  },
  {
    requirement: 'WASIX strong randomness fails closed without descriptor or buffered-state pressure',
    patches: ['0037-oliphaunt-wasix-use-checked-getrandom.patch'],
    evidence: [
      '#elif defined(__wasi__)',
      '#include <sys/random.h>',
      'res = getrandom(p, len, 0);',
      'if (errno == EINTR)',
      'if (res == 0)',
      'No guest-side state to initialize or duplicate.',
    ],
    forbidden: ['WASIX_STRONG_RANDOM_POOL_SIZE', 'wasix_strong_random_pool'],
    posture: 'Every no-OpenSSL WASIX backend bypasses the virtual random device, preserves entropy failures, and keeps no lifecycle-sensitive entropy reservoir.',
  },
  {
    requirement: 'Unsupported writeback hints stay separate from real durability',
    patches: ['0038-oliphaunt-wasix-disable-unsupported-writeback-hints.patch'],
    evidence: [
      '#if defined(OLIPHAUNT_WASM_SINGLE_USER)',
      'Actual fsync/fdatasync durability remains enabled.',
      '#elif defined(HAVE_SYNC_FILE_RANGE)',
    ],
    posture: 'The single-backend guest omits only pg_flush_data hints that WASIX rejects on read-only descriptors; PostgreSQL fsync and fdatasync remain active.',
  },
  {
    requirement: 'PostgreSQL modules own their SJLJ catch frames',
    patches: ['0039-oliphaunt-wasix-inline-sigsetjmp.patch'],
    evidence: [
      '-DOLIPHAUNT_WASM_SIDE_MODULE',
      'WebAssembly SJLJ requires setjmp to be visible at the protected call site.',
      'defined(OLIPHAUNT_WASM_SINGLE_USER) || defined(OLIPHAUNT_WASM_SIDE_MODULE)',
      '#undef sigsetjmp',
      '#define sigsetjmp(env, savesigs) ((void) (savesigs), setjmp(env))',
    ],
    posture: 'PG_TRY expands to a compiler-recognized setjmp in the main executable and every PostgreSQL side module, so nested errors unwind to the live module-local handler.',
  },
  {
    requirement: 'Standalone WASIX libpq sockets are actually nonblocking',
    patches: ['0040-oliphaunt-wasix-set-libpq-sockets-nonblocking.patch'],
    evidence: [
      'defined(SOCK_NONBLOCK) && !defined(__wasi__)',
      '!defined(SOCK_NONBLOCK) || defined(__wasi__)',
      'pg_set_noblock(conn->sock)',
    ],
    posture: 'WASIX uses PostgreSQL\'s existing fcntl fallback because Wasmer ignores socket type flags; native platforms retain upstream atomic socket creation.',
  },
  {
    requirement: 'Captured Oliphaunt psql scripts remain noninteractive',
    patches: ['0041-oliphaunt-wasix-honor-noninteractive-psql-invocations.patch'],
    evidence: [
      'OLIPHAUNT_PSQL_NONINTERACTIVE',
      'strcmp(oliphaunt_noninteractive, "1") == 0',
      '!isatty(fileno(stdin)) || !isatty(fileno(stdout))',
    ],
    posture: 'Only the private exact-value marker overrides virtual terminal detection; ordinary WASIX psql retains upstream isatty semantics.',
  },
  {
    requirement: 'Trusted embedded lifecycle preserves truthful standalone topology',
    patches: ['0029-oliphaunt-wasix-model-trusted-embedded-session.patch'],
    evidence: [
      'OLIPHAUNT_TRUSTED_EMBEDDED_UNSELECTED',
      'OLIPHAUNT_TRUSTED_EMBEDDED_PREPARED',
      'OLIPHAUNT_TRUSTED_EMBEDDED_ATTACHED',
      'return trusted_embedded_lifecycle ==',
      'reached_main ||',
      'ConfigurePreparedTrustedEmbeddedSession(void)',
      'SetConfigOption("io_method", "sync", PGC_POSTMASTER, PGC_S_OVERRIDE)',
      'SetConfigOption("max_worker_processes", "0", PGC_POSTMASTER,',
      'AttachPreparedTrustedEmbeddedSession(void)',
      'if (!AttachPreparedTrustedEmbeddedSession())',
      'IsNormalUserSession(void)',
      'if (IsUnderPostmaster)',
      '!IsTrustedEmbeddedSession() && pathkeys == NIL',
      'ERRCODE_FEATURE_NOT_SUPPORTED',
      'IsUnderPostmaster excludes the trusted embedded session\'s synthetic fd.',
    ],
    forbidden: [
      'IsPostmasterEnvironment = true;',
      'IsUnderPostmaster = true;',
      'HasPostmasterSupervisor',
      'CanLaunchWorkers',
    ],
    posture: 'Preparation is inactive, attach is one-shot, guest GUC limits apply before shared-memory sizing, positive catalog and DDL semantics are explicit, and worker or postmaster-only paths retain upstream standalone fail-closed behavior.',
  },
];

const REQUIRED_EXPERIMENT_DISPOSITIONS = [
  {
    experiment: 'runtime-0013-fail-active-portals-on-host-recovery.patch',
    status: 'removed-after-architecture-review',
    decisionEvidence: ['patch number 0013 remains reserved'],
    rationaleEvidence: [
      'skipped arbitrary nested PG_TRY/PG_CATCH cleanup',
      'observed symptom',
      "PortalRun's own live PG_CATCH",
    ],
  },
  {
    experiment: 'runtime-0020-rearm-exception-stack-after-host-recovery.patch',
    status: 'removed-after-correctness-review',
    decisionEvidence: ['patch number 0020 remains reserved'],
    rationaleEvidence: [
      'pointer to a returned WebAssembly frame',
      'live call-site boundary',
      'clears PG_exception_stack before every return',
    ],
  },
  {
    experiment: '0007-top-xid-current-transaction-fast-path.patch',
    status: 'removed-after-evidence-review',
    decisionEvidence: ['patch number 0015 remains reserved'],
    rationaleEvidence: [
      'semantically plausible',
      'factor-isolated profile or A/B',
      'current-transaction tuple visibility',
      'aborted, nested, parallel, and prepared-transaction tests',
    ],
  },
  {
    experiment: '0012-hash-bytes-unaligned-load-fast-path.patch',
    status: 'removed-after-toolchain-review',
    decisionEvidence: ['patch number 0014 remains reserved'],
    rationaleEvidence: [
      'WASIX clang 21.1.2',
      'i32.load 0:p2align=0',
      'without isolated A/B evidence',
      'complete switch',
    ],
  },
  {
    experiment: '0035-oliphaunt-wasix-use-single-backend-spinlocks.patch',
    status: 'removed-after-evidence-review',
    decisionEvidence: ['patch number 0035 remains reserved'],
    rationaleEvidence: [
      'PR #133',
      'no factor-isolated A/B',
      'normal PostgreSQL spinlock path',
      'coupled experiment',
    ],
  },
  {
    experiment: '0036-oliphaunt-wasix-specialize-single-backend-atomics.patch',
    status: 'removed-after-evidence-review',
    decisionEvidence: ['patch number 0036 remains reserved'],
    rationaleEvidence: [
      'PR #133',
      'no factor-isolated A/B',
      'normal PostgreSQL atomic path',
      'coupled experiment',
    ],
  },
  {
    experiment: 'historical-0035-oliphaunt-wasix-avoid-xlogwrite-prevseg-division.patch',
    status: 'removed-after-evidence-review',
    decisionEvidence: ['patch number 0030 remains reserved'],
    rationaleEvidence: [
      'final uint64 WAL segment',
      '13.993 ms to 15.603 ms',
      'factor-isolated, repeatable COMMIT screen',
    ],
  },
];

if (!['--check', '--write'].includes(mode)) {
  console.error('usage: src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs [--check|--write]');
  process.exit(2);
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function matchRequired(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`missing ${label}`);
  }
  return match[1];
}

function parseSourceManifest() {
  const postgresText = readFileSync(postgresSourceManifestPath, 'utf8');
  const seriesText = readFileSync(patchSeriesManifestPath, 'utf8');
  const version = matchRequired(postgresText, /version\s*=\s*"([^"]+)"/u, 'postgresql.version');
  const url = matchRequired(postgresText, /url\s*=\s*"([^"]+)"/u, 'postgresql.url');
  const sha256 = matchRequired(postgresText, /sha256\s*=\s*"([^"]+)"/u, 'postgresql.sha256');
  const seriesBlock = matchRequired(seriesText, /series\s*=\s*\[([\s\S]*?)\]/u, 'patches.series');
  const series = Array.from(seriesBlock.matchAll(/"([^"]+\.patch)"/gu), match => match[1]);
  if (series.length === 0) {
    throw new Error('WASIX source.toml patch series is empty');
  }
  return {version, url, sha256, series};
}

function patchFiles() {
  return readdirSync(patchDir)
    .filter(name => name.endsWith('.patch'))
    .sort(compareText);
}

function parsePatch(fileName) {
  const relativePath = `src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/${fileName}`;
  const text = read(relativePath);
  const author = text.match(/^From:\s+(.+)$/mu)?.[1];
  if (author !== EXPECTED_AUTHOR) {
    throw new Error(`${relativePath} From: header must be "${EXPECTED_AUTHOR}", got ${author ?? '<missing>'}`);
  }
  const subject = text.match(/^Subject:\s+\[PATCH\]\s+(.+)$/mu)?.[1];
  if (!subject?.startsWith('oliphaunt-wasix: ')) {
    throw new Error(`${relativePath} subject must start with "oliphaunt-wasix: "`);
  }
  const changedFiles = Array.from(
    text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu),
    match => match[2],
  );
  if (changedFiles.length === 0) {
    throw new Error(`${relativePath} does not contain any diff --git file entries`);
  }
  const prefix = `${String(Number(fileName.slice(0, 4))).padStart(4, '0')}-oliphaunt-wasix-`;
  if (!fileName.startsWith(prefix)) {
    throw new Error(`${relativePath} must use sequential prefix ${prefix}`);
  }
  if (/\b(TODO|FIXME)\b/u.test(text)) {
    throw new Error(`${relativePath} must not carry TODO/FIXME placeholders`);
  }

  const diffStart = text
    .indexOf('\ndiff --git ');
  if (diffStart === -1) {
    throw new Error(`${relativePath} is missing a diff body`);
  }
  const rationaleCount = countRationaleLines(text.slice(0, diffStart));
  if (rationaleCount < 2) {
    throw new Error(`${relativePath} must include a short rationale before the diff`);
  }

  const whitespaceProblems = [];
  const symbols = new Set();
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    if (line !== '+' && /[ \t]$/u.test(line)) {
      whitespaceProblems.push(`${index + 1}: ${line}`);
    }
    if (/^\+ \t/u.test(line)) {
      whitespaceProblems.push(`${index + 1}: ${line}`);
    }
    for (const symbol of line.matchAll(/\b(oliphaunt_wasix_[A-Za-z0-9_]+|OLIPHAUNT_WASM_[A-Za-z0-9_]+|PostgresMainLoop(?:DrainBufferedV1|Once)|PostgresMainLongJmp|ProcessStartupPacket)\b/gu)) {
      symbols.add(symbol[1]);
    }
  }
  if (whitespaceProblems.length > 0) {
    throw new Error(
      `${relativePath} contains whitespace problems in added PostgreSQL code:\n${whitespaceProblems.join('\n')}`,
    );
  }

  return {
    fileName,
    relativePath,
    text,
    author,
    subject,
    changedFiles,
    symbols: Array.from(symbols).sort(compareText),
  };
}

function countRationaleLines(headerText) {
  return headerText
    .split('\n')
    .slice(headerText.split('\n').findIndex(line => line.startsWith('Subject: ')) + 1)
    .filter(line => {
      const trimmed = line.trim();
      return trimmed !== '' && !trimmed.startsWith('---') && !trimmed.startsWith('From:') && !trimmed.startsWith('Date:');
    })
    .length;
}

function parseDisposition() {
  const text = readFileSync(dispositionPath, 'utf8');
  const policy = matchRequired(text, /policy\s*=\s*"([^"]+)"/u, 'experiment disposition policy');
  const entries = text
    .split(/\n\[\[patch\]\]\n/u)
    .slice(1)
    .map(block => ({
      experiment: matchRequired(block, /experiment\s*=\s*"([^"]+)"/u, 'experiment'),
      status: matchRequired(block, /status\s*=\s*"([^"]+)"/u, 'status'),
      decision: matchRequired(block, /wasix_runtime_decision\s*=\s*"([^"]+)"/u, 'wasix_runtime_decision'),
      rationale: matchRequired(block, /rationale\s*=\s*"([^"]+)"/u, 'rationale'),
    }));
  if (policy !== 'do-not-port-experiment-patches-without-a-recorded-wasix-runtime-rationale') {
    throw new Error(`unexpected experiment disposition policy: ${policy}`);
  }
  if (entries.length === 0) {
    throw new Error('experiment disposition must record at least one patch');
  }
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.experiment)) {
      throw new Error(`duplicate experiment disposition for ${entry.experiment}`);
    }
    seen.add(entry.experiment);
    for (const field of ['decision', 'rationale']) {
      if (entry[field].trim().length < 8) {
        throw new Error(`experiment ${entry.experiment} has an under-specified ${field}`);
      }
    }
  }
  const byExperiment = new Map(entries.map(entry => [entry.experiment, entry]));
  for (const required of REQUIRED_EXPERIMENT_DISPOSITIONS) {
    const entry = byExperiment.get(required.experiment);
    if (!entry) {
      throw new Error(`missing required experiment disposition ${required.experiment}`);
    }
    if (entry.status !== required.status) {
      throw new Error(
        `experiment ${required.experiment} must have status ${required.status}, got ${entry.status}`,
      );
    }
    for (const evidence of required.decisionEvidence) {
      if (!entry.decision.includes(evidence)) {
        throw new Error(`experiment ${required.experiment} decision is missing ${evidence}`);
      }
    }
    for (const evidence of required.rationaleEvidence) {
      if (!entry.rationale.includes(evidence)) {
        throw new Error(`experiment ${required.experiment} rationale is missing ${evidence}`);
      }
    }
  }
  return {policy, entries};
}

function validateSeries(manifest, actualFiles) {
  if (JSON.stringify(manifest.series) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `WASIX source.toml patch series must exactly match patch directory files\nexpected:\n${manifest.series.join('\n')}\nactual:\n${actualFiles.join('\n')}`,
    );
  }
  const patchNumbers = manifest.series.map(fileName => Number(fileName.slice(0, 4)));
  for (let index = 1; index < patchNumbers.length; index += 1) {
    if (patchNumbers[index] <= patchNumbers[index - 1]) {
      throw new Error('WASIX source.toml patch numbers must be unique and strictly increasing');
    }
  }
}

function validateTouchpoints(patches) {
  const actual = new Set(patches.flatMap(patch => patch.changedFiles));
  const expected = new Set(EXPECTED_TOUCHPOINTS.keys());
  const missing = [...expected].filter(file => !actual.has(file));
  const extra = [...actual].filter(file => !expected.has(file));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `WASIX patch touchpoints changed; update ${path.relative(root, outputPath)} and src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs\nmissing:\n${missing.join('\n') || '<none>'}\nextra:\n${extra.join('\n') || '<none>'}`,
    );
  }
}

function validateAuditChecks(patches) {
  const byName = new Map(patches.map(patch => [patch.fileName, patch]));
  for (const check of REQUIRED_AUDIT_CHECKS) {
    const text = check.patches
      .map(fileName => {
        const patch = byName.get(fileName);
        if (!patch) {
          throw new Error(`audit check "${check.requirement}" references missing patch ${fileName}`);
        }
        return patch.text;
      })
      .join('\n');
    for (const evidence of check.evidence) {
      if (!text.includes(evidence)) {
        throw new Error(`audit check "${check.requirement}" is missing evidence ${evidence}`);
      }
    }
    for (const forbidden of check.forbidden ?? []) {
      if (text.includes(forbidden)) {
        throw new Error(`audit check "${check.requirement}" contains forbidden ambient selector ${forbidden}`);
      }
    }
  }
}

function render() {
  const manifest = parseSourceManifest();
  const actualFiles = patchFiles();
  validateSeries(manifest, actualFiles);
  const patches = actualFiles.map(parsePatch);
  validateTouchpoints(patches);
  validateAuditChecks(patches);
  const disposition = parseDisposition();

  const changedFiles = new Map();
  for (const patch of patches) {
    for (const changed of patch.changedFiles) {
      if (!changedFiles.has(changed)) {
        changedFiles.set(changed, []);
      }
      changedFiles.get(changed).push(patch.fileName);
    }
  }

  const symbols = new Map();
  for (const patch of patches) {
    for (const symbol of patch.symbols) {
      if (!symbols.has(symbol)) {
        symbols.set(symbol, []);
      }
      symbols.get(symbol).push(patch.fileName);
    }
  }

  const lines = [];
  lines.push('<!-- Generated by src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs; do not edit by hand. -->');
  lines.push('# oliphaunt-wasix PostgreSQL 18 WASIX Patch Stack Review');
  lines.push('');
  lines.push('This source-only review artifact keeps the WASIX PostgreSQL patch stack deterministic and reviewable without rebuilding PostgreSQL.');
  lines.push('');
  lines.push('Regenerate with:');
  lines.push('');
  lines.push('```sh');
  lines.push('src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs --write');
  lines.push('```');
  lines.push('');
  lines.push('## Source Pin');
  lines.push('');
  lines.push(`- PostgreSQL: \`${manifest.version}\``);
  lines.push(`- URL: \`${manifest.url}\``);
  lines.push(`- SHA-256: \`${manifest.sha256}\``);
  lines.push(`- Patch directory: \`src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches\``);
  lines.push(`- Experiment disposition policy: \`${disposition.policy}\``);
  lines.push('');
  lines.push('## Patch Series');
  lines.push('');
  lines.push('| Order | Patch | Author | Subject |');
  lines.push('| --- | --- | --- | --- |');
  patches.forEach((patch, index) => {
    lines.push(`| ${index + 1} | \`${patch.fileName}\` | ${patch.author} | ${patch.subject} |`);
  });
  lines.push('');
  lines.push('## Changed Upstream Files');
  lines.push('');
  lines.push('| File | Owning Patch(es) | Rationale |');
  lines.push('| --- | --- | --- |');
  for (const [file, patchNames] of [...changedFiles.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    lines.push(
      `| \`${file}\` | ${patchNames.map(name => `\`${name}\``).join(', ')} | ${EXPECTED_TOUCHPOINTS.get(file)} |`,
    );
  }
  lines.push('');
  lines.push('## Audit Checklist');
  lines.push('');
  lines.push('| Requirement | Owning Patch(es) | Required Evidence | Review Posture |');
  lines.push('| --- | --- | --- | --- |');
  for (const check of REQUIRED_AUDIT_CHECKS) {
    lines.push(
      `| ${check.requirement} | ${check.patches.map(name => `\`${name}\``).join(', ')} | ${check.evidence.map(evidence => `\`${evidence}\``).join(', ')} | ${check.posture} |`,
    );
  }
  lines.push('');
  lines.push('## PostgreSQL Patch Symbols');
  lines.push('');
  for (const [symbol, patchNames] of [...symbols.entries()].sort((a, b) => compareText(a[0], b[0]))) {
    lines.push(`- \`${symbol}\` (${patchNames.map(name => `\`${name}\``).join(', ')})`);
  }
  lines.push('');
  lines.push('## Experiment Patch Disposition');
  lines.push('');
  lines.push('| Experiment Patch | Status | WASIX Runtime Decision | Rationale |');
  lines.push('| --- | --- | --- | --- |');
  for (const entry of disposition.entries) {
    lines.push(`| \`${entry.experiment}\` | \`${entry.status}\` | ${entry.decision} | ${entry.rationale} |`);
  }
  lines.push('');
  lines.push('## Guardrails');
  lines.push('');
  lines.push('- `source.toml` patch series exactly matches the patch directory.');
  lines.push('- Every patch has a deterministic `From: Oliphaunt Maintainers <dev@oliphaunt.dev>` header.');
  lines.push('- Every patch has a deterministic `Subject: [PATCH] oliphaunt-wasix: ...` header and a rationale before the diff.');
  lines.push('- Added PostgreSQL lines are checked for trailing whitespace and space-before-tab indentation.');
  lines.push('- Changed upstream files must exactly match the expected touchpoint table above; new upstream touchpoints need an explicit rationale before landing.');
  lines.push('- Required audit checks prove their evidence in the named owning patch or patches.');
  lines.push('- Experiment patches can only be ported, rejected, or replaced with a recorded WASIX runtime decision and rationale.');
  lines.push('');
  return lines.join('\n');
}

function normalizeGeneratedMarkdown(text) {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trimEnd();
}

try {
  const rendered = render();
  if (mode === '--write') {
    writeFileSync(outputPath, rendered, 'utf8');
  } else {
    if (!existsSync(outputPath)) {
      throw new Error(`${path.relative(root, outputPath)} is missing; run src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs --write`);
    }
    const actual = readFileSync(outputPath, 'utf8');
    if (normalizeGeneratedMarkdown(actual) !== normalizeGeneratedMarkdown(rendered)) {
      throw new Error(`${path.relative(root, outputPath)} is stale; run src/runtimes/liboliphaunt/wasix/tools/check-patch-stack.mjs --write`);
    }
  }
  console.log('WASIX patch stack review artifact is current');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
