import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt, { type OliphauntDatabase } from '@oliphaunt/wasix-ts';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';

const status = requireElement<HTMLParagraphElement>('status');
const output = requireElement<HTMLPreElement>('output');

try {
  const storage = indexedDB('packed-browser-smoke');
  let database = await Oliphaunt.open({
    execution: 'direct',
    storage,
    extensions: [pgtap],
  });
  let pgtapVersion: string;
  try {
    await expectAnswer(database);
    pgtapVersion = await readPgtapVersion(database);
    await database.transaction(async transaction => {
      await transaction.execute('CREATE TABLE packed_reopen_probe (answer integer NOT NULL)');
      await transaction.execute('INSERT INTO packed_reopen_probe VALUES ($1)', [42]);
    });
    await database.checkpoint();
  } finally {
    await database.close();
  }

  database = await Oliphaunt.open({
    execution: 'worker',
    storage,
    extensions: [pgtap],
  });
  try {
    await expectAnswer(database);
    const reopened = await database.query('SELECT answer FROM packed_reopen_probe');
    const answer = reopened.getText(0, 'answer');
    if (answer !== '42') {
      throw new Error(`packed browser package did not reopen IndexedDB state: ${answer}`);
    }
    if ((await readPgtapVersion(database)) !== pgtapVersion) {
      throw new Error('packed browser package changed its pgtap carrier on worker reopen');
    }
    await database.transaction(async transaction => {
      await transaction.execute('INSERT INTO packed_reopen_probe VALUES ($1)', [43]);
    });
    const count = (await database.query('SELECT count(*) AS count FROM packed_reopen_probe')).getText(
      0,
      'count',
    );
    if (count !== '2') {
      throw new Error(`packed browser worker transaction produced ${count} rows`);
    }
    await database.checkpoint();
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
  const result = await database.query('SELECT 40 + 2 AS answer');
  const answer = result.getText(0, 'answer');
  if (answer !== '42') {
    throw new Error(`packed browser package expected 42, received ${JSON.stringify(answer)}`);
  }
}

async function readPgtapVersion(database: OliphauntDatabase): Promise<string> {
  const result = await database.query('SELECT pgtap_version()::text AS version');
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
