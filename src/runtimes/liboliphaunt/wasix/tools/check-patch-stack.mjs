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
  ['src/Makefile.shlib', 'Defines the WASIX dynamic-link shared-library shape.'],
  ['src/backend/Makefile', 'Builds the dynamic-main backend module without changing other ports.'],
  ['src/backend/common.mk', 'Scopes scalar atomics to PostgreSQL backend objects instead of PGXS side modules.'],
  ['src/backend/access/nbtree/nbtdedup.c', 'Keeps btree delete scratch storage on stack under embedded WASIX.'],
  ['src/backend/access/nbtree/nbtinsert.c', 'Adds the guarded int4 insert fast path.'],
  ['src/backend/access/nbtree/nbtsearch.c', 'Adds guarded int4 leaf fast paths.'],
  ['src/backend/access/transam/xact.c', 'Adds top-level current-transaction shortcut for embedded WASIX.'],
  ['src/backend/access/transam/xlog.c', 'Avoids expensive segment division under embedded WASIX.'],
  ['src/backend/commands/copyfromparse.c', 'Reports COPY protocol state to the host.'],
  ['src/backend/commands/copyto.c', 'Reports COPY protocol state to the host.'],
  ['src/backend/commands/collationcmds.c', 'System-collation import preserves PostgreSQL semantics unless a controlled seed producer suppresses discovery.'],
  ['src/backend/libpq/be-secure.c', 'Routes embedded protocol reads and writes through host-owned callbacks.'],
  ['src/backend/libpq/pqcomm.c', 'Skips unavailable postmaster-death wait handles in embedded WASIX.'],
  ['src/backend/main/main.c', 'Rejects concurrent postmaster and fork-child dispatch in the scalar-atomic runtime.'],
  ['src/backend/optimizer/plan/planner.c', 'Suppresses activity identifier reporting in embedded WASIX.'],
  ['src/backend/port/posix_sema.c', 'Uses POSIX semaphore behavior selected by the WASIX template.'],
  ['src/backend/postmaster/checkpointer.c', 'Keeps checkpoint requests local to embedded WASIX.'],
  ['src/backend/postmaster/fork_process.c', 'Declares the WASIX fork boundary without enabling postmaster concurrency.'],
  ['src/backend/replication/walsender.c', 'Suppresses activity identifier reporting in embedded WASIX.'],
  ['src/backend/storage/file/fd.c', 'Keeps real fsync while narrowing unsupported WASIX directory and writeback-hint behavior.'],
  ['src/backend/tcop/backend_startup.c', 'Exports the startup packet parser for host-driven startup.'],
  ['src/backend/tcop/postgres.c', 'Owns embedded lifecycle, protocol loop, and error recovery.'],
  ['src/backend/utils/adt/like.c', 'Adds guarded LIKE literal fast path for embedded WASIX.'],
  ['src/backend/utils/adt/like_match.c', 'Adds guarded LIKE literal fast path for embedded WASIX.'],
  ['src/backend/utils/init/miscinit.c', 'Routes process identity through the WASIX port layer.'],
  ['src/backend/utils/init/postinit.c', 'Skips data-directory ownership checks under embedded WASIX.'],
  ['src/backend/utils/misc/guc.c', 'Uses the embedded WASIX postmaster-style environment.'],
  ['src/backend/utils/mmgr/portalmem.c', 'Fails active portals on host-forced recovery.'],
  ['src/bin/initdb/initdb.c', 'Controlled seed producers may suppress host discovery while verified ICU readiness gates the unicode-version probe.'],
  ['src/bin/pg_dump/connectdb.c', 'Avoids pg_dump LTO symbol collisions.'],
  ['src/bin/pg_dump/connectdb.h', 'Avoids pg_dump LTO symbol collisions.'],
  ['src/bin/pg_dump/parallel.c', 'Stubs unavailable pg_dump parallel fork behavior under WASIX.'],
  ['src/bin/pg_dump/pg_dumpall.c', 'Avoids pg_dump LTO symbol collisions.'],
  ['src/common/file_utils.c', 'Keeps real fsync while narrowing unsupported WASIX directory and writeback-hint behavior.'],
  ['src/common/hashfn.c', 'Uses defined unaligned load fast path under WASIX.'],
  ['src/port/pg_strong_random.c', 'Uses checked direct WASI entropy reads and batches them only for the single-backend runtime.'],
  ['src/include/libpq/libpq-be.h', 'Adds the host I/O callback table to Port only for embedded WASIX.'],
  ['src/include/access/xlog.h', 'Exposes the embedded idle-boundary checkpoint handoff within PostgreSQL.'],
  ['src/include/port/atomics.h', 'Selects scalar atomics only for the explicitly single-backend WASIX build.'],
  ['src/include/port/atomics/arch-wasix-single.h', 'Preserves PostgreSQL atomic layouts and contracts without guest atomic instructions.'],
  ['src/include/port/wasix-dl.h', 'Defines the embedded WASIX port header, durability default, ABI redirects, and call-site SJLJ contract.'],
  ['src/include/port/wasix-dl/sys/ipc.h', 'Provides the WASIX SysV IPC shim surface.'],
  ['src/include/port/wasix-dl/sys/shm.h', 'Provides the WASIX SysV shared-memory shim surface.'],
  ['src/include/storage/s_lock.h', 'Specializes spinlocks only for the enforced single-backend WASIX runtime.'],
  ['src/bin/psql/startup.c', 'Keeps captured Oliphaunt psql invocations noninteractive despite WASIX virtual descriptor types.'],
  ['src/interfaces/libpq/fe-connect.c', 'Makes libpq socket nonblocking state explicit where WASIX socket creation ignores type flags.'],
  ['src/makefiles/Makefile.wasix-dl', 'Builds side modules and PGXS artifacts for WASIX dynamic linking.'],
  ['src/makefiles/pgxs.mk', 'Installs PGXS extension artifacts for WASIX packaging.'],
  ['src/template/wasix-dl', 'Keeps the WASIX template and atomics invariants source-controlled.'],
]);

