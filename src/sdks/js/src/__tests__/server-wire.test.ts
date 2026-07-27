import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  encodeCancelRequest,
  encodeStartupMessage,
  parseBackendKeyData,
} from '../runtime/pgwire.js';
import { serverConnectionString } from '../runtime/server.js';

function main(): void {
  startupMessageUsesPostgresV3AndUtf8();
  cancelRequestMatchesPostgresWireShape();
  backendKeyValidationMatchesRust();
  connectionStringPercentEncodesIdentity();
}

function startupMessageUsesPostgresV3AndUtf8(): void {
  const message = encodeStartupMessage('app user', 'app/db');
  assert.equal(readI32(message, 4), 196_608);
  const text = new TextDecoder().decode(message);
  assert.match(text, /user\0app user\0/);
  assert.match(text, /database\0app\/db\0/);
  assert.match(text, /client_encoding\0UTF8\0/);
}

function cancelRequestMatchesPostgresWireShape(): void {
  const packet = encodeCancelRequest({ processId: 7, secretKey: 11 });
  assert.equal(packet.length, 16);
  assert.equal(readI32(packet, 0), 16);
  assert.equal(readI32(packet, 4), 80_877_102);
  assert.equal(readI32(packet, 8), 7);
  assert.equal(readI32(packet, 12), 11);
}

function backendKeyValidationMatchesRust(): void {
  assert.deepEqual(parseBackendKeyData(new Uint8Array([0, 0, 0, 7, 0, 0, 0, 11])), {
    processId: 7,
    secretKey: 11,
  });
  assert.throws(() => parseBackendKeyData(new Uint8Array([1, 2, 3])), /BackendKeyData/);
}

function connectionStringPercentEncodesIdentity(): void {
  assert.equal(
    serverConnectionString('app user', 'app/db', 15432),
    'postgres://app%20user@127.0.0.1:15432/app%2Fdb',
  );
}

function readI32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0);
}

test('server wire', () => {
  main();
});
