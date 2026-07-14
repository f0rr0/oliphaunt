#!/usr/bin/env bun
import {existsSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function workspaceRoot() {
  const result = run('git', ['rev-parse', '--show-toplevel']);
  const root = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (root) {
    return root;
  }
  const cwd = process.cwd();
  if (cwd) {
    return cwd;
  }
  throw new Error('could not determine workspace root');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireFile(path) {
  if (!existsSync(path)) {
    fail(`missing required file: ${path}`);
  }
}

function requireText(path, text) {
  requireFile(path);
  const contents = readFileSync(path, 'utf8');
  if (!contents.includes(text)) {
    fail(`${path} must contain ${text}`);
  }
}

function gitGrep(args) {
  const result = run('git', ['grep', '-I', '-n', ...args, '--', ':!target/**', ':!node_modules/**']);
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean);
}

function grepLinePath(line) {
  const separator = line.indexOf(':');
  return separator === -1 ? line : line.slice(0, separator);
}

function unexpectedGrepLines(lines, allowedPaths) {
  const allowed = new Set(allowedPaths);
  return lines.filter((line) => !allowed.has(grepLinePath(line)));
}

function checkPostgres18() {
  requireText('src/postgres/versions/18/source.toml', 'version = "18.4"');
  requireText('src/postgres/versions/18/source.toml', 'postgresql-18.4.tar.bz2');
  requireText('src/postgres/versions/18/source.toml', 'sha256 = "');
}

function checkThirdParty() {
  checkThirdPartyShared();
  checkThirdPartyNative();
  checkThirdPartyWasix();
}

function checkThirdPartyShared() {
  for (const path of [
    'src/sources/third-party/shared/icu.toml',
    'src/sources/third-party/shared/openssl.toml',
  ]) {
    requireText(path, 'name = "');
    requireText(path, 'commit = "');
  }
}

function checkThirdPartyNative() {
  requireFile('src/sources/third-party/native/README.md');
}

function checkThirdPartyWasix() {
  requireFile('src/sources/third-party/wasix/README.md');
}

function checkToolchains() {
  requireText('src/sources/toolchains/wasix.toml', '[toolchain]');
  requireText('src/sources/toolchains/wasix.toml', '[build]');
  requireText('src/sources/toolchains/maestro.toml', '[toolchain]');
  requireText('src/sources/toolchains/maestro.toml', 'cloud_required = false');
  requireText('src/sources/toolchains/android-emulator-runner.toml', 'repository = "ReactiveCircus/android-emulator-runner"');
  requireText('src/sources/toolchains/android-emulator-runner.toml', 'sha = "70f4dee990796918b78d040e3278474bdbd348a7"');
  requireText('src/sources/toolchains/android-emulator-runner.toml', 'cloud_required = false');
}

function checkExtensions() {
  for (const path of [
    'src/extensions/catalog/extensions.promoted.toml',
    'src/extensions/catalog/extensions.smoke.toml',
    'src/extensions/contrib/postgres18.toml',
    'src/extensions/external/README.md',
    'src/extensions/external/vector/source.toml',
    'src/extensions/external/postgis/source.toml',
    'src/extensions/external/postgis/dependencies/geos/source.toml',
    'src/extensions/external/postgis/dependencies/proj/source.toml',
    'src/extensions/external/postgis/dependencies/sqlite/source.toml',
    'src/extensions/external/postgis/dependencies/libxml2/source.toml',
    'src/extensions/external/postgis/dependencies/json-c/source.toml',
    'src/extensions/external/postgis/dependencies/libiconv/source.toml',
    'src/extensions/schemas/recipe.schema.json',
    'src/extensions/schemas/support-table.schema.json',
    'src/extensions/evidence/matrix.toml',
    'src/extensions/evidence/schemas/matrix.schema.json',
    'src/extensions/evidence/schemas/run.schema.json',
    'src/extensions/evidence/runs/2026-06-07-transitional-catalog-smoke.json',
    'src/extensions/generated/extensions.catalog.json',
    'src/extensions/generated/extensions.build-plan.json',
    'src/extensions/generated/contrib-build.tsv',
    'src/extensions/generated/pgxs-build.tsv',
    'src/extensions/generated/docs/extensions.json',
    'src/extensions/generated/docs/extension-evidence.json',
    'src/extensions/generated/sdk/rust.json',
    'src/extensions/generated/sdk/swift.json',
    'src/extensions/generated/sdk/kotlin.json',
    'src/extensions/generated/sdk/js.json',
    'src/extensions/generated/sdk/react-native.json',
    'src/sdks/rust/src/generated/extensions.rs',
    'src/sdks/js/src/generated/extensions.ts',
    'src/sdks/kotlin/oliphaunt/src/commonMain/kotlin/dev/oliphaunt/GeneratedExtensions.kt',
    'src/sdks/kotlin/oliphaunt/src/generated/extensions.json',
    'src/sdks/react-native/src/generated/extensions.ts',
    'src/sdks/react-native/src/generated/extensions.json',
    'src/extensions/generated/mobile/static-registry.json',
    'src/extensions/generated/mobile/static-extensions.tsv',
    'src/extensions/generated/wasix/extensions.json',
    'src/extensions/tools/check-extension-model.mjs',
    'src/extensions/tools/check-extension-model.py',
  ]) {
    requireFile(path);
  }

  const result = spawnSync('tools/dev/bun.sh', ['src/extensions/tools/check-extension-model.mjs', '--check'], {
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function checkRepoPolicy() {
  const ephemeralExampleLockfiles = [
    'examples/electron-wasix/src-wasix/Cargo.lock',
    'examples/tauri/src-tauri/Cargo.lock',
    'examples/tauri-wasix/src-tauri/Cargo.lock',
    'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.lock',
  ];
  const registryNeutralExampleManifests = [
    'examples/electron-wasix/src-wasix/Cargo.toml',
    'examples/tauri/src-tauri/Cargo.toml',
    'examples/tauri-wasix/src-tauri/Cargo.toml',
    'src/bindings/wasix-rust/examples/tauri-sqlx-vanilla/src-tauri/Cargo.toml',
  ];

  const assets = run('git', ['ls-files', 'assets']);
  if (assets.status !== 0) {
    process.exit(assets.status ?? 1);
  }
  if (assets.stdout.trim().length > 0) {
    fail(`root assets/ must not contain tracked files:\n${assets.stdout.trim()}`);
  }
  const retiredThirdParty = run('git', ['ls-files', 'src/third-party']);
  if (retiredThirdParty.status !== 0) {
    process.exit(retiredThirdParty.status ?? 1);
  }
  if (retiredThirdParty.stdout.trim().length > 0) {
    fail(`src/third-party must not contain tracked files:\n${retiredThirdParty.stdout.trim()}`);
  }

  requireFile('tools/policy/check-docs.sh');
  requireFile('tools/release/example-cargo-policy.mjs');
  requireFile('tools/release/validate-example-cargo-candidates.mjs');
  requireText('tools/release/example-cargo-registry.mjs', 'https://cargo.oliphaunt.invalid/index');
  requireText('examples/tools/check-lockfiles.sh', 'tools/release/example-cargo-policy.mjs --check');

  for (const manifest of registryNeutralExampleManifests) {
    requireFile(manifest);
    if (/\bregistry\s*=\s*["']oliphaunt-local["']/u.test(readFileSync(manifest, 'utf8'))) {
      fail(`${manifest} must use normal crates.io resolution; candidate patches belong only in release scratch space`);
    }
  }
  for (const lockfile of ephemeralExampleLockfiles) {
    if (existsSync(lockfile)) {
      fail(`${lockfile} must be generated only in release scratch space, not in the source tree`);
    }
    const ignored = run('git', ['check-ignore', '--no-index', '--quiet', '--', lockfile]);
    if (ignored.status !== 0) {
      fail(`${lockfile} must be explicitly ignored`);
    }
    const tracked = run('git', ['ls-files', '--cached', '--', lockfile]);
    if (tracked.status !== 0) {
      process.exit(tracked.status ?? 1);
    }
    if (tracked.stdout.trim().length > 0) {
      const pendingDeletion = run('git', ['status', '--short', '--', lockfile]);
      if (pendingDeletion.status !== 0 || !/(^|\n)( D|D )/u.test(pendingDeletion.stdout)) {
        fail(`${lockfile} must not be tracked`);
      }
    }
  }

  const removedName = 'pg' + 'lite';
  const grepLines = gitGrep([
    '-i',
    '-e',
    `@electric-sql/${removedName}`,
    '-e',
    `@electric-sql/${removedName}-socket`,
    '-e',
    `electric-sql/${removedName}`,
    '-e',
    `postgres-${removedName}`,
    '-e',
    `${removedName}-build`,
    '-e',
    `${removedName}-bindings`,
    '-e',
    `REL_17_5-${removedName}`,
    '-e',
    'pgl_startPG' + 'lite',
    '-e',
    'PG' + 'Lite',
    '-e',
    removedName,
  ]);
  const unexpectedLegacyLines = unexpectedGrepLines(grepLines, [
    'README.md',
    'docs/internal/OLIPHAUNT_README.md',
    'tools/policy/check-docs.sh',
  ]);
  if (unexpectedLegacyLines.length > 0) {
    console.error(unexpectedLegacyLines.join('\n'));
    fail('removed upstream identifiers remain in tracked source');
  }
}

process.chdir(workspaceRoot());

const scope = process.argv[2] ?? 'all';
switch (scope) {
  case 'postgres18':
    checkPostgres18();
    break;
  case 'third-party':
    checkThirdParty();
    break;
  case 'third-party-shared':
    checkThirdPartyShared();
    break;
  case 'third-party-native':
    checkThirdPartyNative();
    break;
  case 'third-party-wasix':
    checkThirdPartyWasix();
    break;
  case 'toolchains':
    checkToolchains();
    break;
  case 'extensions':
    checkPostgres18();
    checkThirdParty();
    checkExtensions();
    break;
  case 'all':
    checkPostgres18();
    checkThirdParty();
    checkToolchains();
    checkExtensions();
    checkRepoPolicy();
    break;
  default:
    fail('usage: assert-source-inputs.mjs [postgres18|third-party|third-party-shared|third-party-native|third-party-wasix|toolchains|extensions|all]');
}
