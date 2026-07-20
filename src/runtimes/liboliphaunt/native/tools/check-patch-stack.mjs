#!/usr/bin/env node
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const mode = process.argv[2] ?? '--check';
const outputPath = path.join(root, 'docs/internal/OLIPHAUNT_PATCH_STACK.md');
const sourceManifestPath = path.join(root, 'src/runtimes/liboliphaunt/native/postgres18/source.toml');
const PATCH_CONSUMERS = [
  'src/runtimes/liboliphaunt/native/bin/build-postgres18-android-arm64.sh',
  'src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-device.sh',
  'src/runtimes/liboliphaunt/native/bin/build-postgres18-ios-simulator.sh',
  'src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh',
  'src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh',
  'src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1',
  'src/runtimes/liboliphaunt/native/bin/check-postgres18-ios-simulator.sh',
];

const REQUIRED_AUDIT_CHECKS = [
  {
    id: 'host-io-vtable',
    requirement: 'Host-owned protocol I/O vtable',
    patches: ['0001-liboliphaunt-add-backend-host-io.patch'],
    evidence: ['OliphauntEmbeddedIO', 'secure_raw_read', 'secure_raw_write'],
    posture: 'Generic libpq backend hook; normal socket I/O remains untouched.',
  },
  {
    id: 'postmaster-waitset-guard',
    requirement: 'Standalone backend waitset guard',
    patches: ['0001-liboliphaunt-add-backend-host-io.patch'],
    evidence: ['WL_POSTMASTER_DEATH', 'if (IsUnderPostmaster)'],
    posture: 'Embedded standalone sessions avoid a postmaster-death wait handle that cannot exist.',
  },
  {
    id: 'embedded-entrypoint',
    requirement: 'Explicit embedded backend entrypoint',
    patches: ['0002-liboliphaunt-add-embedded-entrypoint.patch'],
    evidence: ['oliphaunt_embedded_main', 'pq_init(&client_sock)', 'PostgresMain(dbname, username)'],
    posture: 'Uses PostgreSQL backend initialization and FE/BE protocol instead of single-user query transport.',
  },
  {
    id: 'embedded-backend-return-contract',
    requirement: 'Embedded BackendMain may return without violating its declaration',
    patches: ['0013-liboliphaunt-fix-embedded-backend-main-return-contract.patch'],
    evidence: ['#ifdef OLIPHAUNT_EMBEDDED', 'extern void BackendMain', 'pg_noreturn extern void BackendMain'],
    posture: 'Only embedded builds drop pg_noreturn; normal PostgreSQL server builds retain the upstream non-returning contract.',
  },
  {
    id: 'frontend-terminate-return',
    requirement: 'Frontend Terminate returns to host owner',
    patches: ['0003-liboliphaunt-return-from-embedded-frontend-terminate.patch'],
    evidence: ['frontend sends Terminate', 'return;', 'proc_exit(0)'],
    posture: 'Only OLIPHAUNT_EMBEDDED changes backend termination into a returning thread lifecycle.',
  },
  {
    id: 'embedded-exit-cleanup',
    requirement: 'PostgreSQL exit callbacks still run',
    patches: ['0004-liboliphaunt-run-embedded-exit-cleanup.patch'],
    evidence: ['oliphaunt_embedded_proc_exit', 'proc_exit_prepare(code)'],
    posture: 'Keeps upstream cleanup ordering for shmem, locks, callbacks, and backend-local state.',
  },
  {
    id: 'fatal-startup-guard',
    requirement: 'Startup FATAL does not exit the host process',
    patches: ['0009-liboliphaunt-guard-embedded-proc-exit.patch'],
    evidence: ['oliphaunt_embedded_set_proc_exit_handler', 'siglongjmp', 'proc_exit_handler'],
    posture: 'Embedded startup failures unwind to liboliphaunt after PostgreSQL cleanup callbacks run.',
  },
  {
    id: 'fatal-startup-cleanup-label',
    requirement: 'Embedded proc_exit guard is cleared before returning to host',
    patches: ['0009-liboliphaunt-guard-embedded-proc-exit.patch'],
    evidence: ['embedded_cleanup:', 'oliphaunt_embedded_set_proc_exit_handler(NULL, NULL)', 'chdir(original_cwd)'],
    posture: 'Normal and FATAL startup paths share one cleanup label so thread-local exit guards and host cwd are restored before returning.',
  },
  {
    id: 'cwd-restore',
    requirement: 'Host working directory is restored',
    patches: ['0005-liboliphaunt-restore-host-cwd.patch'],
    evidence: ['original_cwd', 'getcwd(original_cwd', 'chdir(original_cwd)'],
    posture: 'Contains PostgreSQL standalone ChangeToDataDir side effects inside the backend lifetime.',
  },
  {
    id: 'static-extension-loader',
    requirement: 'Static extension registry uses PostgreSQL dfmgr path',
    patches: ['0006-liboliphaunt-add-static-extension-loader.patch'],
    evidence: ['oliphaunt_static_extension_lookup', 'lookup_library_symbol', 'oliphaunt_static_extension_symbol'],
    posture: 'CREATE EXTENSION/LOAD semantics stay in PostgreSQL; hosts only provide module symbols.',
  },
  {
    id: 'msvc-static-extension-loader-defaults',
    requirement: 'MSVC PostgreSQL tools link without static extension providers',
    patches: ['0006-liboliphaunt-add-static-extension-loader.patch'],
    evidence: [
      'defined(_MSC_VER) && (defined(_M_X64) || defined(_M_ARM64))',
      '/alternatename:oliphaunt_static_extension_lookup=oliphaunt_static_extension_lookup_default',
      'oliphaunt_static_extension_symbol_default',
    ],
    posture: 'Meson-built PostgreSQL tools get no-op static extension hooks on MSVC; liboliphaunt still overrides them by linking the real registry provider.',
  },
  {
    id: 'portable-static-extension-loader-defaults',
    requirement: 'Portable PostgreSQL tools link without static extension providers',
    patches: ['0006-liboliphaunt-add-static-extension-loader.patch'],
    evidence: [
      '#define OLIPHAUNT_OPTIONAL_HOOK __attribute__((weak))',
      'oliphaunt_static_extension_lookup(const char *filename)',
      'oliphaunt_static_extension_init(const OliphauntStaticExtension *extension)',
    ],
    posture: 'Non-MSVC embedded PostgreSQL tool links get weak no-op static extension hooks; liboliphaunt overrides them by linking the real registry provider.',
  },
  {
    id: 'static-extension-magic',
    requirement: 'Static extension ABI magic is validated',
    patches: [
      '0006-liboliphaunt-add-static-extension-loader.patch',
      '0008-liboliphaunt-clean-embedded-symbols.patch',
    ],
    evidence: ['oliphaunt_static_extension_magic', 'Pg_magic_struct', 'memcmp(&magic_data_ptr->abi_fields'],
    posture: 'Static modules still pass PostgreSQL ABI checks before symbols are used.',
  },
  {
    id: 'host-runtime-paths',
    requirement: 'Runtime paths come from host-packaged resources',
    patches: ['0010-liboliphaunt-use-host-runtime-paths.patch'],
    evidence: ['oliphaunt_embedded_set_runtime_paths', 'OLIPHAUNT_EMBEDDED_MODULE_DIR', 'my_exec_path', 'PGSYSCONFDIR'],
    posture: 'Avoids executable-bit assumptions for mobile resources while preserving runtime path derivation and using host-packaged embedded modules for pkglib_path.',
  },
  {
    id: 'apple-mobile-shell-exclusion',
    requirement: 'Apple mobile builds do not call system(3)',
    patches: ['0007-liboliphaunt-disable-shell-commands-on-apple-mobile.patch'],
    evidence: ['OLIPHAUNT_EMBEDDED_NO_SHELL_COMMANDS', 'TARGET_OS_IPHONE', 'archive_command cannot be executed'],
    posture: 'Mobile direct mode fails optional shell archive/restore hooks explicitly instead of compiling unavailable APIs.',
  },
  {
    id: 'embedded-mobile-shared-memory',
    requirement: 'Embedded mobile shared memory and semaphores are process-local',
    patches: ['0011-liboliphaunt-add-android-embedded-shared-memory.patch'],
    evidence: ['oliphaunt_embedded_shmem.c', 'oliphaunt_embedded_sema.c', 'OLIPHAUNT_EMBEDDED_MOBILE_SHMEM'],
    posture: 'Android and Apple mobile builds avoid unavailable SysV shared memory and semaphores while direct mode remains one backend per process.',
  },
  {
    id: 'event-trigger-policy',
    requirement: 'Event triggers run in embedded protocol sessions',
    patches: ['0012-liboliphaunt-enable-event-triggers-in-embedded-backend.patch'],
    evidence: ['EventTriggersHaveRunnableBackend', 'OLIPHAUNT_EMBEDDED', 'event_triggers'],
    posture: 'Keeps upstream single-user escape hatch outside OLIPHAUNT_EMBEDDED but treats embedded protocol sessions as runnable backends.',
  },
  {
    id: 'embedded-meson-option',
    requirement: 'Meson builds expose an explicit embedded backend option',
    patches: ['0015-liboliphaunt-add-embedded-meson-option.patch'],
    evidence: ['oliphaunt_embedded', 'add_project_arguments', '-DOLIPHAUNT_EMBEDDED'],
    posture: 'Windows and other Meson-hosted embedded builds enable the backend entrypoint through PostgreSQL build configuration while default server builds remain unchanged.',
  },
  {
    id: 'optional-icu-initdb',
    requirement: 'Optional ICU data stays optional during initdb',
    patches: ['0016-liboliphaunt-skip-icu-collation-version-without-icu-data.patch'],
    evidence: ['getenv("ICU_DATA")', 'pg_collation_actual_version', 'pg_import_system_collations'],
    posture: 'Base liboliphaunt runtimes can bootstrap non-ICU databases without bundling optional ICU data; ICU packages keep upstream collation setup by setting ICU_DATA.',
  },
  {
    id: 'apple-dynahash-namespace',
    requirement: 'Apple builds namespace PostgreSQL dynahash symbols that collide with libSystem',
    patches: ['0017-liboliphaunt-namespace-dynahash-host-collisions.patch'],
    evidence: ['#ifdef __APPLE__', 'oliphaunt_pg_hash_create', 'oliphaunt_pg_hash_destroy', 'oliphaunt_pg_hash_search'],
    posture: 'Apple backend and extension objects share collision-free dynahash names; non-Apple PostgreSQL binary names remain unchanged.',
  },
  {
    id: 'embedded-procsignal-containment',
    requirement: 'Embedded ProcSignal delivery cannot escape into the host process',
    patches: ['0018-liboliphaunt-contain-embedded-proc-signals.patch'],
    evidence: ['oliphaunt_send_proc_signal', 'pid != MyProcPid', 'procsignal_sigusr1_handler(SIGUSR1)', 'host owns SIGUSR1'],
    posture: 'The one-backend embedded runtime dispatches ProcSignal flags synchronously, rejects foreign PIDs, and leaves the host SIGUSR1 disposition untouched; normal PostgreSQL server builds retain upstream signal delivery.',
  },
  {
    id: 'windows-embedded-module-provider',
    requirement: 'Windows embedded extension modules link to the host DLL provider',
    patches: ['0019-liboliphaunt-link-windows-embedded-modules-to-host.patch'],
    evidence: [
      'oliphaunt_embedded_module_provider',
      "requires an embedded MSVC Windows build",
      'pg_mod_link_args += oliphaunt_embedded_module_provider',
      "oliphaunt_embedded_module_provider == ''",
    ],
    posture: 'Embedded MSVC extension modules resolve PostgreSQL backend symbols from the oliphaunt host import library; ordinary PostgreSQL modules retain the upstream postgres executable link contract.',
  },
  {
    id: 'embedded-host-signal-boundary',
    requirement: 'Embedded backend and extension signal calls preserve host SIGUSR1 ownership',
    patches: ['0020-liboliphaunt-enforce-embedded-signal-boundary.patch'],
    evidence: [
      'oliphaunt_embedded_kill',
      'oliphaunt_embedded_raise',
      '!defined(FRONTEND)',
      'if (signo == SIGUSR1)',
    ],
    posture: 'Embedded backend and extension calls cannot replace or emit host-owned SIGUSR1; other signals delegate to the platform implementation, while frontend tools and normal PostgreSQL builds retain upstream behavior.',
  },
];

