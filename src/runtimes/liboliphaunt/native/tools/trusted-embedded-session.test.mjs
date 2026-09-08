import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const patchName = '0021-liboliphaunt-model-trusted-embedded-sessions.patch';
const boundaryPatchName = '0022-liboliphaunt-preserve-host-process-boundaries.patch';
const patchPath = fileURLToPath(
  new URL(`../patches/postgresql-18.4/${patchName}`, import.meta.url),
);
const sourceManifestPath = fileURLToPath(
  new URL('../postgres18/source.toml', import.meta.url),
);

async function fixture() {
  const [patch, sourceManifest] = await Promise.all([
    readFile(patchPath, 'utf8'),
    readFile(sourceManifestPath, 'utf8'),
  ]);
  return {patch, sourceManifest};
}

function diffSection(patch, relativePath) {
  const marker = `diff --git a/${relativePath} b/${relativePath}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `missing diff for ${relativePath}`);
  const end = patch.indexOf('\ndiff --git ', start + marker.length);
  return patch.slice(start, end === -1 ? undefined : end);
}

function changedFileSections(patch) {
  const matches = Array.from(patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu));
  return matches.map((match, index) => ({
    path: match[2],
    section: patch.slice(
      match.index,
      index + 1 < matches.length ? matches[index + 1].index : undefined,
    ),
  }));
}

function addedSource(section) {
  return section
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');
}

function removedSource(section) {
  return section
    .split('\n')
    .filter(line => line.startsWith('-') && !line.startsWith('---'))
    .map(line => line.slice(1))
    .join('\n');
}

function destinationSource(section) {
  return section
    .split('\n')
    .filter(
      line =>
        line.startsWith(' ') ||
        (line.startsWith('+') && !line.startsWith('+++')),
    )
    .map(line => line.slice(1))
    .join('\n');
}

function assertOrdered(text, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = text.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${label}: missing or unordered ${JSON.stringify(fragment)}`);
    cursor = next;
  }
}

function count(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

test('0021 establishes the one-way lifecycle before the terminal host-boundary patch', async () => {
  const {patch, sourceManifest} = await fixture();
  const series = Array.from(
    sourceManifest.matchAll(/^\s*"([^"]+\.patch)",?\s*$/gmu),
    match => match[1],
  );
  assert.ok(series.length > 0, 'source.toml must declare a patch series');
  assert.equal(series.at(-1), boundaryPatchName);
  assert.equal(series.at(-2), patchName);
  assert.equal(series.filter(entry => entry === patchName).length, 1);
  assert.equal(series.filter(entry => entry === boundaryPatchName).length, 1);

  const lifecycle = addedSource(
    diffSection(patch, 'src/backend/utils/init/embedded_session.c'),
  );
  assertOrdered(lifecycle, [
    'TRUSTED_EMBEDDED_SESSION_UNSELECTED = 0',
    'TRUSTED_EMBEDDED_SESSION_PREPARED',
    'TRUSTED_EMBEDDED_SESSION_ATTACHED',
    'static pg_atomic_uint32 trusted_embedded_session_lifecycle = {0};',
    'PrepareTrustedEmbeddedSession(void)',
  ], 'lifecycle declaration');

  const prepareStart = lifecycle.indexOf('PrepareTrustedEmbeddedSession(void)');
  const configureStart = lifecycle.indexOf('ConfigurePreparedTrustedEmbeddedSession(void)');
  const attachStart = lifecycle.indexOf('AttachPreparedTrustedEmbeddedSession(void)');
  const inspectStart = lifecycle.indexOf('IsTrustedEmbeddedSession(void)');
  assert.ok(prepareStart >= 0 && configureStart > prepareStart);
  assert.ok(attachStart > configureStart && inspectStart > attachStart);

  const prepare = lifecycle.slice(prepareStart, configureStart);
  assertOrdered(prepare, [
    'expected = TRUSTED_EMBEDDED_SESSION_UNSELECTED;',
    'pg_atomic_compare_exchange_u32(',
    '&trusted_embedded_session_lifecycle',
    '&expected',
    'TRUSTED_EMBEDDED_SESSION_PREPARED',
  ], 'prepare transition');
  assert.equal(count(prepare, /pg_atomic_compare_exchange_u32/gu), 1);

  const attach = lifecycle.slice(attachStart, inspectStart);
  assertOrdered(attach, [
    'expected = TRUSTED_EMBEDDED_SESSION_PREPARED;',
    'if (!trusted_embedded_settings_are_safe())',
    'return false;',
    'pg_atomic_compare_exchange_u32(',
    '&trusted_embedded_session_lifecycle',
    '&expected',
    'TRUSTED_EMBEDDED_SESSION_ATTACHED',
  ], 'attach transition');
  assert.equal(count(attach, /pg_atomic_compare_exchange_u32/gu), 1);

  const inspect = lifecycle.slice(inspectStart);
  assertOrdered(inspect, [
    'pg_atomic_read_u32(&trusted_embedded_session_lifecycle)',
    'TRUSTED_EMBEDDED_SESSION_ATTACHED',
  ], 'attached-state inspection');
  assert.equal(count(lifecycle, /pg_atomic_compare_exchange_u32/gu), 2);
  assert.doesNotMatch(lifecycle, /pg_atomic_(?:init|write)_u32/gu);
});

