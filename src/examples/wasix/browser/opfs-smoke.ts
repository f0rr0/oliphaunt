import Oliphaunt, {
  type WasixExtensionDescriptor,
  type WasixStorage,
  WasixStorageError,
} from '@oliphaunt/wasix-ts';
import { opfs } from '@oliphaunt/wasix-ts/storage/opfs';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { standardSeed } from './resources.js';

export async function expectExclusiveOwnership(
  storage: WasixStorage,
  extensions: readonly WasixExtensionDescriptor[],
  provider: string,
): Promise<void> {
  try {
    const duplicate = await Oliphaunt.open({ seed: standardSeed, storage, extensions });
    await duplicate.close();
    throw new Error(`browser smoke opened one ${provider} database twice`);
  } catch (error) {
    if (!(error instanceof WasixStorageError) || error.code !== 'busy') {
      throw error;
    }
  }
}

export async function expectOpfsPersistence(
  extensions: readonly WasixExtensionDescriptor[],
  smokePhase: (phase: string) => void = () => {},
): Promise<string> {
  const storage = opfs('browser-smoke');
  smokePhase('OPFS direct open');
  let database = await Oliphaunt.open({ seed: standardSeed, storage, extensions });
  smokePhase('OPFS exclusive ownership');
  await expectExclusiveOwnership(storage, extensions, 'OPFS');
  smokePhase('OPFS direct create');
  await database.queryRaw('CREATE TABLE opfs_reopen_probe (answer integer NOT NULL)');
  smokePhase('OPFS direct first write');
  await database.queryRaw('INSERT INTO opfs_reopen_probe VALUES (1)');
  // PostgreSQL normally retains the relation and WAL descriptors. This second
  // operation proves that the host journal observes writes after initial open.
  smokePhase('OPFS direct retained-descriptor write');
  await database.queryRaw('INSERT INTO opfs_reopen_probe VALUES (2)');
  smokePhase('OPFS direct close');
  await database.close();

  smokePhase('OPFS Worker reopen');
  database = await WorkerOliphaunt.open({ storage, extensions });
  try {
    smokePhase('OPFS synchronous transport');
    await expectSynchronousOpfsTransport('browser-smoke');
    smokePhase('OPFS Worker read');
    const reopened = await database.queryRaw(
      'SELECT string_agg(answer::text, $1 ORDER BY answer) AS answers FROM opfs_reopen_probe',
      [','],
    );
    const answers = reopened.getText(0, 'answers');
    if (answers !== '1,2') {
      throw new Error(`browser smoke did not reopen OPFS state: ${answers}`);
    }
    smokePhase('OPFS Worker write');
    await database.queryRaw('INSERT INTO opfs_reopen_probe VALUES (3)');
    smokePhase('OPFS Worker create');
    await database.queryRaw('CREATE TABLE opfs_sync_create_probe (answer integer NOT NULL)');
    smokePhase('OPFS Worker created-relation write');
    await database.queryRaw('INSERT INTO opfs_sync_create_probe VALUES (99)');
    smokePhase('OPFS Worker checkpoint');
    await database.execute('CHECKPOINT');
  } finally {
    smokePhase('OPFS Worker close');
    await database.close();
  }

  smokePhase('OPFS direct reopen');
  database = await Oliphaunt.open({ storage, extensions });
  try {
    smokePhase('OPFS direct read');
    const reopened = await database.queryRaw(
      'SELECT string_agg(answer::text, $1 ORDER BY answer) AS answers FROM opfs_reopen_probe',
      [','],
    );
    const answers = reopened.getText(0, 'answers');
    if (answers !== '1,2,3') {
      throw new Error(`browser smoke did not reopen synchronous OPFS writes: ${answers}`);
    }
    smokePhase('OPFS direct created-relation read');
    const created = await database.queryRaw('SELECT answer FROM opfs_sync_create_probe');
    if (created.getText(0, 'answer') !== '99') {
      throw new Error('browser smoke did not reopen a relation created through synchronous OPFS');
    }
    return answers;
  } finally {
    smokePhase('OPFS reopened direct close');
    await database.close();
  }
}

async function expectSynchronousOpfsTransport(name: string): Promise<void> {
  const worker = new Worker(new URL('./opfs-transport-probe-worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const response = await new Promise<
      { ok: true; transport: 'synchronous-access' | 'portable' } | { ok: false; error: string }
    >((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OPFS transport probe timed out')), 10_000);
      worker.addEventListener(
        'error',
        (event) => {
          clearTimeout(timeout);
          reject(event.error ?? new Error(event.message));
        },
        { once: true },
      );
      worker.addEventListener(
        'message',
        (event: MessageEvent) => {
          clearTimeout(timeout);
          resolve(
            event.data as
              | { ok: true; transport: 'synchronous-access' | 'portable' }
              | { ok: false; error: string },
          );
        },
        { once: true },
      );
      worker.postMessage({ name });
    });
    if (!response.ok) throw new Error(`OPFS transport probe failed: ${response.error}`);
    if (response.transport !== 'synchronous-access') {
      throw new Error(
        'browser smoke selected portable OPFS instead of the synchronous-access Worker path',
      );
    }
  } finally {
    worker.terminate();
  }
}

export async function expectOpfsCrashRecovery(): Promise<
  Readonly<{ answer: string; relations: string }>
> {
  const name = `browser-crash-${crypto.randomUUID()}`;
  const worker = new Worker(new URL('./opfs-crash-probe-worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const response = await new Promise<
      Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>
    >((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('OPFS crash-recovery setup timed out')),
        60_000,
      );
      worker.addEventListener(
        'error',
        (event) => {
          clearTimeout(timeout);
          reject(event.error ?? new Error(event.message));
        },
        { once: true },
      );
      worker.addEventListener(
        'message',
        (event: MessageEvent) => {
          clearTimeout(timeout);
          resolve(event.data as Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>);
        },
        { once: true },
      );
      worker.postMessage({ name });
    });
    if (!response.ok) throw new Error(`OPFS crash-recovery setup failed: ${response.error}`);
  } finally {
    worker.terminate();
  }

  const database = await Oliphaunt.open({ seed: standardSeed, storage: opfs(name) });
  try {
    const result = await database.queryRaw('SELECT answer FROM opfs_crash_probe');
    const answer = result.getText(0, 'answer');
    if (answer !== '73') {
      throw new Error(`OPFS crash recovery returned an unexpected answer: ${answer}`);
    }
    const relationResult = await database.queryRaw(`
      SELECT count(*)::text AS count
      FROM pg_class
      WHERE relname LIKE 'opfs_crash_burst_%'
    `);
    const relations = relationResult.getText(0, 'count');
    if (relations !== '48') {
      throw new Error(`OPFS crash recovery returned an unexpected relation count: ${relations}`);
    }
    return { answer, relations };
  } finally {
    await database.close();
  }
}
