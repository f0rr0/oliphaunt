import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.argv[2];
assert(root, 'native consumer requires its data directory');
const host = 'Deno' in globalThis ? 'deno' : 'Bun' in globalThis ? 'bun' : 'node';
const { directory } = await import(`@oliphaunt/ts/storage/${host}`);
for (const mode of ['direct', 'broker']) {
  const { default: Oliphaunt } = await import(`@oliphaunt/ts/${mode}`);
  const database = await Oliphaunt.open({
    storage: directory(path.join(root, `database-${mode}`)),
  });
  try {
    assert.equal((await database.queryRaw('SELECT 42::int AS answer')).getText(0, 'answer'), '42');
  } finally {
    await database.close();
  }
}