const EXPECTED_UPSTREAM_TOUCHPOINTS = new Map([
  ['meson.build', 'Meson-hosted embedded builds enable OLIPHAUNT_EMBEDDED through an explicit opt-in build option.'],
  ['meson_options.txt', 'Meson-hosted embedded builds declare opt-in backend and Windows module-provider options without changing default PostgreSQL builds.'],
  ['src/backend/access/transam/xlogarchive.c', 'Apple mobile embedded builds compile out optional archive shell commands.'],
  ['src/backend/archive/shell_archive.c', 'Apple mobile embedded builds compile out optional archive shell commands.'],
  ['src/backend/commands/event_trigger.c', 'Embedded FE/BE protocol sessions can run event triggers without changing standalone recovery behavior.'],
  ['src/backend/libpq/be-secure.c', 'Backend secure read/write path delegates to a host I/O vtable only when OLIPHAUNT_EMBEDDED is set.'],
  ['src/backend/libpq/pqcomm.c', 'Standalone embedded sessions avoid waiting on a non-existent postmaster death latch.'],
  ['src/backend/port/Makefile', 'Embedded mobile builds swap unavailable SysV shared memory and semaphores for process-local implementations.'],
  ['src/backend/port/meson.build', 'Android embedded builds swap unavailable SysV shared memory and semaphores for process-local implementations.'],
  ['src/backend/port/oliphaunt_embedded_sema.c', 'Embedded mobile semaphore implementation for one backend in one process.'],
  ['src/backend/port/oliphaunt_embedded_shmem.c', 'Embedded mobile shared memory implementation for one backend in one process.'],
  ['src/backend/meson.build', 'Embedded MSVC extension modules link to the oliphaunt host import library instead of the standalone postgres executable.'],
  ['src/backend/storage/ipc/ipc.c', 'Embedded backend cleanup and proc_exit unwinding stay at PostgreSQL lifecycle boundaries.'],
  ['src/backend/storage/ipc/procsignal.c', 'The one-backend embedded runtime dispatches ProcSignal flags without sending process-directed host signals.'],
  ['src/backend/tcop/postgres.c', 'Embedded backend entrypoint, protocol lifecycle, cwd restoration, host runtime paths, and host-owned SIGUSR1 disposition.'],
  ['src/backend/utils/fmgr/dfmgr.c', 'Static extension lookup reuses PostgreSQL dynamic function manager semantics.'],
  ['src/bin/initdb/initdb.c', 'Base runtimes skip ICU-backed collation setup until optional ICU data is present.'],
  ['src/include/libpq/libpq-be.h', 'Host I/O vtable is attached to PostgreSQL Port state under OLIPHAUNT_EMBEDDED.'],
  ['src/include/tcop/backend_startup.h', 'Embedded BackendMain may return after its returning PostgresMain call without retaining an invalid pg_noreturn declaration.'],
  ['src/include/port.h', 'Embedded mobile builds avoid POSIX shared memory declarations and route embedded backend signal calls through the host-safe provider boundary.'],
  ['src/include/storage/dsm_impl.h', 'Embedded mobile builds keep DSM on mmap instead of POSIX or SysV shared memory.'],
  ['src/include/storage/ipc.h', 'Embedded cleanup and proc_exit guard declarations.'],
  ['src/include/tcop/tcopprot.h', 'Embedded entrypoint and returning PostgresMain declarations.'],
  ['src/include/utils/hsearch.h', 'Apple builds namespace PostgreSQL dynahash symbols that otherwise bind to unrelated libSystem exports.'],
  ['src/port/chklocale.c', 'Android embedded builds avoid unsupported locale-environment mutation.'],
  ['src/port/pqsignal.c', 'Embedded backend signal registration and emission preserve the host-owned SIGUSR1 disposition while delegating other signals.'],
]);

