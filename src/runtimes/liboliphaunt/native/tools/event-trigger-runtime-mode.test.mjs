import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim();
const eventTriggerPatchPath =
  'src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0012-liboliphaunt-enable-event-triggers-in-embedded-backend.patch';

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function diffSection(patch, relativePath) {
  const marker = `diff --git a/${relativePath} b/${relativePath}`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, `missing diff for ${relativePath}`);
  const end = patch.indexOf('\ndiff --git ', start + marker.length);
  return patch.slice(start, end === -1 ? undefined : end);
}

function addedSource(section) {
  return section
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');
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

test('event-trigger policy is based on runtime topology, not the build profile', async () => {
  const patch = await source(eventTriggerPatchPath);
  const changedFiles = Array.from(
    patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu),
    match => match[2],
  );
  assert.deepEqual(changedFiles, [
    'src/backend/commands/event_trigger.c',
    'src/backend/tcop/postgres.c',
  ]);

  const eventTrigger = addedSource(diffSection(patch, 'src/backend/commands/event_trigger.c'));
  assertOrdered(eventTrigger, [
    '#ifdef OLIPHAUNT_EMBEDDED',
    'return IsUnderPostmaster || AmRegularBackendProcess();',
    '#else',
    'return IsUnderPostmaster;',
    '#endif',
  ]);
  assert.equal(
    (eventTrigger.match(/if \(!EventTriggersHaveRunnableBackend\(\) \|\| !event_triggers/gu) ?? [])
      .length,
    5,
  );
  assert.ok(!eventTrigger.includes('return true;'));
  assert.ok(!eventTrigger.includes('IsTrustedEmbeddedSession'));
  assert.ok(!eventTrigger.includes('IsUnderPostmaster = true;'));
  assert.ok(!eventTrigger.includes('IsPostmasterEnvironment = true;'));
});

test('Native entrypoint admission is atomic, write-once, and pre-initialization', async () => {
  const [patch, entrypointPatch, exitGuardPatch] = await Promise.all([
    source(eventTriggerPatchPath),
    source(
      'src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0002-liboliphaunt-add-embedded-entrypoint.patch',
    ),
    source(
      'src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0009-liboliphaunt-guard-embedded-proc-exit.patch',
    ),
  ]);
  const postgres = diffSection(patch, 'src/backend/tcop/postgres.c');
  const added = addedSource(postgres);

  assertOrdered(added, [
    'static pg_atomic_uint32 embedded_entrypoint_admission = {0};',
    'AdmitEmbeddedEntrypoint(void)',
    'expected = OLIPHAUNT_EMBEDDED_ENTRYPOINT_UNCLAIMED;',
    'if (IsPostmasterEnvironment || IsUnderPostmaster)',
    'pg_atomic_compare_exchange_u32(&embedded_entrypoint_admission',
  ]);
  assert.equal((added.match(/pg_atomic_compare_exchange_u32/gu) ?? []).length, 1);
  assert.equal((added.match(/pg_atomic_read/gu) ?? []).length, 0);
  assert.ok(!added.includes('trusted_embedded_session'));
  assert.ok(!added.includes('IsTrustedEmbeddedSession'));
  assert.ok(!added.includes('pg_atomic_write'));
  assert.doesNotMatch(added, /^\s*pg_atomic_init_u32\(/gmu);

  const selectorCall = postgres.slice(postgres.indexOf('if (!AdmitEmbeddedEntrypoint())'));
  assertOrdered(selectorCall, [
    'if (!AdmitEmbeddedEntrypoint())',
    'lifecycle->rc = -1;',
    'goto embedded_cleanup;',
    'lifecycle->entrypoint_admitted = true;',
  ]);
  assert.ok(postgres.includes('bool\t\tentrypoint_admitted;'));
  const socketPatch = await source(
    'src/runtimes/liboliphaunt/native/patches/postgresql-18.4/0014-liboliphaunt-use-portable-embedded-socketpair.patch',
  );
  assert.ok(socketPatch.includes(
    'if (lifecycle->entrypoint_admitted && FeBeWaitSet != NULL)',
  ));
  const guardedEntrypoint = diffSection(exitGuardPatch, 'src/backend/tcop/postgres.c');
  assertOrdered(guardedEntrypoint, [
    'if (sigsetjmp(lifecycle->proc_exit_env, 1) != 0)',
    'oliphaunt_embedded_install_proc_exit_handler(',
    'lifecycle->proc_exit_handler_armed = true;',
    'if (progname == NULL)',
  ]);
  const entrypoint = diffSection(entrypointPatch, 'src/backend/tcop/postgres.c').slice(
    diffSection(entrypointPatch, 'src/backend/tcop/postgres.c').indexOf(
      'oliphaunt_embedded_main(int argc',
    ),
  );
  assertOrdered(entrypoint, [
    'if (progname == NULL)',
    'InitStandaloneProcess(argv[0]);',
    'MyBackendType = B_BACKEND;',
    'PostgresMain(dbname, username);',
  ]);
  assert.ok(patch.includes('deliberately never reset'));
  assert.ok(patch.includes('Admission is not a session capability'));
  assert.ok(patch.includes('sets MyBackendType to B_BACKEND before PostgresMain'));
});

test('Native modes reach the intended PostgreSQL topology boundary', async () => {
  const [host, broker, server] = await Promise.all([
    source('src/runtimes/liboliphaunt/native/src/liboliphaunt_native.c'),
    source('src/sdks/rust/src/broker_support.rs'),
    source('src/sdks/rust/src/server.rs'),
  ]);

  assertOrdered(host, ['backend_thread_main(void *arg)', 'oliphaunt_embedded_main(']);
  assert.ok(broker.includes('mode: EngineMode::Direct'));
  assert.ok(server.includes('Command::new(executable)'));
});

test('event-trigger backend truth table preserves PostgreSQL escape hatches', () => {
  const runnable = ({underPostmaster, regularBackend, eventTriggers = true}) =>
    (underPostmaster || regularBackend) && eventTriggers;
  const cases = [
    ['Native Direct', false, true, true],
    ['Native Broker helper', false, true, true],
    ['Native Server child', true, true, true],
    ['standalone single-user', false, false, false],
    ['bootstrap', false, false, false],
    ['postmaster auxiliary preserves upstream gate', true, false, true],
  ];

  for (const [name, underPostmaster, regularBackend, expected] of cases) {
    assert.equal(runnable({underPostmaster, regularBackend}), expected, name);
  }
  assert.equal(runnable({underPostmaster: false, regularBackend: true, eventTriggers: false}), false);
  assert.equal(runnable({underPostmaster: true, regularBackend: false, eventTriggers: false}), false);
});

test('the next cached Native artifact smoke proves DDL trigger and GUC behavior', async () => {
  const smoke = await source(
    'src/runtimes/liboliphaunt/native/smoke/liboliphaunt_smoke.c',
  );
  assert.ok(smoke.includes('CREATE EVENT TRIGGER liboliphaunt_ddl_end'));
  assertOrdered(smoke, [
    'SET event_triggers = off',
    'CREATE TABLE liboliphaunt_event_off',
    'SET event_triggers = on',
    'CREATE TABLE liboliphaunt_event_on',
    '1:CREATE TABLE',
  ]);
});
