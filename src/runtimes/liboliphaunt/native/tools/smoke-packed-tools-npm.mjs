#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TOOL = 'smoke-packed-tools-npm.mjs';
const ENGINE_FLAG = '--engine';

if (process.argv.includes(ENGINE_FLAG)) {
  await runConsumer(readEngine(process.argv.slice(2)));
} else {
  await runOrchestrator(readAssetDirectory(process.argv.slice(2)));
}

async function runOrchestrator(assetDir) {
  const connectionString = requiredEnvironment('OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING');
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../..',
  );
  const { currentProductVersionSync } = await import(
    pathToFileURL(path.join(repositoryRoot, 'tools/release/release-artifact-targets.mjs')).href
  );
  const { liboliphauntToolsNpmTarballs } = await import(
    pathToFileURL(path.join(repositoryRoot, 'tools/release/package-release-carriers.mjs')).href
  );
  const version = currentProductVersionSync('liboliphaunt-native', TOOL);
  const packages = liboliphauntToolsNpmTarballs(version, {
    assetDir,
    targetIds: ['linux-x64-gnu'],
  });
  const packageFiles = new Map(packages);
  const facade = requiredPackage(packageFiles, '@oliphaunt/tools');
  const carrier = requiredPackage(packageFiles, '@oliphaunt/tools-linux-x64-gnu');
  if (packages.length !== 2 || packageFiles.size !== 2) {
    throw new Error(`${TOOL}: expected exactly the facade and Linux x64 carrier`);
  }

  const scratch = await mkdtemp(path.join(tmpdir(), 'oliphaunt-native-tools-npm-'));
  try {
    await writeFile(
      path.join(scratch, 'package.json'),
      `${JSON.stringify(
        {
          name: 'oliphaunt-native-tools-smoke-consumer',
          version: '0.0.0',
          private: true,
          type: 'module',
          dependencies: {
            '@oliphaunt/tools': version,
            '@oliphaunt/tools-linux-x64-gnu': version,
          },
        },
        null,
        2,
      )}\n`,
    );
    await copyFile(fileURLToPath(import.meta.url), path.join(scratch, 'smoke.mjs'));
    // The facade advertises every supported optional platform carrier. This
    // Linux-only lane materializes the two already-validated tarballs directly
    // so the smoke remains offline without manufacturing other-platform stubs.
    for (const [tarball, directory] of [
      [facade, path.join(scratch, 'node_modules/@oliphaunt/tools')],
      [carrier, path.join(scratch, 'node_modules/@oliphaunt/tools-linux-x64-gnu')],
    ]) {
      await mkdir(directory, { recursive: true });
      await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', directory]);
    }

    const fixtureRoot = path.join(repositoryRoot, 'src/shared/fixtures/postgres');
    const environment = {
      ...process.env,
      OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING: connectionString,
      OLIPHAUNT_LOGICAL_TOOLS_CONTRACT: path.join(fixtureRoot, 'logical-tools.json'),
      OLIPHAUNT_LOGICAL_TOOLS_SEED: path.join(fixtureRoot, 'logical-tools-seed.sql'),
      OLIPHAUNT_LOGICAL_TOOLS_VERIFY: path.join(fixtureRoot, 'logical-tools-verify.sql'),
    };
    const smoke = path.join(scratch, 'smoke.mjs');
    for (const [engine, command, args] of [
      ['node', 'node', [smoke, ENGINE_FLAG, 'node']],
      ['bun', path.join(repositoryRoot, 'tools/dev/bun.sh'), [smoke, ENGINE_FLAG, 'bun']],
      [
        'deno',
        path.join(repositoryRoot, 'tools/dev/deno.sh'),
        ['run', '--allow-all', smoke, ENGINE_FLAG, 'deno'],
      ],
    ]) {
      await run(command, args, { cwd: scratch, env: environment });
      console.log(`${TOOL}: ${engine} packed tools smoke passed`);
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function runConsumer(engine) {
  const connectionString = requiredEnvironment('OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING');
  const contract = JSON.parse(
    await readFile(requiredEnvironment('OLIPHAUNT_LOGICAL_TOOLS_CONTRACT'), 'utf8'),
  );
  const seed = await readFile(requiredEnvironment('OLIPHAUNT_LOGICAL_TOOLS_SEED'), 'utf8');
  const verify = await readFile(requiredEnvironment('OLIPHAUNT_LOGICAL_TOOLS_VERIFY'), 'utf8');
  const { pgDump, psql } = await import('@oliphaunt/tools');
  const suffix = `${engine}_${process.pid}`.replaceAll(/[^a-z0-9_]/gu, '_');
  const sourceDatabase = `oliphaunt_tools_${suffix}_source`;
  const restoredDatabase = `oliphaunt_tools_${suffix}_restored`;
  const sourceConnection = databaseConnectionString(connectionString, sourceDatabase);
  const restoredConnection = databaseConnectionString(connectionString, restoredDatabase);
  try {
    await psql(connectionString, { command: `CREATE DATABASE ${quoteIdentifier(sourceDatabase)}` });
    await psql(connectionString, {
      command: `CREATE DATABASE ${quoteIdentifier(restoredDatabase)}`,
    });
    await psql(sourceConnection, { script: seed });
    const dump = await pgDump(sourceConnection);
    if (
      !dump.includes('COPY public.logical_items') ||
      dump.includes('INSERT INTO public.logical_items')
    ) {
      throw new Error(`${engine}: pg_dump did not preserve PostgreSQL's ordinary COPY output`);
    }
    await psql(restoredConnection, { script: dump });
    const actual = (await psql(restoredConnection, { args: ['-tA'], script: verify })).trim();
    const expected = expectedLogicalToolsRow(contract);
    if (actual !== expected) {
      throw new Error(
        `${engine}: logical tools round trip returned ${JSON.stringify(actual)}, ` +
          `expected ${JSON.stringify(expected)}`,
      );
    }
    console.log(`OLIPHAUNT_NATIVE_TOOLS_NPM_SMOKE_PASS engine=${engine}`);
  } finally {
    for (const database of [restoredDatabase, sourceDatabase]) {
      try {
        await psql(connectionString, {
          command: `DROP DATABASE IF EXISTS ${quoteIdentifier(database)} WITH (FORCE)`,
        });
      } catch (error) {
        console.error(`${TOOL}: failed to drop ${database}: ${error?.stack ?? error}`);
      }
    }
  }
}

function readAssetDirectory(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== '--asset-dir') {
    throw new Error(`usage: ${TOOL} --asset-dir DIRECTORY`);
  }
  return path.resolve(arguments_[1]);
}

function readEngine(arguments_) {
  if (arguments_.length !== 2 || arguments_[0] !== ENGINE_FLAG) {
    throw new Error(`usage: ${TOOL} ${ENGINE_FLAG} node|bun|deno`);
  }
  if (!new Set(['node', 'bun', 'deno']).has(arguments_[1])) {
    throw new Error(`${TOOL}: unsupported engine ${JSON.stringify(arguments_[1])}`);
  }
  return arguments_[1];
}

function requiredPackage(packages, name) {
  const file = packages.get(name);
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(`${TOOL}: packed package ${name} is missing`);
  }
  return file;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${TOOL}: ${name} is required`);
  }
  return value;
}

function databaseConnectionString(connectionString, database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function expectedLogicalToolsRow(contract) {
  const expected = contract.expected;
  return [
    expected.rows,
    expected.sum,
    expected.sequenceLastValue,
    expected.quotedValue,
    expected.normalizedMatches,
    expected.extensionLoaded ? 't' : 'f',
  ].join('|');
}

async function run(command, args, { cwd, env = process.env } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error?.stdout) process.stdout.write(error.stdout);
    if (error?.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
