import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as protocol from '@oliphaunt/ts-query/protocol';
import * as query from '@oliphaunt/ts-query/query';

const require = createRequire(import.meta.url);
for (const [wire, codec] of [
  [protocol, query],
  [require('@oliphaunt/ts-query/protocol'), require('@oliphaunt/ts-query/query')],
]) {
  const frame = wire.simpleQuery('SELECT 42');
  assert.equal(frame[0], 'Q'.charCodeAt(0));
  assert.equal(new TextDecoder().decode(frame.subarray(5, -1)), 'SELECT 42');
  assert.equal(codec.postgresOids.int4, 23);
  assert.deepEqual(codec.structuredSimpleQuery('SELECT 42'), frame);
}
