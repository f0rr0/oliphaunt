import Oliphaunt, { type OliphauntDatabase } from '@oliphaunt/wasix-ts';
import { opfs } from '@oliphaunt/wasix-ts/storage/opfs';

type ProbeRequest = Readonly<{ name: string }>;
type ProbeResponse = Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>;

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
let database: OliphauntDatabase | undefined;

scope.addEventListener('message', (event: MessageEvent<ProbeRequest>) => {
  void prepareDurableState(event.data.name)
    .then(() => respond({ ok: true }))
    .catch((error) => respond({ ok: false, error: describeError(error) }));
});

async function prepareDurableState(name: string): Promise<void> {
  database = await Oliphaunt.open({ execution: 'direct', storage: opfs(name) });
  await database.query('CREATE TABLE opfs_crash_probe (answer integer NOT NULL)');
  await database.query('INSERT INTO opfs_crash_probe VALUES (73)');
  await database.query(`
    DO $oliphaunt$
    BEGIN
      FOR relation IN 1..48 LOOP
        EXECUTE format('CREATE TABLE opfs_crash_burst_%s (value integer)', relation);
      END LOOP;
    END
    $oliphaunt$
  `);
  await database.checkpoint();
  // Deliberately remain open. The parent terminates this Worker to prove that
  // flushed direct OPFS state does not depend on the clean-close path.
}

function respond(response: ProbeResponse): void {
  scope.postMessage(response);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
