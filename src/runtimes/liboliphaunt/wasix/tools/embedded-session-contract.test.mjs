import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim();

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function assertOrdered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `missing ordered marker ${JSON.stringify(marker)}`);
    assert.ok(next > cursor, `${JSON.stringify(marker)} is out of order`);
    cursor = next;
  }
}

function diffSection(patch, relativePath) {
  const marker = `diff --git a/${relativePath} b/${relativePath}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `missing diff for ${relativePath}`);
  const end = patch.indexOf('\ndiff --git ', start + marker.length);
  return patch.slice(start, end === -1 ? undefined : end);
}

const postgresPatchPath =
  'src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/0029-oliphaunt-wasix-model-trusted-embedded-session.patch';

test('trusted-session lifecycle is private, inactive while prepared, and one-shot', async () => {
  const patch = await source(postgresPatchPath);
  const main = diffSection(patch, 'src/backend/main/main.c');

  assertOrdered(main, [
    'OLIPHAUNT_TRUSTED_EMBEDDED_UNSELECTED = 0',
    'OLIPHAUNT_TRUSTED_EMBEDDED_PREPARED',
    'OLIPHAUNT_TRUSTED_EMBEDDED_ATTACHED',
    'trusted_embedded_lifecycle =',
  ]);
  assertOrdered(main, [
    'IsTrustedEmbeddedSession(void)',
    'return trusted_embedded_lifecycle ==',
    'OLIPHAUNT_TRUSTED_EMBEDDED_ATTACHED;',
  ]);
  assertOrdered(main, [
    'oliphaunt_wasix_prepare_trusted_embedded_session(void)',
    'if (reached_main ||',
    'OLIPHAUNT_TRUSTED_EMBEDDED_UNSELECTED)',
    'return -1;',
    'trusted_embedded_lifecycle = OLIPHAUNT_TRUSTED_EMBEDDED_PREPARED;',
  ]);
  assertOrdered(main, [
    'AttachPreparedTrustedEmbeddedSession(void)',
    'trusted_embedded_lifecycle != OLIPHAUNT_TRUSTED_EMBEDDED_PREPARED',
    '!trusted_embedded_settings_are_safe())',
    'trusted_embedded_lifecycle = OLIPHAUNT_TRUSTED_EMBEDDED_ATTACHED;',
  ]);
  assert.ok(!patch.includes('IsPostmasterEnvironment = true;'));
  assert.ok(!patch.includes('IsUnderPostmaster = true;'));
  assert.ok(!patch.includes('HasPostmasterSupervisor'));
  assert.ok(!patch.includes('CanLaunchWorkers'));
});

test('guest pins safe topology settings and rejects only live worker restoration', async () => {
  const patch = await source(postgresPatchPath);
  const main = diffSection(patch, 'src/backend/main/main.c');
  const postgres = diffSection(patch, 'src/backend/tcop/postgres.c');
  const gucTables = diffSection(patch, 'src/backend/utils/misc/guc_tables.c');

  for (const [name, value] of [
    ['io_method', 'sync'],
    ['max_worker_processes', '0'],
    ['max_parallel_workers', '0'],
    ['max_parallel_workers_per_gather', '0'],
    ['max_parallel_maintenance_workers', '0'],
    ['max_wal_senders', '0'],
  ]) {
    assert.ok(
      main.includes(`SetConfigOption("${name}", "${value}", PGC_POSTMASTER`),
      `missing guest override for ${name}`,
    );
  }
  assertOrdered(postgres, [
    'SelectConfigFiles(userDoption, progname)',
    'ConfigurePreparedTrustedEmbeddedSession();',
    'Validate we have been given a reasonable-looking DataDir',
  ]);
  assert.equal(
    (gucTables.match(/CHECK_OLIPHAUNT_SINGLE_BACKEND_WORKER_LIMIT, NULL, NULL/gu) ?? [])
      .length,
    3,
  );
  assertOrdered(gucTables, [
    'if (IsTrustedEmbeddedSession() &&',
    'source != PGC_S_TEST &&',
    'source >= PGC_S_OVERRIDE &&',
    '*newval != 0)',
  ]);
  assert.ok(!gucTables.includes('(void) source;'));
});

test('only intended positive semantics use the normal-user capability', async () => {
  const patch = await source(postgresPatchPath);

  const expectedSites = new Map([
    ['src/backend/commands/event_trigger.c', 4],
    ['src/backend/commands/tsearchcmds.c', 1],
    ['src/backend/utils/misc/superuser.c', 1],
    ['src/backend/access/transam/varsup.c', 3],
    ['src/backend/access/transam/multixact.c', 1],
  ]);
  for (const [relativePath, expected] of expectedSites) {
    const section = diffSection(patch, relativePath);
    assert.equal(
      (section.match(/\+.*IsNormalUserSession\(\)/gu) ?? []).length,
      expected,
      `unexpected capability coverage in ${relativePath}`,
    );
  }

  const multixact = diffSection(patch, 'src/backend/access/transam/multixact.c');
  assertOrdered(multixact, [
    'if (IsNormalUserSession() &&',
    'if (IsUnderPostmaster)',
    'SendPostmasterSignal(PMSIGNAL_START_AUTOVAC_LAUNCHER);',
  ]);
  assert.ok(patch.includes('never enabled login triggers, startup settings,'));
  assert.ok(!diffSection(patch, 'src/backend/commands/event_trigger.c').includes('EventTriggerOnLogin'));
});

test('async append and synthetic-fd connection polling stay disabled', async () => {
  const patch = await source(postgresPatchPath);
  const createplan = diffSection(patch, 'src/backend/optimizer/plan/createplan.c');
  const postgres = diffSection(patch, 'src/backend/tcop/postgres.c');

  assertOrdered(createplan, [
    'consider_async = (enable_async_append &&',
    '!IsTrustedEmbeddedSession() && pathkeys == NIL',
  ]);
  assertOrdered(postgres, [
    "IsUnderPostmaster excludes the trusted embedded session's synthetic fd.",
    'client_connection_check_interval > 0 &&',
    'IsUnderPostmaster &&',
    'MyProcPort &&',
  ]);
});

test('postmaster signal SQL functions reject or report false before signaling', async () => {
  const patch = await source(postgresPatchPath);
  const signals = diffSection(patch, 'src/backend/storage/ipc/signalfuncs.c');
  const xlog = diffSection(patch, 'src/backend/access/transam/xlogfuncs.c');

  assertOrdered(signals, [
    'pg_reload_conf(PG_FUNCTION_ARGS)',
    'IsTrustedEmbeddedSession()',
    'ERRCODE_FEATURE_NOT_SUPPORTED',
    'kill(PostmasterPid, SIGHUP)',
  ]);
  assertOrdered(signals, [
    'pg_rotate_logfile(PG_FUNCTION_ARGS)',
    'IsTrustedEmbeddedSession()',
    'PG_RETURN_BOOL(false);',
    'if (!Logging_collector)',
  ]);
  assertOrdered(xlog, [
    'pg_promote(PG_FUNCTION_ARGS)',
    'IsTrustedEmbeddedSession()',
    'ERRCODE_FEATURE_NOT_SUPPORTED',
    'if (!RecoveryInProgress())',
  ]);
});

test('hosts and runtime export policy require preparation immediately before _start', async () => {
  const [
    rustHost,
    typeScriptPatch,
    typeScriptManifest,
    postgresSeries,
    runtimeExports,
    assetPipeline,
  ] = await Promise.all([
    source('src/bindings/wasix-rust/crates/oliphaunt-wasix/src/oliphaunt/postgres_mod.rs'),
    source(
      'src/bindings/wasix-ts/host/patches/0023-wasmer-js-prepare-trusted-embedded-session.patch',
    ),
    source('src/bindings/wasix-ts/host/source.toml'),
    source('src/runtimes/liboliphaunt/wasix/assets/build/postgres/patches/series'),
    source('src/runtimes/liboliphaunt/wasix/assets/generated/wasix-dl.exports'),
    source('tools/xtask/src/asset_pipeline.rs'),
  ]);

  for (const host of [rustHost, typeScriptPatch]) {
    assert.ok(
      host.includes('prepare_trusted_embedded_session: TypedFunction<(), i32>'),
      'prepare export must be required and typed as () -> i32',
    );
    assert.ok(
      host.includes('let prepare_trusted_embedded_session = typed_export('),
      'prepare export must not use optional export loading',
    );
    assertOrdered(host, [
      'oliphaunt_wasix_set_active(1)',
      '.prepare_trusted_embedded_session',
      'prepare_status == 0',
      'wasi_start.call',
    ]);
  }
  assert.ok(
    typeScriptManifest.includes('0023-wasmer-js-prepare-trusted-embedded-session.patch'),
    'TypeScript host series must contain the preparation patch',
  );
  assert.ok(!typeScriptManifest.includes('0022-wasmer-js-prepare-trusted-embedded-session.patch'));
  assert.ok(postgresSeries.includes('0029-oliphaunt-wasix-model-trusted-embedded-session.patch'));
  assert.ok(!postgresSeries.includes('0042-oliphaunt-wasix-contain-trusted-embedded-session.patch'));
  assert.ok(
    runtimeExports.split('\n').includes('oliphaunt_wasix_prepare_trusted_embedded_session'),
    'linker export policy must expose the required pre-start preparation function',
  );
  assert.ok(
    assetPipeline.includes('"oliphaunt_wasix_prepare_trusted_embedded_session"'),
    'source-controlled export guard must require the preparation function',
  );
});
