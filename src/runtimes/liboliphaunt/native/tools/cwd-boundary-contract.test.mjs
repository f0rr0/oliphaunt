import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function patchPath(name) {
  return fileURLToPath(new URL(`../patches/postgresql-18.4/${name}`, import.meta.url));
}

async function readPatch(name) {
  return readFile(patchPath(name), 'utf8');
}

function assertOrdered(text, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = text.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${label}: missing or unordered fragment ${JSON.stringify(fragment)}`);
    cursor = next;
  }
}

test('0005 owns early cwd capture and the terminal mutation boundary', async () => {
  const patch = await readPatch('0005-liboliphaunt-restore-host-cwd.patch');
  assert.match(patch, /terminal cleanup, not lifetime isolation/u);
  assert.match(patch, /bool\s+cwd_restore_required = false/u);
  assertOrdered(patch, [
    'getcwd(original_cwd, sizeof(original_cwd))',
    'original_cwd_fd = open(".", O_RDONLY | O_CLOEXEC)',
    'Assert(!IsUnderPostmaster)',
    'cwd_restore_required = true',
    'ChangeToDataDir()',
    'cwd_restore_required && chdir(original_cwd)',
    'cwd_restore_required && fchdir(original_cwd_fd)',
    'close(original_cwd_fd)',
  ], '0005 cwd lifecycle');
  assert.doesNotMatch(patch, /have_original_cwd/u);
});

test('0009 makes proc_exit unwinding non-local-exit safe and single-owner', async () => {
  const patch = await readPatch('0009-liboliphaunt-guard-embedded-proc-exit.patch');
  assert.match(patch, /heap-owned lifecycle object/u);
  assert.match(patch, /Automatic\n\+ \* objects modified after sigsetjmp\(\) would be indeterminate/u);
  assert.match(patch, /OliphauntEmbeddedLifecycle \*lifecycle/u);
  assert.doesNotMatch(patch, /OliphauntEmbeddedLifecycle\s+lifecycle;/u);
  assert.doesNotMatch(patch, /exit_guard|have_original_cwd/u);
  assertOrdered(patch, [
    'lifecycle = calloc(1, sizeof(*lifecycle))',
    'getcwd(lifecycle->original_cwd',
    'lifecycle->original_cwd_fd = open(".", O_RDONLY | O_CLOEXEC)',
    'sigsetjmp(lifecycle->proc_exit_env, 1)',
    'oliphaunt_embedded_install_proc_exit_handler(',
    'lifecycle->proc_exit_handler_armed = true',
    'if (!SelectConfigFiles(userDoption, progname))',
    'lifecycle->cwd_restore_required = true',
    'ChangeToDataDir()',
    'embedded_cleanup:',
    'oliphaunt_embedded_clear_proc_exit_handler(',
    'chdir(lifecycle->original_cwd)',
    'fchdir(lifecycle->original_cwd_fd)',
    'close(lifecycle->original_cwd_fd)',
    'close(lifecycle->socket_pair[1])',
    'close(lifecycle->socket_pair[0])',
    'free(lifecycle)',
  ], '0009 guarded lifecycle');
  assert.doesNotMatch(
    patch,
    /socket_pair\[0\][^\n]*&&\s*MyProcPort\s*==\s*NULL/u,
    'the lifecycle owns descriptor 0 even after pqcomm invalidates MyProcPort->sock',
  );
  assertOrdered(patch, [
    'oliphaunt_proc_exit_handler = NULL',
    'proc_exit_inprogress = false',
    'handler(code, context)',
  ], '0009 one-shot proc_exit escape');
  assert.match(
    patch,
    /if \(handler == NULL \|\| oliphaunt_proc_exit_handler != NULL\)\n\+\t\treturn false;/u,
  );
  assert.match(
    patch,
    /if \(!SelectConfigFiles\(userDoption, progname\)\)[\s\S]{0,240}\+\t\tlifecycle->rc = -1;\n\+\t\tgoto embedded_cleanup;/u,
  );
  assertOrdered(patch, [
    'oliphaunt_proc_exit_context = context',
    'oliphaunt_proc_exit_handler = handler',
  ], '0009 handler publication');
});

test('downstream patches preserve lifecycle ownership boundaries', async () => {
  const [runtimePaths, eventTriggers, socketPair] = await Promise.all([
    readPatch('0010-liboliphaunt-use-host-runtime-paths.patch'),
    readPatch('0012-liboliphaunt-enable-event-triggers-in-embedded-backend.patch'),
    readPatch('0014-liboliphaunt-use-portable-embedded-socketpair.patch'),
  ]);
  assert.doesNotMatch(runtimePaths, /have_original_cwd|cwd_restore_required|proc_exit_handler/u);
  assertOrdered(runtimePaths, [
    "!is_absolute_path(argv0)",
    'strlcpy(my_exec_path, argv0, MAXPGPATH) >= MAXPGPATH',
    'embedded PostgreSQL runtime anchor is too long',
    'canonicalize_path(my_exec_path)',
    '!is_absolute_path(module_dir)',
    'embedded PostgreSQL module directory must be absolute',
    'strlcpy(pkglib_path, module_dir, MAXPGPATH) >= MAXPGPATH',
    'embedded PostgreSQL module directory is too long',
    'canonicalize_path(pkglib_path)',
  ], '0010 fail-closed runtime path validation');
  assert.match(runtimePaths, /if \(!oliphaunt_embedded_set_runtime_paths\(argv\[0\]\)\)\n\+\t\tset_pglocale_pgservice/u);
  assert.match(eventTriggers, /bool\s+entrypoint_admitted;/u);
  assert.match(eventTriggers, /if \(!AdmitEmbeddedEntrypoint\(\)\)/u);
  assert.match(eventTriggers, /lifecycle->rc = -1;\n\+\t\tgoto embedded_cleanup;/u);
  assertOrdered(eventTriggers, [
    'if (!AdmitEmbeddedEntrypoint())',
    'goto embedded_cleanup',
    'lifecycle->entrypoint_admitted = true',
  ], '0012 admission ownership publication');
  assert.doesNotMatch(eventTriggers, /set_proc_exit_handler\(NULL, NULL\)|clear_proc_exit_handler/u);
  assert.match(socketPair, /pgsocket\s+socket_pair\[2\]/u);
  assert.match(socketPair, /oliphaunt_embedded_create_socketpair\(lifecycle->socket_pair\)/u);
  assert.match(socketPair, /closesocket\(lifecycle->socket_pair\[1\]\)/u);
  assert.match(socketPair, /closesocket\(lifecycle->socket_pair\[0\]\)/u);
  assert.doesNotMatch(socketPair, /static bool wsa_started/u);
  assert.match(socketPair, /could not initialize Winsock: error code %d/u);
  assert.match(
    socketPair,
    /if \(lifecycle->entrypoint_admitted && FeBeWaitSet != NULL\)/u,
    'a rejected contender must not free the admitted backend wait set',
  );
  assertOrdered(socketPair, [
    'WSAStartup(MAKEWORD(2, 2), &wsa_data)',
    'lifecycle->winsock_started = true',
    'if (!oliphaunt_embedded_set_runtime_paths(argv[0]))',
    'FreeWaitEventSet(FeBeWaitSet)',
    'closesocket(lifecycle->socket_pair[1])',
    'closesocket(lifecycle->socket_pair[0])',
    'WSACleanup()',
  ], '0014 Winsock and transport cleanup ownership');
  assert.match(socketPair, /before PostgreSQL initialization and preload\n\+?libraries/u);
  assert.doesNotMatch(
    socketPair,
    /^\+.*socket_pair\[0\][^\n]*&&\s*MyProcPort\s*==\s*NULL/gmu,
    'portable cleanup must close the PostgreSQL-facing socket unconditionally',
  );
});
