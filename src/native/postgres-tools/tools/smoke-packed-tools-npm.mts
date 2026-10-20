#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOL = 'smoke-packed-tools-npm.mts';
const ENGINE_FLAG = '--engine';

if (process.argv.includes(ENGINE_FLAG)) {
  await runConsumer(readEngine(process.argv.slice(2)), process.argv.includes('--output-only'));
} else {
  if (process.argv.length !== 4)
    throw new Error('usage: smoke-packed-tools-npm.mts ASSET_DIR STAGE_DIR');
  await prepareConsumer(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
}

async function prepareConsumer(assetDir, scratch) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const { currentProductVersionSync } = await import(
    pathToFileURL(path.join(repositoryRoot, 'tools/release/release-artifact-targets.mts')).href
  );
  const { liboliphauntToolsNpmTarballs } = await import(
    pathToFileURL(path.join(repositoryRoot, 'src/native/postgres-tools/tools/package-carriers.mts'))
      .href
  );
  const version = currentProductVersionSync('postgres-tools-native', TOOL);
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
  await copyFile(fileURLToPath(import.meta.url), path.join(scratch, 'smoke.mts'));
  await writeFile(path.join(scratch, 'tarballs'), facade + '\0' + carrier + '\0');
}

async function runConsumer(engine, outputOnly) {
  const connectionString = requiredEnvironment('OLIPHAUNT_NATIVE_TOOLS_CONNECTION_STRING');
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
    if (outputOnly) {
      await verifyOutputDestinations(sourceConnection, restoredConnection, suffix);
      console.log(`OLIPHAUNT_NATIVE_TOOLS_OUTPUT_SMOKE_PASS engine=${engine}`);
      return;
    }
    const contract = JSON.parse(
      await readFile(requiredEnvironment('OLIPHAUNT_LOGICAL_TOOLS_CONTRACT'), 'utf8'),
    );
    const seed = await readFile(requiredEnvironment('OLIPHAUNT_LOGICAL_TOOLS_SEED'), 'utf8');
    const verify = await readFile(requiredEnvironment('OLIPHAUNT_LOGICAL_TOOLS_VERIFY'), 'utf8');
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

async function verifyOutputDestinations(sourceConnection, restoredConnection, suffix) {
  const {
    pgDump,
    pgDumpToFile,
    pgDumpToStream,
    psql,
    psqlToFile,
    psqlToStream,
    PostgresToolError,
  } = await import('@oliphaunt/tools');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oliphaunt-tools-output-'));
  const role = `dump_reader_${suffix}`;
  const reader = new URL(sourceConnection);
  reader.username = role;
  const options = { args: ['--restrict-key=oliphauntOutputTest'] };
  try {
    await psql(sourceConnection, {
      command: `CREATE TABLE dump_payload AS SELECT g AS id, repeat('λ', 4096) AS value FROM generate_series(1, 8193) AS g; CREATE TABLE effects(value integer); CREATE ROLE ${quoteIdentifier(role)} LOGIN; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(role)}`,
    });
    const destination = path.join(root, 'dump.sql');
    const summary = await pgDumpToFile(reader.href, destination, options);
    assert(summary.stdoutBytes > 64 * 1024 * 1024);
    const dump = await readFile(destination);
    assert.equal(dump.length, summary.stdoutBytes);
    assert.equal(await pgDump(reader.href, options), dump.toString('utf8'));
    await assert.rejects(
      pgDumpToFile(reader.href, destination, options),
      (error) => error instanceof PostgresToolError && error.exitCode === 0,
    );
    assert.equal((await stat(destination)).size, dump.length);
    if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);

    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const firstWrite = new Promise((resolve) => {
      started = resolve;
    });
    let calls = 0;
    const hash = createHash('sha256');
    const stream = new WritableStream({
      async write(chunk) {
        assert(chunk instanceof Uint8Array && chunk.length <= 64 * 1024);
        hash.update(chunk);
        if (++calls === 1) {
          started();
          await blocked;
        }
      },
    });
    const running = pgDumpToStream(reader.href, stream, options);
    await firstWrite;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    release();
    assert.equal((await running).stdoutBytes, dump.length);
    assert.equal(hash.digest('hex'), createHash('sha256').update(dump).digest('hex'));
    await stream.getWriter().close();
    await psql(restoredConnection, { script: dump.toString('utf8') });
    assert.equal(
      (
        await psql(restoredConnection, {
          args: ['-tA'],
          command: 'SELECT count(*) FROM dump_payload WHERE octet_length(value) = 8192',
        })
      ).trim(),
      '8193',
    );

    let hugeBytes = 0;
    await psqlToStream(
      reader.href,
      new WritableStream({
        write(chunk) {
          hugeBytes += chunk.length;
        },
      }),
      { args: ['-tA'], command: "SELECT repeat('λ', 33554433)" },
    );
    assert(hugeBytes > 64 * 1024 * 1024);
    const failure = new Error('destination failed');
    await assert.rejects(
      psqlToStream(
        sourceConnection,
        new WritableStream({
          write() {
            throw failure;
          },
        }),
        { command: "INSERT INTO effects VALUES (1); SELECT repeat('x', 100000)" },
      ),
      (error) =>
        error instanceof PostgresToolError && error.exitCode === 0 && error.cause === failure,
    );
    assert.equal(
      (
        await psql(sourceConnection, { args: ['-tA'], command: 'SELECT count(*) FROM effects' })
      ).trim(),
      '1',
    );

    const failed = path.join(root, 'failed.sql');
    await assert.rejects(
      psqlToFile(sourceConnection, failed, { script: 'SELECT 1; SELECT 1 / 0' }),
      PostgresToolError,
    );
    assert.deepEqual(await readdir(root), ['dump.sql']);
    let diagnosticBytes = 0;
    const diagnostic = await psqlToStream(sourceConnection, new WritableStream({ write() {} }), {
      command:
        "DO $$ BEGIN FOR i IN 1..100 LOOP RAISE WARNING '%', repeat('w', 1024); END LOOP; END $$",
      stderr: new WritableStream({
        write(chunk) {
          diagnosticBytes += chunk.length;
        },
      }),
    });
    assert(diagnosticBytes > 100 * 1024);
    assert.equal(diagnostic.stderr.length, 8192);
    assert(diagnostic.stderrTruncated);

    const controller = new AbortController();
    let stalled;
    const stalledWrite = new Promise((resolve) => {
      stalled = resolve;
    });
    const cancelled = psqlToStream(
      sourceConnection,
      new WritableStream({
        write() {
          stalled();
          return new Promise(() => {});
        },
      }),
      {
        command: "SELECT repeat('x', 1048576) FROM generate_series(1, 32)",
        signal: controller.signal,
      },
    );
    await stalledWrite;
    controller.abort(new Error('cancelled stalled destination'));
    await assert.rejects(
      cancelled,
      (error) =>
        error instanceof PostgresToolError && (error.signal !== null || error.exitCode !== 0),
    );

    const finalController = new AbortController();
    const finalFailure = new Error('cancelled final destination write');
    let finalStarted;
    const finalWriteStarted = new Promise((resolve) => {
      finalStarted = resolve;
    });
    let releaseFinal;
    const finalWrite = new Promise((resolve) => {
      releaseFinal = resolve;
    });
    const finalOutput = psqlToStream(
      sourceConnection,
      new WritableStream({
        write(chunk) {
          finalStarted(Number(new TextDecoder().decode(chunk).trim()));
          return finalWrite;
        },
      }),
      // The shell's parent is psql, whose final output fits in its pipe.
      { script: '\\! echo $PPID\n', signal: finalController.signal },
    );
    let timeout;
    try {
      const pid = await finalWriteStarted;
      assert(Number.isSafeInteger(pid) && pid > 0);
      const deadline = performance.now() + 5000;
      for (;;) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') break;
          throw error;
        }
        assert(performance.now() < deadline, 'psql did not exit before its final write settled');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      finalController.abort(finalFailure);
      await assert.rejects(
        Promise.race([
          finalOutput,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('final output cancellation stalled')),
              1000,
            );
          }),
        ]),
        (error) =>
          error instanceof PostgresToolError &&
          error.exitCode === 0 &&
          error.signal === null &&
          error.cause === finalFailure,
      );
    } finally {
      clearTimeout(timeout);
      releaseFinal();
      await finalOutput.catch(() => {});
    }
    assert.equal(
      (await psql(sourceConnection, { args: ['-tA'], command: 'SELECT 42' })).trim(),
      '42',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await psql(restoredConnection, { command: `DROP OWNED BY ${quoteIdentifier(role)}` });
    await psql(sourceConnection, {
      command: `DROP OWNED BY ${quoteIdentifier(role)}; DROP ROLE ${quoteIdentifier(role)}`,
    });
  }
}

function readEngine(arguments_) {
  if (
    (arguments_.length !== 2 && !(arguments_.length === 3 && arguments_[2] === '--output-only')) ||
    arguments_[0] !== ENGINE_FLAG
  ) {
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
