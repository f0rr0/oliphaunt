import seedArchive from '@oliphaunt/seed-wasix-standard/seed.tar.zst?url';
import seedManifest from '@oliphaunt/seed-wasix-standard/manifest.json?url';
const seed = { archive: seedArchive, manifest: seedManifest };
import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import {
  PostgresToolError,
  pgDump,
  psql,
  pgDumpToStream,
  psqlToStream,
} from '@oliphaunt/wasix-tools';
import { indexedDB as indexedDbStorage } from '@oliphaunt/wasix-ts/storage/indexed-db';
import { opfs } from '@oliphaunt/wasix-ts/storage/opfs';
import type { OpenConfig } from '@oliphaunt/wasix-ts';
import logicalToolsFixtureJson from './logical-tools.json?raw';
import logicalToolsSeed from './logical-tools-seed.sql?raw';
import logicalToolsVerify from './logical-tools-verify.sql?raw';
import { expectDirectPgDump } from './direct-pg-dump-smoke.js';
const logicalToolsFixture = JSON.parse(logicalToolsFixtureJson);
const status = document.getElementById('status')!;
const output = document.getElementById('output')!;
try {
  const direct = await Oliphaunt.open({ seed, extensions: [pgtap] });
  try {
    await expectDirectPgDump(direct);
    const rejected = await pgDumpToStream(direct, new WritableStream()).catch((error) => error);
    if (!(rejected instanceof PostgresToolError) || !rejected.message.includes('/worker'))
      throw new Error('browser root async destination did not fail before execution');
  } finally {
    await direct.close();
  }
  const logicalTools = await expectLogicalTools();
  for (const [placement, storage] of [
    ['memory', undefined],
    ['indexed-db', indexedDbStorage(`tools-stream-idb-${crypto.randomUUID()}`)],
    ['opfs', opfs(`tools-stream-opfs-${crypto.randomUUID()}`)],
  ] as const) {
    await expectStreamDestinations(placement, storage);
  }
  status.textContent = 'PostgreSQL tools browser smoke passed.';
  output.textContent = JSON.stringify({ directPgDump: true, logicalTools });
  document.documentElement.dataset.oliphauntSmoke = 'passed';
} catch (error) {
  status.textContent = 'PostgreSQL tools browser smoke failed.';
  output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  document.documentElement.dataset.oliphauntSmoke = 'failed';
}

