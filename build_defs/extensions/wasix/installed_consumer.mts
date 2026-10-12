import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  connect,
  onceClosed,
  onceConnected,
  readExchange,
  simpleQuery,
  startupPacket,
} from '../../../src/wasix/sdks/ts/tools/pgwire-client.mts';

const [addonName, product, sqlName, specPath, frozenPath, fixturePath, hostManifestPath] =
  process.argv.slice(2);
assert.equal(process.argv.length, 9);
const hostManifest = JSON.parse(readFileSync(hostManifestPath, 'utf8'));
assert(
  addonName && product && sqlName && specPath && frozenPath && fixturePath && hostManifestPath,
);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
assert.equal(spec.product, product);
assert.equal(spec.sqlName, sqlName);
assert.equal(frozen.product, product);
assert.equal(frozen.sqlName, sqlName);
const lifecycle = frozen.wasixInstall.lifecycle;
const defaultVersion = spec.source['extension-control']['default-version'];
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const fixture = readFileSync(fixturePath, 'utf8');
const statements = (sql: string) =>
  sql
    .split('-- oliphaunt-statement')
    .map((statement) => statement.trim())
    .filter(Boolean);
const smoke = statements(fixture);
const verification = statements(
  fixture.includes('-- oliphaunt-verify')
    ? fixture.slice(fixture.indexOf('-- oliphaunt-verify') + '-- oliphaunt-verify'.length)
    : fixture,
);
assert(smoke.length > 0 && verification.length > 0);
const startupGucs: Record<string, string> = {};
for (const assignment of lifecycle.startupConfig) {
  const equals = assignment.indexOf('=');
  assert(equals > 0, `invalid canonical startup assignment ${assignment}`);
  const name = assignment.slice(0, equals);
  const value = assignment.slice(equals + 1);
  assert(!Object.hasOwn(startupGucs, name) || startupGucs[name] === value);
  startupGucs[name] = value;
}
// The pinned host keeps directory-database runtime overlays in temporary workspaces.
const workspaces = path.join(process.cwd(), 'runtime-workspaces');
mkdirSync(workspaces);
process.env.TMPDIR = workspaces;
const require = createRequire(path.join(process.cwd(), 'consumer-package.json'));
const addon = require(require.resolve(`${addonName}/oliphaunt_wasix_napi.node`));
const addonManifest = require(require.resolve(`${addonName}/package.json`));
assert.equal(addon.addonAbiVersion(), addonManifest.oliphaunt.addonAbiVersion);
assert.equal(addon.nodeApiVersion(), addonManifest.oliphaunt.nodeApiVersion);
assert.equal(addon.runtimeVersion(), spec.compatibility.wasix_runtime_version);
const runtimeIdentity = addon.payloadIdentity('runtimeArchive');
assert.match(runtimeIdentity, /^[0-9a-f]{64}:[1-9][0-9]*$/u);
assert.equal(
  runtimeIdentity.split(':')[0],
  hostManifest.runtime.sha256,
  'executing addon embeds a different declared host archive',
);
const packageName = `@oliphaunt/${product.slice('oliphaunt-'.length)}-wasix`;
const packageJson = require.resolve(`${packageName}/package.json`);
const manifest = require(packageJson);
assert.equal(manifest.version, spec.version);
assert.equal(frozen.version, spec.version);
const carrier = manifest.oliphaunt.carriers[sqlName];
const extensionPackage = {
  sqlName,
  product,
  version: manifest.version,
  packageJson,
  archiveSha256: carrier.sha256,
  archiveSize: carrier.size,
  ...(frozen.wasixInstall.nativeModules.length > 0
    ? { aotPackageJson: require.resolve(`${packageName}-linux-x64-gnu/package.json`) }
    : {}),
};
const options = {
  profile: 'standard',
  storage: { kind: 'memory' },
  username: 'postgres',
  database: 'postgres',
  startupGucs,
  extensions: [sqlName],
  extensionPackages: [extensionPackage],
};
function queryErrors(database: any, statement: string) {
  const response = Buffer.from(database.execProtocolRaw(simpleQuery(statement)));
  const errors: string[] = [];
  let ready = false;
  for (let offset = 0; offset < response.length; ) {
    assert(offset + 5 <= response.length, 'truncated PostgreSQL response header');
    const length = response.readUInt32BE(offset + 1);
    assert(length >= 4 && offset + length + 1 <= response.length);
    const tag = String.fromCharCode(response[offset]);
    if (tag === 'E') errors.push(response.subarray(offset + 5, offset + length + 1).toString());
    if (tag === 'Z') ready = true;
    offset += length + 1;
  }
  assert(ready, 'PostgreSQL response has no ReadyForQuery');
  return errors;
}
function sql(database: any, statement: string) {
  assert.deepEqual(queryErrors(database, statement), [], `${sqlName}: ${statement}`);
}

