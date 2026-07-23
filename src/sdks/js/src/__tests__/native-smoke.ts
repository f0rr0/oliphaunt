import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Oliphaunt, type OliphauntDatabase } from '../index.js';
import type { BackupArtifact, EngineMode, OpenConfig } from '../types.js';

async function main(): Promise<void> {
  const libraryPath = process.env.LIBOLIPHAUNT_PATH;
  if (libraryPath === undefined || libraryPath.length === 0) {
    throw new Error('LIBOLIPHAUNT_PATH is required for the TypeScript SDK native smoke check');
  }

  if (process.env.OLIPHAUNT_TS_SMOKE_NODE_DIRECT === '1') {
    await smokeDirect(libraryPath);
  }

  if (process.env.OLIPHAUNT_BROKER !== undefined && process.env.OLIPHAUNT_BROKER.length > 0) {
    await smokeBroker(libraryPath, process.env.OLIPHAUNT_BROKER);
  }

  if (process.env.OLIPHAUNT_POSTGRES !== undefined && process.env.OLIPHAUNT_POSTGRES.length > 0) {
    await smokeServer(libraryPath, process.env.OLIPHAUNT_POSTGRES);
  }
}

async function smokeDirect(libraryPath: string): Promise<void> {
  await smokeMode('nativeDirect', {
    engine: 'nativeDirect',
    libraryPath,
  });
}

async function smokeBroker(libraryPath: string, brokerExecutable: string): Promise<void> {
  await requireAvailable('nativeBroker', { libraryPath, brokerExecutable });
  await smokeMode('nativeBroker', {
    engine: 'nativeBroker',
    libraryPath,
    brokerExecutable,
  });
}

async function smokeServer(libraryPath: string, serverExecutable: string): Promise<void> {
  const serverToolDirectory = process.env.OLIPHAUNT_POSTGRES_TOOL_DIR ?? dirname(serverExecutable);
  await requireAvailable('nativeServer', {
    libraryPath,
    serverExecutable,
    serverToolDirectory,
  });
  await smokeMode('nativeServer', {
    engine: 'nativeServer',
    libraryPath,
    serverExecutable,
    serverToolDirectory,
  });
}

async function requireAvailable(
  engine: EngineMode,
  options: {
    libraryPath: string;
    brokerExecutable?: string;
    serverExecutable?: string;
    serverToolDirectory?: string;
  },
): Promise<void> {
  const modes = await Oliphaunt.supportedModes(options);
  const support = modes.find((mode) => mode.engine === engine);
  if (!support?.available) {
    throw new Error(`${engine} smoke support is unavailable: ${support?.unavailableReason}`);
  }
}

async function smokeMode(engine: EngineMode, config: OpenConfig): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `oliphaunt-js-${engine}-`));
  const db = await Oliphaunt.open({
    ...config,
    root,
  });
  let closed = false;
  try {
    const result = await db.query(`SELECT '${engine}'::text AS value`);
    assert.equal(result.getText(0, 'value'), engine);

    const chunks: Uint8Array[] = [];
    await db.execProtocolStream(
      new TextEncoder().encode('Q\0\0\0\u0016SELECT 1 AS value\0'),
      (chunk) => chunks.push(chunk),
    );
    assert.ok(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) > 0);

    const capabilities = await db.capabilities();
    assert.equal(capabilities.engine, engine);

    if (engine === 'nativeServer') {
      assert.equal(typeof (await db.connectionString()), 'string');
      const sql = await db.backup('sql');
      assert.equal(sql.format, 'sql');
      assert.ok(new TextDecoder().decode(sql.bytes).includes('PostgreSQL database dump'));
    }

    let archive: BackupArtifact | undefined;
    if (await db.supportsBackupFormat('physicalArchive')) {
      archive = await db.backup('physicalArchive');
      assert.equal(archive.format, 'physicalArchive');
      assert.ok(archive.bytes.byteLength >= 1024);
      assert.ok(new TextDecoder('latin1').decode(archive.bytes).includes('pgdata/backup_label'));
    }
    if (archive !== undefined) {
      await db.close();
      closed = true;
      await restoreSmokeBackup(engine, config, archive);
    }
  } finally {
    if (!closed) {
      await db.close();
    }
    if (engine !== 'nativeDirect') {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function restoreSmokeBackup(
  engine: EngineMode,
  config: OpenConfig,
  artifact: BackupArtifact,
): Promise<void> {
  const restoredRoot = await mkdtemp(join(tmpdir(), `oliphaunt-js-restored-${engine}-`));
  await rm(restoredRoot, { recursive: true, force: true });
  try {
    await Oliphaunt.restore({
      engine: engine === 'nativeDirect' ? 'nativeDirect' : 'nativeBroker',
      root: restoredRoot,
      libraryPath: config.libraryPath,
      brokerExecutable: config.brokerExecutable,
      artifact,
    });
    assert.match(await readFile(join(restoredRoot, 'pgdata', 'PG_VERSION'), 'utf8'), /^\d+\n$/);
    if (engine === 'nativeDirect') {
      return;
    }
    const restored = await Oliphaunt.open({
      ...config,
      root: restoredRoot,
    });
    try {
      const result = await restored.query('SELECT 1 AS value');
      assert.equal(result.getText(0, 'value'), '1');
    } finally {
      await restored.close();
    }
  } finally {
    await rm(restoredRoot, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