test('trusted startup is explicit without forging PostgreSQL topology', async () => {
  const {patch} = await fixture();
  const allAdded = changedFileSections(patch)
    .map(({section}) => addedSource(section))
    .join('\n');
  const postgres = destinationSource(diffSection(patch, 'src/backend/tcop/postgres.c'));
  const backendStartup = destinationSource(
    diffSection(patch, 'src/backend/tcop/backend_startup.c'),
  );
  const declarations = destinationSource(diffSection(patch, 'src/include/tcop/tcopprot.h'));
  const miscadmin = destinationSource(diffSection(patch, 'src/include/miscadmin.h'));

  assert.match(miscadmin, /#define INIT_PG_TRUSTED_CLIENT\s+0x0008/u);
  assert.equal(count(declarations, /bits32 init_postgres_flags/gu), 2);
  assert.match(backendStartup, /PostgresMain\(MyProcPort->database_name, MyProcPort->user_name, 0\);/u);
  assert.match(postgres, /PostgresMain\(dbname, username, 0\);/u);
  assertOrdered(postgres, [
    'PostgresMain(const char *dbname, const char *username,',
    'bits32 init_postgres_flags)',
    'Assert((init_postgres_flags & ~INIT_PG_TRUSTED_CLIENT) == 0);',
    'InitPostgres(dbname, InvalidOid',
    'init_postgres_flags |',
  ], 'trusted flag propagation');

  const entrypoint = postgres;
  assertOrdered(entrypoint, [
    'lifecycle->entrypoint_admitted = true;',
    'PrepareTrustedEmbeddedSession()',
    'ConfigurePreparedTrustedEmbeddedSession();',
    'CreateSharedMemoryAndSemaphores();',
    'MyBackendType = B_BACKEND;',
    'InitProcess();',
    'if (!MyProc->isRegularBackend)',
    'MyProcPort = pq_init(&client_sock);',
    'MyProcPort->proto = PG_PROTOCOL_EARLIEST;',
    'MyProcPort->database_name = pstrdup(dbname);',
    'MyProcPort->user_name = pstrdup(username);',
    'PostgresMain(dbname, username, INIT_PG_TRUSTED_CLIENT);',
  ], 'trusted embedded entrypoint');
  assert.equal(count(entrypoint, /MyBackendType = B_BACKEND;/gu), 1);

  assert.doesNotMatch(
    allAdded,
    /\b(?:IsUnderPostmaster|IsPostmasterEnvironment)\s*=/gu,
  );
  assert.doesNotMatch(
    allAdded,
    /#define\s+(?:IsUnderPostmaster|IsPostmasterEnvironment)\b/gu,
  );
  assert.match(
    miscadmin,
    /return IsUnderPostmaster \|\| IsTrustedEmbeddedSession\(\);/u,
  );
});

test('only the trusted branch bypasses authentication, installs catalog identity, and leaves system_user NULL', async () => {
  const {patch} = await fixture();
  const section = diffSection(patch, 'src/backend/utils/init/postinit.c');
  const added = addedSource(section);
  const removed = removedSource(section);
  const destination = destinationSource(section);

  assertOrdered(destination, [
    'bool\t\ttrusted_client = (flags & INIT_PG_TRUSTED_CLIENT) != 0;',
    'if (trusted_client)',
    'bootstrap || IsPostmasterEnvironment || IsUnderPostmaster',
    '!AmRegularBackendProcess() || MyProcPort == NULL',
    'AttachPreparedTrustedEmbeddedSession()',
    'else if (trusted_client)',
    'Assert(IsTrustedEmbeddedSession());',
    'InitializeSessionUserId(username, useroid, false);',
    'am_superuser = superuser();',
    'else if (!IsUnderPostmaster)',
    'InitializeSessionUserIdStandalone();',
  ], 'trusted identity branch');
  assert.equal(count(added, /else if \(trusted_client\)/gu), 1);
  assert.doesNotMatch(added, /PerformAuthentication|ClientAuthentication_hook/gu);
  assert.doesNotMatch(removed, /PerformAuthentication|ClientAuthentication_hook/gu);

  const trustedIdentity = destination.slice(
    destination.indexOf('else if (trusted_client)'),
    destination.indexOf('else if (!IsUnderPostmaster)'),
  );
  assert.doesNotMatch(
    trustedIdentity,
    /authn_id|auth_method|SetAuthenticatedUserId|InitializeSessionUserIdStandalone|system_user/gu,
  );
});

test('trusted sessions retain role, database, and settings policy gates', async () => {
  const {patch} = await fixture();
  const miscinit = diffSection(patch, 'src/backend/utils/init/miscinit.c');
  const postinit = diffSection(patch, 'src/backend/utils/init/postinit.c');
  const miscinitAdded = addedSource(miscinit);
  const postinitAdded = addedSource(postinit);

  assert.match(miscinit, /@@ .* InitializeSessionUserId\(/u);
  assert.match(miscinitAdded, /if \(IsNormalUserSession\(\)\)/u);
  assert.match(miscinitAdded, /These checks apply to normal user sessions/u);
  assert.match(postinit, /@@ .* CheckMyDatabase\(/u);
  assert.match(postinitAdded, /if \(IsNormalUserSession\(\)\)/u);
  assert.match(postinit, /@@ .* process_settings\(/u);
  assert.match(postinitAdded, /if \(!IsNormalUserSession\(\)\)/u);
  assert.match(removedSource(postinit), /if \(!IsUnderPostmaster\)/u);
  assert.match(
    patch,
    /enforces LOGIN and connection limits, checks database access, loads\npg_db_role_setting/u,
  );
});

test('normal-user semantics have an exact, narrow call-site allowlist', async () => {
  const {patch} = await fixture();
  const observed = new Map();
  for (const {path, section} of changedFileSections(patch)) {
    const occurrences = count(addedSource(section), /IsNormalUserSession\(/gu);
    if (occurrences > 0)
      observed.set(path, occurrences);
  }

  assert.deepEqual(observed, new Map([
    ['src/backend/access/transam/multixact.c', 1],
    ['src/backend/access/transam/varsup.c', 3],
    ['src/backend/commands/event_trigger.c', 1],
    ['src/backend/commands/tsearchcmds.c', 1],
    ['src/backend/utils/init/miscinit.c', 1],
    ['src/backend/utils/init/postinit.c', 2],
    ['src/backend/utils/misc/superuser.c', 1],
    ['src/include/miscadmin.h', 1],
  ]));

  const multixact = destinationSource(
    diffSection(patch, 'src/backend/access/transam/multixact.c'),
  );
  assertOrdered(multixact, [
    'if (IsNormalUserSession() &&',
    'if (IsUnderPostmaster)',
    'SendPostmasterSignal(PMSIGNAL_START_AUTOVAC_LAUNCHER);',
  ], 'MultiXact stop protection and supervisor signal split');
  assert.match(
    destinationSource(diffSection(patch, 'src/include/miscadmin.h')),
    /This says nothing about supervisor,\n \* worker, socket, or XLOG topology/u,
  );
});

test('supervisor-only SQL functions fail closed before signalling', async () => {
  const {patch} = await fixture();
  const signals = destinationSource(
    diffSection(patch, 'src/backend/storage/ipc/signalfuncs.c'),
  );
  const promote = destinationSource(
    diffSection(patch, 'src/backend/access/transam/xlogfuncs.c'),
  );
  assert.match(
    diffSection(patch, 'src/backend/access/transam/xlogfuncs.c'),
    /@@ .* pg_promote\(PG_FUNCTION_ARGS\)/u,
  );

  assertOrdered(signals, [
    'pg_reload_conf(PG_FUNCTION_ARGS)',
    'if (IsTrustedEmbeddedSession())',
    'configuration reload is not supported in a trusted embedded session',
    'if (kill(PostmasterPid, SIGHUP))',
    'pg_rotate_logfile(PG_FUNCTION_ARGS)',
    'if (IsTrustedEmbeddedSession())',
    'log rotation is not supported in a trusted embedded session',
    'PG_RETURN_BOOL(false);',
    'if (!Logging_collector)',
  ], 'reload and rotate fail-closed guards');
  assertOrdered(promote, [
    'if (IsTrustedEmbeddedSession())',
    'standby promotion is not supported in a trusted embedded session',
    'if (!RecoveryInProgress())',
  ], 'promotion fail-closed guard');
});

test('live parallel-worker GUC hooks reject nonzero values but preserve PGC_S_TEST', async () => {
  const {patch} = await fixture();
  const gucs = addedSource(diffSection(patch, 'src/backend/utils/misc/guc_tables.c'));
  const lifecycle = addedSource(
    diffSection(patch, 'src/backend/utils/init/embedded_session.c'),
  );

  assertOrdered(gucs, [
    'check_trusted_embedded_worker_limit(int *newval, void **extra,',
    'source != PGC_S_TEST',
    'source >= PGC_S_OVERRIDE',
    '*newval != 0',
    'Trusted embedded sessions cannot launch PostgreSQL workers.',
    '#define CHECK_TRUSTED_EMBEDDED_WORKER_LIMIT check_trusted_embedded_worker_limit',
  ], 'trusted worker GUC hook');
  assert.equal(
    count(gucs, /CHECK_TRUSTED_EMBEDDED_WORKER_LIMIT, NULL, NULL/gu),
    3,
  );
  assertOrdered(lifecycle, [
    'SetConfigOption("io_method", "sync", PGC_POSTMASTER, PGC_S_OVERRIDE);',
    'SetConfigOption("max_worker_processes", "0", PGC_POSTMASTER,',
    'SetConfigOption("max_parallel_workers", "0", PGC_POSTMASTER,',
    'SetConfigOption("max_parallel_workers_per_gather", "0", PGC_POSTMASTER,',
    'SetConfigOption("max_parallel_maintenance_workers", "0", PGC_POSTMASTER,',
    'SetConfigOption("max_wal_senders", "0", PGC_POSTMASTER, PGC_S_OVERRIDE);',
    'if (!trusted_embedded_settings_are_safe())',
  ], 'pre-shared-memory topology pinning');
});