if (!['--check', '--write'].includes(mode)) {
  console.error('usage: src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs [--check|--write]');
  process.exit(2);
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function parseSourceManifest() {
  const text = readFileSync(sourceManifestPath, 'utf8');
  const version = matchRequired(text, /version\s*=\s*"([^"]+)"/u, 'postgresql.version');
  const url = matchRequired(text, /url\s*=\s*"([^"]+)"/u, 'postgresql.url');
  const sha256 = matchRequired(text, /sha256\s*=\s*"([^"]+)"/u, 'postgresql.sha256');
  const directory = matchRequired(text, /directory\s*=\s*"([^"]+)"/u, 'patches.directory');
  const seriesBlock = matchRequired(text, /series\s*=\s*\[([\s\S]*?)\]/u, 'patches.series');
  const series = Array.from(seriesBlock.matchAll(/"([^"]+\.patch)"/gu), match => match[1]);
  if (series.length === 0) {
    throw new Error('src/runtimes/liboliphaunt/native/postgres18/source.toml patch series is empty');
  }
  const patchDir = path.resolve(path.dirname(sourceManifestPath), directory);
  return {version, url, sha256, directory, patchDir, series};
}

function matchRequired(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`missing ${label} in src/runtimes/liboliphaunt/native/postgres18/source.toml`);
  }
  return match[1];
}

