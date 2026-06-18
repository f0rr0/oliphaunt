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
    'src/sdks/kotlin/oliphaunt/src/generated/extensions.json',
    'src/sdks/react-native/src/generated/extensions.ts',
    'src/sdks/react-native/src/generated/extensions.json',
    'src/extensions/generated/mobile/static-registry.json',
    'src/extensions/generated/mobile/static-extensions.tsv',
    'src/extensions/generated/wasix/extensions.json',
    'src/extensions/tools/check-extension-model.py',
  ]) {
    requireFile(path);
  }

  const result = spawnSync('python3', ['src/extensions/tools/check-extension-model.py', '--check'], {
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

  const removedName = 'pg' + 'lite';
  const grep = run('git', [
    'grep',
    '-I',
    '-i',
    '-n',
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
    '--',
    ':!target/**',
    ':!node_modules/**',
  ]);
  if (grep.status === 0) {
    console.error(grep.stdout);
    fail('removed upstream identifiers remain in tracked source');
  }
  if (grep.status !== 1) {
    process.exit(grep.status ?? 1);
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
