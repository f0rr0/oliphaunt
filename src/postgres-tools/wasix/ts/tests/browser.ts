import seedArchive from '@oliphaunt/seed-wasix-standard/seed.tar.zst?url';
import seedManifest from '@oliphaunt/seed-wasix-standard/manifest.json?url';
const seed = { archive: seedArchive, manifest: seedManifest };
import pgtap from '@oliphaunt/extension-pgtap-wasix';
import Oliphaunt from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { pgDump, psql } from '@oliphaunt/wasix-tools';
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
  } finally {
    await direct.close();
  }
  const logicalTools = await expectLogicalTools();
  status.textContent = 'PostgreSQL tools browser smoke passed.';
  output.textContent = JSON.stringify({ directPgDump: true, logicalTools });
  document.documentElement.dataset.oliphauntSmoke = 'passed';
} catch (error) {
  status.textContent = 'PostgreSQL tools browser smoke failed.';
  output.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  document.documentElement.dataset.oliphauntSmoke = 'failed';
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
