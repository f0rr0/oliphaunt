import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createBrokerRuntimeBinding } from '../runtime/broker.js';
import { parseReadyEndpoint, randomHexToken, unixSocketPathsFit } from '../runtime/node-adapter.js';
import {
  encodeCancelRequest,
  encodeStartupMessage,
  parseBackendKeyData,
} from '../runtime/pgwire.js';
import { createServerRuntimeBinding } from '../runtime/server.js';

// liboliphaunt-doc-example:typescript-open-server
test('runtime adapters implement the shared internal operation boundary', () => {
  const broker = createBrokerRuntimeBinding();
  assert.equal(typeof broker.open, 'function');
  assert.equal(typeof broker.execProtocolRaw, 'function');
  assert.equal(typeof broker.backup, 'function');
  assert.equal(typeof broker.cancel, 'function');
  assert.equal(typeof broker.detach, 'function');

  const server = createServerRuntimeBinding();
  assert.equal(typeof server.open, 'function');
  assert.equal(typeof server.execProtocolRaw, 'function');
  assert.equal(server.backup, undefined);
  assert.equal(typeof server.connectionString, 'function');
});

test('node adapter validates local endpoints and socket path limits', () => {
  assert.deepEqual(parseReadyEndpoint('tcp:127.0.0.1:15432'), {
    kind: 'tcp',
    host: '127.0.0.1',
    port: 15432,
  });
  assert.deepEqual(parseReadyEndpoint('unix:/tmp/oliphaunt.sock'), {
    kind: 'unix',
    path: '/tmp/oliphaunt.sock',
  });
  assert.throws(() => parseReadyEndpoint('http://localhost'), /endpoint/);
  assert.equal(unixSocketPathsFit('/tmp/oliphaunt.sock'), true);
  assert.equal(unixSocketPathsFit(`/tmp/${'x'.repeat(110)}`), false);
  assert.match(randomHexToken(), /^[0-9a-f]+$/u);
});

test('server wire uses PostgreSQL v3 startup and cancel packets', () => {
  const startup = encodeStartupMessage('app user', 'app/db');
  assert.equal(readI32(startup, 4), 196_608);
  const startupText = new TextDecoder().decode(startup);
  assert.match(startupText, /user\0app user\0/);
  assert.match(startupText, /database\0app\/db\0/);
  assert.match(startupText, /client_encoding\0UTF8\0/);

  const cancel = encodeCancelRequest({ processId: 7, secretKey: 11 });
  assert.equal(cancel.length, 16);
  assert.equal(readI32(cancel, 0), 16);
  assert.equal(readI32(cancel, 4), 80_877_102);
  assert.equal(readI32(cancel, 8), 7);
  assert.equal(readI32(cancel, 12), 11);
  assert.deepEqual(parseBackendKeyData(cancel.subarray(8)), {
    processId: 7,
    secretKey: 11,
  });
  assert.throws(() => parseBackendKeyData(new Uint8Array([1, 2])), /BackendKeyData/);
});

function readI32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0);
}
