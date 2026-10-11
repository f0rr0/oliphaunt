import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const [addonName, product, sqlName] = process.argv.slice(2);
const require = createRequire(path.join(process.cwd(), 'consumer-package.json'));
const addon = require(require.resolve(`${addonName}/oliphaunt_wasix_napi.node`));
const packageName = `@oliphaunt/${product.slice('oliphaunt-'.length)}-wasix`;
const packageJson = require.resolve(`${packageName}/package.json`);
const manifest = require(packageJson);
const carrier = manifest.oliphaunt.carriers[sqlName];
const extensionPackage = {
  sqlName,
  product,
  version: manifest.version,
  packageJson,
  archiveSha256: carrier.sha256,
  archiveSize: carrier.size,
  aotPackageJson: require.resolve(`${packageName}-linux-x64-gnu/package.json`),
};
const options = {
  profile: 'standard',
  storage: { kind: 'memory' },
  username: 'postgres',
  database: 'postgres',
  startupGucs: {},
  extensions: [sqlName],
  extensionPackages: [extensionPackage],
};
function sql(database: any, statement: string) {
  const query = Buffer.from(`${statement}\0`);
  const packet = Buffer.alloc(query.length + 5);
  packet[0] = 81;
  packet.writeInt32BE(query.length + 4, 1);
  query.copy(packet, 5);
  const response = Buffer.from(database.execProtocolRaw(packet));
  let ready = false;
  for (let offset = 0; offset < response.length; ) {
    const length = response.readUInt32BE(offset + 1);
    assert(length >= 4 && offset + length + 1 <= response.length);
    const tag = String.fromCharCode(response[offset]);
    assert.notEqual(tag, 'E', response.subarray(offset + 5, offset + length + 1).toString());
    if (tag === 'Z') ready = true;
    offset += length + 1;
  }
  assert(ready);
}
const database = addon.NativeWasixDatabase.open(options);
try {
  sql(database, `CREATE EXTENSION "${sqlName}" WITH SCHEMA "pg_catalog"`);
  sql(
    database,
    "DO $$ BEGIN IF id_encode(1001) IS DISTINCT FROM 'jNl' THEN RAISE EXCEPTION 'pg_hashids encode failed'; END IF; IF id_decode_once('jNl') IS DISTINCT FROM 1001 THEN RAISE EXCEPTION 'pg_hashids decode failed'; END IF; END $$",
  );
  sql(
    database,
    "DO $$ BEGIN FOR i IN 1..2000 LOOP IF id_decode_once(id_encode(i)) IS DISTINCT FROM i OR id_decode(id_encode(ARRAY[i::bigint, (i + 1)::bigint])) IS DISTINCT FROM ARRAY[i::bigint, (i + 1)::bigint] THEN RAISE EXCEPTION 'pg_hashids repeated allocation failed'; END IF; END LOOP; END $$",
  );
  sql(
    database,
    'CREATE TABLE wasix_extension_probe(value bigint); INSERT INTO wasix_extension_probe VALUES (12345)',
  );
  const backup = database.backup();
  database.close();
  const storage = { kind: 'directory', path: path.join(process.cwd(), 'restored-database') };
  addon.restoreDirect(storage.path, backup);
  const restored = addon.NativeWasixDatabase.open({ ...options, storage });
  try {
    sql(
      restored,
      "DO $$ BEGIN IF (SELECT value FROM wasix_extension_probe) IS DISTINCT FROM 12345 OR id_decode_once(id_encode(12345)) IS DISTINCT FROM 12345 THEN RAISE EXCEPTION 'pg_hashids restore failed'; END IF; END $$",
    );
  } finally {
    restored.close();
  }
  console.log(
    'Installed pg_hashids on the exact declared published WASIX host: CREATE EXTENSION, function SQL and backup/restore: PASS',
  );
} finally {
  try {
    database.close();
  } catch {}
}
