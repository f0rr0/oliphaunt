import assert from 'node:assert/strict';
import path from 'node:path';
import { checkExtensions } from './extensions.mts';

const root = process.argv[2];
assert(root, 'native consumer requires its data directory');
const packages: { name: string; sqlName: string }[] = JSON.parse(process.argv[3]);
const extensions = await Promise.all(
  packages.map(async ({ name, sqlName }) => (await import(name))[sqlName.replaceAll('-', '_')]),
);
const host = 'Deno' in globalThis ? 'deno' : 'Bun' in globalThis ? 'bun' : 'node';
const { directory } = await import(`@oliphaunt/ts/storage/${host}`);
for (const mode of ['direct', 'broker']) {
  const { default: Oliphaunt } = await import(`@oliphaunt/ts/${mode}`);
  const database = await Oliphaunt.open({
    storage: directory(path.join(root, `database-${mode}`)),
    extensions,
  });
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
