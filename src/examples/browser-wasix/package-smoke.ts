import seedArchive from '@oliphaunt/seed-wasix-standard/seed.tar.zst?url';
import seedManifest from '@oliphaunt/seed-wasix-standard/manifest.json?url';
import icuSeedArchive from '@oliphaunt/seed-wasix-icu/seed.tar.zst?url';
import icuSeedManifest from '@oliphaunt/seed-wasix-icu/manifest.json?url';
import icuData from '@oliphaunt/icu/data?url';
import icuManifest from '@oliphaunt/icu/manifest?url';
import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt, { type OliphauntDatabase } from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';

import { expectStructuredApi } from './structured-api-smoke.js';

const status = requireElement<HTMLParagraphElement>('status');
const output = requireElement<HTMLPreElement>('output');

try {
  const storage = indexedDB('packed-browser-smoke');
  let database = await Oliphaunt.open({
    storage,
    seed: { archive: seedArchive, manifest: seedManifest },
    extensions: [pgtap],
  });
  let pgtapVersion: string;
  try {
    await database.execute('CREATE EXTENSION pgtap');
    await expectAnswer(database);
    await expectStructuredApi(database, 'packed browser direct');
    pgtapVersion = await readPgtapVersion(database);
    await database.transaction(async (transaction) => {
      await transaction.execute('CREATE TABLE packed_reopen_probe (answer integer NOT NULL)');
      await transaction.execute('INSERT INTO packed_reopen_probe VALUES ($1)', [42]);
    });
    await database.execute('CHECKPOINT');
  } finally {
    await database.close();
  }

  database = await WorkerOliphaunt.open({
    storage,
    extensions: [pgtap],
  });
  try {
    await expectAnswer(database);
    await expectStructuredApi(database, 'packed browser Worker');
    const reopened = await database.queryRaw('SELECT answer FROM packed_reopen_probe');
    const answer = reopened.getText(0, 'answer');
    if (answer !== '42') {
      throw new Error(`packed browser package did not reopen IndexedDB state: ${answer}`);
    }
    if ((await readPgtapVersion(database)) !== pgtapVersion) {
      throw new Error('packed browser package changed its pgtap carrier on worker reopen');
    }
    await database.transaction(async (transaction) => {
      await transaction.execute('INSERT INTO packed_reopen_probe VALUES ($1)', [43]);
    });
    const count = (
      await database.queryRaw('SELECT count(*) AS count FROM packed_reopen_probe')
    ).getText(0, 'count');
    if (count !== '2') {
      throw new Error(`packed browser worker transaction produced ${count} rows`);
    }
    await database.execute('CHECKPOINT');
    const icuDatabase = await Oliphaunt.open({
      seed: { archive: icuSeedArchive, manifest: icuSeedManifest },
      icu: { data: icuData, manifest: icuManifest },
    });
    try {
      const ordered = await icuDatabase.queryRaw(
        `SELECT string_agg(value, ',' ORDER BY value COLLATE "en-x-icu") AS value FROM (VALUES ('z'), ('a'), (chr(228))) AS input(value)`,
      );
      if (ordered.getText(0, 'value') !== 'a,ä,z')
        throw new Error('selected ICU resources did not provide ICU collation');
    } finally {
      await icuDatabase.close();
    }
    status.textContent = 'Packed browser package smoke passed.';
    output.textContent = JSON.stringify({
      direct: 42,
      worker: 42,
      indexedDB: answer,
      transactionRows: count,
      pgtap: pgtapVersion,
    });
    document.documentElement.dataset.oliphauntSmoke = 'passed';
  } finally {
    await database.close();
  }
} catch (error) {
  status.textContent = 'Packed browser package smoke failed.';
  output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  document.documentElement.dataset.oliphauntSmoke = 'failed';
}

async function expectAnswer(database: OliphauntDatabase): Promise<void> {
  const result = await database.queryRaw('SELECT 40 + 2 AS answer');
  const answer = result.getText(0, 'answer');
  if (answer !== '42') {
    throw new Error(`packed browser package expected 42, received ${JSON.stringify(answer)}`);
  }
}

async function readPgtapVersion(database: OliphauntDatabase): Promise<string> {
  const result = await database.queryRaw('SELECT pgtap_version()::text AS version');
  const version = result.getText(0, 'version');
  if (version === null || version.length === 0) {
    throw new Error('packed browser package returned no pgtap version');
  }
  return version;
}

function requireElement<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element as ElementType;
}