type Execute = (statement: string) => void | Promise<void>;
const stagedSql = `DO $$ BEGIN IF EXISTS (SELECT FROM pg_extension WHERE extname = ${quoteLiteral(sqlName)}) THEN RAISE EXCEPTION 'staging installed extension'; END IF; END $$`;
const versionSql = `DO $$ BEGIN IF (SELECT extversion FROM pg_extension WHERE extname = ${quoteLiteral(sqlName)}) IS DISTINCT FROM ${quoteLiteral(defaultVersion)} THEN RAISE EXCEPTION 'installed extension version differs from pinned source'; END IF; END $$`;
const stronger =
  sqlName === 'pg_hashids'
    ? [
        "DO $$ BEGIN IF id_encode(1001) IS DISTINCT FROM 'jNl' OR id_decode_once('jNl') IS DISTINCT FROM 1001 THEN RAISE EXCEPTION 'pg_hashids known roundtrip failed'; END IF; FOR i IN 1..2000 LOOP IF id_decode_once(id_encode(i)) IS DISTINCT FROM i OR id_decode(id_encode(ARRAY[i::bigint, (i + 1)::bigint])) IS DISTINCT FROM ARRAY[i::bigint, (i + 1)::bigint] THEN RAISE EXCEPTION 'pg_hashids repeated allocation failed'; END IF; END LOOP; END $$",
      ]
    : sqlName === 'pg_uuidv7'
      ? [
          "DO $$ DECLARE id uuid; BEGIN id := uuid_generate_v7(); IF length(id::text) IS DISTINCT FROM 36 OR substring(id::text FROM 15 FOR 1) IS DISTINCT FROM '7' THEN RAISE EXCEPTION 'uuidv7 generation failed'; END IF; IF uuid_v7_to_timestamptz('018570bb-4a7d-7000-8000-000000000000') IS DISTINCT FROM timestamptz '2023-01-02 04:26:40.637+00' OR uuid_v7_to_timestamp('018570bb-4a7d-7000-8000-000000000000') IS DISTINCT FROM timestamp '2023-01-02 04:26:40.637' OR uuid_timestamptz_to_v7(timestamptz '2023-01-02 04:26:40.637+00', true) IS DISTINCT FROM uuid '018570bb-4a7d-7000-8000-000000000000' OR uuid_timestamp_to_v7(timestamp '2023-01-02 04:26:40.637', true) IS DISTINCT FROM uuid '018570bb-4a7d-7000-8000-000000000000' THEN RAISE EXCEPTION 'uuidv7 timestamp conversion failed'; END IF; END $$",
        ]
      : sqlName === 'vector'
        ? [
            "DO $$ BEGIN IF current_setting('hnsw.ef_search', true) IS NULL OR current_setting('ivfflat.probes', true) IS NULL THEN RAISE EXCEPTION 'vector initializer did not register index options'; END IF; END $$",
          ]
        : sqlName === 'postgis'
          ? [
              "DO $$ DECLARE i int; BEGIN IF ST_Distance(ST_GeomFromText('POINT(0 0)'), ST_GeomFromText('POINT(3 4)')) IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'postgis geometry distance failed'; END IF; IF ST_Within(ST_GeomFromText('POINT(0.5 0.5)'), ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'postgis within failed'; END IF; IF ST_SRID(ST_Transform(ST_SetSRID(ST_MakePoint(-71.060316, 48.432044), 4326), 3857)) IS DISTINCT FROM 3857 THEN RAISE EXCEPTION 'postgis transform failed'; END IF; IF (ST_Area(ST_Transform(ST_GeomFromText('POLYGON((-71.18 42.39,-71.18 42.40,-71.17 42.40,-71.17 42.39,-71.18 42.39))', 4326), 26986)) > 0) IS DISTINCT FROM true THEN RAISE EXCEPTION 'postgis projected area failed'; END IF; IF ST_NumGeometries(ST_Polygonize(ARRAY[ST_GeomFromText('LINESTRING(0 0,1 0)'), ST_GeomFromText('LINESTRING(1 0,1 1)'), ST_GeomFromText('LINESTRING(1 1,0 1)'), ST_GeomFromText('LINESTRING(0 1,0 0)')])) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'postgis polygonize failed'; END IF; FOR i IN 1..200 LOOP IF (ST_Area(ST_Buffer(ST_MakePoint(i::float8, i::float8), 1)) > 3) IS DISTINCT FROM true OR (ST_X(ST_Transform(ST_SetSRID(ST_MakePoint(i::float8 / 1000, i::float8 / 1000), 4326), 3857)) > 0) IS DISTINCT FROM true THEN RAISE EXCEPTION 'postgis repeated GEOS/PROJ allocation failed'; END IF; END LOOP; END $$",
            ]
          : sqlName === 'pgtap'
            ? [
                "DO $$ BEGIN IF num_failed() IS DISTINCT FROM 0 OR _get('curr_test') IS DISTINCT FROM 2 OR _get('plan') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'canonical pgTAP fixture failed or did not execute its exact plan'; END IF; END $$",
                'SELECT _cleanup()',
                'SELECT plan(2)',
                "DO $$ BEGIN IF ok(true, 'declared SQL-only carrier executes') IS DISTINCT FROM 'ok 1 - declared SQL-only carrier executes' OR is(1, 1, 'declared SQL-only carrier compares') IS DISTINCT FROM 'ok 2 - declared SQL-only carrier compares' THEN RAISE EXCEPTION 'pgTAP returned a failing or missing assertion'; END IF; END $$",
                'SELECT * FROM finish(true)',
                'SELECT _cleanup()',
              ]
            : [];