const REQUIRED_AUDIT_CHECKS = [
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
    requirement: 'Protocol loop recovery remains at the PostgresMain boundary',
    patches: [
      '0005-oliphaunt-wasix-add-loop-pumped-protocol-exports.patch',
      '0019-oliphaunt-wasix-schedule-ready-after-host-recovery.patch',
      '0020-oliphaunt-wasix-rearm-exception-stack-after-host-recovery.patch',
    ],
    evidence: ['PostgresMainLoopOnce', 'PostgresMainLongJmp', 'send_ready_for_query = true'],
    posture: 'The host pumps PostgreSQL one loop at a time and recovery re-enters the upstream exception stack.',
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
    requirement: 'PGXS side modules use the WASIX dynamic-link contract',
    patches: [
      '0007-oliphaunt-wasix-add-wasix-pgxs-side-module-support.patch',
      '0022-oliphaunt-wasix-use-wasm-ld-for-backend-core.patch',
    ],
    evidence: ['PGXS', 'WASM_LD ?= $(shell $(CC) -print-prog-name=wasm-ld)'],
    posture: 'Extension and backend side-module behavior is source-reviewed with the linker path.',
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
    requirement: 'Controlled initdb collation discovery',
    patches: ['0033-oliphaunt-wasix-control-initdb-collation-discovery.patch'],
    evidence: ['OLIPHAUNT_INTERNAL_ICU_READY', 'OLIPHAUNT_INTERNAL_SKIP_SYSTEM_COLLATION_DISCOVERY', 'OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY', 'strcmp', 'pg_collation_actual_version', 'pg_import_system_collations'],
    posture: 'Public collation import retains PostgreSQL semantics. Distributed standard seeds suppress OS and ICU discovery; ICU seeds suppress only OS discovery and verify ICU readiness for initdb\'s unicode-version probe.',
  },
  {
    requirement: 'COPY streaming keeps an explicit hybrid transport ABI',
    patches: ['0034-oliphaunt-wasix-declare-hybrid-protocol-transport.patch'],
    evidence: [
      'oliphaunt_wasix_set_protocol_transport(int mode)',
      'oliphaunt_wasix_protocol_stream_active(void)',
    ],
    posture: 'Only COPY switches an embedded host from buffered protocol I/O to its attached stream; Rust and TypeScript provide language-native bounded stream adapters over the same guest ABI.',
  },
  {
    requirement: 'Single-backend WASIX spinlocks preserve their ABI and scope',
    patches: ['0035-oliphaunt-wasix-use-single-backend-spinlocks.patch'],
    evidence: [
      'defined(__wasi__) && defined(OLIPHAUNT_WASM_SINGLE_USER)',
      'OLIPHAUNT_WASM_SINGLE_BACKEND_ATOMICS',
      'typedef int slock_t;',
      'oliphaunt_wasix_single_user_tas',
    ],
    posture: 'The shared guest lets Rust AOT and every TypeScript placement replace atomic exchange; all concurrent PostgreSQL builds retain upstream spinlocks.',
  },
  {
    requirement: 'Single-backend WASIX atomics preserve ABI and operation contracts',
    patches: ['0036-oliphaunt-wasix-specialize-single-backend-atomics.patch'],
    evidence: [
      'override CPPFLAGS += -DOLIPHAUNT_WASM_SINGLE_BACKEND_ATOMICS',
      'postmaster mode is unavailable in the single-backend WASIX runtime',
      'PG_HAVE_8BYTE_SINGLE_COPY_ATOMICITY',
      'volatile uint64 value pg_attribute_aligned(8)',
      '*expected = current',
    ],
    posture: 'Shared guest backend objects use scalar operations for Rust and TypeScript hosts; frontends, extensions, and every concurrent PostgreSQL build retain normal atomics.',
  },
  {
    requirement: 'WASIX strong randomness avoids descriptor pressure and forked state',
    patches: ['0037-oliphaunt-wasix-buffer-strong-random.patch'],
    evidence: [
      '#elif defined(__wasi__)',
      'wasix_strong_random_fill(void *buf, size_t len)',
      '#if defined(OLIPHAUNT_WASM_SINGLE_USER)',
      'wasix_strong_random_fill(wasix_strong_random_pool',
      'if (errno == EINTR)',
      'wasix_strong_random_used += copy_len',
      'No guest-side state in a process that may fork.',
    ],
    posture: 'Every WASIX backend bypasses the virtual random device. The embedded backend amortizes host calls, while fork-capable backends keep no duplicable random state.',
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
    requirement: 'WASIX WAL durability uses explicit fdatasync calls',
    patches: ['0042-oliphaunt-wasix-default-wal-sync-to-fdatasync.patch'],
    evidence: [
      'PLATFORM_DEFAULT_WAL_SYNC_METHOD',
      'WAL_SYNC_METHOD_FDATASYNC',
      'explicit fd_datasync operation',
    ],
    posture: 'The shared PostgreSQL port avoids relying on variable O_DSYNC open semantics and gives browser and Rust Wasmer hosts one durability default.',
  },
  {
    requirement: 'PostgreSQL side modules own their SJLJ catch frames',
    patches: ['0039-oliphaunt-wasix-inline-sigsetjmp.patch'],
    evidence: [
      '-DOLIPHAUNT_WASM_SIDE_MODULE',
      'WebAssembly SJLJ requires setjmp to be visible at the protected call site.',
      'defined(__wasm_exception_handling__) && defined(OLIPHAUNT_WASM_SIDE_MODULE)',
      '#undef sigsetjmp',
      '#define sigsetjmp(env, savesigs) ((void) (savesigs), setjmp(env))',
    ],
    posture: 'PG_TRY expands to a compiler-recognized setjmp in every PostgreSQL side module, so nested errors unwind to the live module-local handler.',
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
    for (const symbol of line.matchAll(/\b(oliphaunt_wasix_[A-Za-z0-9_]+|OLIPHAUNT_WASM_[A-Za-z0-9_]+|PostgresMainLoopOnce|PostgresMainLongJmp|ProcessStartupPacket)\b/gu)) {
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
  return {policy, entries};
}

function validateSeries(manifest, actualFiles) {
  if (JSON.stringify(manifest.series) !== JSON.stringify(actualFiles)) {
    throw new Error(
      `WASIX source.toml patch series must exactly match patch directory files\nexpected:\n${manifest.series.join('\n')}\nactual:\n${actualFiles.join('\n')}`,
    );
  }
  manifest.series.forEach((fileName, index) => {
    const expectedPrefix = `${String(index + 1).padStart(4, '0')}-oliphaunt-wasix-`;
    if (!fileName.startsWith(expectedPrefix)) {
      throw new Error(`${fileName} must use sequential prefix ${expectedPrefix}`);
    }
  });
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
