import Oliphaunt, { PostgresError } from '@oliphaunt/wasix-ts';
import WorkerOliphaunt from '@oliphaunt/wasix-ts/worker';
import { indexedDB } from '@oliphaunt/wasix-ts/storage/indexed-db';

/** Exercise real startup identity on the same durable root in both browser placements. */
export async function expectConfiguredIdentity(): Promise<void> {
  const storage = indexedDB(`browser-identity-${crypto.randomUUID()}`);
  const admin = await Oliphaunt.open({ storage });
  try {
    for (const sql of [
      'CREATE ROLE browser_reader LOGIN',
      'CREATE ROLE browser_no_login NOLOGIN',
      'ALTER ROLE browser_reader SET default_statistics_target = 137',
      'CREATE TABLE browser_login_events(who name)',
      `CREATE FUNCTION browser_login_event() RETURNS event_trigger LANGUAGE plpgsql
       SECURITY DEFINER SET search_path = pg_catalog, public AS $$
       BEGIN INSERT INTO public.browser_login_events VALUES (session_user); END $$`,
      'CREATE EVENT TRIGGER browser_login ON login EXECUTE FUNCTION browser_login_event()',
      'GRANT SELECT ON browser_login_events TO browser_reader',
    ]) {
      await admin.execute(sql);
    }
  } finally {
    await admin.close();
  }

  let expectedLogins = 0;
  for (const placement of [Oliphaunt, WorkerOliphaunt, Oliphaunt]) {
    const database = await placement.open({ storage, username: 'browser_reader' });
    expectedLogins += 1;
    try {
      for (const reset of [undefined, 'RESET ROLE', 'DISCARD ALL']) {
        if (reset !== undefined) await database.execute(reset);
        const row = await database.queryRaw(`
          SELECT current_user::text AS current_role, session_user::text AS session_role,
                 (system_user IS NULL)::text AS no_auth_identity,
                 current_setting('default_statistics_target') AS statistics_target,
                 (SELECT count(*)::text FROM browser_login_events
                  WHERE who = session_user) AS logins
        `);
        for (const [column, expected] of Object.entries({
          current_role: 'browser_reader',
          session_role: 'browser_reader',
          no_auth_identity: 'true',
          statistics_target: '137',
          logins: String(expectedLogins),
        })) {
          if (row.getText(0, column) !== expected) {
            throw new Error(
              `browser configured identity ${column}: expected ${expected}, got ${row.getText(0, column)}`,
            );
          }
        }
      }
      try {
        await database.execute('SET ROLE postgres');
        throw new Error('browser configured role unexpectedly acquired superuser rights');
      } catch (error) {
        if (!(error instanceof PostgresError) || error.sqlstate !== '42501') throw error;
      }
    } finally {
      await database.close();
    }
  }

  for (const placement of [Oliphaunt, WorkerOliphaunt]) {
    let rejected = false;
    try {
      const unexpected = await placement.open({ storage, username: 'browser_no_login' });
      await unexpected.close();
    } catch (error) {
      if (!(error instanceof PostgresError) || error.sqlstate !== '28000') throw error;
      rejected = true;
    }
    if (!rejected) throw new Error('browser accepted a configured NOLOGIN role');
  }
}