function patchFiles(patchDir) {
  return readdirSync(patchDir)
    .filter(name => name.endsWith('.patch'))
    .sort();
}

function parsePatch(fileName, patchDir) {
  const relativePath = `src/runtimes/liboliphaunt/native/patches/${path.basename(patchDir)}/${fileName}`;
  const text = read(relativePath);
  const trailingWhitespaceLine = text
    .split(/\r?\n/u)
    .findIndex(line => /[\t ]+$/u.test(line));
  if (trailingWhitespaceLine !== -1) {
    throw new Error(
      `${relativePath}:${trailingWhitespaceLine + 1} contains trailing whitespace`,
    );
  }
  if (/\r?\n-- ?\r?\n[0-9]+(?:[.][0-9]+){1,2}\r?\n?$/u.test(text)) {
    throw new Error(`${relativePath} must not include a format-patch tool signature footer`);
  }
  const syntax = spawnSync('git', ['apply', '--numstat', '--whitespace=error-all', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (syntax.error !== undefined || syntax.status !== 0 || syntax.stderr.trim() !== '') {
    const detail = syntax.error?.message ?? (syntax.stderr.trim() || `git apply exited ${syntax.status}`);
    throw new Error(`${relativePath} is not a warning-free strict Git patch: ${detail}`);
  }
  const author = text.match(/^From:\s+(.+)$/mu)?.[1];
  if (!author) {
    throw new Error(`${relativePath} must have a deterministic From: header`);
  }
  if (author !== 'liboliphaunt <liboliphaunt@example.invalid>') {
    throw new Error(
      `${relativePath} From: header must be "liboliphaunt <liboliphaunt@example.invalid>", got ${author}`,
    );
  }
  const subjectHeader = text.match(/^Subject:[ \t]+(.+(?:\r?\n[ \t]+.+)*)/mu)?.[1]
    ?.replace(/\r?\n[ \t]+/gu, ' ');
  const subject = subjectHeader?.match(/^\[PATCH\][ \t]+(.+)$/u)?.[1];
  if (!subject) {
    throw new Error(`${relativePath} must have a deterministic Subject: [PATCH] header`);
  }
  if (!subject.startsWith('liboliphaunt: ')) {
    throw new Error(`${relativePath} subject must start with "liboliphaunt: "`);
  }

  const changedFiles = Array.from(
    text.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gmu),
    match => match[2],
  );
  if (changedFiles.length === 0) {
    throw new Error(`${relativePath} does not contain any diff --git file entries`);
  }

  const forbidden = [];
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
    if (/\b(Swift|Kotlin|React|JavaScript|TypeScript|wasix|wasmer|wasm|oliphaunt-wasix)\b/iu.test(line)) {
      forbidden.push(line);
    }
    if (/\b(extern|PGDLLIMPORT|oliphaunt_embedded_main|oliphaunt_embedded_proc_exit)\b/u.test(line)) {
      for (const symbol of line.matchAll(/\b(oliphaunt_[A-Za-z0-9_]+)\b/gu)) {
        symbols.add(symbol[1]);
      }
    }
  }
  if (forbidden.length > 0) {
    throw new Error(
      `${relativePath} contains product-specific terms in added PostgreSQL code:\n${forbidden.join('\n')}`,
    );
  }
  if (whitespaceProblems.length > 0) {
    throw new Error(
      `${relativePath} contains whitespace problems in added PostgreSQL code:\n${whitespaceProblems.join('\n')}`,
    );
  }

  return {
    fileName,
    relativePath,
    author,
    subject,
    changedFiles,
    symbols: Array.from(symbols).sort(),
  };
}

