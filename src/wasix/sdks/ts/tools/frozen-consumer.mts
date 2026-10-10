import assert from 'node:assert/strict';

for (const mode of ['', '/direct', '/worker']) {
  const { default: Oliphaunt } = await import(`@oliphaunt/wasix-ts${mode}`);
  const database = await Oliphaunt.open();
  try {
    assert.equal((await database.queryRaw('SELECT 42::int AS answer')).getText(0, 'answer'), '42');
  } finally {
    await database.close();
  }
}
const { openServer } = await import('@oliphaunt/wasix-ts/server');
const server = await openServer();
assert.match(server.connectionString, /^postgres(?:ql)?:\/\//);
await server.close();
assert.equal(server.closed, true);
