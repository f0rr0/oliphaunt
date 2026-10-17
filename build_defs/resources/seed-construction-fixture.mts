import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { packageClusterSeed } from '../../src/database-resources/seeds/package.mts';
import { createDeterministicTar } from '../../tools/packaging/archive-directory.mts';
import {
  captureSeedConstructionIntent,
  writeSeedConstructionReceipt,
} from './seed_construction.mts';

export const publication = {
  product: 'database-resources',
  version: '0.2.2',
  tagName: 'database-resources-v0.2.2',
  publicationSha: 'a'.repeat(40),
  publicationTree: 'b'.repeat(40),
  releaseSha: 'c'.repeat(40),
};

export const identity = (file: string) => {
  const bytes = readFileSync(file);
  return {
    path: file,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

export async function fixture(
  family: 'native' | 'wasix',
  profile: 'standard' | 'icu' = 'standard',
) {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-construction-test-'));
  const contract = JSON.parse(
    readFileSync(
      new URL('../../src/database-resources/contracts/contract.json', import.meta.url),
      'utf8',
    ),
  );
  const target = family === 'native' ? 'linux-x64-gnu' : 'portable';
  const pgdata = path.join(root, 'pgdata');
  for (const directory of contract.pgdataDirectories)
    mkdirSync(path.join(pgdata, directory), { recursive: true });
  writeFileSync(path.join(pgdata, 'PG_VERSION'), '18\n');
  // Opaque formatter fixtures: installed resource tests supply actual PostgreSQL execution.
  writeFileSync(path.join(pgdata, 'global/pg_control'), 'unchanged opaque control bytes\n');
  writeFileSync(
    path.join(pgdata, 'pg_wal/000000010000000000000001'),
    'unchanged opaque WAL bytes\n',
  );
  const runtime = path.join(root, 'runtime');
  mkdirSync(path.join(runtime, 'bin'), { recursive: true });
  const postgres = path.join(runtime, 'bin/postgres');
  const initdb = path.join(runtime, 'bin/initdb');
  const tool = path.join(root, 'constructor.mts');
  writeFileSync(postgres, 'actual declared postgres bytes fixture');
  writeFileSync(initdb, 'actual declared initdb bytes fixture');
  writeFileSync(tool, 'actual constructor source fixture');
  const inputs = { postgres, initdb, tool };
  const invocation = {
    contract,
    command: 'initdb',
    arguments: ['--encoding=UTF8'],
    environment: { TZ: 'UTC' },
  };
  const intent = captureSeedConstructionIntent({ family, target, profile }, invocation, inputs);
  const frozen = path.join(root, 'frozen.tar');
  writeFileSync(frozen, await createDeterministicTar(pgdata));
  const receiptPath = path.join(root, 'receipt.json');
  const receipt = writeSeedConstructionReceipt(receiptPath, intent, frozen, pgdata);
  const icuData = profile === 'icu' ? path.join(root, 'icu') : undefined;
  if (icuData) {
    mkdirSync(icuData);
    writeFileSync(path.join(icuData, 'icudt76l.dat'), 'fixture data');
  }
  const assets = await packageClusterSeed({
    family,
    target,
    profile,
    pgdata,
    runtime,
    icuData,
    contract,
    version: publication.version,
    runtimeVersion: '0.3.2',
    outputDir: path.join(root, 'assets'),
  });
  const metadata = path.join(root, 'metadata.json');
  const updateMetadata = (currentReceipt = receipt) =>
    writeFileSync(
      metadata,
      JSON.stringify({
        source: { commit: publication.publicationSha, tree: publication.publicationTree },
        product: { id: publication.product, version: publication.version },
        construction: [
          { seedConstructions: [{ path: receiptPath, contents: JSON.stringify(currentReceipt) }] },
        ],
      }),
    );
  updateMetadata();
  const control = () => ({
    operation: 'reuse' as const,
    publication,
    archive: identity(assets.archive),
    manifest: identity(assets.manifest),
    metadata: identity(metadata),
  });
  return {
    root,
    intent,
    inputs,
    invocation,
    pgdata,
    receipt,
    receiptPath,
    frozen,
    assets,
    metadata,
    updateMetadata,
    control,
  };
}

export function bootstrapFiles(root: string) {
  const share = path.join(root, 'share');
  mkdirSync(path.join(share, 'extension'), { recursive: true });
  for (const name of [
    'postgres.bki',
    'pg_hba.conf.sample',
    'pg_ident.conf.sample',
    'postgresql.conf.sample',
    'snowball_create.sql',
    'information_schema.sql',
    'sql_features.txt',
    'system_constraints.sql',
    'system_functions.sql',
    'system_views.sql',
  ])
    writeFileSync(path.join(share, name), `actual ${name} bytes\n`);
  writeFileSync(path.join(share, 'extension/plpgsql.control'), "default_version = '1.0'\n");
  writeFileSync(path.join(share, 'extension/plpgsql--1.0.sql'), 'actual language bootstrap SQL\n');
  return share;
}