function validateSeries(manifest, actualFiles) {
  const expected = manifest.series;
  if (JSON.stringify(expected) !== JSON.stringify(actualFiles)) {
    const expectedText = expected.map(name => `  ${name}`).join('\n');
    const actualText = actualFiles.map(name => `  ${name}`).join('\n');
    throw new Error(
      `source.toml patch series must exactly match patch directory files\nexpected:\n${expectedText}\nactual:\n${actualText}`,
    );
  }
}

function validatePatchConsumers() {
  for (const consumer of PATCH_CONSUMERS) {
    const text = read(consumer);
    if (text.includes('--recount') || text.includes('--whitespace=nowarn')) {
      throw new Error(`${consumer} must not relax PostgreSQL patch parsing with --recount or --whitespace=nowarn`);
    }
    if (!text.includes('git apply --whitespace=error-all')) {
      throw new Error(`${consumer} must apply PostgreSQL patches with git apply --whitespace=error-all`);
    }
  }
}

function render() {
  const manifest = parseSourceManifest();
  const actualFiles = patchFiles(manifest.patchDir);
  validateSeries(manifest, actualFiles);
  validatePatchConsumers();
  const patches = actualFiles.map(fileName => parsePatch(fileName, manifest.patchDir));
  const patchesByName = new Map(patches.map(patch => [patch.fileName, patch]));

  const changedFiles = new Map();
  const symbols = new Map();
  for (const patch of patches) {
    for (const file of patch.changedFiles) {
      if (!changedFiles.has(file)) {
        changedFiles.set(file, []);
      }
      changedFiles.get(file).push(patch.fileName);
    }
    for (const symbol of patch.symbols) {
      if (!symbols.has(symbol)) {
        symbols.set(symbol, []);
      }
      symbols.get(symbol).push(patch.fileName);
    }
  }

  for (const file of changedFiles.keys()) {
    if (!EXPECTED_UPSTREAM_TOUCHPOINTS.has(file)) {
      throw new Error(
        `patch-stack audit found unexpected upstream touchpoint ${file}; add an explicit rationale before changing it`,
      );
    }
  }
  for (const file of EXPECTED_UPSTREAM_TOUCHPOINTS.keys()) {
    if (!changedFiles.has(file)) {
      throw new Error(`patch-stack audit expected upstream touchpoint ${file} is no longer changed`);
    }
  }

  for (const check of REQUIRED_AUDIT_CHECKS) {
    for (const patchName of check.patches) {
      if (!patchesByName.has(patchName)) {
        throw new Error(`patch-stack audit check ${check.id} references missing patch ${patchName}`);
      }
    }
    const checkText = check.patches
      .map(patchName => read(patchesByName.get(patchName).relativePath))
      .join('\n');
    const missing = check.evidence.filter(fragment => !checkText.includes(fragment));
    if (missing.length > 0) {
      throw new Error(
        `patch-stack audit check ${check.id} is missing evidence in ${check.patches.join(', ')}: ${missing.join(', ')}`,
      );
    }
  }

  const lines = [];
  lines.push('<!-- Generated by src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs; do not edit by hand. -->');
  lines.push('# liboliphaunt PostgreSQL 18 Patch Stack Review');
  lines.push('');
  lines.push('This source-only review artifact keeps the native PostgreSQL patch stack deterministic and reviewable without rebuilding PostgreSQL.');
  lines.push('');
  lines.push('Regenerate with:');
  lines.push('');
  lines.push('```sh');
  lines.push('src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs --write');
  lines.push('```');
  lines.push('');
  lines.push('## Source Pin');
  lines.push('');
  lines.push(`- PostgreSQL: \`${manifest.version}\``);
  lines.push(`- URL: \`${manifest.url}\``);
  lines.push(`- SHA-256: \`${manifest.sha256}\``);
  lines.push(`- Patch directory: \`${manifest.directory}\``);
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
  for (const [file, owners] of Array.from(changedFiles.entries()).sort()) {
    lines.push(`- \`${file}\` (${owners.map(owner => `\`${owner}\``).join(', ')})`);
  }
  lines.push('');
  lines.push('## Expected Upstream Touchpoints');
  lines.push('');
  lines.push('| File | Rationale |');
  lines.push('| --- | --- |');
  for (const [file, rationale] of Array.from(EXPECTED_UPSTREAM_TOUCHPOINTS.entries()).sort()) {
    lines.push(`| \`${file}\` | ${rationale} |`);
  }
  lines.push('');
  lines.push('## PostgreSQL Patch Symbols');
  lines.push('');
  if (symbols.size === 0) {
    lines.push('- none');
  } else {
    for (const [symbol, owners] of Array.from(symbols.entries()).sort()) {
      lines.push(`- \`${symbol}\` (${owners.map(owner => `\`${owner}\``).join(', ')})`);
    }
  }
  lines.push('');
  lines.push('## Audit Checklist');
  lines.push('');
  lines.push('| Requirement | Owning Patch | Required Evidence | Review Posture |');
  lines.push('| --- | --- | --- | --- |');
  for (const check of REQUIRED_AUDIT_CHECKS) {
    lines.push(
      `| ${check.requirement} | ${check.patches.map(patch => `\`${patch}\``).join(', ')} | ${check.evidence.map(fragment => `\`${fragment}\``).join(', ')} | ${check.posture} |`,
    );
  }
  lines.push('');
  lines.push('## Guardrails');
  lines.push('');
  lines.push('- `source.toml` patch series exactly matches the patch directory.');
  lines.push('- Every patch has a deterministic `From: liboliphaunt <liboliphaunt@example.invalid>` header.');
  lines.push('- Every patch has a deterministic `Subject: [PATCH] liboliphaunt: ...` header.');
  lines.push('- Entire patch files are checked for trailing whitespace; added PostgreSQL lines are also checked for space-before-tab indentation and SDK/runtime/product-specific terms that belong above PostgreSQL.');
  lines.push('- Changed upstream files must exactly match the expected touchpoint table above; new upstream touchpoints need an explicit rationale before landing.');
  lines.push('- Required audit checks prove their evidence in the named owning patch or patches, keeping host I/O, embedded lifecycle, cleanup, cwd restore, runtime paths, static extensions, host-signal containment, Windows module linkage, mobile shell exclusion, embedded mobile shared memory, and event triggers reviewable independently.');
  lines.push('- Changed upstream files and patch-introduced `oliphaunt_*` symbols are listed here for release review.');
  lines.push('');

  return `${lines.join('\n')}`;
}

function normalizeGeneratedMarkdown(text) {
  return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trimEnd();
}

try {
  const generated = render();
  if (mode === '--write') {
    writeFileSync(outputPath, generated, 'utf8');
  } else {
    const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
    if (normalizeGeneratedMarkdown(current) !== normalizeGeneratedMarkdown(generated)) {
      console.error('docs/internal/OLIPHAUNT_PATCH_STACK.md is stale; run src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs --write');
      process.exit(1);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