async function runStatements(execute: Execute, rows: string[]) {
  for (const statement of rows) await execute(statement);
}
async function activate(execute: Execute) {
  await execute(stagedSql);
  await runStatements(execute, lifecycle.loadSql);
  if (lifecycle.createExtension) {
    const schema = lifecycle.createSchema;
    if (schema && schema !== 'pg_catalog')
      await execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await execute(
      `CREATE EXTENSION ${quoteIdentifier(sqlName)}${schema ? ` WITH SCHEMA ${quoteIdentifier(schema)}` : ''}`,
    );
  }
  await runStatements(execute, lifecycle.postCreateSql);
  if (lifecycle.createExtension) await execute(versionSql);
  await runStatements(execute, [...smoke, ...stronger]);
}
async function verify(execute: Execute) {
  if (lifecycle.createExtension) await execute(versionSql);
  await runStatements(execute, [...verification, ...stronger]);
}
function assertSelectedModules() {
  const prefix = 'lib/postgresql/';
  const expected = new Set<string>(
    frozen.wasixInstall.nativeModules.map((module: { path: string }) => {
      assert(module.path.startsWith(prefix));
      return module.path.slice(prefix.length);
    }),
  );
  for (const module of spec.descriptor['native-support-modules'] ?? []) {
    assert(module['runtime-path'].startsWith(prefix));
    expected.add(module['runtime-path'].slice(prefix.length));
  }
  const roots = readdirSync(workspaces, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaces, entry.name, 'tmp/oliphaunt'))
    .filter((directory) => existsSync(directory));
  assert.equal(roots.length, 1, 'expected one active pinned-host runtime workspace');
  const files = (directory: string, relative = ''): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) return files(path.join(directory, entry.name), name);
      assert(entry.isFile(), 'runtime module must be a regular file');
      return [name];
    });
  const libraryRoot = path.join(roots[0], 'lib/postgresql');
  assert.deepEqual(
    existsSync(libraryRoot) ? files(libraryRoot).sort() : [],
    [...expected].sort(),
    'staged unselected modules',
  );
}

const memory = addon.NativeWasixDatabase.open(options);
try {
  assert(queryErrors(memory, 'SELECT 1 / 0').length > 0, 'SQL errors were not recognized');
  sql(memory, 'SELECT 1');
  await activate((statement) => sql(memory, statement));
} finally {
  memory.close();
}

const storage = { kind: 'directory', path: path.join(process.cwd(), 'persistent-database') };
const direct = addon.NativeWasixDatabase.open({ ...options, storage });
try {
  assertSelectedModules();
  await activate((statement) => sql(direct, statement));
  sql(
    direct,
    'CREATE TABLE wasix_extension_probe(value bigint); INSERT INTO wasix_extension_probe VALUES (12345)',
  );
} finally {
  direct.close();
}
const retainedSql =
  "DO $$ BEGIN IF (SELECT value FROM wasix_extension_probe) IS DISTINCT FROM 12345 THEN RAISE EXCEPTION 'physical restore probe was not retained'; END IF; END $$";
const reopened = addon.NativeWasixDatabase.open({ ...options, storage });
let backup: Uint8Array;
try {
  assertSelectedModules();
  sql(reopened, retainedSql);
  await verify((statement) => sql(reopened, statement));
  backup = reopened.backup();
  assert(backup.byteLength > 0, 'physical backup is empty');
} finally {
  reopened.close();
}
const restoredStorage = { kind: 'directory', path: path.join(process.cwd(), 'restored-database') };
addon.restoreDirect(restoredStorage.path, backup);
const restored = addon.NativeWasixDatabase.open({ ...options, storage: restoredStorage });
try {
  assertSelectedModules();
  sql(restored, retainedSql);
  await verify((statement) => sql(restored, statement));
} finally {
  restored.close();
}

const server = await addon.NativeWasixServer.open({ ...options, listen: { transport: 'tcp' } });
let socket: ReturnType<typeof connect> | undefined;
try {
  const connectedSocket = connect(server.connectionString);
  socket = connectedSocket;
  await onceConnected(connectedSocket);
  const startup = readExchange(connectedSocket);
  connectedSocket.write(startupPacket(options.username, options.database));
  await startup;
  await activate(async (statement) => {
    const response = readExchange(connectedSocket);
    connectedSocket.write(simpleQuery(statement));
    try {
      await response;
    } catch (cause) {
      throw new Error(`${sqlName} server SQL failed: ${statement}`, { cause });
    }
  });
} finally {
  if (socket) {
    const closed = onceClosed(socket);
    socket.destroy();
    await closed;
  }
  await server.close();
}
console.log(
  `Installed ${sqlName} on declared WASIX host ${spec.compatibility.wasix_runtime_version}: staging, canonical activation, fixture SQL, reopen, physical backup/restore and server: PASS`,
);