async function expectStreamDestinations(
  placement: string,
  storage: OpenConfig['storage'],
): Promise<void> {
  let source = await WorkerOliphaunt.open({ seed, storage });
  let target: Awaited<ReturnType<typeof WorkerOliphaunt.open>> | undefined;
  try {
    await source.execute('CREATE ROLE logical_owner LOGIN SUPERUSER');
    if (storage !== undefined) {
      await source.close();
      source = await WorkerOliphaunt.open({ seed, storage, username: 'logical_owner' });
    }
    await source.execute('CREATE TABLE stream_dump (id integer PRIMARY KEY, value text)');
    await source.execute(
      "INSERT INTO stream_dump SELECT i, repeat('λ', 4096) FROM generate_series(1, 8193) i",
    );
    await source.execute('CREATE TABLE stream_effects (value integer)');
    const options = { args: ['--restrict-key=OliphauntBrowserStreamTest'] };
    const sql = await pgDump(source, options);
    const expected = new TextEncoder().encode(sql);
    if (expected.length <= 64 * 1024 * 1024) throw new Error('browser dump did not exceed 64 MiB');
    let bytes = 0;
    let firstByteMs: number | undefined;
    const start = performance.now();
    const output = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (chunk.length > 64 * 1024) throw new Error('browser output callback exceeded batching');
        if (firstByteMs === undefined) {
          firstByteMs = performance.now() - start;
          const owned = chunk.slice();
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (!owned.every((byte, index) => byte === chunk[index]))
            throw new Error('browser output chunk was reused before acceptance');
        }
        for (const byte of chunk)
          if (byte !== expected[bytes++])
            throw new Error('browser stream differed from UTF-8 collector output');
      },
    });
    const summary = await pgDumpToStream(source, output, options);
    if (bytes !== expected.length || summary.stdoutBytes !== bytes || output.locked)
      throw new Error('browser async dump was truncated or retained destination ownership');
    console.log(
      `browser ${placement} stream: ${JSON.stringify({ bytes, firstByteMs, elapsedMs: performance.now() - start })}`,
    );
    target = await WorkerOliphaunt.open({ seed });
    await target.execute('CREATE ROLE logical_owner LOGIN');
    await psql(target, { script: sql });
    if (
      (await target.queryRaw('SELECT count(*)::int AS rows FROM stream_dump')).getText(
        0,
        'rows',
      ) !== '8193'
    )
      throw new Error('browser dump did not restore every row');
    await target.close();
    target = undefined;
    const cause = new Error('browser destination failed');
    const failed = await psqlToStream(
      source,
      new WritableStream({
        write() {
          throw cause;
        },
      }),
      { command: "INSERT INTO stream_effects VALUES (1); SELECT repeat('s', 1000000)" },
    ).catch((error) => error);
    if (!(failed instanceof PostgresToolError) || failed.exitCode !== 0 || failed.cause !== cause)
      throw new Error('browser sink failure lost completed tool metadata');
    if (
      (await source.queryRaw('SELECT count(*)::int AS rows FROM stream_effects')).getText(
        0,
        'rows',
      ) !== '1'
    )
      throw new Error('browser sink failure changed committed SQL');
    if (placement === 'memory') {
      let hugeBytes = 0;
      await psqlToStream(
        source,
        new WritableStream({
          write(chunk: Uint8Array) {
            if (chunk.length > 64 * 1024) throw new Error('oversized browser chunk');
            for (const byte of chunk) {
              if (byte !== (hugeBytes === 65 * 1024 * 1024 ? 10 : 88))
                throw new Error('browser huge value changed');
              hugeBytes++;
            }
          },
        }),
        {
          args: ['--tuples-only', '--no-align'],
          command: `SELECT repeat('X', ${65 * 1024 * 1024})`,
        },
      );
      if (hugeBytes !== 65 * 1024 * 1024 + 1) throw new Error('browser huge value was truncated');
      let diagnosticBytes = 0;
      const diagnostic = await psqlToStream(source, new WritableStream({ write() {} }), {
        command:
          "DO $$ BEGIN FOR i IN 1..24 LOOP RAISE WARNING '%', repeat('diagnostic', 1024); END LOOP; RAISE WARNING 'last diagnostic'; END $$",
        stderr: new WritableStream({
          write(chunk) {
            diagnosticBytes += chunk.length;
          },
        }),
      });
      if (
        diagnosticBytes <= 8192 ||
        !diagnostic.stderrTruncated ||
        new TextEncoder().encode(diagnostic.stderr).length > 8192 ||
        !diagnostic.stderr.includes('last diagnostic')
      )
        throw new Error('browser diagnostic stream or marked tail was lost');
      const controller = new AbortController();
      const reason = new Error('cancel browser sink');
      const cancelled = await psqlToStream(
        source,
        new WritableStream({
          write() {
            controller.abort(reason);
            return new Promise<void>(() => {});
          },
        }),
        { command: "SELECT repeat('c', 2000000)", signal: controller.signal },
      ).catch((error) => error);
      if (!(cancelled instanceof PostgresToolError) || cancelled.cause !== reason)
        throw new Error('browser stalled sink cancellation lost its cause');
    }
    if ((await source.queryRaw('SELECT 42 AS answer')).getText(0, 'answer') !== '42')
      throw new Error('browser database was unusable after output failure');
    if (storage !== undefined) {
      await source.close();
      source = await WorkerOliphaunt.open({ seed, storage, username: 'logical_owner' });
      if (
        (await source.queryRaw('SELECT count(*)::int AS rows FROM stream_effects')).getText(
          0,
          'rows',
        ) !== '1'
      )
        throw new Error('browser committed effect was lost on reopen');
    }
  } finally {
    await target?.close();
    await source.close();
  }
}
async function expectLogicalTools(): Promise<string> {
  const source = await WorkerOliphaunt.open({ seed, extensions: [pgtap] });
  let sql: string;
  try {
    await psql(source, { script: logicalToolsSeed });
    sql = await pgDump(source);
    if (!sql.includes('COPY public.logical_items') || sql.includes('--inserts')) {
      throw new Error('packed browser pg_dump did not preserve standard plain COPY output');
    }
  } finally {
    await source.close();
  }

  const target = await WorkerOliphaunt.open({ seed, extensions: [pgtap] });
  try {
    await psql(target, { script: sql });
    const result = await target.queryRaw(logicalToolsVerify);
    const actual = {
      rows: Number(result.getText(0, 'rows')),
      sum: Number(result.getText(0, 'sum')),
      sequenceLastValue: Number(result.getText(0, 'sequence_last_value')),
      quotedValue: result.getText(0, 'quoted_value'),
      normalizedMatches: Number(result.getText(0, 'normalized_matches')),
      extensionLoaded: result.getText(0, 'extension_loaded') === 't',
    };
    if (JSON.stringify(actual) !== JSON.stringify(logicalToolsFixture.expected)) {
      throw new Error(
        `packed browser logical tool round trip differed from the shared fixture: ${JSON.stringify(actual)}`,
      );
    }
    return `${actual.rows}:${actual.sum}:${actual.sequenceLastValue}`;
  } finally {
    await target.close();
  }
}
