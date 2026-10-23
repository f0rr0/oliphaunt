import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  connect,
  onceClosed,
  onceConnected,
  readExchange,
  simpleQuery,
  startupPacket,
} from '../../src/wasix/sdks/ts/tools/pgwire-client.mts';

const [packageName, lifecycleFile] = process.argv.slice(2);
const require = createRequire(path.join(process.cwd(), 'consumer-package.json'));
const manifest = require(`${packageName}/package.json`);
const binary = require.resolve(`${packageName}/oliphaunt_wasix_napi.node`);
const addon = require(binary);
const provenance = require(`${packageName}/artifact-provenance.json`);
assert.equal(provenance.schema, 'oliphaunt-wasix-napi-construction-data-v3');
assert(!Object.hasOwn(provenance, 'scope'));
assert(!Object.hasOwn(manifest.oliphaunt, 'qualificationOnly'));
assert.equal(
  createHash('sha256').update(readFileSync(binary)).digest('hex'),
  provenance.binary.sha256,
);
assert.equal(addon.addonAbiVersion(), manifest.oliphaunt.addonAbiVersion);
assert.equal(addon.nodeApiVersion(), manifest.oliphaunt.nodeApiVersion);
assert.equal(addon.runtimeVersion(), manifest.oliphaunt.runtimeVersion);
assert.deepEqual(addon.supportedProfiles(), ['standard', 'icu']);
const identity = ({ sha256, size }) => `${sha256}:${size}`;
assert.equal(
  addon.payloadIdentity('runtimeArchive'),
  identity(provenance.buildInputs.inputs.runtimeArchive),
);
const extensions = provenance.buildInputs.inputs.extensionArtifacts[0].portableArchives;
for (const row of extensions)
  assert.equal(
    addon.extensionIdentity(row.sqlName),
    identity(row),
    `compiled extension differs: ${row.sqlName}`,
  );
assert.throws(() => addon.extensionIdentity('unselected-extension'));
const { lifecycles } = JSON.parse(readFileSync(lifecycleFile, 'utf8'));
assert.deepEqual(
  lifecycles.map((row) => row.sqlName).sort(),
  extensions.map((row) => row.sqlName).sort(),
);

function exchange(bytes: Uint8Array) {
  const rows = [] as string[][];
  let ready = false;
  for (let offset = 0; offset < bytes.length; ) {
    assert(offset + 5 <= bytes.length, 'truncated PostgreSQL frame');
    const tag = String.fromCharCode(bytes[offset]);
    const data = Buffer.from(
      bytes.buffer,
      bytes.byteOffset + offset + 5,
      bytes.length - offset - 5,
    );
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
    assert(length >= 4 && offset + length + 1 <= bytes.length, 'invalid PostgreSQL frame length');
    assert.notEqual(
      tag,
      'E',
      `PostgreSQL ErrorResponse: ${data.subarray(0, length - 4).toString()}`,
    );
    if (tag === 'D') {
      const row = [] as string[];
      for (let count = data.readUInt16BE(0), field = 2; count > 0; count--) {
        const size = data.readInt32BE(field);
        field += 4;
        row.push(size < 0 ? '<null>' : data.subarray(field, field + size).toString());
        if (size >= 0) field += size;
      }
      rows.push(row);
    }
    if (tag === 'Z') ready = true;
    offset += length + 1;
  }
  assert(ready, 'PostgreSQL response omitted ReadyForQuery');
  return rows;
}

const options = {
  profile: 'standard',
  storage: { kind: 'memory' },
  username: 'postgres',
  database: 'postgres',
  startupGucs: {},
  extensions: extensions.map((row) => row.sqlName),
};
const direct = addon.NativeWasixDatabase.open(options);
let backup: Uint8Array;
try {
  assert.deepEqual(exchange(direct.execProtocolRaw(simpleQuery('SELECT 42::text'))), [['42']]);
  const created = new Set<string>();
  const pending = new Map(lifecycles.map((row) => [row.sqlName, row]));
  while (pending.size) {
    const ready = [...pending.values()].filter((row: any) =>
      row.dependencies.every((name) => !pending.has(name)),
    );
    assert(ready.length, 'canonical extension lifecycle contains a dependency cycle');
    for (const row of ready as any[]) {
      if (row.create) {
        const schema = row.schema ? ` WITH SCHEMA "${row.schema}"` : '';
        exchange(direct.execProtocolRaw(simpleQuery(`CREATE EXTENSION "${row.sqlName}"${schema}`)));
        created.add(row.sqlName);
      }
      for (const sql of row.loadSql) exchange(direct.execProtocolRaw(simpleQuery(sql)));
      for (const sql of row.postCreateSql) exchange(direct.execProtocolRaw(simpleQuery(sql)));
      pending.delete(row.sqlName);
    }
  }
  const installed = exchange(
    direct.execProtocolRaw(
      simpleQuery("SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname"),
    ),
  ).map(([name]) => name);
  assert.deepEqual(installed, [...created].sort());
  exchange(
    direct.execProtocolRaw(
      simpleQuery(
        "CREATE TABLE carrier_roundtrip(value text); INSERT INTO carrier_roundtrip VALUES ('persisted')",
      ),
    ),
  );
  const chunks: Uint8Array[] = [];
  assert.equal(
    direct.execProtocolRawStream(
      simpleQuery('SELECT value FROM carrier_roundtrip'),
      (chunk: Uint8Array) => chunks.push(chunk),
    ),
    'complete',
  );
  assert.deepEqual(exchange(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))), [
    ['persisted'],
  ]);
  backup = direct.backup();
  assert(backup.byteLength > 0, 'physical backup is empty');
} finally {
  direct.close();
}
assert(direct.closed);

const actor = await addon.NativeWasixActorDatabase.open(options);
try {
  assert.deepEqual(exchange(await actor.execProtocolRaw(simpleQuery('SELECT 42::text'))), [['42']]);
} finally {
  await actor.close();
}
assert(actor.closed);

const server = await addon.NativeWasixServer.open({ ...options, listen: { transport: 'tcp' } });
const socket = connect(server.connectionString);
try {
  await onceConnected(socket);
  const startup = readExchange(socket);
  socket.write(startupPacket('postgres', 'postgres'));
  await startup;
  const query = readExchange(socket);
  const chunks: Buffer[] = [];
  const capture = (chunk: Buffer) => chunks.push(Buffer.from(chunk));
  socket.on('data', capture);
  try {
    socket.write(simpleQuery('SELECT 42::text'));
    await query;
    assert.deepEqual(exchange(Buffer.concat(chunks)), [['42']]);
  } finally {
    socket.off('data', capture);
  }
} finally {
  socket.end();
  await onceClosed(socket);
  await server.close();
}
assert(server.closed);
const storage = { kind: 'directory', path: path.join(process.cwd(), 'restored-database') };
assert(backup, 'physical backup was not produced');
addon.restoreDirect(storage.path, backup);
const restored = addon.NativeWasixDatabase.open({ ...options, storage });
try {
  assert.deepEqual(
    exchange(restored.execProtocolRaw(simpleQuery('SELECT value FROM carrier_roundtrip'))),
    [['persisted']],
  );
} finally {
  restored.close();
}
console.log(
  `Installed native WASIX addon: exact runtime + ${extensions.length} contrib identities/lifecycles; direct/actor/server SQL + stream + backup restore: PASS`,
);
