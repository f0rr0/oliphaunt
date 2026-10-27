import assert from 'node:assert/strict';

const [mode, phase, directory] = process.argv.slice(2);
assert(mode === 'direct' || mode === 'broker');
assert(phase === 'write' || phase === 'read');
assert(directory);
const { Oliphaunt } = await import(`@oliphaunt/ts/${mode}`);
const database = await Oliphaunt.open({ storage: { kind: 'directory', path: directory } });
let brokerPid: number | undefined;
try {
  assert.deepEqual((await database.query('SELECT 42 AS answer')).rows, [{ answer: 42 }]);
  assert.match((await database.query('SHOW server_version')).rows[0].server_version, /^18\./u);
  if (mode === 'broker') {
    brokerPid = (await database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert(
      typeof brokerPid === 'number' && Number.isInteger(brokerPid) && brokerPid !== process.pid,
      'broker SQL must execute in its companion process',
    );
    process.kill(brokerPid, 0);
  }
  if (phase === 'write') {
    await database.exec('CREATE TABLE carrier_probe (value text NOT NULL)');
    await database.query('INSERT INTO carrier_probe VALUES ($1)', [`installed-${mode}`]);
  }
  assert.deepEqual((await database.query('SELECT value FROM carrier_probe')).rows, [
    { value: `installed-${mode}` },
  ]);
} finally {
  await database.close();
}
if (brokerPid !== undefined) {
  const pid = brokerPid;
  assert.throws(
    () => process.kill(pid, 0),
    (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    'closing the installed broker SDK must reap its companion process',
  );
}
console.log(`Installed ${mode} SQL ${phase}: PASS`);
