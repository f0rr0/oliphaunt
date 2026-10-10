import assert from 'node:assert/strict';
import { checkExtensions } from './extensions.mts';

const packages: { name: string; sqlName: string }[] = JSON.parse(process.argv[3]);
const extensions = await Promise.all(
  packages.map(async ({ name }) => (await import(name)).default),
);

for (const mode of ['', '/direct', '/worker']) {
  const { default: Oliphaunt } = await import(`@oliphaunt/wasix-ts${mode}`);
  const database = await Oliphaunt.open({ extensions });
  try {
    await checkExtensions(
      database,
      packages.map(({ sqlName }) => sqlName),
    );
    assert.equal((await database.queryRaw('SELECT 42::int AS answer')).getText(0, 'answer'), '42');
  } finally {
    await database.close();
  }
}
const { openServer } = await import('@oliphaunt/wasix-ts/server');
const server = await openServer({ extensions });
assert.match(server.connectionString, /^postgres(?:ql)?:\/\//);
await server.close();
assert.equal(server.closed, true);
